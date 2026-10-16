import { FIELD_SPECS, type FieldId } from '../core/field.ts';
import { ContentError } from '../core/errors.ts';
import { momentsMean } from '../core/sim/metrics.ts';
import {
  ROLE_LABELS,
  STRESS_RESPONSE_ACTIONS,
  STRESS_RESPONSE_LABELS,
  analyseGating,
  factorLoss,
  type FieldDistribution,
  type SpeciesId,
  type StressResponse,
  type TrophicRole,
} from '../core/sim/species.ts';
import { computeFieldDistributions, type SectorConfig } from '../core/sim/sector.ts';
import { World } from '../core/sim/world.ts';
import { SPECIES_BY_ID, SPECIES_LIST, requireSpecies } from './species.ts';
import { SECTORS } from './sectors.ts';

/**
 * The deduction layer.
 *
 * Every proposition is derived from the sector's *real* parameters and from *real* simulation output
 * (ADR-005), so the Codex can never disagree with the world the player is looking at:
 *
 * - tolerance, role, stress response and the reproduction driver are derived from the species' hidden
 *   trait block plus the sector's own time-averaged field distribution;
 * - trophic links come from a canonical, seeded, intervention-free observation run of the sector, so
 *   "what does this animal actually eat here?" is answered by what the world actually did.
 *
 * Nothing is hand-written prose that could drift away from the code.
 */

export type PropositionKind = 'role' | 'tolerance' | 'trophic' | 'reproDriver' | 'stress';

export interface PropositionOption {
  readonly id: string;
  readonly label: string;
}

export interface Proposition {
  readonly id: string;
  readonly kind: PropositionKind;
  readonly subject: SpeciesId;
  readonly field?: FieldId;
  readonly prompt: string;
  readonly options: readonly PropositionOption[];
  readonly correctOptionId: string;
  /** Revealed in the debrief: *why* the correct option is the correct one. */
  readonly explanation: string;
  /** The real numbers behind the answer, shown with the debrief. */
  readonly evidence: Readonly<Record<string, string>>;
  /** Weight in the report score (harder deductions are worth more). */
  readonly weight: number;
  /** Charge cost of the in-game Data Assist for this proposition. */
  readonly assistCost: number;
}

/** Authored request for one proposition; everything else is derived. */
export interface LawSpec {
  readonly kind: PropositionKind;
  readonly species: SpeciesId;
  readonly field?: FieldId;
  readonly weight?: number;
}

export const ASSIST_COST = 3;

// ---------------------------------------------------------------- tolerance bands

/** Canonical band definitions: a species' optimum falls in exactly one band per field. */
export interface FieldBand {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
}

const BAND_BOUNDS: Readonly<Record<FieldId, readonly number[]>> = Object.freeze({
  temperature: [0, 272, 352, 100000],
  humidity: [0, 0.4, 0.66, 1000],
  light: [0, 0.25, 0.6, 1000],
});

const BAND_LABELS: Readonly<Record<FieldId, readonly string[]>> = Object.freeze({
  temperature: ['cold (below 272 K)', 'temperate (272–352 K)', 'hot (above 352 K)'],
  humidity: [
    'arid (below 0.40 saturation)',
    'balanced (0.40–0.66 saturation)',
    'humid (above 0.66 saturation)',
  ],
  light: ['aphotic (below 0.25 lux)', 'dim (0.25–0.60 lux)', 'bright (above 0.60 lux)'],
});

export const FIELD_BANDS: Readonly<Record<FieldId, readonly FieldBand[]>> = Object.freeze({
  temperature: buildBands('temperature'),
  humidity: buildBands('humidity'),
  light: buildBands('light'),
});

function buildBands(field: FieldId): readonly FieldBand[] {
  const bounds = BAND_BOUNDS[field];
  const labels = BAND_LABELS[field];
  const bands: FieldBand[] = [];
  for (let i = 0; i < labels.length; i++) {
    bands.push({
      id: bandIds(field)[i] as string,
      label: labels[i] as string,
      min: bounds[i] as number,
      max: bounds[i + 1] as number,
    });
  }
  return Object.freeze(bands);
}

function bandIds(field: FieldId): readonly string[] {
  if (field === 'temperature') return ['cold', 'temperate', 'hot'];
  if (field === 'humidity') return ['arid', 'balanced', 'humid'];
  return ['aphotic', 'dim', 'bright'];
}

/**
 * Band id for a field value — the classifier the fairness audit and the UI both use.
 * Exported separately because it is what callers pass around, and it avoids handing out a mutable
 * band object where only its identity matters.
 */
export function bandIdFor(field: FieldId, value: number): string {
  return bandFor(field, value).id;
}

/** The band a value falls into (the last band whose minimum it reaches). */
export function bandFor(field: FieldId, value: number): FieldBand {
  const bands = FIELD_BANDS[field];
  let match = bands[0] as FieldBand;
  for (const band of bands) {
    if (value >= band.min) match = band;
  }
  return match;
}

// ---------------------------------------------------------------- canonical observation run

export interface TrophicMeasurement {
  readonly prey: SpeciesId;
  readonly share: number;
  readonly runnerUp: number;
}

export interface CanonicalObservation {
  /** Dominant energy source per consumer, measured over an intervention-free run. */
  readonly primaryPrey: ReadonlyMap<SpeciesId, TrophicMeasurement>;
  readonly ticks: number;
  /** Mean fields at each species' birth sites during the observation window. */
  readonly birthFieldMean: (
    species: SpeciesId,
    field: FieldId,
  ) => { value: number; samples: number };
}

const observationCache = new Map<string, CanonicalObservation>();

/**
 * Runs the sector headless with no player intervention and records what each consumer actually ate
 * and where each species successfully reproduced. Deterministic and cached: every player sees the
 * same trophic links, so a measurable law is also a fair one.
 */
export function canonicalObservation(config: SectorConfig, ticks = 900): CanonicalObservation {
  const cacheKey = `${config.id}:${ticks}`;
  const cached = observationCache.get(cacheKey);
  if (cached) return cached;
  if (!Number.isFinite(ticks) || ticks < 0) {
    throw new ContentError(`Invalid observation window ${ticks} for sector ${config.id}`, {
      id: config.id,
    });
  }

  const world = new World({ config, species: SPECIES_LIST, seed: config.seed });
  world.run(ticks);

  const primaryPrey = new Map<SpeciesId, TrophicMeasurement>();
  for (const [id, traits] of world.traits) {
    if (traits.dietKind === 'none') continue;
    const shares = [...world.intakeShares(id).entries()].sort((a, b) => b[1] - a[1]);
    const top = shares[0];
    if (!top) continue;
    primaryPrey.set(id, { prey: top[0], share: top[1], runnerUp: shares[1]?.[1] ?? 0 });
  }

  const observation: CanonicalObservation = {
    primaryPrey,
    ticks,
    birthFieldMean: (species, field) => {
      const moments = world.birthMoments.get(species);
      if (!moments || moments.n === 0) return { value: Number.NaN, samples: 0 };
      return { value: momentsMean(moments, field), samples: moments.n };
    },
  };
  observationCache.set(cacheKey, observation);
  return observation;
}

// ---------------------------------------------------------------- builders

function traitsOf(species: SpeciesId) {
  const definition = SPECIES_BY_ID.get(species);
  if (!definition) {
    throw new ContentError(`Law proposition references unknown species "${species}"`, { species });
  }
  return definition.traits;
}

function distributions(config: SectorConfig) {
  return computeFieldDistributions(config);
}

function unit(field: FieldId): string {
  return FIELD_SPECS[field].unit;
}

function formatValue(field: FieldId, value: number): string {
  const decimals = field === 'temperature' ? 1 : 2;
  return `${value.toFixed(decimals)} ${unit(field)}`;
}

function buildRole(spec: LawSpec): Proposition {
  const traits = traitsOf(spec.species);
  const roles: readonly TrophicRole[] = ['photoautotroph', 'herbivore', 'carnivore', 'filter'];
  return {
    id: `role:${spec.species}`,
    kind: 'role',
    subject: spec.species,
    prompt: `What is the primary ecological role of ${traits.name} (${traits.code})?`,
    options: roles.map((role) => ({ id: role, label: ROLE_LABELS[role] })),
    correctOptionId: traits.role,
    explanation: `${traits.code} is a ${ROLE_LABELS[traits.role].toLowerCase()}: ${
      traits.dietKind === 'none'
        ? `it fixes its own energy from the environment and deposits biomass at ${traits.growthRate.toFixed(2)} per tick`
        : `it takes its energy from ${traits.diet.join(', ')}`
    }.`,
    evidence: {
      'diet kind': traits.dietKind,
      'diet list': traits.diet.join(', ') || 'none',
      'growth rate': traits.growthRate.toFixed(3),
      'intake rate': traits.intakeRate.toFixed(3),
    },
    weight: spec.weight ?? 0.6,
    assistCost: ASSIST_COST,
  };
}

function buildTolerance(config: SectorConfig, spec: LawSpec): Proposition {
  const field = spec.field;
  if (!field) {
    throw new ContentError('Tolerance proposition needs a field', { species: spec.species });
  }
  const traits = traitsOf(spec.species);
  const tolerance = traits.tolerance[field];
  const correct = bandFor(field, tolerance.ideal);
  const distribution: FieldDistribution = distributions(config)[field];
  const observation = canonicalObservation(config);
  const birth = observation.birthFieldMean(spec.species, field);
  return {
    id: `tolerance:${spec.species}:${field}`,
    kind: 'tolerance',
    subject: spec.species,
    field,
    prompt: `In which range of ${FIELD_SPECS[field].label.toLowerCase()} does ${traits.name} (${traits.code}) reach its peak growth?`,
    options: FIELD_BANDS[field].map((band) => ({ id: band.id, label: band.label })),
    correctOptionId: correct.id,
    explanation: `${traits.name} reaches peak fitness at ${formatValue(field, tolerance.ideal)}, inside the "${correct.label}" range. Its tolerance half-width is ${tolerance.width.toFixed(2)} ${unit(field)}, so beyond ${formatValue(field, tolerance.ideal + tolerance.width)} or ${formatValue(field, tolerance.ideal - tolerance.width)} it cannot grow at all.`,
    evidence: {
      'optimum measured for this species': formatValue(field, tolerance.ideal),
      'sector range': `${distribution.min.toFixed(1)} – ${distribution.max.toFixed(1)} ${unit(field)}`,
      'sector mean': formatValue(field, distribution.mean),
      'mean at its birth sites': birth.samples > 0 ? formatValue(field, birth.value) : 'no births recorded',
    },
    weight: spec.weight ?? 1,
    assistCost: ASSIST_COST,
  };
}

function buildTrophic(config: SectorConfig, spec: LawSpec): Proposition {
  const traits = traitsOf(spec.species);
  const isProducer = traits.dietKind === 'none';
  const measured = canonicalObservation(config).primaryPrey.get(spec.species);
  const correctId = isProducer ? 'ambient' : (measured?.prey ?? 'ambient');

  const options: PropositionOption[] = [];
  for (const id of config.roster) {
    if (id === spec.species) continue;
    const other = requireSpecies(id).traits;
    options.push({ id, label: `${other.name} (${other.code})` });
  }
  options.push({ id: 'ambient', label: 'Ambient nutrients — it needs no other species' });
  options.sort((a, b) => a.label.localeCompare(b.label));

  const preyLabel =
    correctId === 'ambient'
      ? 'ambient nutrients'
      : `${requireSpecies(correctId).traits.name} (${requireSpecies(correctId).traits.code})`;

  return {
    id: `trophic:${spec.species}`,
    kind: 'trophic',
    subject: spec.species,
    prompt: `Which single source supplies most of the energy ${traits.name} (${traits.code}) takes in, in this sector?`,
    options,
    correctOptionId: correctId,
    explanation: isProducer
      ? `${traits.code} is a ${ROLE_LABELS[traits.role].toLowerCase()}: it builds its own biomass from the environment instead of consuming another species, so no other organism needs to be present for it to feed.`
      : `Over ${canonicalObservation(config).ticks} ticks of observation, ${(measured ? measured.share * 100 : 0).toFixed(0)} % of the energy ${traits.code} absorbed came from ${preyLabel}.`,
    evidence: {
      'measured share of intake': measured ? `${(measured.share * 100).toFixed(0)} %` : 'n/a',
      'runner-up share': measured ? `${(measured.runnerUp * 100).toFixed(0)} %` : 'n/a',
      'declared diet': traits.diet.join(', ') || 'none',
      'observation window': `${canonicalObservation(config).ticks} ticks, no player intervention`,
    },
    weight: spec.weight ?? 1.2,
    assistCost: ASSIST_COST,
  };
}

function buildReproDriver(config: SectorConfig, spec: LawSpec): Proposition {
  const traits = traitsOf(spec.species);
  const analysis = analyseGating(traits, distributions(config));
  const label: Readonly<Record<FieldId, string>> = {
    temperature: 'Warmth (temperature)',
    humidity: 'Moisture (humidity)',
    light: 'Light (irradiance)',
  };
  const fields: readonly FieldId[] = ['temperature', 'humidity', 'light'];
  return {
    id: `reproDriver:${spec.species}`,
    kind: 'reproDriver',
    subject: spec.species,
    field: analysis.field,
    prompt: `Which environmental factor most restricts growth and reproduction of ${traits.name} (${traits.code}) across this sector?`,
    options: fields.map((field) => ({ id: field, label: label[field] })),
    correctOptionId: analysis.field,
    explanation: `Averaged across this sector's own climate, ${label[analysis.field].toLowerCase()} costs ${traits.code} ${(analysis.losses[analysis.field] * 100).toFixed(0)} % of its growth potential — more than any other factor. The runner-up costs ${(100 * (analysis.losses[analysis.field] - analysis.margin)).toFixed(0)} %, a margin of ${(analysis.margin * 100).toFixed(1)} points.`,
    evidence: {
      'mean growth loss — temperature': `${(analysis.losses.temperature * 100).toFixed(0)} %`,
      'mean growth loss — humidity': `${(analysis.losses.humidity * 100).toFixed(0)} %`,
      'mean growth loss — light': `${(analysis.losses.light * 100).toFixed(0)} %`,
      'winning margin': `${(analysis.margin * 100).toFixed(1)} points`,
    },
    weight: spec.weight ?? 1.4,
    assistCost: ASSIST_COST,
  };
}

function buildStress(spec: LawSpec): Proposition {
  const traits = traitsOf(spec.species);
  const responses: readonly StressResponse[] = ['migrate', 'dormant', 'perish'];
  const behaviour: Readonly<Record<StressResponse, string>> = {
    migrate: `${STRESS_RESPONSE_LABELS.migrate} — exposure drain halved while moving away`,
    dormant: `${STRESS_RESPONSE_LABELS.dormant} — exposure drain reduced, but no reproduction until conditions recover`,
    perish: `${STRESS_RESPONSE_LABELS.perish} — it makes no avoidance move and its exposure drain is multiplied by 1.85`,
  };
  return {
    id: `stress:${spec.species}`,
    kind: 'stress',
    subject: spec.species,
    prompt: `How does ${traits.name} (${traits.code}) behave when it is exposed to conditions it cannot tolerate?`,
    options: responses.map((response) => ({
      id: response,
      label: STRESS_RESPONSE_ACTIONS[response],
    })),
    correctOptionId: traits.stressResponse,
    explanation: `Observed behaviour of ${traits.code}: ${behaviour[traits.stressResponse]}.`,
    evidence: {
      'stress response': traits.stressResponse,
      'exposure drain': traits.exposureCost.toFixed(3),
      'tolerated exposure before death': `${Math.round(1 / traits.exposureCost)} ticks`,
    },
    weight: spec.weight ?? 1.2,
    assistCost: ASSIST_COST,
  };
}

const BUILDERS: Readonly<
  Record<PropositionKind, (config: SectorConfig, spec: LawSpec) => Proposition>
> = {
  role: (_config, spec) => buildRole(spec),
  tolerance: buildTolerance,
  trophic: buildTrophic,
  reproDriver: buildReproDriver,
  stress: (_config, spec) => buildStress(spec),
};

/** Builds every proposition of a sector from its authored law specification. */
export function buildPropositions(config: SectorConfig): Proposition[] {
  const specs = LAW_SPECS[config.id];
  if (!specs) {
    throw new ContentError(`No law specification for sector "${config.id}"`, { id: config.id });
  }
  const built = specs.map((spec) => {
    if (!config.roster.includes(spec.species)) {
      throw new ContentError(
        `Sector ${config.id}: law proposition subject "${spec.species}" is not on the roster`,
        { id: config.id, species: spec.species },
      );
    }
    const base = BUILDERS[spec.kind](config, spec);
    // Namespace the id by sector: the same species/field pair appears in several sectors (KEL-2's
    // temperature tolerance in both KEL-4 and ORP-2), and reports, saves and the UI all need a key
    // that is unique across the campaign — not just within one sector.
    const proposition: Proposition = { ...base, id: `${config.id}/${base.id}` };
    if (!proposition.options.some((option) => option.id === proposition.correctOptionId)) {
      throw new ContentError(
        `Sector ${config.id}: proposition ${proposition.id} has no option matching its correct answer`,
        { id: config.id, proposition: proposition.id },
      );
    }
    return proposition;
  });
  const ids = new Set(built.map((p) => p.id));
  if (ids.size !== built.length) {
    throw new ContentError(`Sector ${config.id}: duplicate proposition ids`, { id: config.id });
  }
  return built;
}

const propositionCache = new Map<string, readonly Proposition[]>();

/** Propositions of a sector, cached per sector id (pure function of the configuration). */
export function propositionsFor(config: SectorConfig): readonly Proposition[] {
  const cached = propositionCache.get(config.id);
  if (cached) return cached;
  const built = Object.freeze(buildPropositions(config));
  propositionCache.set(config.id, built);
  return built;
}

export function totalWeight(propositions: readonly Proposition[]): number {
  return propositions.reduce((sum, proposition) => sum + proposition.weight, 0);
}

/**
 * Authored proposition lists. Deliberately progressive: FER-1 teaches the vocabulary (role, one
 * tolerance band, one trophic link); later sectors add specialists, filters and stress behaviour.
 */
export const LAW_SPECS: Readonly<Record<string, readonly LawSpec[]>> = Object.freeze({
  'FER-1': [
    { kind: 'role', species: 'AUR-3' },
    { kind: 'tolerance', species: 'AUR-3', field: 'temperature' },
    { kind: 'tolerance', species: 'AUR-3', field: 'humidity' },
    { kind: 'trophic', species: 'FER-7' },
    { kind: 'reproDriver', species: 'AUR-3' },
  ],
  'KEL-4': [
    { kind: 'tolerance', species: 'KEL-2', field: 'temperature' },
    { kind: 'tolerance', species: 'KEL-2', field: 'light' },
    { kind: 'trophic', species: 'VEL-5' },
    { kind: 'trophic', species: 'ORS-9' },
    { kind: 'stress', species: 'VEL-5' },
    // NB: KEL-2 is deliberately *not* a reproduction-driver subject here — its three factor losses
    // are 31 % / 25 % / 31 %, a statistical tie that would make the question unfair (tools/laws.ts
    // fails on margins below 8 points). VEL-5 wins by 10.5 points.
    { kind: 'reproDriver', species: 'VEL-5' },
  ],
  'VOX-9': [
    { kind: 'tolerance', species: 'VOX-1', field: 'light' },
    { kind: 'tolerance', species: 'SCU-4', field: 'light' },
    { kind: 'tolerance', species: 'MYC-8', field: 'light' },
    { kind: 'trophic', species: 'SCU-4' },
    { kind: 'trophic', species: 'MYC-8' },
    { kind: 'reproDriver', species: 'VOX-1' },
  ],
  'ORP-2': [
    { kind: 'tolerance', species: 'ORP-6', field: 'temperature' },
    { kind: 'tolerance', species: 'KEL-2', field: 'temperature' },
    { kind: 'stress', species: 'CAL-5' },
    { kind: 'trophic', species: 'CAL-5' },
    { kind: 'trophic', species: 'GLI-3' },
    { kind: 'reproDriver', species: 'ORP-6' },
    { kind: 'reproDriver', species: 'CAL-5' },
  ],
  'TAU-7': [
    { kind: 'tolerance', species: 'AUR-3', field: 'temperature' },
    { kind: 'tolerance', species: 'KEL-2', field: 'light' },
    { kind: 'trophic', species: 'TAU-0' },
    { kind: 'trophic', species: 'FER-7' },
    { kind: 'trophic', species: 'ORS-9' },
    { kind: 'stress', species: 'TAU-0' },
    // TAU-7 is deliberately the clement sector where every factor is liveable, so *no* species has a
    // single dominant limiting factor here (the best margin available measures 8.0 points, below the
    // fairness bar — see law-fairness.ts). Rather than ship a coin-flip question in the final act,
    // TAU-7 asks for a second, strongly measurable tolerance law instead. The player applies the
    // driver laws they learned earlier; the meridian is where they test them.
    { kind: 'tolerance', species: 'FER-7', field: 'humidity' },
  ],
});

export function allSectorIds(): readonly string[] {
  return SECTORS.map((sector) => sector.id);
}

/** Exported for tests and tools: sector, species and field -> the measured loss of that factor. */
export function measuredFactorLoss(
  config: SectorConfig,
  species: SpeciesId,
  field: FieldId,
): number {
  return factorLoss(traitsOf(species), field, distributions(config)[field]);
}
