import { describe, expect, it } from 'vitest';
import {
  ROLE_LABELS,
  STRESS_BEHAVIOUR,
  STRESS_RESPONSE_LABELS,
  analyseGating,
  binValue,
  describeSpecies,
  factorLoss,
  fitnessAt,
  fitnessFactor,
  type SpeciesDefinition,
  type SpeciesTraits,
} from '../../src/core/sim/species.ts';
import { FIELD_IDS, FIELD_SPECS } from '../../src/core/field.ts';
import { SPECIES_BY_ID, SPECIES_LIST } from '../../src/content/species.ts';
import { computeFieldDistributions, buildFields, TERRAIN_PROFILES } from '../../src/core/sim/sector.ts';
import { SECTORS } from '../../src/content/sectors.ts';

function traitsWith(overrides: Partial<SpeciesTraits> = {}): SpeciesTraits {
  const base: SpeciesTraits = {
    code: 'TST-0',
    name: 'Test organism',
    color: '#ffffff',
    glow: 0,
    variance: 0.1,
    maxEnergy: 120,
    moveCost: 0.004,
    role: 'photoautotroph',
    dietKind: 'none',
    strategy: 'photosynthetic',
    resourceNeeds: { waterPerEnergy: 0, nutrientsPerEnergy: 0 },
    decompositionYield: 0,
    symbiosis: null,
    diet: [],
    tolerance: {
      temperature: { ideal: 300, width: 40, fragile: 0.25 },
      humidity: { ideal: 0.5, width: 0.2, fragile: 0.2 },
      light: { ideal: 0.5, width: 0.3, fragile: 0.2 },
    },
    metabolism: 0.05,
    intakeRate: 0.3,
    growthRate: 0.3,
    exposureCost: 0.1,
    startEnergy: 40,
    reproEnergy: 60,
    reproCost: 20,
    reproCooldown: 200,
    maturity: 120,
    lifespan: 2000,
    speed: 0.1,
    wander: 0.5,
    sense: 6,
    size: 1,
    depositRatio: 0.8,
    stressResponse: 'migrate',
    captureChance: 1,
  };
  // Overrides only ever carry valid trait values, so the merge is safe; the assertion also keeps
  // `Partial<SpeciesTraits>` from widening every optional-free field to `T | undefined`.
  return { ...base, ...overrides };
}

describe('fitnessFactor law', () => {
  it('is 1 at the ideal value and 0 at the tolerance width', () => {
    const traits = traitsWith({});
    expect(fitnessFactor(traits, 'temperature', 300)).toBe(1);
    expect(fitnessFactor(traits, 'temperature', 340)).toBeCloseTo(0, 9);
    expect(fitnessFactor(traits, 'temperature', 260)).toBeCloseTo(0, 9);
  });

  it('is symmetric, monotone and never negative', () => {
    const traits = traitsWith({});
    expect(fitnessFactor(traits, 'humidity', 0.6)).toBeCloseTo(
      fitnessFactor(traits, 'humidity', 0.4),
      12,
    );
    let previous = 1;
    for (let value = 300; value <= 340; value += 2) {
      const current = fitnessFactor(traits, 'temperature', value);
      expect(current).toBeLessThanOrEqual(previous + 1e-12);
      expect(current).toBeGreaterThanOrEqual(0);
      previous = current;
    }
    expect(fitnessFactor(traits, 'light', -5)).toBe(0);
    expect(fitnessFactor(traits, 'light', 500)).toBe(0);
  });

  it('degrades gracefully with degenerate tolerance definitions', () => {
    const zeroWidth = traitsWith({
      tolerance: {
        ...traitsWith({}).tolerance,
        light: { ideal: 0.5, width: 0, fragile: 0.2 },
      },
    });
    expect(fitnessFactor(zeroWidth, 'light', 0.5)).toBe(1);
    expect(fitnessFactor(zeroWidth, 'light', 0.5001)).toBe(0);
  });
});

describe('fitnessAt law', () => {
  const traits = traitsWith({});
  const ideal = { temperature: 300, humidity: 0.5, light: 0.5 };
  const off = (overrides: Partial<typeof ideal>) => ({ ...ideal, ...overrides });

  it('is 1 when every factor is ideal', () => {
    expect(fitnessAt(traits, ideal)).toBeCloseTo(1, 9);
  });

  it('is the cubic root of the product of the three factor contributions', () => {
    const readings = off({ temperature: 320 });
    const expected = Math.cbrt(fitnessFactor(traits, 'temperature', 320) * 1 * 1);
    expect(fitnessAt(traits, readings)).toBeCloseTo(expected, 12);
  });

  it('is zero if any factor is zero (a species cannot live on two thirds of a world)', () => {
    expect(fitnessAt(traits, off({ temperature: 500 }))).toBe(0);
    expect(fitnessAt(traits, off({ humidity: 5 }))).toBe(0);
    expect(fitnessAt(traits, off({ light: -3 }))).toBe(0);
  });

  it('degrades gracefully with non-finite readings and stays in [0, 1]', () => {
    expect(fitnessAt(traits, off({ temperature: Number.NaN }))).toBe(0);
    expect(fitnessAt(traits, off({ light: Number.POSITIVE_INFINITY }))).toBe(0);
    expect(fitnessAt(traits, ideal)).toBeLessThanOrEqual(1);
    expect(fitnessAt(traits, ideal)).toBeGreaterThanOrEqual(0);
  });

  it('treats mild deviations as survivable but severe ones as fatal', () => {
    // The documented rationale for the geometric mean: three 0.8 factors must stay viable.
    const mild = fitnessAt(traits, off({ temperature: 300 + 8, humidity: 0.54, light: 0.56 }));
    expect(mild).toBeGreaterThan(0.5);
    const severe = fitnessAt(traits, off({ temperature: 300 + 39 }));
    expect(severe).toBeLessThan(0.2); // cube root of a tiny number is still > 0, but far from viable
  });
});

describe('gating analysis', () => {
  it('names the factor with the largest distribution-weighted loss', () => {
    const config = SECTORS[2] as (typeof SECTORS)[number];
    const distributions = computeFieldDistributions(config);
    for (const species of config.roster) {
      const traits = SPECIES_BY_ID.get(species)?.traits;
      if (!traits) throw new Error(`no traits for ${species}`);
      const analysis = analyseGating(traits, distributions);
      for (const field of FIELD_IDS) {
        expect(analysis.losses[field]).toBeGreaterThanOrEqual(0);
        expect(analysis.losses[field]).toBeLessThanOrEqual(1);
        if (field !== analysis.field) {
          expect(analysis.losses[field]).toBeLessThanOrEqual(analysis.losses[analysis.field] + 1e-9);
        }
      }
      // The reported margin must be the real difference to the runner-up.
      const runnerUp = Math.max(
        ...FIELD_IDS.filter((field) => field !== analysis.field).map(
          (field) => analysis.losses[field],
        ),
      );
      expect(analysis.margin).toBeCloseTo(analysis.losses[analysis.field] - runnerUp, 9);
    }
  });

  it('factorLoss ignores bins with zero weight and stays in [0, 1]', () => {
    const traits = traitsWith({});
    const empty = {
      field: 'light' as const,
      min: 0,
      max: 1,
      bins: 4,
      weights: new Float64Array([0, 0, 0, 0]),
      mean: 0,
    };
    expect(factorLoss(traits, 'light', empty)).toBe(0);
    const tolerance = traits.tolerance.light;
    expect(factorLoss(traits, 'light', { ...empty, weights: new Float64Array([1, 1, 1, 1]) })).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) {
      expect(binValue({ ...empty, weights: new Float64Array([1, 1, 1, 1]) }, i)).toBeGreaterThanOrEqual(0);
    }
    expect(tolerance.width).toBeGreaterThan(0);
  });
});

describe('stress behaviour table', () => {
  it('gives every response a documented mechanism and a usable label', () => {
    for (const response of ['migrate', 'dormant', 'perish'] as const) {
      const behaviour = STRESS_BEHAVIOUR[response];
      expect(behaviour.exposureScale).toBeGreaterThan(0);
      expect(behaviour.taxis).toBeGreaterThan(0);
      expect(behaviour.reproGate).toBeGreaterThan(0);
      expect(behaviour.reproGate).toBeLessThanOrEqual(1);
      expect(STRESS_RESPONSE_LABELS[response].length).toBeGreaterThan(5);
    }
    // Migrators must actually be better at surviving exposure than perish-ers.
    expect(STRESS_BEHAVIOUR.migrate.exposureScale).toBeLessThan(
      STRESS_BEHAVIOUR.perish.exposureScale,
    );
    expect(STRESS_BEHAVIOUR.perish.taxis).toBeLessThan(STRESS_BEHAVIOUR.migrate.taxis);
  });
});

describe('shipped species catalogue', () => {
  it('has unique ids and codes and a role label for every role', () => {
    const ids = new Set<string>();
    const codes = new Set<string>();
    for (const definition of SPECIES_LIST) {
      expect(ids.has(definition.id)).toBe(false);
      expect(codes.has(definition.traits.code)).toBe(false);
      ids.add(definition.id);
      codes.add(definition.traits.code);
      expect(definition.id).toBe(definition.traits.code);
      expect(ROLE_LABELS[definition.traits.role]).toBeTruthy();
      expect(definition.traits.name.length).toBeGreaterThan(3);
    }
    expect(SPECIES_BY_ID.size).toBe(SPECIES_LIST.length);
  });

  it('keeps every numeric trait inside a physically sane range', () => {
    for (const definition of SPECIES_LIST) {
      const t = definition.traits;
      for (const field of FIELD_IDS) {
        const tolerance = t.tolerance[field];
        const spec = FIELD_SPECS[field];
        expect(tolerance.ideal).toBeGreaterThanOrEqual(0);
        expect(tolerance.ideal).toBeLessThanOrEqual(spec.max);
        expect(tolerance.width).toBeGreaterThan(0);
        expect(tolerance.fragile).toBeGreaterThan(0);
        expect(tolerance.fragile).toBeLessThan(1);
      }
      expect(t.metabolism).toBeGreaterThan(0);
      expect(t.metabolism).toBeLessThan(1);
      expect(t.reproEnergy).toBeGreaterThan(t.startEnergy * 0.5);
      expect(t.reproCost).toBeGreaterThan(0);
      expect(t.reproCost).toBeLessThan(t.reproEnergy);
      expect(t.maturity).toBeGreaterThan(0);
      expect(t.lifespan).toBeGreaterThan(t.maturity);
      expect(t.speed).toBeGreaterThan(0);
      expect(t.speed).toBeLessThanOrEqual(0.5);
      expect(t.sense).toBeGreaterThan(0);
      expect(t.size).toBeGreaterThan(0);
      expect(t.depositRatio).toBeGreaterThan(0);
      expect(t.depositRatio).toBeLessThanOrEqual(1);
      if (t.role === 'carnivore') {
        expect(t.dietKind).toBe('predation');
        expect(t.captureChance).toBeGreaterThan(0);
        expect(t.captureChance).toBeLessThan(1);
        expect(t.diet.length).toBeGreaterThan(0);
      } else {
        expect(t.captureChance).toBe(1);
      }
      if (t.dietKind === 'none') {
        expect(t.role).toBe('photoautotroph');
        expect(t.growthRate).toBeGreaterThan(0);
      } else {
        expect(t.diet.length).toBeGreaterThan(0);
      }
    }
  });

  it('only ever lists diet species that exist, and never itself', () => {
    for (const definition of SPECIES_LIST) {
      for (const prey of definition.traits.diet) {
        expect(SPECIES_BY_ID.has(prey)).toBe(true);
        expect(prey).not.toBe(definition.id);
      }
    }
  });

  it('describeSpecies exposes only fields that exist at runtime', () => {
    const traits = traitsWith({});
    const descriptor = describeSpecies({ id: 'TST-0', traits } satisfies SpeciesDefinition);
    expect(descriptor.code).toBe(traits.code);
    for (const key of ['name', 'code', 'role', 'dietKind'] as const) {
      expect(String(descriptor[key]).length).toBeGreaterThan(0);
    }
  });
});

describe('every species is viable somewhere', () => {
  it('can spawn in at least one sector (fitness > 0 at some spawn cell)', () => {
    for (const definition of SPECIES_LIST) {
      const sectors = SECTORS.filter((sector) => sector.roster.includes(definition.id));
      expect(sectors.length).toBeGreaterThan(0);
      let bestFitness = 0;
      for (const sector of sectors) {
        const fields = buildFields(sector);
        for (let y = 0; y < sector.height; y += 2) {
          for (let x = 0; x < sector.width; x += 2) {
            const readings = {
              temperature: fields.temperature.sampleBilinear(x + 0.5, y + 0.5),
              humidity: fields.humidity.sampleBilinear(x + 0.5, y + 0.5),
              light: fields.light.sampleBilinear(x + 0.5, y + 0.5),
            };
            bestFitness = Math.max(bestFitness, fitnessAt(definition.traits, readings));
          }
        }
      }
      expect(bestFitness, `${definition.id} has no habitable cell in any of its sectors`).toBeGreaterThan(0);
    }
  });

  it('declares a terrain polarity for every terrain kind used by content', () => {
    for (const sector of SECTORS) {
      for (const source of sector.sources) {
        expect(TERRAIN_PROFILES[source.kind]).toBeTruthy();
      }
    }
  });
});
