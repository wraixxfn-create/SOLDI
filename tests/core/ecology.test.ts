import { describe, expect, it } from 'vitest';
import { STARTER_SPECIES, STARTER_SPECIES_BY_ID } from '../../src/content/species.ts';
import { STARTER_WORLD } from '../../src/content/starter-ecosystem.ts';
import { ContentError } from '../../src/core/errors.ts';
import { RESOURCE_LIMITS } from '../../src/core/sim/resources.ts';
import { assertValidWorldConfig, validateWorldConfig, type SectorConfig } from '../../src/core/sim/sector.ts';
import { World } from '../../src/core/sim/world.ts';

function createWorld(config: SectorConfig = STARTER_WORLD, seed = config.seed): World {
  return new World({ config, species: STARTER_SPECIES, seed });
}

describe('explicit ecosystem world model', () => {
  it('defines four distinct starter strategies with configurable lifecycle and interaction traits', () => {
    expect(STARTER_SPECIES.map((species) => species.id)).toEqual(['PHY-1', 'PRE-1', 'DEC-1', 'SYM-1']);
    expect(new Set(STARTER_SPECIES.map((species) => species.traits.strategy)).size).toBe(4);
    for (const { traits } of STARTER_SPECIES) {
      expect(traits.maxEnergy).toBeGreaterThan(traits.startEnergy);
      expect(traits.reproEnergy).toBeGreaterThan(traits.startEnergy);
      expect(traits.maturity).toBeLessThan(traits.lifespan);
      expect(traits.speed).toBeGreaterThan(0);
      expect(traits.resourceNeeds.waterPerEnergy).toBeGreaterThanOrEqual(0);
      expect(traits.resourceNeeds.nutrientsPerEnergy).toBeGreaterThanOrEqual(0);
    }
    expect(STARTER_SPECIES_BY_ID.get('DEC-1')?.traits.decompositionYield).toBeGreaterThan(0);
    expect(STARTER_SPECIES_BY_ID.get('SYM-1')?.traits.symbiosis?.partner).toBe('PHY-1');
    expect(STARTER_SPECIES_BY_ID.get('PRE-1')?.traits.diet).toContain('SYM-1');
  });

  it('validates the explicit finite territory, climate, initial stocks and rule set before construction', () => {
    expect(validateWorldConfig(STARTER_WORLD, STARTER_SPECIES_BY_ID)).toEqual([]);
    assertValidWorldConfig(STARTER_WORLD, STARTER_SPECIES_BY_ID);
    const world = createWorld();
    expect(world.config.width).toBe(32);
    expect(world.config.height).toBe(24);
    expect(world.resources.water.stats().mean).toBeCloseTo(STARTER_WORLD.resources.water.initial, 6);
    expect(world.resources.nutrients.stats().mean).toBeCloseTo(STARTER_WORLD.resources.nutrients.initial, 6);
    expect(world.snapshot().resources).toBe(world.resources);
  });

  it('snapshots its validated config so later caller mutations cannot rewrite the world', () => {
    const mutableConfig = structuredClone(STARTER_WORLD) as SectorConfig;
    const world = createWorld(mutableConfig);
    Object.assign(mutableConfig.baseline, { temperature: 400 });
    Object.assign(mutableConfig.resources.water, { initial: 0 });
    Object.assign(mutableConfig, { roster: [...mutableConfig.roster].reverse() });
    expect(world.config.baseline.temperature).toBe(STARTER_WORLD.baseline.temperature);
    expect(world.config.resources.water.initial).toBe(STARTER_WORLD.resources.water.initial);
    expect(world.config.roster).toEqual(STARTER_WORLD.roster);
    expect(Object.isFrozen(world.config)).toBe(true);
    const phytoTraits = world.getSpecies('PHY-1');
    expect(Object.isFrozen(phytoTraits)).toBe(true);
    expect(Object.isFrozen(phytoTraits.resourceNeeds)).toBe(true);
    expect(() => new World({ config: STARTER_WORLD, species: STARTER_SPECIES, seed: 1.5 })).toThrow(ContentError);
  });

  it('keeps all four starter strategies viable through the configured survey horizon', () => {
    const world = createWorld();
    world.run(STARTER_WORLD.surveyTicks);
    expect(world.extinctSpecies()).toEqual([]);
    for (const definition of STARTER_SPECIES) {
      expect(world.count(definition.id)).toBeGreaterThan(0);
      expect(world.counters.births.get(definition.id) ?? 0).toBeGreaterThan(0);
    }
  });

  it('rejects out-of-range resource configuration and missing roster species', () => {
    const badResources: SectorConfig = {
      ...STARTER_WORLD,
      resources: {
        ...STARTER_WORLD.resources,
        water: { ...STARTER_WORLD.resources.water, initial: 1.2 },
      },
    };
    expect(validateWorldConfig(badResources, STARTER_SPECIES_BY_ID).join(' ')).toMatch(/initial water/);
    expect(() => createWorld(badResources)).toThrow(ContentError);

    const missingSpecies: SectorConfig = {
      ...STARTER_WORLD,
      roster: ['PHY-1', 'PRE-1'],
      initialPopulations: { 'PHY-1': 1, 'PRE-1': 1 },
      populationCaps: { 'PHY-1': 10, 'PRE-1': 10 },
    };
    expect(validateWorldConfig(missingSpecies, STARTER_SPECIES_BY_ID).join(' ')).toMatch(/has none of its diet species/);
  });

  it('evaluates configured rules at the environment phase and applies their typed effects', () => {
    const lowMineralWorld: SectorConfig = {
      ...STARTER_WORLD,
      id: 'ECO-RULE',
      resources: {
        ...STARTER_WORLD.resources,
        nutrients: { ...STARTER_WORLD.resources.nutrients, initial: 0.5, regeneration: 0 },
      },
    };
    const world = createWorld(lowMineralWorld);
    world.step();
    expect(world.resources.nutrients.getAt(16, 12)).toBeGreaterThan(0.5);
  });

  it('supports threshold-driven environmental effects without executable level code', () => {
    const config: SectorConfig = {
      ...STARTER_WORLD,
      id: 'ECO-CLIMATE-RULE',
      rules: [{
        id: 'cool-world-response',
        priority: 5,
        mode: 'stack',
        group: null,
        frequency: 'each-turn',
        prerequisites: { type: 'field-mean', field: 'temperature', comparison: 'lt', value: 305 },
        effects: [{ type: 'field-shift', field: 'temperature', x: 16, y: 12, radius: 4, amount: 18 }],
      }],
    };
    const world = createWorld(config);
    const before = world.fields.temperature.getAt(16, 12);
    world.step();
    expect(world.fields.temperature.getAt(16, 12)).toBeGreaterThan(before);
  });

  it('keeps water and nutrient cells within documented limits as they evolve', () => {
    const world = createWorld();
    world.run(120);
    for (const [id, field] of Object.entries(world.resources)) {
      const limits = RESOURCE_LIMITS[id as keyof typeof RESOURCE_LIMITS];
      expect(field.stats().min).toBeGreaterThanOrEqual(limits.min);
      expect(field.stats().max).toBeLessThanOrEqual(limits.max);
    }
  });

  it('limits a photosynthetic organism by local water and nutrient availability', () => {
    const config: SectorConfig = {
      ...STARTER_WORLD,
      id: 'ECO-DRY',
      roster: ['PHY-1'],
      initialPopulations: { 'PHY-1': 1 },
      populationCaps: { 'PHY-1': 10 },
      sources: [],
      rules: [],
      resources: {
        water: { ...STARTER_WORLD.resources.water, initial: 0, recharge: 0, evaporation: 0, diffusion: 0 },
        nutrients: { ...STARTER_WORLD.resources.nutrients, initial: 0, regeneration: 0, diffusion: 0 },
      },
    };
    const world = createWorld(config);
    const before = world.speciesBiomass('PHY-1');
    world.step();
    expect(world.speciesBiomass('PHY-1')).toBe(before);
  });

  it('converts consumed organic biomass into mineral nutrients for producers', () => {
    const config: SectorConfig = {
      ...STARTER_WORLD,
      id: 'ECO-DECOMP',
      roster: ['DEC-1', 'PHY-1'],
      initialPopulations: { 'DEC-1': 1, 'PHY-1': 1 },
      populationCaps: { 'DEC-1': 10, 'PHY-1': 10 },
      sources: [],
      rules: [],
      resources: {
        water: { ...STARTER_WORLD.resources.water, initial: 0, recharge: 0, evaporation: 0, diffusion: 0 },
        nutrients: { ...STARTER_WORLD.resources.nutrients, initial: 0, regeneration: 0, diffusion: 0 },
      },
    };
    const world = createWorld(config);
    const decomposer = world.agents.find((agent) => agent.species === 'DEC-1');
    const producer = world.agents.find((agent) => agent.species === 'PHY-1');
    if (!decomposer || !producer) throw new Error('starter organisms were not placed');
    decomposer.x = 15.5;
    decomposer.y = 12.5;
    producer.x = 27.5;
    producer.y = 19.5;
    world.biomassFields.get('PHY-1')?.setAt(15, 12, 4);
    world.resources.nutrients.fill(0);

    world.step();
    expect(world.resources.nutrients.getAt(15, 12)).toBeGreaterThan(0);
  });

  it('applies mutualism to both partner species when they share local territory', () => {
    const config: SectorConfig = {
      ...STARTER_WORLD,
      id: 'ECO-SYMBIOSIS',
      roster: ['PHY-1', 'SYM-1'],
      initialPopulations: { 'PHY-1': 1, 'SYM-1': 1 },
      populationCaps: { 'PHY-1': 10, 'SYM-1': 10 },
      sources: [],
      rules: [],
      resources: {
        water: { ...STARTER_WORLD.resources.water, initial: 0, recharge: 0, evaporation: 0, diffusion: 0 },
        nutrients: { ...STARTER_WORLD.resources.nutrients, initial: 0, regeneration: 0, diffusion: 0 },
      },
    };
    const world = createWorld(config);
    const producer = world.agents.find((agent) => agent.species === 'PHY-1');
    const symbiont = world.agents.find((agent) => agent.species === 'SYM-1');
    if (!producer || !symbiont) throw new Error('starter organisms were not placed');
    producer.x = 16.5;
    producer.y = 12.5;
    symbiont.x = 16.5;
    symbiont.y = 12.5;
    const before = new Map(world.agents.map((agent) => [agent.species, agent.energy]));
    const expected = new Map<string, number>();

    for (const agent of [producer, symbiont]) {
      const traits = world.getSpecies(agent.species);
      const fitness = world.fitnessAt(agent.x, agent.y, agent.species);
      const behaviourScale = 0.65; // both starter strains use the documented dormant response
      const density = 2;
      const metabolism = traits.metabolism * (1 + 0.35 * density / 18);
      const exposure = traits.exposureCost * (1 - fitness) * behaviourScale;
      const partnerBonus = agent.species === 'PHY-1' ? 0.035 : 0.055;
      expected.set(agent.species, (before.get(agent.species) ?? 0) - metabolism - exposure + partnerBonus - traits.moveCost);
    }

    world.step();
    expect(producer.energy).toBeCloseTo(expected.get('PHY-1') ?? 0, 6);
    expect(symbiont.energy).toBeCloseTo(expected.get('SYM-1') ?? 0, 6);
  });
});
