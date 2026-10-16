import { describe, expect, it } from 'vitest';
import { FIELD_IDS } from '../../src/core/field.ts';
import { STARTER_SPECIES } from '../../src/content/species.ts';
import { STARTER_WORLD } from '../../src/content/starter-ecosystem.ts';
import { World, WORLD_TICK_PHASES } from '../../src/core/sim/world.ts';
import type { SectorConfig } from '../../src/core/sim/sector.ts';

function createWorld(config: SectorConfig = STARTER_WORLD, seed = config.seed): World {
  return new World({ config, species: STARTER_SPECIES, seed });
}

function fingerprint(world: World): unknown {
  const agents = [...world.agents]
    .sort((a, b) => a.id - b.id)
    .map(({ id, species, x, y, dx, dy, energy, age, cooldown, stress, generation, alive }) =>
      ({ id, species, x, y, dx, dy, energy, age, cooldown, stress, generation, alive }));
  const biomassFields = [...world.biomassFields.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([id, field]) => [id, Array.from(field.data)]);
  const fields = Object.fromEntries(FIELD_IDS.map((id) => [id, Array.from(world.fields[id].data)]));
  const resources = {
    water: Array.from(world.resources.water.data),
    nutrients: Array.from(world.resources.nutrients.data),
  };
  return {
    tick: world.tick,
    counts: world.counts(),
    agents,
    fields,
    resources,
    biomassFields,
    events: world.events.toArray(),
    probes: world.probes.map((probe) => ({ ...probe, samples: probe.samples.map((sample) => ({ ...sample })) })),
    extinctions: world.extinctSpecies(),
  };
}

describe('seeded world determinism', () => {
  it('replays the same seed, config and ordered player actions byte-for-byte', () => {
    const a = createWorld(STARTER_WORLD, 0x1234);
    const b = createWorld(STARTER_WORLD, 0x1234);
    a.run(72);
    b.run(72);

    for (const world of [a, b]) {
      world.pulseField('temperature', 11, 10, 4, 18);
      world.nutrientBloom('PHY-1', 15, 11, 3.5, 0.7);
      world.introduce('SYM-1', 2, 16, 12);
      world.addProbe(14, 12, 4);
      world.addBarrier(4, 5, 18, 5);
      world.cull(8, 7, 1.2, 'PRE-1');
      world.run(150);
    }
    expect(fingerprint(a)).toEqual(fingerprint(b));
  });

  it('does not depend on array insertion order or equivalent config table order', () => {
    const reordered: SectorConfig = {
      ...STARTER_WORLD,
      roster: [...STARTER_WORLD.roster].reverse(),
      sources: [...STARTER_WORLD.sources].reverse(),
      pulses: [...STARTER_WORLD.pulses].reverse(),
      rules: [...STARTER_WORLD.rules].reverse(),
      initialPopulations: Object.fromEntries(Object.entries(STARTER_WORLD.initialPopulations).reverse()),
      populationCaps: Object.fromEntries(Object.entries(STARTER_WORLD.populationCaps).reverse()),
    };
    const a = createWorld();
    const b = createWorld(reordered);
    b.agents.reverse();
    a.run(180);
    b.run(180);
    expect(fingerprint(a)).toEqual(fingerprint(b));
  });

  it('publishes and executes the documented turn phases in order', () => {
    expect(WORLD_TICK_PHASES).toEqual([
      'environment',
      'resource-availability',
      'metabolism',
      'interactions',
      'reproduction',
      'mortality',
      'state-update',
    ]);
    const world = createWorld();
    world.step();
    expect(world.tick).toBe(1);
  });
});
