import { ScalarField, FIELD_IDS, type FieldId, type FieldStats } from '../field.ts';
import { Rng } from '../rng.ts';
import { clamp, clamp01, safeDiv, finite } from '../math.ts';
import { InvariantError, invariant } from '../errors.ts';
import {
  STRESS_BEHAVIOUR,
  fitnessAt,
  type SpeciesDefinition,
  type SpeciesId,
  type SpeciesTraits,
  type TrophicRole,
} from './species.ts';
import {
  EventLog,
  countEvent,
  createEventCounters,
  bump,
  type DeathCause,
  type EventCounters,
  type WorldEvent,
} from './events.ts';
import {
  createMoments,
  addReading,
  createProbe,
  recordProbeSample,
  stabilityIndex,
  type FieldMoments,
  type PopulationSample,
  type ProbeState,
} from './metrics.ts';
import {
  DEFAULT_DIFFUSION,
  DEFAULT_RELAXATION,
  advanceFields,
  applyScheduledPulses,
  buildFields,
  type SectorConfig,
} from './sector.ts';

/**
 * The ecosystem simulation.
 *
 * ## Determinism (ADR-002)
 * `World` is a pure function of `(sectorConfig, species, seed, orderedCalls)`. Randomness comes
 * exclusively from forked `Rng` streams, time advances only through `step()`, and nothing here reads
 * the DOM, the clock, or `Math.random`. Two worlds built with the same seed and fed the same
 * instrument calls produce identical histories (asserted by `tests/core/determinism.test.ts`).
 *
 * ## Physics summary (see docs/DESIGN.md §3)
 * Each tick: environment → sensing → feeding → metabolism → movement → reproduction → death.
 * Biomass is a real, spatially resolved quantity: autotrophs deposit it, consumers remove it, and
 * whoever is removed pays for it with energy. Nothing is scripted.
 *
 * ## Scratch buffers
 * `updateAgent` reuses `scratchReadings` for speed. Any *stored* reading (event snapshots) is
 * re-read with the allocating `readingsAt()` so a snapshot can never alias the scratch object.
 */

export interface Agent {
  id: number;
  species: SpeciesId;
  x: number;
  y: number;
  /** Unit heading; multiplied by the species speed each tick. */
  dx: number;
  dy: number;
  energy: number;
  age: number;
  cooldown: number;
  /** Consecutive ticks spent in lethal conditions. */
  stress: number;
  generation: number;
  alive: boolean;
}

export interface Barrier {
  readonly id: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface WorldOptions {
  readonly config: SectorConfig;
  readonly species: readonly SpeciesDefinition[];
  readonly seed: number;
  /** Field diffusion rate per tick (0..0.25). */
  readonly diffusion?: number;
  /** Relaxation of fields toward their baseline per tick. */
  readonly relaxation?: number;
  readonly eventCapacity?: number;
  readonly populationHistoryCapacity?: number;
}

/** A snapshot of everything the renderer and the UI need for one frame (read-only by contract). */
export interface WorldSnapshot {
  readonly tick: number;
  readonly counts: Readonly<Record<SpeciesId, number>>;
  readonly biomass: Readonly<Record<SpeciesId, number>>;
  readonly totalBiomass: number;
  readonly fieldStats: Readonly<Record<FieldId, FieldStats>>;
  readonly agents: readonly Agent[];
  readonly probes: readonly ProbeState[];
  readonly history: readonly PopulationSample[];
  readonly stability: number;
  readonly barriers: readonly Barrier[];
  readonly fields: Readonly<Record<FieldId, ScalarField>>;
  readonly biomassFields: ReadonlyMap<SpeciesId, ScalarField>;
  readonly extinctions: readonly SpeciesId[];
}

export interface CullResult {
  readonly removed: number;
  readonly perSpecies: Readonly<Record<SpeciesId, number>>;
}

export const BIOMASS_CELL_LIMIT = 4;
export const EXPOSURE_LETHAL_TICK_LIMIT = 110;
export const MOVE_DECISION_INTERVAL = 3;
export const HASH_CELL_SIZE = 4;


const BIOMASS_DECAY = 0.0022;
const BIOMASS_SPREAD = 0.1;
/**
 * Fraction of a dead organism's remaining energy that returns to its species' biomass field as a
 * carcass. This closes the nutrient loop *and* is the predators' real food economy: without it a
 * predator earns only the energy it drains with its teeth, and the hunting lifestyle cannot pay for
 * itself in a small sector (measured with `npm run balance`: predators starved in 5 of 15
 * sector/seed combinations). With it, carrion is scavenged by whoever reaches it first — predators,
 * filter feeders, or the mat itself.
 */
const DECOMPOSE_RATIO = 0.3;
const ASSIMILATION = 0.85;
const PREDATION_ASSIMILATION = 0.8;
const LOCAL_BREEDING_LIMIT = 9;
/**
 * A consumer only breeds where there is food under it. Without this gate, grazers boomed on a
 * temporarily abundant mat and stripped the producers to extinction within a single survey
 * (measured with `npm run balance`: 318 starvation deaths and a dead primary producer).
 */
const BREEDING_FOOD_GATE = 0.22;
/**
 * Efficiency of eating the *mat* rather than one's own prey: a drifting detritus field for filter
 * feeders, carrion and grazing on the move for predators. Role-dependent on purpose — scavenging
 * must be enough to survive a bad patch but not enough to raise a family, otherwise predators stop
 * depending on prey and eat their ecosystem out of existence (measured: GLI-3 recovered, then
 * wiped out CALYX in all three test seeds).
 */
const SCAVENGE_BY_ROLE: Readonly<Record<TrophicRole, number>> = Object.freeze({
  photoautotroph: 0,
  herbivore: 0,
  filter: 0.5,
  carnivore: 0.2,
});
/**
 * Predators range over a much larger territory than a grazer, so requiring the same *local* food
 * density would sterilise them: a lone hunter with prey in sight must still be able to breed.
 */
const PREDATOR_BREEDING_FOOD_GATE = 0.08;
/** Neighbour count (within 3 cells) at which density halves a producer's growth. */
const DENSITY_HALF = 18;
/** Extra metabolic cost per unit of local density (competition). */
const COMPETITION_DRAIN = 0.35;
/** Standing biomass (per patch) at which a consumer reaches half of its maximum intake rate. */
const INTAKE_HALF_SATURATION = 2.5;
/**
 * When a grazer strips the mat it also damages the organisms that built it, but only for part of
 * the biomass it takes: the deposited mat *is* producer tissue, so charging the individual for the
 * full mouthful as well would double-count the loss and made producers unable to survive any
 * grazing pressure at all (measured with `npm run balance`: producers were driven to local
 * extinction while their grazers thrived).
 */
const GRAZE_TISSUE_LOSS = 0.15;
const SAMPLE_INTERVAL = 25;
const PROBE_INTERVAL = 10;

export class World {
  readonly config: SectorConfig;
  readonly seed: number;
  readonly fields: Record<FieldId, ScalarField>;
  readonly biomassFields: Map<SpeciesId, ScalarField> = new Map();
  readonly traits: ReadonlyMap<SpeciesId, SpeciesTraits>;
  readonly events: EventLog;
  readonly counters: EventCounters = createEventCounters();
  readonly birthMoments: Map<SpeciesId, FieldMoments> = new Map();
  readonly probes: ProbeState[] = [];
  readonly barriers: Barrier[] = [];
  /** Measured energy drawn per (consumer → prey) pair; the empirical trophic link (ADR-005). */
  readonly intakeGraph: Map<SpeciesId, Map<SpeciesId, number>> = new Map();

  /** Dense array of living organisms, rebuilt by `compact()` at the end of every tick. */
  agents: Agent[] = [];
  tick = 0;

  private readonly rng: Rng;
  private readonly movementRng: Rng;
  private readonly history: PopulationSample[] = [];
  private readonly historyCapacity: number;
  private readonly diffusion: number;
  private readonly relaxation: number;
  private readonly pool: Agent[] = [];
  private readonly buckets: Agent[][] = [];
  private readonly bucketCols: number;
  private readonly bucketRows: number;
  private readonly populationCounts: Map<SpeciesId, number> = new Map();
  private readonly scratchReadings: Record<FieldId, number> = {
    temperature: 0,
    humidity: 0,
    light: 0,
  };
  private readonly extinctions: SpeciesId[] = [];
  private nextAgentId = 1;
  private nextProbeId = 1;
  private nextBarrierId = 1;

  constructor(options: WorldOptions) {
    const { config } = options;
    this.config = config;
    this.seed = (options.seed ?? config.seed) >>> 0;
    this.rng = new Rng(this.seed).fork('world');
    this.movementRng = new Rng(this.seed).fork('movement');
    this.diffusion = options.diffusion ?? DEFAULT_DIFFUSION;
    this.relaxation = options.relaxation ?? DEFAULT_RELAXATION;
    this.events = new EventLog(options.eventCapacity ?? 4000);
    this.historyCapacity = options.populationHistoryCapacity ?? 600;

    const traitMap = new Map<SpeciesId, SpeciesTraits>();
    for (const def of options.species) traitMap.set(def.id, def.traits);
    this.traits = traitMap;

    this.fields = buildFields(config) as Record<FieldId, ScalarField>;
    for (const id of config.roster) {
      invariant(traitMap.has(id), `Sector ${config.id} rosters unknown species ${id}`);
      this.biomassFields.set(id, new ScalarField(config.width, config.height, 0));
      this.birthMoments.set(id, createMoments());
      this.populationCounts.set(id, 0);
      this.intakeGraph.set(id, new Map());
    }

    this.bucketCols = Math.ceil(config.width / HASH_CELL_SIZE);
    this.bucketRows = Math.ceil(config.height / HASH_CELL_SIZE);
    for (let i = 0; i < this.bucketCols * this.bucketRows; i++) this.buckets.push([]);

    this.seedInitialPopulation();
    this.recount();
    this.sampleHistory();
  }

  // ---------------------------------------------------------------- construction / setup

  private seedInitialPopulation(): void {
    const spawnRng = this.rng.fork('initial-population');
    for (const species of this.config.roster) {
      const target = this.config.initialPopulations[species] ?? 0;
      const traits = this.traits.get(species);
      if (!traits) continue;
      let placed = 0;
      let attempts = 0;
      const maxAttempts = target * 260 + 6000;
      while (placed < target && attempts < maxAttempts) {
        attempts++;
        const x = spawnRng.range(0.5, this.config.width - 0.5);
        const y = spawnRng.range(0.5, this.config.height - 0.5);
        const fit = this.fitnessAtPosition(traits, x, y);
        // Rejection sampling: organisms start where they can actually live. The threshold relaxes
        // as attempts run out, so a harsh sector still starts populated (and visibly struggling)
        // rather than empty.
        const floor = attempts > maxAttempts * 0.7 ? 0.05 : 0.25;
        if (fit < floor) continue;
        if (this.nearbyCount(x, y, 3) > 8) continue;
        this.spawn(species, x, y, traits.startEnergy * spawnRng.range(0.8, 1.05), 0, spawnRng);
        placed++;
      }
      if (placed === 0) {
        // Guard rail: a sector must never start empty; place at the fittest cell in the sector.
        const best = this.findFittestCell(traits);
        this.spawn(species, best.x, best.y, traits.startEnergy, 0, spawnRng);
      }
    }
  }

  private findFittestCell(traits: SpeciesTraits): { x: number; y: number; fit: number } {
    let best = { x: this.config.width / 2, y: this.config.height / 2, fit: -1 };
    for (let y = 0; y < this.config.height; y++) {
      for (let x = 0; x < this.config.width; x++) {
        const fit = this.fitnessAtPosition(traits, x + 0.5, y + 0.5);
        if (fit > best.fit) best = { x: x + 0.5, y: y + 0.5, fit };
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- public reads

  /** Reads the three fields at a position (allocates a fresh object; safe to store). */
  readingsAt(x: number, y: number): Record<FieldId, number> {
    return {
      temperature: this.fields.temperature.sampleBilinear(x, y),
      humidity: this.fields.humidity.sampleBilinear(x, y),
      light: this.fields.light.sampleBilinear(x, y),
    };
  }

  /**
   * Fitness of a species at a position under the current environment. Uses the shared scratch
   * object: the returned value is safe, the internal readings are not.
   */
  fitnessAtPosition(traits: SpeciesTraits, x: number, y: number): number {
    const readings = this.scratchReadings;
    readings.temperature = this.fields.temperature.sampleBilinear(x, y);
    readings.humidity = this.fields.humidity.sampleBilinear(x, y);
    readings.light = this.fields.light.sampleBilinear(x, y);
    return fitnessAt(traits, readings);
  }

  /** Fitness of a species at a point. Throws on an unknown id — a typo must not read as "dead zone". */
  fitnessAt(x: number, y: number, species: SpeciesId): number {
    return this.fitnessAtPosition(this.getSpecies(species), x, y);
  }

  count(species: SpeciesId): number {
    return this.populationCounts.get(species) ?? 0;
  }

  counts(): Record<SpeciesId, number> {
    const out: Record<SpeciesId, number> = {};
    for (const id of this.config.roster) out[id] = this.populationCounts.get(id) ?? 0;
    return out;
  }

  speciesBiomass(species: SpeciesId): number {
    const field = this.biomassFields.get(species);
    if (!field) return 0;
    let sum = 0;
    const d = field.data;
    for (let i = 0; i < d.length; i++) sum += d[i] as number;
    return sum;
  }

  biomassReport(): Record<SpeciesId, number> {
    const out: Record<SpeciesId, number> = {};
    for (const id of this.config.roster) out[id] = this.speciesBiomass(id);
    return out;
  }

  totalBiomass(): number {
    let sum = 0;
    for (const id of this.config.roster) sum += this.speciesBiomass(id);
    return sum;
  }

  /** Total standing biomass inside a circular area (probe readouts, area surveys). */
  /** Standing biomass of one species inside a radius (the honest read-out for its instruments). */
  speciesBiomassInRadius(species: SpeciesId, x: number, y: number, radius: number): number {
    const field = this.biomassFields.get(species);
    if (!field) return 0;
    const r2 = radius * radius;
    let total = 0;
    const x0 = clamp(Math.floor(x - radius), 0, field.width - 1);
    const x1 = clamp(Math.ceil(x + radius), 0, field.width - 1);
    const y0 = clamp(Math.floor(y - radius), 0, field.height - 1);
    const y1 = clamp(Math.ceil(y + radius), 0, field.height - 1);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const dx = cx + 0.5 - x;
        const dy = cy + 0.5 - y;
        if (dx * dx + dy * dy <= r2) total += field.getAt(cx, cy);
      }
    }
    return total;
  }

  biomassInRadius(x: number, y: number, radius: number): number {
    const r2 = radius * radius;
    let total = 0;
    for (const id of this.config.roster) {
      const field = this.biomassFields.get(id);
      if (!field) continue;
      const x0 = clamp(Math.floor(x - radius), 0, field.width - 1);
      const x1 = clamp(Math.ceil(x + radius), 0, field.width - 1);
      const y0 = clamp(Math.floor(y - radius), 0, field.height - 1);
      const y1 = clamp(Math.ceil(y + radius), 0, field.height - 1);
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const dx = cx + 0.5 - x;
          const dy = cy + 0.5 - y;
          if (dx * dx + dy * dy <= r2) total += field.getAt(cx, cy);
        }
      }
    }
    return total;
  }

  /** Number of living organisms. */
  get population(): number {
    return this.agents.length;
  }

  getSpecies(species: SpeciesId): SpeciesTraits {
    const traits = this.traits.get(species);
    invariant(traits !== undefined, `Unknown species "${species}" requested from world`);
    return traits;
  }

  /** Finds the organism under a world-space point (used by the click/tap inspector). */
  pickAgent(x: number, y: number, tolerance = 1.4): Agent | null {
    let best: Agent | null = null;
    let bestDist = tolerance * tolerance;
    for (const agent of this.agents) {
      const dx = agent.x - x;
      const dy = agent.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestDist) {
        bestDist = d2;
        best = agent;
      }
    }
    return best;
  }

  /** Organisms within `radius` of a point, grouped by species (probe sampling, area surveys). */
  censusAround(x: number, y: number, radius: number): Record<SpeciesId, number> {
    const out: Record<SpeciesId, number> = {};
    for (const id of this.config.roster) out[id] = 0;
    const r2 = radius * radius;
    for (const agent of this.agents) {
      const dx = agent.x - x;
      const dy = agent.y - y;
      if (dx * dx + dy * dy <= r2) out[agent.species] = (out[agent.species] ?? 0) + 1;
    }
    return out;
  }

  // ---------------------------------------------------------------- tick loop

  /** Advances the world by one tick. */
  step(): void {
    this.tick++;
    this.applyPulses();
    advanceFields(this.fields, this.config, this.diffusion, this.relaxation);
    this.decayBiomass();
    this.rebuildBuckets();

    const list = this.agents;
    for (let i = 0; i < list.length; i++) {
      const agent = list[i] as Agent;
      if (agent.alive) this.updateAgent(agent);
    }

    this.compact();
    this.detectExtinctions();

    if (this.tick % SAMPLE_INTERVAL === 0) this.sampleHistory();
    if (this.tick % PROBE_INTERVAL === 0) this.sampleProbes();
  }

  /** Runs `ticks` simulation steps (the caller budgets them per frame). */
  run(ticks: number): void {
    const n = Math.max(0, Math.floor(ticks));
    for (let i = 0; i < n; i++) this.step();
  }

  private applyPulses(): void {
    // The field effect comes from the shared scheduler (the same one the climate sampler uses, so a
    // law can never be derived from a pulse-free world); only the player-visible event is local.
    const fired = applyScheduledPulses(this.fields, this.config, this.tick);
    for (const pulse of fired) {
      this.emit({
        tick: this.tick,
        kind: 'pulse',
        x: pulse.x,
        y: pulse.y,
        amount: pulse.amount,
        message: `${pulse.field} surge ${pulse.amount > 0 ? '+' : ''}${pulse.amount.toFixed(0)}`,
      });
    }
  }

  /**
   * Standing biomass decays (respiration) and spreads slowly into neighbouring cells, like a mat
   * creeping outward. Spreading matters mechanically: it turns isolated pockets of production into
   * a grazeable resource gradient instead of food that is locked in the cells where it was made.
   */
  private decayBiomass(): void {
    for (const id of this.config.roster) {
      const field = this.biomassFields.get(id);
      if (!field) continue;
      this.decayField(field, BIOMASS_DECAY);
      if (BIOMASS_SPREAD > 0) field.diffuse(BIOMASS_SPREAD);
    }
  }

  private decayField(field: ScalarField, rate: number): void {
    const d = field.data;
    for (let i = 0; i < d.length; i++) {
      d[i] = (d[i] as number) * (1 - rate);
    }
  }

  private rebuildBuckets(): void {
    for (const bucket of this.buckets) bucket.length = 0;
    const list = this.agents;
    for (let i = 0; i < list.length; i++) {
      const agent = list[i] as Agent;
      if (!agent.alive) continue;
      const bucket = this.buckets[this.bucketIndex(agent.x, agent.y)];
      if (bucket) bucket.push(agent);
    }
  }

  private bucketIndex(x: number, y: number): number {
    const cx = clamp(Math.floor(x / HASH_CELL_SIZE), 0, this.bucketCols - 1);
    const cy = clamp(Math.floor(y / HASH_CELL_SIZE), 0, this.bucketRows - 1);
    return cy * this.bucketCols + cx;
  }

  /**
   * Living organisms in the agent's own hash bucket. Buckets are 4×4 cells, so this is a cheap,
   * stable proxy for local crowding; the exact 3-cell count is reserved for the rarer decisions
   * (breeding, exposure) where precision matters.
   */
  private bucketDensity(x: number, y: number): number {
    const bucket = this.buckets[this.bucketIndex(x, y)];
    return bucket ? bucket.length : 0;
  }

  /** Counts living organisms within `radius` using the spatial hash (no allocation). */
  private nearbyCount(x: number, y: number, radius: number): number {
    const r2 = radius * radius;
    const cx = clamp(Math.floor(x / HASH_CELL_SIZE), 0, this.bucketCols - 1);
    const cy = clamp(Math.floor(y / HASH_CELL_SIZE), 0, this.bucketRows - 1);
    let n = 0;
    for (let row = Math.max(0, cy - 1); row <= Math.min(this.bucketRows - 1, cy + 1); row++) {
      for (let col = Math.max(0, cx - 1); col <= Math.min(this.bucketCols - 1, cx + 1); col++) {
        const bucket = this.buckets[row * this.bucketCols + col];
        if (!bucket) continue;
        for (const agent of bucket) {
          const dx = agent.x - x;
          const dy = agent.y - y;
          if (dx * dx + dy * dy <= r2) n++;
        }
      }
    }
    return n;
  }

  // ---------------------------------------------------------------- agent update

  private updateAgent(agent: Agent): void {
    const traits = this.traits.get(agent.species);
    if (!traits) {
      this.killAgent(agent, 'exposure');
      return;
    }
    const readings = this.scratchReadings;
    readings.temperature = this.fields.temperature.sampleBilinear(agent.x, agent.y);
    readings.humidity = this.fields.humidity.sampleBilinear(agent.x, agent.y);
    readings.light = this.fields.light.sampleBilinear(agent.x, agent.y);
    const fit = fitnessAt(traits, readings);

    agent.age++;
    if (agent.cooldown > 0) agent.cooldown--;

    const behaviour = STRESS_BEHAVIOUR[traits.stressResponse];
    if (fit < traits.tolerance.temperature.fragile) {
      agent.stress++;
    } else {
      agent.stress = Math.max(0, agent.stress - 2);
    }

    const density = this.bucketDensity(agent.x, agent.y);

    // --- feeding ---
    // Every branch assigns, so the initialiser would only ever be dead code.
    const gained =
      traits.dietKind === 'none'
        ? this.photosynthesise(agent, traits, fit, density)
        : traits.dietKind === 'biomass'
          ? this.graze(agent, traits, fit, false)
          : this.hunt(agent, traits, fit);
    agent.energy = finite(agent.energy + gained);

    // --- movement ---
    const travelled = this.moveAgent(agent, traits, fit, behaviour.taxis);

    // --- metabolism ---
    // Crowding also raises the cost of living (competition for space, trampling, disease pressure),
    // which is what gives every species a real carrying capacity below its hard cap.
    const exposure = traits.exposureCost * (1 - fit) * behaviour.exposureScale;
    const competition = density / DENSITY_HALF;
    const drain =
      traits.metabolism * (1 + COMPETITION_DRAIN * competition) +
      exposure +
      traits.moveCost * (travelled / Math.max(0.01, traits.speed));
    agent.energy -= drain;

    // --- reproduction ---
    if (this.canReproduce(agent, traits, fit, behaviour.reproGate)) {
      this.reproduce(agent, traits);
    }

    // --- death ---
    if (agent.energy <= 0) {
      this.killAgent(agent, 'starvation');
    } else if (agent.age >= traits.lifespan) {
      this.killAgent(agent, 'age');
    } else if (agent.stress > EXPOSURE_LETHAL_TICK_LIMIT) {
      this.killAgent(agent, 'exposure');
    }
  }

  /** Photosynthesis analogue: growth scales with fitness and falls off in saturated biomass. */
  private photosynthesise(
    agent: Agent,
    traits: SpeciesTraits,
    fit: number,
    density: number,
  ): number {
    if (fit <= 0) return 0;
    const field = this.biomassFields.get(agent.species);
    const local = field ? field.getAt(agent.x, agent.y) : 0;
    // Carrying capacity curve: growth slows to 50 % in a saturated mat. Measured with
    // `npm run balance`: a harsher floor (0.25) put every dense patch below break-even, so
    // populations could only grow by colonising empty cells and the survey always collapsed.
    const saturation = 1 - clamp01(local / BIOMASS_CELL_LIMIT) * 0.5;
    // Density dependence. A *smooth* hyperbolic response, not a clamped one: with a clamped brake
    // every population pinned to its hard cap and the world froze into a static state (measured
    // with `npm run balance`). Space, not the cap, must be the limiting factor.
    const crowding = 1 / (1 + density / DENSITY_HALF);
    const gain = traits.growthRate * fit * saturation * crowding;
    const room = Math.max(0, traits.maxEnergy - agent.energy);
    const actual = Math.min(gain, room);
    if (field && actual > 0) {
      const deposited = Math.min(actual * traits.depositRatio, BIOMASS_CELL_LIMIT);
      field.addAt(agent.x, agent.y, deposited);
      if (field.getAt(agent.x, agent.y) > BIOMASS_CELL_LIMIT) {
        field.setAt(agent.x, agent.y, BIOMASS_CELL_LIMIT);
      }
    }
    return actual;
  }

  /**
   * Grazing: energy is taken from the prey species' biomass field *and* proportionally drained from
   * the prey individuals standing in the same cell. Local over-grazing therefore really starves
   * individual producers — the mechanic that makes carrying capacity observable.
   */
  private graze(
    agent: Agent,
    traits: SpeciesTraits,
    fit: number,
    browseFallback: boolean,
  ): number {
    if (fit <= 0 || traits.diet.length === 0) return 0;
    const room = Math.max(0, traits.maxEnergy - agent.energy);
    if (room <= 0) return 0;
    const radius = this.harvestRadius(traits);
    const patch = this.selectPatch(agent, traits, radius, browseFallback);
    if (!patch) return 0;
    const { species: bestSpecies, efficiency: bestEfficiency, available: bestAvailable } = patch;
    const field = this.biomassFields.get(bestSpecies);
    if (!field) return 0;
    const demand = traits.intakeRate * bestEfficiency * (0.4 + 0.6 * fit);
    // Holling type II response: intake saturates as food becomes abundant and falls away as the
    // patch is stripped, so grazing pressure tracks the standing crop instead of wiping it out.
    const saturationFactor = bestAvailable / (bestAvailable + INTAKE_HALF_SATURATION);
    const taken = Math.min(demand * saturationFactor, bestAvailable, room / ASSIMILATION);
    if (taken <= 0) return 0;
    this.removeFromPatch(field, agent.x, agent.y, radius, taken, bestAvailable);
    // Tissue damage: grazers only partly hurt the organisms that built the mat (see GRAZE_TISSUE_LOSS).
    if (browseFallback || this.traits.get(bestSpecies)?.dietKind === 'none') {
      this.drainPreyIndividuals(agent, bestSpecies, taken * GRAZE_TISSUE_LOSS, radius);
    }
    this.recordIntake(agent.species, bestSpecies, taken);
    return taken * ASSIMILATION;
  }

  /**
   * Picks the richest reachable food patch for a grazer and returns it with its efficiency.
   *
   * Candidates are, in order of preference:
   *  - the species this animal actually eats (the mat it grazes);
   *  - *producers* it does not eat, for filter feeders (drifting detritus) and for any animal forced
   *    onto the fallback browse path (scavenging). Only producers lay down a standing mat, so
   *    scavenging must target them: an earlier version browsed the empty biomass fields of consumer
   *    species, which gave a predator whose strike missed literally nothing to eat while it stood on
   *    a lush mat (measured with `npm run trace -- ORP-2 GLI-3`).
   */
  private selectPatch(
    agent: Agent,
    traits: SpeciesTraits,
    radius: number,
    browseFallback: boolean,
  ): { species: SpeciesId; efficiency: number; available: number } | null {
    const baseEfficiency = browseFallback ? 0.7 : 1;
    const roleScavenge = SCAVENGE_BY_ROLE[traits.role];
    let best: { species: SpeciesId; efficiency: number; available: number } | null = null;
    for (const id of this.config.roster) {
      const candidateTraits = this.traits.get(id);
      if (!candidateTraits) continue;
      const isDiet = traits.diet.includes(id);
      const canScavenge =
        candidateTraits.dietKind === 'none' &&
        roleScavenge > 0 &&
        (traits.role === 'filter' || browseFallback);
      if (!isDiet && !canScavenge) continue;
      const field = this.biomassFields.get(id);
      if (!field) continue;
      const efficiency = isDiet ? baseEfficiency : baseEfficiency * roleScavenge;
      const available = this.patchBiomass(field, agent.x, agent.y, radius) * efficiency;
      if (available > (best?.available ?? 0)) best = { species: id, efficiency, available };
    }
    return best;
  }

  /** Radius of the grazing patch: bigger for animals with a wider sensory range. */
  private harvestRadius(traits: SpeciesTraits): number {
    return 1.8 + traits.sense * 0.3;
  }

  /** Total biomass of a field inside a circular patch. */
  private patchBiomass(field: ScalarField, x: number, y: number, radius: number): number {
    const r2 = radius * radius;
    const x0 = clamp(Math.floor(x - radius), 0, field.width - 1);
    const x1 = clamp(Math.ceil(x + radius), 0, field.width - 1);
    const y0 = clamp(Math.floor(y - radius), 0, field.height - 1);
    const y1 = clamp(Math.ceil(y + radius), 0, field.height - 1);
    let total = 0;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const dx = cx + 0.5 - x;
        const dy = cy + 0.5 - y;
        if (dx * dx + dy * dy > r2) continue;
        total += field.getAt(cx, cy);
      }
    }
    return total;
  }

  /** Removes `amount` of biomass from a patch, proportionally to each cell's share of it. */
  private removeFromPatch(
    field: ScalarField,
    x: number,
    y: number,
    radius: number,
    amount: number,
    patchTotal: number,
  ): void {
    if (patchTotal <= 0) return;
    const r2 = radius * radius;
    const x0 = clamp(Math.floor(x - radius), 0, field.width - 1);
    const x1 = clamp(Math.ceil(x + radius), 0, field.width - 1);
    const y0 = clamp(Math.floor(y - radius), 0, field.height - 1);
    const y1 = clamp(Math.ceil(y + radius), 0, field.height - 1);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const dx = cx + 0.5 - x;
        const dy = cy + 0.5 - y;
        if (dx * dx + dy * dy > r2) continue;
        const current = field.getAt(cx, cy);
        if (current <= 0) continue;
        field.setAt(cx, cy, Math.max(0, current - (current / patchTotal) * amount));
      }
    }
  }

  /** Distributes a grazing loss over the prey individuals in the cell (the biomass is the sum). */
  private drainPreyIndividuals(
    grazer: Agent,
    preySpecies: SpeciesId,
    energy: number,
    radius: number,
  ): void {
    const victims: Agent[] = [];
    this.collectNearby(grazer.x, grazer.y, radius, victims, preySpecies, grazer);
    if (victims.length === 0) return;
    let totalEnergy = 0;
    for (const victim of victims) totalEnergy += victim.energy;
    if (totalEnergy <= 0) return;
    // Each victim loses a share proportional to how much of the patch's living biomass it is.
    for (const victim of victims) {
      const taken = Math.min(victim.energy, (victim.energy / totalEnergy) * energy);
      victim.energy -= taken;
      if (victim.energy <= 0) this.killAgent(victim, 'grazed');
    }
  }

  /**
   * Predation: hunts the nearest individual of a diet species and drains its energy. Missing prey
   * forces a reduced-rate browse of standing biomass, so a predator population collapses *after*
   * its prey does — a genuinely observable trophic cascade.
   */
  private hunt(agent: Agent, traits: SpeciesTraits, fit: number): number {
    if (fit <= 0 || traits.diet.length === 0) return 0;
    const room = Math.max(0, traits.maxEnergy - agent.energy);
    if (room <= 0) return 0;
    const candidates: Agent[] = [];
    this.collectNearby(agent.x, agent.y, traits.sense, candidates, null, agent, traits.diet);
    let victim: Agent | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const d = Math.hypot(candidate.x - agent.x, candidate.y - agent.y);
      if (d < bestDist) {
        bestDist = d;
        victim = candidate;
      }
    }
    const demand = traits.intakeRate * (0.4 + 0.6 * fit);
    if (!victim) return this.graze(agent, traits, fit, true);
    // A strike can fail: the prey escapes. This is the single most important stabiliser of the
    // predator/prey interaction — without it, predation becomes a pure energy pump that erases the
    // prey population (measured with `npm run trace -- VOX-9 SCU-4`: 34 of 36 grazers killed).
    if (traits.captureChance < 1 && !this.rng.chance(traits.captureChance)) {
      // A failed chase is not a wasted tick: the animal gives up on the hunt and scavenges what it
      // can reach. Without this fallback a predator whose strikes miss a few times in a row loses
      // energy with prey in plain sight (`npm run trace -- VOX-9 GLI-3`).
      return this.graze(agent, traits, fit, true);
    }
    const taken = Math.min(demand, victim.energy, room / PREDATION_ASSIMILATION);
    if (taken <= 0) return 0;
    victim.energy -= taken;
    this.recordIntake(agent.species, victim.species, taken);
    const field = this.biomassFields.get(victim.species);
    if (field) field.addAt(victim.x, victim.y, -Math.min(taken * 0.15, field.getAt(victim.x, victim.y)));
    if (victim.energy <= 0) {
      this.emit({
        tick: this.tick,
        kind: 'kill',
        species: victim.species,
        target: agent.species,
        x: victim.x,
        y: victim.y,
        readings: this.readingsAt(victim.x, victim.y),
      });
      bump(this.counters.kills, `${agent.species}->${victim.species}`);
      this.killAgent(victim, 'predation');
    }
    return taken * PREDATION_ASSIMILATION;
  }

  /** Collects nearby organisms into `out` (avoids allocating a closure per call). */
  private collectNearby(
    x: number,
    y: number,
    radius: number,
    out: Agent[],
    species: SpeciesId | null,
    exclude: Agent,
    allowed?: readonly SpeciesId[],
  ): void {
    const r2 = radius * radius;
    const cx = clamp(Math.floor(x / HASH_CELL_SIZE), 0, this.bucketCols - 1);
    const cy = clamp(Math.floor(y / HASH_CELL_SIZE), 0, this.bucketRows - 1);
    for (let row = Math.max(0, cy - 1); row <= Math.min(this.bucketRows - 1, cy + 1); row++) {
      for (let col = Math.max(0, cx - 1); col <= Math.min(this.bucketCols - 1, cx + 1); col++) {
        const bucket = this.buckets[row * this.bucketCols + col];
        if (!bucket) continue;
        for (const agent of bucket) {
          if (agent === exclude || !agent.alive) continue;
          if (species && agent.species !== species) continue;
          if (allowed && !allowed.includes(agent.species)) continue;
          const dx = agent.x - x;
          const dy = agent.y - y;
          if (dx * dx + dy * dy <= r2) out.push(agent);
        }
      }
    }
  }

  private recordIntake(consumer: SpeciesId, prey: SpeciesId, amount: number): void {
    let row = this.intakeGraph.get(consumer);
    if (!row) {
      row = new Map();
      this.intakeGraph.set(consumer, row);
    }
    row.set(prey, (row.get(prey) ?? 0) + amount);
    bump(this.counters.grazingRemoved, prey, amount);
  }

  /** Movement: taxis toward better fitness when stressed, otherwise a correlated random walk. */
  private moveAgent(
    agent: Agent,
    traits: SpeciesTraits,
    fit: number,
    taxisMultiplier: number,
  ): number {
    const stressed = fit < 0.72;
    // A hungry consumer also forages: without this, grazers standing on an empty cell never reach
    // the food a few cells away and every consumer species dies out within a few hundred ticks
    // (measured with `npm run balance`).
    const hungry =
      traits.dietKind !== 'none' && agent.energy < traits.reproEnergy * 0.95 && fit > 0.15;
    if ((this.tick + agent.id) % MOVE_DECISION_INTERVAL === 0) {
      const dir =
        stressed || hungry ? this.bestDirection(agent, traits, hungry && !stressed) : null;
      if (dir) {
        agent.dx = dir.dx;
        agent.dy = dir.dy;
      } else {
        this.wander(agent, traits);
      }
    }
    const speed = traits.speed * (stressed ? taxisMultiplier : 1);
    const nx = agent.x + agent.dx * speed;
    const ny = agent.y + agent.dy * speed;
    const clampedX = clamp(nx, 0.5, this.config.width - 0.5);
    const clampedY = clamp(ny, 0.5, this.config.height - 0.5);
    if (clampedX !== nx) agent.dx = -agent.dx;
    if (clampedY !== ny) agent.dy = -agent.dy;
    if (this.blockedByBarrier(agent.x, agent.y, clampedX, clampedY)) {
      agent.dx = -agent.dx;
      agent.dy = -agent.dy;
      return 0;
    }
    agent.x = clampedX;
    agent.y = clampedY;
    return speed;
  }

  private wander(agent: Agent, traits: SpeciesTraits): void {
    const turn = this.movementRng.gauss() * traits.wander;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const nx = agent.dx * cos - agent.dy * sin;
    const ny = agent.dx * sin + agent.dy * cos;
    const norm = Math.hypot(nx, ny) || 1;
    agent.dx = nx / norm;
    agent.dy = ny / norm;
  }

  /**
   * Samples the 4 axis neighbours and returns the unit direction of steepest fitness gain. This is a
   * real gradient estimate of the same fitness function the simulation uses, which is what makes
   * "the species migrates toward tolerable terrain" an honest, verifiable law.
   */
  private bestDirection(
    agent: Agent,
    traits: SpeciesTraits,
    foraging = false,
  ): { dx: number; dy: number } | null {
    const probe = Math.max(1, traits.sense * 0.75);
    const score = (x: number, y: number): number => {
      const fit = this.fitnessAtPosition(traits, x, y);
      if (!foraging) return fit;
      // Food and climate are combined into one search signal: food dominates while starving, but a
      // lethal cell never wins on food alone.
      const food = this.foodScoreAt(traits, x, y);
      return fit * 0.55 + food * 0.45 * (fit > 0.2 ? 1 : 0.1);
    };
    let bestScore = score(agent.x, agent.y);
    let bestX = 0;
    let bestY = 0;
    for (let i = 0; i < 4; i++) {
      const offsetX = i === 0 ? probe : i === 1 ? -probe : 0;
      const offsetY = i === 2 ? probe : i === 3 ? -probe : 0;
      const x = clamp(agent.x + offsetX, 0.5, this.config.width - 0.5);
      const y = clamp(agent.y + offsetY, 0.5, this.config.height - 0.5);
      const candidate = score(x, y);
      if (candidate > bestScore + 1e-4) {
        bestScore = candidate;
        bestX = offsetX;
        bestY = offsetY;
      }
    }
    if (bestX === 0 && bestY === 0) return null;
    const norm = Math.hypot(bestX, bestY) || 1;
    return { dx: bestX / norm, dy: bestY / norm };
  }

  /** Normalised food signal in [0, 1] used by foraging consumers. */
  private foodScoreAt(traits: SpeciesTraits, x: number, y: number): number {
    if (traits.dietKind === 'biomass') {
      const radius = this.harvestRadius(traits);
      let total = 0;
      for (const prey of traits.diet) {
        const field = this.biomassFields.get(prey);
        if (field) total += this.patchBiomass(field, x, y, radius);
      }
      if (traits.role === 'filter') {
        for (const id of this.config.roster) {
          if (traits.diet.includes(id)) continue;
          if (this.traits.get(id)?.dietKind !== 'none') continue;
          const field = this.biomassFields.get(id);
          if (field) total += this.patchBiomass(field, x, y, radius) * SCAVENGE_BY_ROLE[traits.role];
        }
      }
      return clamp01(total / 6);
    }
    if (traits.dietKind === 'predation') {
      const prey = this.countNearbySpecies(x, y, traits.sense, traits.diet);
      return clamp01(prey / 1.5);
    }
    return 0;
  }

  /** Counts living organisms of the given species within `radius` (foraging, predator sensing). */
  private countNearbySpecies(x: number, y: number, radius: number, species: readonly SpeciesId[]): number {
    const r2 = radius * radius;
    const cx = clamp(Math.floor(x / HASH_CELL_SIZE), 0, this.bucketCols - 1);
    const cy = clamp(Math.floor(y / HASH_CELL_SIZE), 0, this.bucketRows - 1);
    let n = 0;
    for (let row = Math.max(0, cy - 1); row <= Math.min(this.bucketRows - 1, cy + 1); row++) {
      for (let col = Math.max(0, cx - 1); col <= Math.min(this.bucketCols - 1, cy + 1); col++) {
        const bucket = this.buckets[row * this.bucketCols + col];
        if (!bucket) continue;
        for (const agent of bucket) {
          if (!species.includes(agent.species)) continue;
          const dx = agent.x - x;
          const dy = agent.y - y;
          if (dx * dx + dy * dy <= r2) n++;
        }
      }
    }
    return n;
  }

  private canReproduce(
    agent: Agent,
    traits: SpeciesTraits,
    fit: number,
    reproGate: number,
  ): boolean {
    if (agent.cooldown > 0) return false;
    if (agent.age < traits.maturity) return false;
    if (agent.energy < traits.reproEnergy) return false;
    if (fit < reproGate) return false;
    if (traits.dietKind !== 'none') {
      const gate = traits.dietKind === 'predation' ? PREDATOR_BREEDING_FOOD_GATE : BREEDING_FOOD_GATE;
      if (this.foodScoreAt(traits, agent.x, agent.y) < gate) return false;
    }
    const cap = this.config.populationCaps[agent.species] ?? Number.POSITIVE_INFINITY;
    return this.count(agent.species) < cap;
  }

  private reproduce(agent: Agent, traits: SpeciesTraits): void {
    const rng = this.rng.fork('birth', agent.id + agent.generation * 7919 + this.tick % 97);
    const x = clamp(agent.x + rng.around(1.6), 0.5, this.config.width - 0.5);
    const y = clamp(agent.y + rng.around(1.6), 0.5, this.config.height - 0.5);
    if (this.nearbyCount(x, y, 2) > LOCAL_BREEDING_LIMIT) {
      agent.cooldown = Math.floor(traits.reproCooldown * 0.35);
      return;
    }
    const paid = Math.min(agent.energy * 0.5, traits.reproCost);
    agent.energy -= paid;
    agent.cooldown = traits.reproCooldown;
    const childEnergy = Math.max(1, paid * (1 + rng.gauss() * traits.variance));
    this.spawn(agent.species, x, y, childEnergy, agent.generation + 1, rng);
    const snapshot = this.readingsAt(agent.x, agent.y);
    const moments = this.birthMoments.get(agent.species);
    if (moments) addReading(moments, snapshot);
    this.emit({
      tick: this.tick,
      kind: 'birth',
      species: agent.species,
      x,
      y,
      readings: snapshot,
      message: `${agent.species} reproduced`,
    });
  }

  private spawn(
    species: SpeciesId,
    x: number,
    y: number,
    energy: number,
    generation: number,
    rng: Rng,
  ): Agent {
    const angle = rng.range(0, Math.PI * 2);
    const reused = this.pool.pop();
    const agent: Agent = reused ?? {
      id: 0,
      species,
      x: 0,
      y: 0,
      dx: 0,
      dy: 0,
      energy: 0,
      age: 0,
      cooldown: 0,
      stress: 0,
      generation: 0,
      alive: true,
    };
    agent.id = this.nextAgentId++;
    agent.species = species;
    agent.x = x;
    agent.y = y;
    agent.dx = Math.cos(angle);
    agent.dy = Math.sin(angle);
    agent.energy = finite(energy);
    agent.age = 0;
    agent.cooldown = 0;
    agent.stress = 0;
    agent.generation = generation;
    agent.alive = true;
    this.agents.push(agent);
    this.populationCounts.set(species, (this.populationCounts.get(species) ?? 0) + 1);
    return agent;
  }

  /**
   * Removes an organism and records *why* it died. The cause is evidence: it is what lets the player
   * separate "it starved because its food was gone" from "it froze".
   */
  private killAgent(agent: Agent, cause: DeathCause): void {
    if (!agent.alive) return;
    agent.alive = false;
    const field = this.biomassFields.get(agent.species);
    if (field && agent.energy > 0) {
      field.addAt(agent.x, agent.y, agent.energy * DECOMPOSE_RATIO);
    }
    this.populationCounts.set(agent.species, Math.max(0, this.count(agent.species) - 1));
    this.emit({
      tick: this.tick,
      kind: 'death',
      species: agent.species,
      x: agent.x,
      y: agent.y,
      cause,
      readings: this.readingsAt(agent.x, agent.y),
    });
  }

  private compact(): void {
    let write = 0;
    const list = this.agents;
    for (let i = 0; i < list.length; i++) {
      const agent = list[i] as Agent;
      if (agent.alive) {
        list[write++] = agent;
      } else {
        this.pool.push(agent);
      }
    }
    list.length = write;
    this.recount();
  }

  /** Rebuilds the per-species population counters from the living set (self-healing invariant). */
  private recount(): void {
    for (const id of this.config.roster) this.populationCounts.set(id, 0);
    const list = this.agents;
    for (let i = 0; i < list.length; i++) {
      const agent = list[i] as Agent;
      const current = this.populationCounts.get(agent.species) ?? 0;
      this.populationCounts.set(agent.species, current + 1);
    }
  }

  private detectExtinctions(): void {
    for (const species of this.config.roster) {
      const alive = this.count(species);
      const index = this.extinctions.indexOf(species);
      if (alive === 0 && index < 0) {
        this.extinctions.push(species);
        this.emit({
          tick: this.tick,
          kind: 'extinction',
          species,
          x: this.config.width / 2,
          y: this.config.height / 2,
          message: `${species} has no surviving individuals`,
        });
      } else if (alive > 0 && index >= 0) {
        this.extinctions.splice(index, 1);
      }
    }
  }

  // ---------------------------------------------------------------- player-facing mutations

  /** Applies a radial field perturbation (thermal/cryo/humidity/light instruments). */
  pulseField(field: FieldId, x: number, y: number, radius: number, amount: number): void {
    this.fields[field].addRadial(x, y, radius, amount);
    this.emit({
      tick: this.tick,
      kind: 'instrument',
      x,
      y,
      amount,
      message: `${field} ${amount > 0 ? '+' : ''}${amount.toFixed(1)} pulse`,
    });
  }

  /** Injects assimilable biomass for a producer species (nutrient bloom instrument). */
  nutrientBloom(species: SpeciesId, x: number, y: number, radius: number, amount: number): number {
    this.getSpecies(species); // throws on an unknown id rather than silently doing nothing
    if (!(amount > 0) || !Number.isFinite(amount) || !(radius > 0)) {
      throw new InvariantError(
        `nutrientBloom needs a positive amount and radius (got amount=${amount}, radius=${radius})`,
        { species, amount, radius },
      );
    }
    const field = this.biomassFields.get(species);
    if (!field) return 0;
    const before = this.speciesBiomassInRadius(species, x, y, radius);
    field.addRadial(x, y, radius, amount);
    for (let i = 0; i < field.data.length; i++) {
      field.data[i] = Math.min(BIOMASS_CELL_LIMIT, field.data[i] as number);
    }
    // Report what this instrument actually deposited (cells are capped, so the deposit can be less
    // than requested). The previous version returned the *total* biomass standing in the radius
    // across every species, which described the neighbourhood rather than the action.
    const added = this.speciesBiomassInRadius(species, x, y, radius) - before;
    this.emit({
      tick: this.tick,
      kind: 'instrument',
      species,
      x,
      y,
      amount: added,
      message: `nutrient bloom for ${species}`,
    });
    return added;
  }

  /** Removes organisms inside a radius; the destructive instrument. */
  cull(x: number, y: number, radius: number, species?: SpeciesId): CullResult {
    if (species !== undefined && !this.traits.has(species)) {
      this.getSpecies(species);
    }
    if (!(radius >= 0) || !Number.isFinite(radius)) {
      throw new InvariantError(`cull needs a finite, non-negative radius (got ${radius})`, { radius });
    }
    const perSpecies: Record<SpeciesId, number> = {};
    let removed = 0;
    const r2 = radius * radius;
    for (const agent of this.agents) {
      if (!agent.alive) continue;
      if (species && agent.species !== species) continue;
      const dx = agent.x - x;
      const dy = agent.y - y;
      if (dx * dx + dy * dy > r2) continue;
      this.killAgent(agent, 'culled');
      perSpecies[agent.species] = (perSpecies[agent.species] ?? 0) + 1;
      removed++;
    }
    this.compact();
    if (removed > 0) {
      this.emit({
        tick: this.tick,
        kind: 'cull',
        species,
        x,
        y,
        amount: removed,
        message: `cull wave removed ${removed} organism${removed === 1 ? '' : 's'}`,
      });
      this.detectExtinctions();
    }
    return { removed, perSpecies };
  }

  /** Places new individuals of a species (hatchery instrument / invasion event). */
  introduce(species: SpeciesId, count: number, x: number, y: number): number {
    const traits = this.getSpecies(species); // throws on an unknown id instead of returning 0
    if (!Number.isInteger(count) || count < 1) {
      throw new InvariantError(`introduce needs a positive whole count (got ${count})`, {
        species,
        count,
      });
    }
    const rng = this.rng.fork('introduce', this.tick + this.nextAgentId);
    const cap = this.config.populationCaps[species] ?? Number.POSITIVE_INFINITY;
    let placed = 0;
    for (let i = 0; i < count; i++) {
      if (this.count(species) >= cap) break;
      const px = clamp(x + rng.around(2.2), 0.5, this.config.width - 0.5);
      const py = clamp(y + rng.around(2.2), 0.5, this.config.height - 0.5);
      this.spawn(species, px, py, traits.startEnergy * rng.range(0.8, 1), 0, rng);
      placed++;
    }
    if (placed > 0) {
      const index = this.extinctions.indexOf(species);
      if (index >= 0) this.extinctions.splice(index, 1);
      this.emit({
        tick: this.tick,
        kind: 'introduction',
        species,
        x,
        y,
        amount: placed,
        message: `${placed} × ${species} introduced`,
      });
    }
    return placed;
  }

  addBarrier(x1: number, y1: number, x2: number, y2: number): Barrier {
    const barrier: Barrier = { id: this.nextBarrierId++, x1, y1, x2, y2 };
    this.barriers.push(barrier);
    this.emit({
      tick: this.tick,
      kind: 'instrument',
      x: (x1 + x2) / 2,
      y: (y1 + y2) / 2,
      message: 'containment barrier deployed',
    });
    return barrier;
  }

  removeLastBarrier(): Barrier | null {
    const removed = this.barriers.pop() ?? null;
    if (removed) {
      this.emit({
        tick: this.tick,
        kind: 'instrument',
        x: (removed.x1 + removed.x2) / 2,
        y: (removed.y1 + removed.y2) / 2,
        message: 'containment barrier dismantled',
      });
    }
    return removed;
  }

  private blockedByBarrier(fromX: number, fromY: number, toX: number, toY: number): boolean {
    if (this.barriers.length === 0) return false;
    for (const barrier of this.barriers) {
      if (
        segmentsIntersect(fromX, fromY, toX, toY, barrier.x1, barrier.y1, barrier.x2, barrier.y2)
      ) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- probes & metrics

  addProbe(x: number, y: number, radius = 5): ProbeState {
    const probe = createProbe(this.nextProbeId++, x, y, radius);
    this.probes.push(probe);
    this.emit({
      tick: this.tick,
      kind: 'instrument',
      x,
      y,
      message: `probe #${probe.id} deployed`,
    });
    this.sampleProbe(probe);
    return probe;
  }

  removeProbe(id: number): boolean {
    const index = this.probes.findIndex((p) => p.id === id);
    if (index < 0) return false;
    this.probes.splice(index, 1);
    return true;
  }

  private sampleProbes(): void {
    for (const probe of this.probes) this.sampleProbe(probe);
  }

  private sampleProbe(probe: ProbeState): void {
    recordProbeSample(probe, {
      tick: this.tick,
      temperature: this.fields.temperature.sampleBilinear(probe.x, probe.y),
      humidity: this.fields.humidity.sampleBilinear(probe.x, probe.y),
      light: this.fields.light.sampleBilinear(probe.x, probe.y),
      counts: this.censusAround(probe.x, probe.y, probe.radius),
      biomass: this.biomassInRadius(probe.x, probe.y, probe.radius),
    });
  }

  private sampleHistory(): void {
    const counts = this.counts();
    const biomass = this.biomassReport();
    let total = 0;
    for (const id of this.config.roster) total += biomass[id] ?? 0;
    this.history.push({ tick: this.tick, counts, biomass, totalBiomass: total });
    if (this.history.length > this.historyCapacity) this.history.shift();
  }

  historySeries(): readonly PopulationSample[] {
    return this.history;
  }

  /** Live stability readout (see metrics.stabilityIndex for the exact definition). */
  stability(): number {
    return stabilityIndex(this.history, this.config.roster.length);
  }

  fieldStats(): Record<FieldId, FieldStats> {
    return {
      temperature: this.fields.temperature.stats(),
      humidity: this.fields.humidity.stats(),
      light: this.fields.light.stats(),
    };
  }

  /** Mean value of each field across the whole sector (the baseline a player compares against). */
  fieldMeans(): Record<FieldId, number> {
    const stats = this.fieldStats();
    return {
      temperature: stats.temperature.mean,
      humidity: stats.humidity.mean,
      light: stats.light.mean,
    };
  }

  fieldSds(): Record<FieldId, number> {
    const out: Record<FieldId, number> = { temperature: 0, humidity: 0, light: 0 };
    for (const id of FIELD_IDS) {
      const field = this.fields[id];
      const mean = field.stats().mean;
      let acc = 0;
      const d = field.data;
      for (let i = 0; i < d.length; i++) {
        const diff = (d[i] as number) - mean;
        acc += diff * diff;
      }
      out[id] = Math.sqrt(acc / Math.max(1, d.length));
    }
    return out;
  }

  /** Species that currently have zero living individuals. */
  extinctSpecies(): readonly SpeciesId[] {
    return this.extinctions.slice();
  }

  /** Share of each prey species in a consumer's measured energy intake (empty if it never ate). */
  intakeShares(consumer: SpeciesId): Map<SpeciesId, number> {
    const row = this.intakeGraph.get(consumer);
    const out = new Map<SpeciesId, number>();
    if (!row) return out;
    let total = 0;
    for (const value of row.values()) total += value;
    if (total <= 0) return out;
    for (const [prey, value] of row) out.set(prey, safeDiv(value, total));
    return out;
  }

  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      counts: this.counts(),
      biomass: this.biomassReport(),
      totalBiomass: this.totalBiomass(),
      fieldStats: this.fieldStats(),
      agents: this.agents,
      probes: this.probes,
      history: this.history,
      stability: this.stability(),
      barriers: this.barriers,
      fields: this.fields,
      biomassFields: this.biomassFields,
      extinctions: this.extinctions,
    };
  }

  private emit(event: Omit<WorldEvent, 'id'>): void {
    const stored = this.events.push(event);
    countEvent(this.counters, stored);
  }
}

/** Segment intersection (standard orientation test) used by containment barriers. */
function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}
