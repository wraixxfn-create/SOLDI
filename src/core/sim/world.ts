import { ScalarField, FIELD_IDS, type FieldId, type FieldStats } from '../field.ts';
import { Rng } from '../rng.ts';
import { clamp, clamp01, safeDiv, finite } from '../math.ts';
import { ContentError, InvariantError, invariant } from '../errors.ts';
import {
  STRESS_BEHAVIOUR,
  fitnessAt,
  type SpeciesDefinition,
  type SpeciesId,
  type SpeciesTraits,
  type TrophicRole,
} from './species.ts';
import {
  RESOURCE_LIMITS,
  advanceResourceFields,
  buildResourceFields,
  shiftResource,
  type ResourceFields,
} from './resources.ts';
import {
  RuleEngine,
  parseRuleSet,
  type EcosystemRule,
  type RuleEffect,
  type RuleObservation,
} from './rules.ts';
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
  FIELD_LIMITS,
  advanceFields,
  applyScheduledPulses,
  assertValidWorldConfig,
  buildFields,
  type WorldConfig,
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
 * ## Tick order (see docs/DESIGN.md §3)
 * Environment → resource availability → metabolism → interactions → reproduction → mortality →
 * state update. Stable ids arbitrate shared food; movement is planned from one shared position
 * snapshot, and births are queued until the final phase.
 *
 * ## Scratch buffers
 * `fitnessAtPosition` reuses `scratchReadings` for speed. Any *stored* reading (event snapshots) is
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
  readonly config: WorldConfig;
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
  readonly resources: Readonly<ResourceFields>;
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

/** Canonical causal order for one discrete simulation turn. */
export const WORLD_TICK_PHASES = Object.freeze([
  'environment',
  'resource-availability',
  'metabolism',
  'interactions',
  'reproduction',
  'mortality',
  'state-update',
] as const);

interface AgentTurnState {
  readonly agent: Agent;
  readonly traits: SpeciesTraits;
  readonly fitness: number;
  readonly density: number;
  readonly behaviour: (typeof STRESS_BEHAVIOUR)[keyof typeof STRESS_BEHAVIOUR];
}

interface AgentMovementPlan {
  readonly agent: Agent;
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly travelled: number;
}

interface PendingBirth {
  readonly parentId: number;
  readonly species: SpeciesId;
  readonly x: number;
  readonly y: number;
  readonly parentX: number;
  readonly parentY: number;
  readonly energy: number;
  readonly generation: number;
  readonly rng: Rng;
}

interface SpeciesRuleModifier {
  metabolism: number;
  growth: number;
  reproduction: number;
}

const BASE_RULE_MODIFIER: Readonly<SpeciesRuleModifier> = Object.freeze({
  metabolism: 1,
  growth: 1,
  reproduction: 1,
});

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
  readonly config: WorldConfig;
  readonly seed: number;
  readonly fields: Record<FieldId, ScalarField>;
  readonly resources: ResourceFields;
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
  private readonly ruleEngine: RuleEngine;
  private readonly ruleModifiers = new Map<SpeciesId, SpeciesRuleModifier>();
  private readonly pendingDeaths = new Map<number, DeathCause>();
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
    if (!Number.isInteger(options.seed)) {
      throw new ContentError(`World ${config.id} needs an explicit integer seed`, { seed: options.seed });
    }

    const traitMap = new Map<SpeciesId, SpeciesTraits>();
    for (const definition of options.species) {
      if (traitMap.has(definition.id)) {
        throw new ContentError(`Duplicate species definition "${definition.id}"`, { species: definition.id });
      }
      if (definition.id !== definition.traits.code) {
        throw new ContentError(`Species id/code mismatch for "${definition.id}"`, {
          id: definition.id,
          code: definition.traits.code,
        });
      }
      traitMap.set(definition.id, snapshotSpeciesTraits(definition.traits));
    }
    assertValidWorldConfig(config, new Map(options.species.map((definition) => [definition.id, definition])));
    const parsedRules = parseRuleSet(config.rules, {
      width: config.width,
      height: config.height,
      species: config.roster,
    });
    this.ruleEngine = new RuleEngine(parsedRules.rules);

    this.config = snapshotWorldConfig(config, parsedRules.rules);
    this.seed = options.seed >>> 0;
    this.rng = new Rng(this.seed).fork('world');
    this.movementRng = new Rng(this.seed).fork('movement');
    this.diffusion = options.diffusion ?? DEFAULT_DIFFUSION;
    this.relaxation = options.relaxation ?? DEFAULT_RELAXATION;
    this.events = new EventLog(options.eventCapacity ?? 4000);
    this.historyCapacity = options.populationHistoryCapacity ?? 600;
    this.traits = traitMap;

    this.fields = buildFields(this.config) as Record<FieldId, ScalarField>;
    this.resources = buildResourceFields(this.config.width, this.config.height, this.config.resources);
    for (const id of this.config.roster) {
      invariant(traitMap.has(id), `World ${this.config.id} rosters unknown species ${id}`);
      this.biomassFields.set(id, new ScalarField(this.config.width, this.config.height, 0));
      this.birthMoments.set(id, createMoments());
      this.populationCounts.set(id, 0);
      this.intakeGraph.set(id, new Map());
      this.ruleModifiers.set(id, { metabolism: 1, growth: 1, reproduction: 1 });
    }

    this.bucketCols = Math.ceil(this.config.width / HASH_CELL_SIZE);
    this.bucketRows = Math.ceil(this.config.height / HASH_CELL_SIZE);
    for (let i = 0; i < this.bucketCols * this.bucketRows; i++) this.buckets.push([]);

    this.seedInitialPopulation();
    this.recount();
    this.sampleHistory();
  }

  // ---------------------------------------------------------------- construction / setup

  private seedInitialPopulation(): void {
    for (const species of [...this.config.roster].sort(compareIds)) {
      const spawnRng = this.rng.fork(`initial-${species}`);
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
    for (const id of [...this.config.roster].sort(compareIds)) out[id] = this.populationCounts.get(id) ?? 0;
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
    for (const id of [...this.config.roster].sort(compareIds)) out[id] = this.speciesBiomass(id);
    return out;
  }

  totalBiomass(): number {
    let sum = 0;
    for (const id of [...this.config.roster].sort(compareIds)) sum += this.speciesBiomass(id);
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
    for (const id of [...this.config.roster].sort(compareIds)) {
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
      if (d2 < bestDist || (d2 === bestDist && agent.id < (best?.id ?? Number.POSITIVE_INFINITY))) {
        bestDist = d2;
        best = agent;
      }
    }
    return best;
  }

  /** Organisms within `radius` of a point, grouped by species (probe sampling, area surveys). */
  censusAround(x: number, y: number, radius: number): Record<SpeciesId, number> {
    const out: Record<SpeciesId, number> = {};
    for (const id of [...this.config.roster].sort(compareIds)) out[id] = 0;
    const r2 = radius * radius;
    for (const agent of this.agents) {
      const dx = agent.x - x;
      const dy = agent.y - y;
      if (dx * dx + dy * dy <= r2) out[agent.species] = (out[agent.species] ?? 0) + 1;
    }
    return out;
  }

  // ---------------------------------------------------------------- tick loop

  /**
   * Advances one fixed discrete turn. Each phase reads the phase-start cohort in stable id order.
   * Births are queued until state update, and deaths are resolved after reproduction, so a newly
   * created organism never receives an accidental extra update because it was appended to an array.
   */
  step(): void {
    this.tick++;
    this.pendingDeaths.clear();
    const cohort = this.agents.filter((agent) => agent.alive).sort(compareAgents);

    this.environmentPhase();
    this.resourceAvailabilityPhase();
    this.rebuildBuckets(cohort);
    const turnStates = this.metabolismPhase(cohort);
    this.interactionsPhase(turnStates);
    const births = this.reproductionPhase(turnStates);
    this.mortalityPhase(cohort);
    this.stateUpdatePhase(births);
  }

  /** Runs `ticks` simulation steps (the caller budgets them per frame). */
  run(ticks: number): void {
    const n = Math.max(0, Math.floor(ticks));
    for (let i = 0; i < n; i++) this.step();
  }

  /** Phase 1: environmental pulses, terrain persistence, diffusion and declarative rules. */
  private environmentPhase(): void {
    this.applyPulses();
    advanceFields(this.fields, this.config, this.diffusion, this.relaxation);
    this.applyConfiguredRules();
  }

  /** Phase 2: replenish/diffuse water and minerals, then update standing organic biomass. */
  private resourceAvailabilityPhase(): void {
    advanceResourceFields(this.resources, this.config.resources, this.fields.humidity);
    this.decayBiomass();
  }

  /** Phase 3: age/stress and the baseline metabolic drain are computed before interactions. */
  private metabolismPhase(cohort: readonly Agent[]): AgentTurnState[] {
    const turnStates: AgentTurnState[] = [];
    for (const agent of cohort) {
      if (!agent.alive) continue;
      const traits = this.traits.get(agent.species);
      if (!traits) {
        this.pendingDeaths.set(agent.id, 'exposure');
        continue;
      }
      const fit = this.fitnessAtPosition(traits, agent.x, agent.y);
      agent.age++;
      if (agent.cooldown > 0) agent.cooldown--;

      const behaviour = STRESS_BEHAVIOUR[traits.stressResponse];
      if (fit < traits.tolerance.temperature.fragile) {
        agent.stress++;
      } else {
        agent.stress = Math.max(0, agent.stress - 2);
      }

      const density = this.bucketDensity(agent.x, agent.y);
      const competition = density / DENSITY_HALF;
      const modifier = this.modifierFor(agent.species);
      const exposure = traits.exposureCost * (1 - fit) * behaviour.exposureScale;
      const metabolic = traits.metabolism * (1 + COMPETITION_DRAIN * competition) * modifier.metabolism;
      agent.energy = finite(agent.energy - metabolic - exposure);
      turnStates.push({ agent, traits, fitness: fit, density, behaviour });
    }
    return turnStates;
  }

  /** Phase 4: food-web transfers and symbiosis resolve on the stable start-of-turn positions. */
  private interactionsPhase(turnStates: readonly AgentTurnState[]): void {
    for (const state of turnStates) {
      const { agent, traits, fitness, density } = state;
      if (!agent.alive || this.pendingDeaths.has(agent.id)) continue;
      const gained = traits.dietKind === 'none'
        ? this.photosynthesise(agent, traits, fitness, density, this.modifierFor(agent.species).growth)
        : traits.dietKind === 'biomass'
          ? this.graze(agent, traits, fitness, false)
          : this.hunt(agent, traits, fitness);
      agent.energy = finite(agent.energy + gained);
    }

    this.applySymbiosis(turnStates);

    // Plan all moves against the same interaction snapshot; apply positions only after every agent
    // has chosen. A predator's result therefore cannot depend on whether its prey was iterated first.
    const movementPlans: AgentMovementPlan[] = [];
    for (const state of turnStates) {
      const { agent, traits, fitness, behaviour } = state;
      if (!agent.alive || this.pendingDeaths.has(agent.id)) continue;
      movementPlans.push(this.planMovement(agent, traits, fitness, behaviour.taxis));
    }
    for (const plan of movementPlans) {
      plan.agent.x = plan.x;
      plan.agent.y = plan.y;
      plan.agent.dx = plan.dx;
      plan.agent.dy = plan.dy;
      const traits = this.traits.get(plan.agent.species);
      if (traits) {
        plan.agent.energy = finite(
          plan.agent.energy - traits.moveCost * (plan.travelled / Math.max(0.01, traits.speed)),
        );
      }
    }
    this.rebuildBuckets(turnStates.map((state) => state.agent));
  }

  /** Phase 5: collect eligible parents and reserve cap slots; actual offspring appear in state update. */
  private reproductionPhase(turnStates: readonly AgentTurnState[]): PendingBirth[] {
    const births: PendingBirth[] = [];
    const reserved = new Map<SpeciesId, number>();
    for (const state of turnStates) {
      const { agent, traits, fitness, behaviour } = state;
      if (!agent.alive || this.pendingDeaths.has(agent.id)) continue;
      if (!this.canReproduce(agent, traits, fitness, behaviour.reproGate, reserved)) continue;
      const birth = this.reproduce(agent, traits, this.modifierFor(agent.species).reproduction);
      if (!birth) continue;
      births.push(birth);
      reserved.set(birth.species, (reserved.get(birth.species) ?? 0) + 1);
      const snapshot = this.readingsAt(birth.parentX, birth.parentY);
      const moments = this.birthMoments.get(birth.species);
      if (moments) addReading(moments, snapshot);
      this.emit({
        tick: this.tick,
        kind: 'birth',
        species: birth.species,
        x: birth.x,
        y: birth.y,
        readings: snapshot,
        message: `${birth.species} reproduced`,
      });
    }
    return births;
  }

  /** Phase 6: apply deferred interaction deaths, then starvation, age and exposure mortality. */
  private mortalityPhase(cohort: readonly Agent[]): void {
    for (const agent of cohort) {
      if (!agent.alive) continue;
      const interactionCause = this.pendingDeaths.get(agent.id);
      if (interactionCause) {
        this.killAgent(agent, interactionCause);
      } else if (agent.energy <= 0) {
        this.killAgent(agent, 'starvation');
      } else if (agent.age >= (this.traits.get(agent.species)?.lifespan ?? 0)) {
        this.killAgent(agent, 'age');
      } else if (agent.stress > EXPOSURE_LETHAL_TICK_LIMIT) {
        this.killAgent(agent, 'exposure');
      }
    }
  }

  /** Phase 7: compact, materialize queued births, and update extinctions and public samples. */
  private stateUpdatePhase(births: readonly PendingBirth[]): void {
    this.compact();
    for (const birth of births) {
      const cap = this.config.populationCaps[birth.species] ?? Number.POSITIVE_INFINITY;
      if (this.count(birth.species) >= cap) continue;
      this.spawn(birth.species, birth.x, birth.y, birth.energy, birth.generation, birth.rng);
    }
    this.pendingDeaths.clear();
    this.detectExtinctions();
    if (this.tick % SAMPLE_INTERVAL === 0) this.sampleHistory();
    if (this.tick % PROBE_INTERVAL === 0) this.sampleProbes();
  }

  /** Applies rules against one immutable observation captured after environment evolution. */
  private applyConfiguredRules(): void {
    for (const id of this.config.roster) {
      this.ruleModifiers.set(id, { metabolism: 1, growth: 1, reproduction: 1 });
    }
    const observation: RuleObservation = {
      tick: this.tick,
      fieldMeans: this.fieldMeans(),
      resourceMeans: {
        water: this.resources.water.stats().mean,
        nutrients: this.resources.nutrients.stats().mean,
      },
      populations: this.counts(),
      biomass: this.biomassReport(),
    };
    for (const activation of this.ruleEngine.evaluate(observation)) {
      this.applyRuleEffect(activation.effect);
    }
  }

  private applyRuleEffect(effect: RuleEffect): void {
    switch (effect.type) {
      case 'field-shift': {
        this.fields[effect.field].addRadial(effect.x, effect.y, effect.radius, effect.amount);
        const limits = FIELD_LIMITS[effect.field];
        this.fields[effect.field].clampTo(limits.min, limits.max);
        return;
      }
      case 'resource-shift':
        shiftResource(this.resources, effect.resource, effect.x, effect.y, effect.radius, effect.amount);
        return;
      case 'metabolism-scale':
        this.scaleRuleModifier(effect.species, 'metabolism', effect.factor);
        return;
      case 'growth-scale':
        this.scaleRuleModifier(effect.species, 'growth', effect.factor);
        return;
      case 'reproduction-scale':
        this.scaleRuleModifier(effect.species, 'reproduction', effect.factor);
        return;
    }
  }

  private scaleRuleModifier(species: SpeciesId, key: keyof SpeciesRuleModifier, factor: number): void {
    const current = this.ruleModifiers.get(species);
    if (!current) return;
    current[key] = clamp(current[key] * factor, 0.1, 4);
  }

  private modifierFor(species: SpeciesId): Readonly<SpeciesRuleModifier> {
    return this.ruleModifiers.get(species) ?? BASE_RULE_MODIFIER;
  }

  /**
   * Symbiosis is data-driven and pairwise. Each configured symbiont shares an energy benefit with
   * each nearby partner; both bonuses are capped by the recipient's configured energy capacity.
   */
  private applySymbiosis(turnStates: readonly AgentTurnState[]): void {
    const partners: Agent[] = [];
    for (const state of turnStates) {
      const { agent, traits } = state;
      const bond = traits.symbiosis;
      if (!bond || !agent.alive || this.pendingDeaths.has(agent.id)) continue;
      partners.length = 0;
      this.collectNearby(agent.x, agent.y, bond.radius, partners, bond.partner, agent);
      if (partners.length === 0) continue;
      const selfRoom = Math.max(0, traits.maxEnergy - agent.energy);
      agent.energy = finite(agent.energy + Math.min(selfRoom, bond.selfEnergyBonus * partners.length));
      for (const partner of partners) {
        const partnerTraits = this.traits.get(partner.species);
        if (!partnerTraits || this.pendingDeaths.has(partner.id)) continue;
        const partnerRoom = Math.max(0, partnerTraits.maxEnergy - partner.energy);
        partner.energy = finite(partner.energy + Math.min(partnerRoom, bond.partnerEnergyBonus));
      }
    }
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

  private rebuildBuckets(agents: readonly Agent[] = this.agents): void {
    for (const bucket of this.buckets) bucket.length = 0;
    const stableAgents = [...agents].sort(compareAgents);
    for (const agent of stableAgents) {
      if (!agent.alive || this.pendingDeaths.has(agent.id)) continue;
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

  /** Photosynthesis analogue: growth scales with fitness and falls off in saturated biomass. */
  private photosynthesise(
    agent: Agent,
    traits: SpeciesTraits,
    fit: number,
    density: number,
    growthMultiplier: number,
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
    const potential = traits.growthRate * fit * saturation * crowding * growthMultiplier;
    const room = Math.max(0, traits.maxEnergy - agent.energy);
    const needs = traits.resourceNeeds;
    const water = this.resources.water.getAt(agent.x, agent.y);
    const nutrients = this.resources.nutrients.getAt(agent.x, agent.y);
    const byWater = needs.waterPerEnergy > 0 ? water / needs.waterPerEnergy : potential;
    const byNutrients = needs.nutrientsPerEnergy > 0 ? nutrients / needs.nutrientsPerEnergy : potential;
    const actual = Math.min(potential, room, byWater, byNutrients);
    if (actual > 0) {
      if (needs.waterPerEnergy > 0) {
        this.resources.water.setAt(
          agent.x,
          agent.y,
          clamp(water - actual * needs.waterPerEnergy, RESOURCE_LIMITS.water.min, RESOURCE_LIMITS.water.max),
        );
      }
      if (needs.nutrientsPerEnergy > 0) {
        this.resources.nutrients.setAt(
          agent.x,
          agent.y,
          clamp(nutrients - actual * needs.nutrientsPerEnergy, RESOURCE_LIMITS.nutrients.min, RESOURCE_LIMITS.nutrients.max),
        );
      }
      if (field) {
        const deposited = Math.min(actual * traits.depositRatio, BIOMASS_CELL_LIMIT);
        field.addAt(agent.x, agent.y, deposited);
        if (field.getAt(agent.x, agent.y) > BIOMASS_CELL_LIMIT) {
          field.setAt(agent.x, agent.y, BIOMASS_CELL_LIMIT);
        }
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
    // Tissue damage: ordinary grazers partly hurt the organisms that built the mat. A decomposer
    // processes organic stock without attacking living producer agents directly.
    if (
      traits.strategy !== 'decomposer' &&
      (browseFallback || this.traits.get(bestSpecies)?.dietKind === 'none')
    ) {
      this.drainPreyIndividuals(agent, bestSpecies, taken * GRAZE_TISSUE_LOSS, radius);
    }
    if (traits.strategy === 'decomposer') {
      const nutrients = this.resources.nutrients.getAt(agent.x, agent.y);
      this.resources.nutrients.setAt(
        agent.x,
        agent.y,
        clamp(
          nutrients + taken * traits.decompositionYield,
          RESOURCE_LIMITS.nutrients.min,
          RESOURCE_LIMITS.nutrients.max,
        ),
      );
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
    for (const id of [...this.config.roster].sort(compareIds)) {
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
      if (victim.energy <= 0) this.pendingDeaths.set(victim.id, 'grazed');
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
      if (d < bestDist || (d === bestDist && candidate.id < (victim?.id ?? Number.POSITIVE_INFINITY))) {
        bestDist = d;
        victim = candidate;
      }
    }
    const demand = traits.intakeRate * (0.4 + 0.6 * fit);
    if (!victim) return this.graze(agent, traits, fit, true);
    // A strike can fail: the prey escapes. This is the single most important stabiliser of the
    // predator/prey interaction — without it, predation becomes a pure energy pump that erases the
    // prey population (measured with `npm run trace -- VOX-9 SCU-4`: 34 of 36 grazers killed).
    const huntRng = this.rng.fork('hunt', agent.id).fork('tick', this.tick);
    if (traits.captureChance < 1 && !huntRng.chance(traits.captureChance)) {
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
      this.pendingDeaths.set(victim.id, 'predation');
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
          if (agent === exclude || !agent.alive || this.pendingDeaths.has(agent.id)) continue;
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

  /** Plans movement without mutating shared positions; plans are committed as a separate pass. */
  private planMovement(
    agent: Agent,
    traits: SpeciesTraits,
    fit: number,
    taxisMultiplier: number,
  ): AgentMovementPlan {
    const stressed = fit < 0.72;
    const hungry =
      traits.dietKind !== 'none' && agent.energy < traits.reproEnergy * 0.95 && fit > 0.15;
    let dx = agent.dx;
    let dy = agent.dy;
    if ((this.tick + agent.id) % MOVE_DECISION_INTERVAL === 0) {
      const direction = stressed || hungry ? this.bestDirection(agent, traits, hungry && !stressed) : null;
      if (direction) {
        dx = direction.dx;
        dy = direction.dy;
      } else {
        const wandered = this.wanderDirection(agent, traits);
        dx = wandered.dx;
        dy = wandered.dy;
      }
    }

    const speed = traits.speed * (stressed ? taxisMultiplier : 1);
    const nx = agent.x + dx * speed;
    const ny = agent.y + dy * speed;
    const x = clamp(nx, 0.5, this.config.width - 0.5);
    const y = clamp(ny, 0.5, this.config.height - 0.5);
    if (x !== nx) dx = -dx;
    if (y !== ny) dy = -dy;
    if (this.blockedByBarrier(agent.x, agent.y, x, y)) {
      return { agent, x: agent.x, y: agent.y, dx: -dx, dy: -dy, travelled: 0 };
    }
    return { agent, x, y, dx, dy, travelled: speed };
  }

  /** Per-agent, per-tick wandering stream; unrelated organisms never consume this sequence. */
  private wanderDirection(agent: Agent, traits: SpeciesTraits): { dx: number; dy: number } {
    const turnRng = this.movementRng.fork('agent', agent.id).fork('tick', this.tick);
    const turn = turnRng.gauss() * traits.wander;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const nx = agent.dx * cos - agent.dy * sin;
    const ny = agent.dx * sin + agent.dy * cos;
    const norm = Math.hypot(nx, ny) || 1;
    return { dx: nx / norm, dy: ny / norm };
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
        for (const id of [...this.config.roster].sort(compareIds)) {
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
          if (!agent.alive || this.pendingDeaths.has(agent.id) || !species.includes(agent.species)) continue;
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
    reservedBirths: ReadonlyMap<SpeciesId, number>,
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
    return this.count(agent.species) + (reservedBirths.get(agent.species) ?? 0) < cap;
  }

  private reproduce(
    agent: Agent,
    traits: SpeciesTraits,
    reproductionScale: number,
  ): PendingBirth | null {
    const rng = this.rng
      .fork('birth', agent.id)
      .fork('generation', agent.generation)
      .fork('tick', this.tick);
    const x = clamp(agent.x + rng.around(1.6), 0.5, this.config.width - 0.5);
    const y = clamp(agent.y + rng.around(1.6), 0.5, this.config.height - 0.5);
    if (this.nearbyCount(x, y, 2) > LOCAL_BREEDING_LIMIT) {
      agent.cooldown = Math.max(1, Math.floor((traits.reproCooldown * 0.35) / reproductionScale));
      return null;
    }
    const paid = Math.min(agent.energy * 0.5, traits.reproCost);
    agent.energy -= paid;
    agent.cooldown = Math.max(1, Math.round(traits.reproCooldown / reproductionScale));
    const childEnergy = Math.max(1, paid * (1 + rng.gauss() * traits.variance));
    return {
      parentId: agent.id,
      species: agent.species,
      x,
      y,
      parentX: agent.x,
      parentY: agent.y,
      energy: childEnergy,
      generation: agent.generation + 1,
      rng,
    };
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
    for (const id of [...this.config.roster].sort(compareIds)) this.populationCounts.set(id, 0);
    const list = this.agents;
    for (let i = 0; i < list.length; i++) {
      const agent = list[i] as Agent;
      const current = this.populationCounts.get(agent.species) ?? 0;
      this.populationCounts.set(agent.species, current + 1);
    }
  }

  private detectExtinctions(): void {
    for (const species of [...this.config.roster].sort(compareIds)) {
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
    for (const agent of [...this.agents].sort(compareAgents)) {
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
    for (const id of [...this.config.roster].sort(compareIds)) total += biomass[id] ?? 0;
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
      resources: this.resources,
      biomassFields: this.biomassFields,
      extinctions: this.extinctions,
    };
  }

  private emit(event: Omit<WorldEvent, 'id'>): void {
    const stored = this.events.push(event);
    countEvent(this.counters, stored);
  }
}

function snapshotSpeciesTraits(traits: SpeciesTraits): SpeciesTraits {
  const snapshot: SpeciesTraits = {
    ...traits,
    diet: [...traits.diet],
    tolerance: {
      temperature: { ...traits.tolerance.temperature },
      humidity: { ...traits.tolerance.humidity },
      light: { ...traits.tolerance.light },
    },
    resourceNeeds: { ...traits.resourceNeeds },
    symbiosis: traits.symbiosis ? { ...traits.symbiosis } : null,
  };
  return deepFreeze(snapshot);
}

function snapshotWorldConfig(
  config: WorldConfig,
  rules: readonly EcosystemRule[],
): WorldConfig {
  const snapshot: WorldConfig = {
    ...config,
    baseline: { ...config.baseline },
    resources: {
      water: { ...config.resources.water },
      nutrients: { ...config.resources.nutrients },
    },
    sources: config.sources.map((source) => ({ ...source })),
    pulses: config.pulses.map((pulse) => ({ ...pulse })),
    rules: [...rules],
    roster: [...config.roster],
    initialPopulations: { ...config.initialPopulations },
    populationCaps: { ...config.populationCaps },
    biomassTarget: { ...config.biomassTarget },
    instruments: [...config.instruments],
  };
  return deepFreeze(snapshot);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function compareIds(a: SpeciesId, b: SpeciesId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareAgents(a: Agent, b: Agent): number {
  return a.id - b.id;
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
