import { bellFit, clamp01, finite } from '../math.ts';
import type { FieldId } from '../field.ts';

/**
 * Species model.
 *
 * IMPORTANT DESIGN NOTE: the trait block below *is* the game's hidden content. What the player sees
 * ("AURELIA thrives where it is warm and moist") is generated from these numbers by
 * `content/laws.ts` (ADR-005), so the Codex can never disagree with the simulation.
 */

export type SpeciesId = string;

/** Broad ecological function: drives balance rules, diet validation and player-facing labels. */
export type TrophicRole = 'photoautotroph' | 'herbivore' | 'carnivore' | 'filter';

export const ROLE_LABELS: Readonly<Record<TrophicRole, string>> = Object.freeze({
  photoautotroph: 'Autotroph',
  herbivore: 'Grazer',
  carnivore: 'Predator',
  filter: 'Filter feeder',
});

export type DietKind = 'none' | 'biomass' | 'predation';

/**
 * How a species reacts to sustained unfavourable conditions. A *behavioural* law: directly
 * observable in the field (dispersal, birth stop, mass mortality) and one of the propositions the
 * player must deduce. It also changes the simulation:
 *
 * - `migrate` — strong taxis away from bad cells (speed multiplier) and half the exposure drain
 *   while fleeing; the species visibly evacuates a disturbance.
 * - `dormant` — no reproduction below a fitness gate, but a reduced exposure drain; the species
 *   stops producing offspring and waits it out.
 * - `perish`  — almost no taxis and a much higher exposure drain: bad conditions kill it where it
 *   stands.
 */
export type StressResponse = 'migrate' | 'dormant' | 'perish';

export const STRESS_RESPONSE_LABELS: Readonly<Record<StressResponse, string>> = Object.freeze({
  migrate: 'migrate toward tolerable terrain',
  dormant: 'stop reproducing and endure',
  perish: 'die in place, without dispersing',
});

/** Behaviour multipliers derived from `stressResponse`; one place, so tests can assert the law. */
export const STRESS_BEHAVIOUR: Readonly<
  Record<StressResponse, { taxis: number; exposureScale: number; reproGate: number }>
> = Object.freeze({
  migrate: { taxis: 1.6, exposureScale: 0.5, reproGate: 0.25 },
  dormant: { taxis: 1.0, exposureScale: 0.65, reproGate: 0.5 },
  perish: { taxis: 0.3, exposureScale: 1.85, reproGate: 0.25 },
});

/** Half-width tolerance model: fitness 1 at `ideal`, 0 at `ideal ± width`. */
export interface Tolerance {
  readonly ideal: number;
  readonly width: number;
  /** Sustained conditions below this fitness are lethal (see `EXPOSURE_LETHAL_TICK_LIMIT`). */
  readonly fragile: number;
}

export interface SpeciesTraits {
  /** Player-facing name. */
  readonly name: string;
  /** Field code used in reports, e.g. "AUR-3". */
  readonly code: string;
  readonly role: TrophicRole;
  readonly dietKind: DietKind;
  /** Species consumed, in priority order. Empty for autotrophs. */
  readonly diet: readonly SpeciesId[];
  readonly tolerance: Readonly<Record<FieldId, Tolerance>>;
  readonly stressResponse: StressResponse;

  // --- Energy budget (abstract units, 0..maxEnergy per individual) ---
  readonly maxEnergy: number;
  readonly startEnergy: number;
  readonly metabolism: number;
  readonly exposureCost: number;
  readonly moveCost: number;
  /** Energy per tick at fitness 1 (autotrophs only). */
  readonly growthRate: number;
  /** Max energy per tick taken from prey (consumers only). */
  readonly intakeRate: number;
  /** Fraction of assimilated autotroph energy deposited into the shared biomass field. */
  readonly depositRatio: number;

  // --- Life history ---
  readonly reproEnergy: number;
  readonly reproCost: number;
  readonly reproCooldown: number;
  readonly maturity: number;
  readonly lifespan: number;

  /**
   * Probability that a hunting attempt actually catches the prey. Without a failure mode, predation
   * is a pure energy pump and a handful of predators erases their prey population in a few hundred
   * ticks (measured with `npm run trace -- VOX-9 SCU-4`: 34 of 36 grazers killed by 12 hunters).
   */
  readonly captureChance: number;

  // --- Motion & perception ---
  readonly speed: number;
  readonly wander: number;
  readonly sense: number;

  // --- Presentation ---
  readonly size: number;
  readonly color: string;
  readonly glow: number;
  /** Relative jitter applied to offspring starting energy (inherited variation). */
  readonly variance: number;
}

export interface SpeciesDefinition {
  readonly id: SpeciesId;
  readonly traits: SpeciesTraits;
}

/**
 * The core fitness law. Each environmental factor contributes a two-sided bell centred on the
 * species' hidden ideal, and the three contributions are combined with the **geometric mean**:
 *
 *     fitness = (fitTemperature × fitHumidity × fitLight) ^ (1/3)
 *
 * Rationale (measured with `npm run balance`):
 * - The geometric mean preserves the lethal rule: if *any* factor is outside its tolerance band the
 *   product is 0 and the species cannot live there, which is what makes terrain niches readable.
 * - A plain product, by contrast, sinks a species to inviability for three *mild* deviations from
 *   ideal (0.8 × 0.8 × 0.8 = 0.51), which produced a world where almost nothing could sustain
 *   itself over a full survey. The geometric mean keeps mild deviations survivable while keeping
 *   one severe deviation fatal, which is both better ecology and better game feel.
 *
 * Every tolerance proposition the player answers is a statement about one factor of this law.
 */
export function fitnessAt(
  traits: SpeciesTraits,
  readings: Readonly<Record<FieldId, number>>,
): number {
  const t = traits.tolerance.temperature;
  const h = traits.tolerance.humidity;
  const l = traits.tolerance.light;
  const product =
    finite(bellFit(readings.temperature, t.ideal, t.width), 0) *
    finite(bellFit(readings.humidity, h.ideal, h.width), 0) *
    finite(bellFit(readings.light, l.ideal, l.width), 0);
  if (product <= 0) return 0;
  return clamp01(Math.cbrt(product));
}

/** Fitness contribution of one field alone — used to explain *why* an organism is suffering. */
export function fitnessFactor(traits: SpeciesTraits, field: FieldId, value: number): number {
  const tol = traits.tolerance[field];
  return clamp01(bellFit(value, tol.ideal, tol.width));
}

/**
 * Distribution of an environmental field across a sector: a histogram plus the value each bin
 * represents. Any statistic computed from this is a *real* measure of the world the player is in
 * (it is built from the same field arrays the simulation integrates), which is what allows the
 * deduction layer to state laws that are guaranteed true (ADR-005).
 */
export interface FieldDistribution {
  readonly field: FieldId;
  readonly min: number;
  readonly max: number;
  readonly bins: number;
  /** Relative weight of each bin, summing to 1. */
  readonly weights: Float64Array;
  readonly mean: number;
}

/** Mean fitness each environmental factor allows across a sector (0 = always ideal, 1 = always 0). */
export function factorLoss(
  traits: SpeciesTraits,
  field: FieldId,
  distribution: FieldDistribution,
): number {
  let loss = 0;
  for (let i = 0; i < distribution.bins; i++) {
    const weight = distribution.weights[i] as number;
    if (weight <= 0) continue;
    const value = binValue(distribution, i);
    loss += weight * (1 - fitnessFactor(traits, field, value));
  }
  return clamp01(loss);
}

/** Value at the centre of a distribution bin. */
export function binValue(distribution: FieldDistribution, index: number): number {
  const step = (distribution.max - distribution.min) / Math.max(1, distribution.bins - 1);
  return distribution.min + step * index;
}

export interface GatingAnalysis {
  readonly field: FieldId;
  readonly losses: Readonly<Record<FieldId, number>>;
  /** Difference between the winning factor's loss and the runner-up (must be meaningfully > 0). */
  readonly margin: number;
}

/**
 * Determines which field most constrains a species in a given sector: the factor whose *mean
 * fitness loss over the sector's actual field distribution* is largest.
 *
 * The proposition "reproduction of X is driver-limited by factor F" is generated from the winner of
 * this analysis, and `tests/core/fairness.test.ts` additionally asserts that the winner is
 * unambiguous (margin) and that the player-observable birth statistic agrees with it.
 */
export function analyseGating(
  traits: SpeciesTraits,
  distributions: Readonly<Record<FieldId, FieldDistribution>>,
): GatingAnalysis {
  const fields: readonly FieldId[] = ['temperature', 'humidity', 'light'];
  const losses: Record<FieldId, number> = { temperature: 0, humidity: 0, light: 0 };
  for (const field of fields) {
    losses[field] = factorLoss(traits, field, distributions[field]);
  }
  let best: FieldId = 'temperature';
  let second = 0;
  for (const field of fields) {
    if (losses[field] > losses[best] + 1e-9) {
      second = losses[best];
      best = field;
    } else if (field !== best) {
      second = Math.max(second, losses[field]);
    }
  }
  return { field: best, losses, margin: losses[best] - second };
}

export interface SpeciesDescriptor {
  readonly id: SpeciesId;
  readonly name: string;
  readonly code: string;
  readonly role: TrophicRole;
  readonly roleLabel: string;
  readonly color: string;
  readonly dietKind: DietKind;
}

export function describeSpecies(def: SpeciesDefinition): SpeciesDescriptor {
  return {
    id: def.id,
    name: def.traits.name,
    code: def.traits.code,
    role: def.traits.role,
    roleLabel: ROLE_LABELS[def.traits.role],
    color: def.traits.color,
    dietKind: def.traits.dietKind,
  };
}
