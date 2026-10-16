import {
  type DietKind,
  type SpeciesDefinition,
  type SpeciesId,
  type SpeciesTraits,
  type StressResponse,
  type TrophicRole,
} from '../core/sim/species.ts';
import { assertContent } from '../core/errors.ts';

/**
 * The species catalogue. Every number here is a *hidden law parameter* of the simulation: it is what
 * the player must infer from behaviour. Tuning is validated by the headless balance harness
 * (`npm run balance`, `tools/balance.ts`) and by the fairness invariant
 * (`tests/core/fairness.test.ts`).
 *
 * Naming convention: the code (`AUR-3`) is the catalogue id used everywhere in code and reports; the
 * name (`Aurelia thermica`) is what the player reads in the field guide.
 *
 * Energy economy (see docs/DESIGN.md §3.2): every organism holds at most `maxEnergy` abstract energy
 * units. An autotroph at full fitness nets roughly `growthRate × 0.45 − metabolism ≈ +0.12` per tick
 * in a saturated mat and considerably more while colonising empty ground, so it reproduces every
 * ~150–250 ticks. A consumer nets roughly `intakeRate × 0.85 − metabolism`, but only while prey
 * biomass is physically present under it, which is what makes carrying capacity observable.
 */

type TraitInput = Partial<SpeciesTraits> & {
  name: string;
  code: string;
  role: TrophicRole;
  tolerance: SpeciesTraits['tolerance'];
};

const DEFAULTS = {
  dietKind: 'none' as DietKind,
  diet: [] as readonly SpeciesId[],
  stressResponse: 'dormant' as StressResponse,
  maxEnergy: 100,
  startEnergy: 40,
  metabolism: 0.07,
  exposureCost: 0.12,
  moveCost: 0.012,
  growthRate: 0,
  intakeRate: 0,
  depositRatio: 0.8,
  reproEnergy: 56,
  reproCost: 18,
  reproCooldown: 190,
  maturity: 80,
  lifespan: 2200,
  captureChance: 1,
  speed: 0.05,
  wander: 0.55,
  sense: 3.5,
  size: 1.7,
  color: '#9fb3c8',
  glow: 0,
  variance: 0.08,
} satisfies Omit<SpeciesTraits, 'name' | 'code' | 'role' | 'tolerance'>;

function define(input: TraitInput): SpeciesDefinition {
  const traits: SpeciesTraits = { ...DEFAULTS, ...input };
  assertContent(traits.name.length > 0, 'species needs a name');
  assertContent(/^[A-Z]{3}-\d$/.test(traits.code), `bad species code "${traits.code}"`, {
    code: traits.code,
  });
  assertContent(
    traits.dietKind === 'none' || traits.diet.length > 0,
    `species ${traits.code} is a consumer with an empty diet`,
  );
  assertContent(
    traits.dietKind !== 'none' || traits.diet.length === 0,
    `species ${traits.code} is an autotroph but lists prey`,
  );
  assertContent(
    traits.dietKind !== 'none' || traits.growthRate > 0,
    `species ${traits.code}: an autotroph needs a positive growth rate`,
  );
  assertContent(
    traits.dietKind === 'none' || traits.intakeRate > 0,
    `species ${traits.code}: a consumer needs a positive intake rate`,
  );
  for (const field of ['temperature', 'humidity', 'light'] as const) {
    const tol = traits.tolerance[field];
    assertContent(tol.width > 0, `species ${traits.code}: ${field} tolerance width must be > 0`);
    assertContent(
      tol.fragile >= 0 && tol.fragile <= 1,
      `species ${traits.code}: ${field} fragile threshold must be in [0, 1]`,
    );
  }
  assertContent(traits.maturity < traits.lifespan, `species ${traits.code}: must mature before dying`);
  assertContent(
    traits.startEnergy < traits.maxEnergy,
    `species ${traits.code}: start energy must be below max energy`,
  );
  return { id: traits.code, traits };
}

/**
 * AURELIA — a warm, damp-adapted autotroph: the workhorse producer of the campaign. It grows in a
 * thermal plume and dies back at the shelf edge, which is the first thing a new player learns to
 * read on the temperature overlay.
 */
export const AURELIA = define({
  name: 'Aurelia thermica',
  code: 'AUR-3',
  role: 'photoautotroph',
  dietKind: 'none',
  stressResponse: 'dormant',
  color: '#41d19a',
  glow: 0.15,
  growthRate: 0.46,
  metabolism: 0.07,
  exposureCost: 0.12,
  startEnergy: 40,
  reproEnergy: 56,
  reproCost: 18,
  reproCooldown: 190,
  maturity: 80,
  lifespan: 2200,
  speed: 0.028,
  wander: 0.35,
  size: 1.6,
  tolerance: {
    temperature: { ideal: 336, width: 70, fragile: 0.3 },
    humidity: { ideal: 0.56, width: 0.36, fragile: 0.28 },
    light: { ideal: 0.62, width: 0.58, fragile: 0.25 },
  },
});

/** FERRAX — the first grazer the player meets. It migrates when it cannot tolerate the terrain. */
export const FERRAX = define({
  name: 'Ferrax repens',
  code: 'FER-7',
  role: 'herbivore',
  dietKind: 'biomass',
  diet: [AURELIA.id],
  stressResponse: 'migrate',
  color: '#e8a33d',
  intakeRate: 0.3,
  metabolism: 0.082,
  exposureCost: 0.13,
  startEnergy: 46,
  reproEnergy: 62,
  reproCost: 20,
  reproCooldown: 230,
  maturity: 100,
  lifespan: 2400,
  speed: 0.075,
  wander: 0.7,
  sense: 4,
  size: 1.5,
  tolerance: {
    temperature: { ideal: 326, width: 58, fragile: 0.3 },
    humidity: { ideal: 0.52, width: 0.42, fragile: 0.26 },
    light: { ideal: 0.55, width: 0.72, fragile: 0.24 },
  },
});

/** KELPIA — a cool, wet, dim autotroph: the producer of cave and basin biomes. */
export const KELPIA = define({
  name: 'Kelpia umbrosa',
  code: 'KEL-2',
  role: 'photoautotroph',
  dietKind: 'none',
  stressResponse: 'dormant',
  color: '#3fb6e0',
  glow: 0.1,
  growthRate: 0.42,
  metabolism: 0.064,
  exposureCost: 0.11,
  startEnergy: 40,
  reproEnergy: 54,
  reproCost: 18,
  reproCooldown: 205,
  maturity: 85,
  lifespan: 2300,
  speed: 0.025,
  wander: 0.3,
  size: 1.7,
  tolerance: {
    temperature: { ideal: 262, width: 46, fragile: 0.32 },
    humidity: { ideal: 0.7, width: 0.3, fragile: 0.26 },
    light: { ideal: 0.26, width: 0.32, fragile: 0.24 },
  },
});

/** VELLUM — grazer of the dim basins; flees disturbances, which makes it a good "migration" witness. */
export const VELLUM = define({
  name: 'Vellum vagans',
  code: 'VEL-5',
  role: 'herbivore',
  dietKind: 'biomass',
  diet: [KELPIA.id],
  stressResponse: 'migrate',
  color: '#d873c9',
  intakeRate: 0.25,
  metabolism: 0.078,
  exposureCost: 0.13,
  startEnergy: 46,
  reproEnergy: 60,
  reproCost: 20,
  reproCooldown: 240,
  maturity: 105,
  lifespan: 2500,
  speed: 0.085,
  wander: 0.75,
  sense: 4.5,
  size: 1.5,
  tolerance: {
    temperature: { ideal: 284, width: 50, fragile: 0.3 },
    humidity: { ideal: 0.68, width: 0.4, fragile: 0.26 },
    light: { ideal: 0.4, width: 0.62, fragile: 0.24 },
  },
});

/** ORSAX — a generalist predator: it takes VELLUM or FERRAX, whichever it can reach first. */
export const ORSAX = define({
  name: 'Orsax vorax',
  code: 'ORS-9',
  role: 'carnivore',
  dietKind: 'predation',
  diet: [VELLUM.id, FERRAX.id],
  stressResponse: 'migrate',
  color: '#e0574f',
  glow: 0.2,
  intakeRate: 0.44,
  metabolism: 0.076,
  exposureCost: 0.15,
  startEnergy: 50,
  reproEnergy: 60,
  reproCost: 22,
  reproCooldown: 320,
  maturity: 150,
  lifespan: 3200,
  captureChance: 0.42,
  speed: 0.125,
  wander: 0.8,
  sense: 11,
  size: 2.1,
  tolerance: {
    temperature: { ideal: 302, width: 72, fragile: 0.3 },
    humidity: { ideal: 0.56, width: 0.52, fragile: 0.26 },
    light: { ideal: 0.48, width: 0.78, fragile: 0.24 },
  },
});

/** VOXA — a light-hungry autotroph: it cannot grow in the shade at all. */
export const VOXA = define({
  name: 'Voxa lucida',
  code: 'VOX-1',
  role: 'photoautotroph',
  dietKind: 'none',
  stressResponse: 'dormant',
  color: '#9ed14b',
  glow: 0.25,
  growthRate: 0.5,
  metabolism: 0.072,
  exposureCost: 0.12,
  startEnergy: 40,
  reproEnergy: 58,
  reproCost: 19,
  reproCooldown: 195,
  maturity: 80,
  lifespan: 2100,
  speed: 0.024,
  wander: 0.3,
  size: 1.6,
  tolerance: {
    temperature: { ideal: 318, width: 58, fragile: 0.3 },
    humidity: { ideal: 0.5, width: 0.36, fragile: 0.28 },
    light: { ideal: 0.8, width: 0.26, fragile: 0.3 },
  },
});

/** SCUTA — a shade-loving grazer that follows VOXA only into its dim fringes. */
export const SCUTA = define({
  name: 'Scuta limax',
  code: 'SCU-4',
  role: 'herbivore',
  dietKind: 'biomass',
  diet: [VOXA.id],
  stressResponse: 'migrate',
  color: '#8f7ae6',
  intakeRate: 0.3,
  metabolism: 0.066,
  exposureCost: 0.11,
  startEnergy: 44,
  reproEnergy: 52,
  reproCost: 20,
  reproCooldown: 235,
  maturity: 100,
  lifespan: 2400,
  speed: 0.08,
  wander: 0.7,
  sense: 4,
  size: 1.5,
  tolerance: {
    temperature: { ideal: 312, width: 62, fragile: 0.3 },
    humidity: { ideal: 0.52, width: 0.42, fragile: 0.26 },
    light: { ideal: 0.42, width: 0.5, fragile: 0.26 },
  },
});

/**
 * MYCORRHIZA — a slow filter feeder that strips standing biomass from the dark reef floor. It is
 * the only species that is comfortable where there is no light at all.
 */
export const MYCORRHIZA = define({
  name: 'Mycorrhiza pallens',
  code: 'MYC-8',
  role: 'filter',
  dietKind: 'biomass',
  diet: [VOXA.id, KELPIA.id],
  stressResponse: 'dormant',
  color: '#c9cfd8',
  intakeRate: 0.34,
  metabolism: 0.045,
  exposureCost: 0.1,
  startEnergy: 44,
  reproEnergy: 58,
  reproCost: 20,
  reproCooldown: 290,
  maturity: 140,
  lifespan: 2800,
  speed: 0.04,
  wander: 0.5,
  sense: 4.6,
  size: 1.4,
  tolerance: {
    temperature: { ideal: 298, width: 72, fragile: 0.3 },
    humidity: { ideal: 0.68, width: 0.42, fragile: 0.26 },
    light: { ideal: 0.22, width: 0.42, fragile: 0.28 },
  },
});

/** ORPA — the heat-loving autotroph of the ashfall plains. */
export const ORPA = define({
  name: 'Orpa ustulata',
  code: 'ORP-6',
  role: 'photoautotroph',
  dietKind: 'none',
  stressResponse: 'dormant',
  color: '#e07a3f',
  glow: 0.2,
  growthRate: 0.44,
  metabolism: 0.072,
  exposureCost: 0.12,
  startEnergy: 40,
  reproEnergy: 58,
  reproCost: 19,
  reproCooldown: 185,
  maturity: 85,
  lifespan: 2250,
  speed: 0.026,
  wander: 0.32,
  size: 1.6,
  tolerance: {
    temperature: { ideal: 380, width: 52, fragile: 0.3 },
    humidity: { ideal: 0.36, width: 0.38, fragile: 0.28 },
    light: { ideal: 0.68, width: 0.44, fragile: 0.26 },
  },
});

/** CALYX — a heat-adapted grazer demonstrating the `perish` stress law: it dies where it stands. */
export const CALYX = define({
  name: 'Calyx fervens',
  code: 'CAL-5',
  role: 'herbivore',
  dietKind: 'biomass',
  diet: [ORPA.id],
  stressResponse: 'perish',
  color: '#d9a13b',
  intakeRate: 0.27,
  metabolism: 0.084,
  exposureCost: 0.17,
  startEnergy: 46,
  reproEnergy: 62,
  reproCost: 20,
  reproCooldown: 225,
  maturity: 95,
  lifespan: 2350,
  speed: 0.07,
  wander: 0.6,
  sense: 3.4,
  size: 1.5,
  tolerance: {
    temperature: { ideal: 372, width: 56, fragile: 0.34 },
    humidity: { ideal: 0.34, width: 0.44, fragile: 0.28 },
    light: { ideal: 0.62, width: 0.66, fragile: 0.24 },
  },
});

/** GLIRRA — a patient predator of the reef and the ash plains. */
export const GLIRRA = define({
  name: 'Glirra nox',
  code: 'GLI-3',
  role: 'carnivore',
  dietKind: 'predation',
  diet: [SCUTA.id, CALYX.id],
  stressResponse: 'dormant',
  color: '#2fa8a0',
  glow: 0.2,
  intakeRate: 0.5,
  metabolism: 0.056,
  exposureCost: 0.11,
  startEnergy: 46,
  reproEnergy: 48,
  reproCost: 18,
  reproCooldown: 260,
  maturity: 120,
  lifespan: 3600,
  captureChance: 0.42,
  speed: 0.12,
  wander: 0.85,
  sense: 11,
  size: 2,
  tolerance: {
    temperature: { ideal: 324, width: 78, fragile: 0.3 },
    humidity: { ideal: 0.5, width: 0.54, fragile: 0.26 },
    light: { ideal: 0.52, width: 0.8, fragile: 0.24 },
  },
});

/**
 * TAUROS — the invasive generalist. Broad tolerance, cheap metabolism, fast reproduction: it does
 * not need to be *better* anywhere, it just survives everywhere. Sector 5 asks the player to
 * diagnose exactly that.
 */
export const TAUROS = define({
  name: 'Tauros invadens',
  code: 'TAU-0',
  role: 'herbivore',
  dietKind: 'biomass',
  diet: [AURELIA.id, KELPIA.id],
  stressResponse: 'migrate',
  color: '#e04f8a',
  intakeRate: 0.27,
  metabolism: 0.062,
  exposureCost: 0.08,
  startEnergy: 44,
  reproEnergy: 54,
  reproCost: 18,
  reproCooldown: 160,
  maturity: 70,
  lifespan: 2600,
  speed: 0.088,
  wander: 0.8,
  sense: 5,
  size: 1.5,
  tolerance: {
    temperature: { ideal: 322, width: 92, fragile: 0.24 },
    humidity: { ideal: 0.5, width: 0.62, fragile: 0.22 },
    light: { ideal: 0.55, width: 0.86, fragile: 0.22 },
  },
});

export const SPECIES_LIST: readonly SpeciesDefinition[] = [
  AURELIA,
  FERRAX,
  KELPIA,
  VELLUM,
  ORSAX,
  VOXA,
  SCUTA,
  MYCORRHIZA,
  ORPA,
  CALYX,
  GLIRRA,
  TAUROS,
];

export const SPECIES_BY_ID: ReadonlyMap<SpeciesId, SpeciesDefinition> = new Map(
  SPECIES_LIST.map((def) => [def.id, def]),
);

export function requireSpecies(id: SpeciesId): SpeciesDefinition {
  const def = SPECIES_BY_ID.get(id);
  assertContent(def !== undefined, `Unknown species "${id}"`, { id });
  return def;
}

export const SPECIES_IDS: ReadonlySet<SpeciesId> = new Set(SPECIES_LIST.map((d) => d.id));
