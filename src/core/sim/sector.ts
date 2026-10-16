import { ScalarField, FIELD_IDS, type FieldId, type FieldStats } from '../field.ts';
import { clamp } from '../math.ts';
import { ContentError } from '../errors.ts';
import { fitnessAt, type FieldDistribution, type SpeciesDefinition, type SpeciesId } from './species.ts';

/**
 * Sector configuration: the complete, authored description of one mission world.
 *
 * A sector is *data*, never code: `World` is built from it and every derived law proposition is
 * computed from it (ADR-005). `validateSector()` is the single gate every sector must pass, both at
 * import time in `content/sectors.ts` and in the test suite.
 */

/**
 * Terrain feature kinds. The kind determines *which field the source drives and with which
 * polarity*, so content can never place a "cryo seep" that heats the map: the sign lives in code,
 * only the magnitude is authored.
 */
export type TerrainKind = 'thermal' | 'cryo' | 'mist' | 'arid' | 'lumen' | 'shade';

export interface TerrainProfile {
  readonly field: FieldId;
  readonly polarity: 1 | -1;
  readonly label: string;
}

export const TERRAIN_PROFILES: Readonly<Record<TerrainKind, TerrainProfile>> = Object.freeze({
  thermal: { field: 'temperature', polarity: 1, label: 'Thermal vent' },
  cryo: { field: 'temperature', polarity: -1, label: 'Cryo seep' },
  mist: { field: 'humidity', polarity: 1, label: 'Mist basin' },
  arid: { field: 'humidity', polarity: -1, label: 'Arid ridge' },
  lumen: { field: 'light', polarity: 1, label: 'Lumen growth' },
  shade: { field: 'light', polarity: -1, label: 'Shade canyon' },
});

export interface TerrainSource {
  readonly id: string;
  readonly kind: TerrainKind;
  /** Cell coordinates of the source centre. */
  readonly x: number;
  readonly y: number;
  /** Influence radius in cells. */
  readonly radius: number;
  /** Magnitude of the offset at the centre, in field units (always positive; sign comes from kind). */
  readonly strength: number;
  /** Per-tick relaxation weight that keeps the feature alive against diffusion (0, 0.5]. */
  readonly persistence: number;
}

export interface EnvironmentalPulse {
  readonly id: string;
  readonly field: FieldId;
  /** Period in ticks between pulses. */
  readonly period: number;
  /** Signed offset applied at the epicentre. */
  readonly amount: number;
  readonly radius: number;
  readonly x: number;
  readonly y: number;
  /** Tick offset of the first pulse. */
  readonly phase: number;
  readonly label: string;
}

export interface SectorFeature {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly kind: TerrainKind | 'pulse';
}

export interface SectorConfig {
  readonly id: string;
  /** Campaign order, 1-based; drives unlocking. */
  readonly index: number;
  readonly name: string;
  readonly designation: string;
  readonly tagline: string;
  readonly brief: string;
  readonly objective: string;

  readonly width: number;
  readonly height: number;
  /** Base seed for the sector's own world instance. */
  readonly seed: number;

  readonly baseline: Readonly<Record<FieldId, number>>;
  readonly sources: readonly TerrainSource[];
  readonly pulses: readonly EnvironmentalPulse[];

  readonly roster: readonly SpeciesId[];
  readonly initialPopulations: Readonly<Record<SpeciesId, number>>;
  /** Hard population cap per species (prevents unbounded growth after a lucky bloom). */
  readonly populationCaps: Readonly<Record<SpeciesId, number>>;

  readonly startingCharge: number;
  /**
   * Integrity pool: the ecosystem's tolerance for being disturbed. Destructive instruments spend it
   * (see docs/DESIGN.md §4.2) and it never regenerates during a mission, so the destructive tools are
   * a one-way commitment.
   */
  readonly startingIntegrity: number;
  /**
   * Conservation target: the standing-biomass band the survey board wants to see at filing time.
   * Authored against a measured, intervention-free run of the sector (the natural range is recorded
   * in the sector's comment), so "leave it as you found it" scores full marks and a heavy-handed
   * survey does not.
   */
  readonly biomassTarget: { readonly min: number; readonly max: number };
  readonly surveyTicks: number;
  readonly instruments: readonly string[];
  readonly unlockAfter: string | null;
  readonly difficulty: 1 | 2 | 3 | 4 | 5;
}

export interface FieldRange {
  readonly min: number;
  readonly max: number;
}

export type FieldRanges = Readonly<Record<FieldId, FieldRange>>;

/** Physical limits of each field; also used to clamp instruments and pulses. */
export const FIELD_LIMITS: Readonly<Record<FieldId, FieldRange>> = Object.freeze({
  temperature: { min: 150, max: 450 },
  humidity: { min: 0, max: 1 },
  light: { min: 0, max: 1 },
});

/** Target value a terrain source relaxes toward at its epicentre. */
export function sourceTarget(config: SectorConfig, source: TerrainSource): number {
  const profile = TERRAIN_PROFILES[source.kind];
  const limits = FIELD_LIMITS[profile.field];
  return clamp(config.baseline[profile.field] + profile.polarity * source.strength, limits.min, limits.max);
}

/** Applies one terrain source to its field (used by field construction and by the tick loop). */
export function applySource(
  fields: Readonly<Record<FieldId, ScalarField>>,
  config: SectorConfig,
  source: TerrainSource,
  weight: number,
): void {
  const profile = TERRAIN_PROFILES[source.kind];
  fields[profile.field].addRadial(
    source.x,
    source.y,
    source.radius,
    weight,
    sourceTarget(config, source),
  );
}

/** Builds the initial field set for a sector. Deterministic: identical config ⇒ identical fields. */
export function buildFields(config: SectorConfig): Readonly<Record<FieldId, ScalarField>> {
  const fields: Record<FieldId, ScalarField> = {
    temperature: new ScalarField(config.width, config.height, config.baseline.temperature),
    humidity: new ScalarField(config.width, config.height, config.baseline.humidity),
    light: new ScalarField(config.width, config.height, config.baseline.light),
  };
  for (const source of config.sources) {
    // The initial placement is a full-strength blend so the authored terrain is visible at tick 0;
    // afterwards the tick loop re-applies it at `persistence` weight to hold it against diffusion.
    applySource(fields, config, source, 1);
  }
  for (const id of FIELD_IDS) {
    const limits = FIELD_LIMITS[id];
    fields[id].clampTo(limits.min, limits.max);
  }
  return fields;
}

/** Default per-tick field dynamics; the World and the climate sampler must share these numbers. */
export const DEFAULT_DIFFUSION = 0.06;
export const DEFAULT_RELAXATION = 0.0035;

/**
 * Applies the environmental pulses scheduled for `tick`.
 *
 * Lives here rather than inside the World because the *climate* the deduction layer measures must
 * include the dramatic events the player experiences; a law derived from a pulse-free climate would
 * describe a world nobody plays in.
 */
export function applyScheduledPulses(
  fields: Readonly<Record<FieldId, ScalarField>>,
  config: SectorConfig,
  tick: number,
): readonly EnvironmentalPulse[] {
  const fired: EnvironmentalPulse[] = [];
  for (const pulse of config.pulses) {
    if (pulse.period <= 0) continue;
    // Floored modulo: robust for ticks before the first phase as well as after it.
    if ((((tick - pulse.phase) % pulse.period) + pulse.period) % pulse.period !== 0) continue;
    fields[pulse.field].addRadial(pulse.x, pulse.y, pulse.radius, pulse.amount);
    fired.push(pulse);
  }
  return fired;
}

/** Applies one tick of environmental dynamics: source persistence, diffusion, relaxation. */
export function advanceFields(
  fields: Readonly<Record<FieldId, ScalarField>>,
  config: SectorConfig,
  diffusion: number,
  relaxation: number,
): void {
  for (const source of config.sources) {
    applySource(fields, config, source, source.persistence);
  }
  for (const id of FIELD_IDS) {
    const field = fields[id];
    field.diffuse(diffusion);
    field.relaxTowardBaseline(config.baseline[id], relaxation);
    const limits = FIELD_LIMITS[id];
    field.clampTo(limits.min, limits.max);
  }
}

/**
 * Time-averaged distribution of each field over a full environmental cycle (including pulses).
 *
 * This is the sector's "climate": every law proposition about tolerance and reproduction drivers is
 * derived from it, so the laws describe the world the player actually plays in rather than the
 * authored intent. Cached per sector id because it is a pure function of the configuration.
 */
// Keyed by the config *object*, not by its id: two sectors that happen to share an id (a hand-built
// variant in a test, a future user-authored sector) must never be served each other's distributions.
const distributionCache = new WeakMap<SectorConfig, Readonly<Record<FieldId, FieldDistribution>>>();

export function computeFieldDistributions(
  config: SectorConfig,
  bins = 32,
): Readonly<Record<FieldId, FieldDistribution>> {
  const cached = distributionCache.get(config);
  if (cached) return cached;

  const sampleEvery = 6;
  const horizon = config.pulses.length
    ? Math.min(900, Math.max(...config.pulses.map((p) => p.period)) + 120)
    : 240;

  // Pass 1 — walk the climate once to learn the range each field actually spans (pulses included).
  // Pass 2 — bin *that* range, so `weights[i]` and `binValue(distribution, i)` describe the same
  // interval. They used to disagree: samples were binned on the physical limits (150–450 K) while
  // `binValue` reconstructed them on the observed range, so `factorLoss` integrated a 265 K weight
  // against, say, 306 K of fitness — which silently corrupted every reproduction-driver law.
  const ranges: Record<FieldId, { min: number; max: number }> = {
    temperature: { min: Infinity, max: -Infinity },
    humidity: { min: Infinity, max: -Infinity },
    light: { min: Infinity, max: -Infinity },
  };
  const probe = buildFields(config);
  const observe = (fields: Readonly<Record<FieldId, ScalarField>>): void => {
    for (const id of FIELD_IDS) {
      const stats = fields[id].stats();
      if (stats.min < ranges[id].min) ranges[id].min = stats.min;
      if (stats.max > ranges[id].max) ranges[id].max = stats.max;
    }
  };
  observe(probe);
  for (let t = 1; t <= horizon; t++) {
    applyScheduledPulses(probe, config, t);
    advanceFields(probe, config, DEFAULT_DIFFUSION, DEFAULT_RELAXATION);
    if (t % sampleEvery === 0) observe(probe);
  }
  for (const id of FIELD_IDS) {
    const range = ranges[id];
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      const baseline = config.baseline[id];
      range.min = baseline;
      range.max = baseline;
    }
    if (range.max <= range.min) range.max = range.min + 1e-6;
  }

  // Pass 2 — count samples per bin of the observed range.
  const fields = buildFields(config);
  const accumulators: Record<FieldId, Float64Array> = {
    temperature: new Float64Array(bins),
    humidity: new Float64Array(bins),
    light: new Float64Array(bins),
  };
  const accumulate = (): void => {
    for (const id of FIELD_IDS) {
      const range = ranges[id];
      const span = range.max - range.min;
      const data = fields[id].data;
      const counts = accumulators[id];
      for (let i = 0; i < data.length; i++) {
        const bin = clamp(Math.floor((((data[i] as number) - range.min) / span) * (bins - 1)), 0, bins - 1);
        counts[bin] = (counts[bin] as number) + 1;
      }
    }
  };
  accumulate();
  for (let t = 1; t <= horizon; t++) {
    applyScheduledPulses(fields, config, t);
    advanceFields(fields, config, DEFAULT_DIFFUSION, DEFAULT_RELAXATION);
    if (t % sampleEvery === 0) accumulate();
  }

  const result: Record<FieldId, FieldDistribution> = {
    temperature: buildDistribution('temperature', bins, ranges.temperature.min, ranges.temperature.max, accumulators.temperature),
    humidity: buildDistribution('humidity', bins, ranges.humidity.min, ranges.humidity.max, accumulators.humidity),
    light: buildDistribution('light', bins, ranges.light.min, ranges.light.max, accumulators.light),
  };
  distributionCache.set(config, result);
  return result;
}

function buildDistribution(
  field: FieldId,
  bins: number,
  min: number,
  max: number,
  counts: Float64Array,
): FieldDistribution {
  let total = 0;
  for (let i = 0; i < bins; i++) total += counts[i] as number;
  const weights = new Float64Array(bins);
  let mean = 0;
  const step = (max - min) / Math.max(1, bins - 1);
  for (let i = 0; i < bins; i++) {
    const weight = total > 0 ? (counts[i] as number) / total : 1 / bins;
    weights[i] = weight;
    mean += weight * (min + step * i);
  }
  return { field, min, max, bins, weights, mean };
}

/** Distribution summary used by tests and the briefing screen. */
export function describeDistribution(distribution: FieldDistribution): string {
  return `${distribution.field}: min ${distribution.min.toFixed(1)} mean ${distribution.mean.toFixed(1)} max ${distribution.max.toFixed(1)}`;
}

/** Field statistics of the initial (tick 0) sector state, for the mission briefing. */
export function initialFieldStats(config: SectorConfig): Record<FieldId, FieldStats> {
  const fields = buildFields(config);
  return {
    temperature: fields.temperature.stats(),
    humidity: fields.humidity.stats(),
    light: fields.light.stats(),
  };
}

/**
 * Validates a sector configuration. Returns every problem it finds (instead of throwing on the
 * first) so the UI and the test suite can report them together; `assertValidSector` throws.
 */
export function validateSector(
  config: SectorConfig,
  speciesById: ReadonlyMap<SpeciesId, SpeciesDefinition>,
): string[] {
  const problems: string[] = [];
  const need = (condition: boolean, message: string): void => {
    if (!condition) problems.push(message);
  };

  need(config.id.length > 0, 'sector id must not be empty');
  need(Number.isInteger(config.index) && config.index >= 1, `sector ${config.id}: index must be >= 1`);
  need(
    Number.isInteger(config.width) && config.width >= 16 && config.width <= 128,
    `sector ${config.id}: width must be an integer in [16, 128]`,
  );
  need(
    Number.isInteger(config.height) && config.height >= 12 && config.height <= 128,
    `sector ${config.id}: height must be an integer in [12, 128]`,
  );
  need(Number.isInteger(config.seed), `sector ${config.id}: seed must be an integer`);
  need(config.roster.length >= 2, `sector ${config.id}: needs at least two species`);
  need(config.startingCharge > 0, `sector ${config.id}: startingCharge must be positive`);
  need(
    Number.isInteger(config.startingIntegrity) && config.startingIntegrity > 0,
    `sector ${config.id}: startingIntegrity must be a positive integer`,
  );
  need(
    Number.isFinite(config.biomassTarget.min) && config.biomassTarget.min > 0,
    `sector ${config.id}: biomassTarget.min must be positive`,
  );
  need(
    Number.isFinite(config.biomassTarget.max) && config.biomassTarget.max > config.biomassTarget.min,
    `sector ${config.id}: biomassTarget.max must exceed its min`,
  );
  need(config.surveyTicks >= 600, `sector ${config.id}: surveyTicks must allow a real experiment`);
  need(config.instruments.length > 0, `sector ${config.id}: at least one instrument must be enabled`);
  need(
    config.difficulty >= 1 && config.difficulty <= 5,
    `sector ${config.id}: difficulty must be in [1, 5]`,
  );

  for (const id of FIELD_IDS) {
    const limits = FIELD_LIMITS[id];
    const value = config.baseline[id];
    need(
      Number.isFinite(value) && value >= limits.min && value <= limits.max,
      `sector ${config.id}: baseline ${id}=${value} outside [${limits.min}, ${limits.max}]`,
    );
  }

  const roster = checkRoster(config, speciesById, need);
  checkSources(config, need);
  // Every rule below measures the *really constructed* fields, not the authored numbers.
  const sampledFields = buildFields(config);
  checkPulses(config, sampledFields, need);
  checkHabitability(config, speciesById, sampledFields, need);

  // A survey must start with enough organisms to observe: at least 1.5 % of the grid populated.
  const total = Object.values(config.initialPopulations).reduce((a, b) => a + b, 0);
  need(
    total >= Math.round(config.width * config.height * 0.015),
    `sector ${config.id}: initial population (${total}) is too sparse for a survey`,
  );

  // Every consumer on the roster must have at least one of its diet species present, otherwise its
  // trophic law would be unobservable. Autotrophs are exempt.
  for (const species of config.roster) {
    const def = speciesById.get(species);
    if (!def || def.traits.dietKind === 'none') continue;
    const available = def.traits.diet.filter((prey) => roster.has(prey));
    need(
      available.length > 0,
      `sector ${config.id}: consumer "${species}" has none of its diet species on the roster`,
    );
  }

  return problems;
}

type Need = (condition: boolean, message: string) => void;

/** Roster, population and cap tables. Returns the validated roster for later checks. */
function checkRoster(
  config: SectorConfig,
  speciesById: ReadonlyMap<SpeciesId, SpeciesDefinition>,
  need: Need,
): Set<SpeciesId> {
  const known = new Set(speciesById.keys());
  const seen = new Set<SpeciesId>();
  for (const species of config.roster) {
    need(known.has(species), `sector ${config.id}: unknown species "${species}"`);
    need(!seen.has(species), `sector ${config.id}: species "${species}" listed twice`);
    seen.add(species);
    const pop = config.initialPopulations[species];
    need(
      Number.isInteger(pop) && (pop ?? 0) > 0,
      `sector ${config.id}: initial population for "${species}" must be a positive integer`,
    );
    const cap = config.populationCaps[species];
    need(
      Number.isInteger(cap) && (cap ?? 0) > 0 && (cap ?? 0) >= (pop ?? 0),
      `sector ${config.id}: cap for "${species}" must be an integer >= its initial population`,
    );
  }
  for (const key of Object.keys(config.initialPopulations)) {
    need(seen.has(key), `sector ${config.id}: initialPopulations mentions "${key}" which is not on the roster`);
  }
  for (const key of Object.keys(config.populationCaps)) {
    need(seen.has(key), `sector ${config.id}: populationCaps mentions "${key}" which is not on the roster`);
  }
  return seen;
}

/** Terrain sources: unique ids, inside the grid, with a real radius, strength and persistence. */
function checkSources(config: SectorConfig, need: Need): void {
  const ids = new Set<string>();
  for (const source of config.sources) {
    need(!ids.has(source.id), `sector ${config.id}: duplicate terrain source id "${source.id}"`);
    ids.add(source.id);
    need(
      source.x >= 0 && source.x < config.width && source.y >= 0 && source.y < config.height,
      `sector ${config.id}: terrain source "${source.id}" is outside the grid`,
    );
    need(source.radius > 0, `sector ${config.id}: terrain source "${source.id}" needs a radius`);
    need(
      Number.isFinite(source.strength) && source.strength !== 0,
      `sector ${config.id}: terrain source "${source.id}" needs a non-zero strength`,
    );
    need(
      source.persistence > 0 && source.persistence <= 0.5,
      `sector ${config.id}: terrain source "${source.id}" persistence must be in (0, 0.5]`,
    );
  }
}

/**
 * Pulses: unique ids, sane periods and origins — and a measurable effect.
 *
 * A pulse whose epicentre already sits at (or beyond) the physical limit of its field has its impulse
 * clipped away, so the dramatic event the sector brief promises would be invisible. This is measured
 * against the real constructed field, not guessed from the authored numbers.
 */
function checkPulses(
  config: SectorConfig,
  sampledFields: Readonly<Record<FieldId, ScalarField>>,
  need: Need,
): void {
  const ids = new Set<string>();
  for (const pulse of config.pulses) {
    need(!ids.has(pulse.id), `sector ${config.id}: duplicate pulse id "${pulse.id}"`);
    ids.add(pulse.id);
    need(pulse.period >= 120, `sector ${config.id}: pulse period must be >= 120 ticks`);
    need(
      Number.isFinite(pulse.amount) && pulse.amount !== 0,
      `sector ${config.id}: pulse amount must be non-zero`,
    );
    need(
      pulse.x >= 0 && pulse.x < config.width && pulse.y >= 0 && pulse.y < config.height,
      `sector ${config.id}: pulse "${pulse.id}" origin is outside the grid`,
    );

    const limits = FIELD_LIMITS[pulse.field];
    const current = sampledFields[pulse.field].getAt(pulse.x, pulse.y);
    const observable = Math.abs(clamp(current + pulse.amount, limits.min, limits.max) - current);
    need(
      observable >= Math.abs(pulse.amount) * 0.5,
      `sector ${config.id}: pulse "${pulse.id}" is clipped at the ${pulse.field} limit — it would move the field by only ${observable.toFixed(3)} of ${Math.abs(pulse.amount)}`,
    );
  }
}

/**
 * Every species on the roster must have somewhere to live: at least one cell where the real fitness
 * law is positive. Without this the world silently starts a doomed population on its "fittest cell"
 * fallback and the player watches an extinction they could never have prevented.
 */
function checkHabitability(
  config: SectorConfig,
  speciesById: ReadonlyMap<SpeciesId, SpeciesDefinition>,
  sampledFields: Readonly<Record<FieldId, ScalarField>>,
  need: Need,
): void {
  for (const species of config.roster) {
    const definition = speciesById.get(species);
    if (!definition) continue; // already reported as an unknown species
    let habitable = 0;
    for (let y = 0; y < config.height && habitable === 0; y++) {
      for (let x = 0; x < config.width; x++) {
        const fit = fitnessAt(definition.traits, {
          temperature: sampledFields.temperature.sampleBilinear(x + 0.5, y + 0.5),
          humidity: sampledFields.humidity.sampleBilinear(x + 0.5, y + 0.5),
          light: sampledFields.light.sampleBilinear(x + 0.5, y + 0.5),
        });
        if (fit > 0) {
          habitable = 1;
          break;
        }
      }
    }
    need(
      habitable > 0,
      `sector ${config.id}: species "${species}" has no habitable cell (its tolerances do not overlap this sector's climate)`,
    );
  }
}

/**
 * Throws a `ContentError` listing **every** problem: the message carries the first few and the full
 * list travels in `context.problems`, so a stack trace stays actionable without a debugger.
 */
export function assertValidSector(
  config: SectorConfig,
  speciesById: ReadonlyMap<SpeciesId, SpeciesDefinition>,
): void {
  const problems = validateSector(config, speciesById);
  if (problems.length === 0) return;
  const summary = problems.slice(0, 4).join('; ');
  const more = problems.length > 4 ? ` (+${problems.length - 4} more)` : '';
  throw new ContentError(`Invalid sector "${config.id}": ${summary}${more}`, { problems });
}

export function requireSectorById(sectors: readonly SectorConfig[], id: string): SectorConfig {
  const found = sectors.find((s) => s.id === id);
  if (!found) {
    throw new ContentError('Unknown sector id', { id, available: sectors.map((s) => s.id) });
  }
  return found;
}
