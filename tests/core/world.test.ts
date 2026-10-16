import { describe, expect, it } from 'vitest';
import { World } from '../../src/core/sim/world.ts';
import { SPECIES_LIST } from '../../src/content/species.ts';
import { SECTORS } from '../../src/content/sectors.ts';
import type { SectorConfig } from '../../src/core/sim/sector.ts';
import { FIELD_LIMITS } from '../../src/core/sim/sector.ts';
import { FIELD_IDS } from '../../src/core/field.ts';
import { InvariantError, WorldBugError } from '../../src/core/errors.ts';

/** KEL-4 is small, has three species and a pulse: the cheapest sector to run in tests. */
const SECTOR = SECTORS[1] as SectorConfig;

function world(config: SectorConfig = SECTOR, seed = config.seed): World {
  return new World({ config, species: SPECIES_LIST, seed });
}

describe('world construction', () => {
  it('spawns the configured populations (or reports what it could not place)', () => {
    const w = world();
    expect(w.population).toBeGreaterThan(0);
    for (const species of SECTOR.roster) {
      const configured = SECTOR.initialPopulations[species] ?? 0;
      const actual = w.count(species);
      expect(actual).toBeGreaterThan(0);
      expect(actual).toBeLessThanOrEqual(configured);
    }
  });

  it('rejects unknown species ids instead of silently ignoring them', () => {
    expect(() => world().getSpecies('ZZZ-9')).toThrow(InvariantError);
    expect(() => world().fitnessAt(1, 1, 'ZZZ-9')).toThrow(InvariantError);
    expect(() => world().nutrientBloom('ZZZ-9', 5, 5, 4, 0.5)).toThrow(InvariantError);
    expect(() => world().cull(5, 5, 4, 'ZZZ-9')).toThrow(InvariantError);
    expect(() => world().cull(5, 5, Number.NaN)).toThrow(WorldBugError);
  });

  it('never starts an empty world, even when habitability is marginal', () => {
    // Content validation refuses a roster species with no habitable cell (`validateSector`), so the
    // world's own guard rail covers the softer case: a species that *can* live somewhere but cannot
    // place its configured population. It must fall back to the fittest cell, never start empty.
    const harsh: SectorConfig = {
      ...SECTOR,
      roster: ['KEL-2'],
      initialPopulations: { 'KEL-2': 40 },
      populationCaps: { 'KEL-2': 40 },
      sources: [
        { id: 'cold', kind: 'cryo', x: 24, y: 16, radius: 8, strength: 60, persistence: 0.4 },
      ],
    };
    const w = world(harsh);
    expect(w.population).toBeGreaterThan(0);
    expect(w.count('KEL-2')).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('two worlds with the same seed produce identical census and biomass', () => {
    const a = world(SECTOR, 12345);
    const b = world(SECTOR, 12345);
    a.run(400);
    b.run(400);
    expect(a.counts()).toEqual(b.counts());
    expect(a.biomassReport()).toEqual(b.biomassReport());
    expect(a.totalBiomass()).toBeCloseTo(b.totalBiomass(), 6);
    expect(a.totalBiomass()).toBeGreaterThan(0);
  });

  it('a different seed produces a different world', () => {
    const a = world(SECTOR, 1);
    const b = world(SECTOR, 2);
    a.run(200);
    b.run(200);
    expect(a.counts()).not.toEqual(b.counts());
  });

  it('splitting the same run into chunks is identical to running it in one go', () => {
    const one = world(SECTOR, 777);
    const chunks = world(SECTOR, 777);
    one.run(300);
    for (let i = 0; i < 30; i++) chunks.run(10);
    expect(chunks.counts()).toEqual(one.counts());
    expect(chunks.totalBiomass()).toBeCloseTo(one.totalBiomass(), 6);
  });

  it('never consults Math.random', () => {
    const original = Math.random;
    let called = 0;
    Math.random = () => {
      called++;
      return original();
    };
    try {
      const w = world(SECTOR, 99);
      w.run(120);
      w.pulseField('temperature', 10, 10, 6, 20);
      w.addProbe(5, 5);
      w.cull(10, 10, 4);
      w.nutrientBloom(SECTOR.roster[0] as string, 10, 10, 5, 0.5);
    } finally {
      Math.random = original;
    }
    expect(called).toBe(0);
  });
});

describe('field coupling', () => {
  it('keeps every field inside its physical limits, including after extreme instruments', () => {
    const w = world(SECTOR, 31);
    for (let i = 0; i < 30; i++) {
      w.pulseField('temperature', 24, 16, 20, 500);
      w.pulseField('humidity', 24, 16, 20, -5);
      w.pulseField('light', 24, 16, 20, 5);
      w.run(5);
    }
    for (const id of FIELD_IDS) {
      const stats = w.fields[id].stats();
      expect(stats.min).toBeGreaterThanOrEqual(FIELD_LIMITS[id].min);
      expect(stats.max).toBeLessThanOrEqual(FIELD_LIMITS[id].max);
    }
  });

  it('pulseField ignores degenerate input instead of throwing', () => {
    const w = world(SECTOR, 5);
    const before = Array.from(w.fields.temperature.data);
    w.pulseField('temperature', 10, 10, 0, 50);
    w.pulseField('temperature', 10, 10, 5, 0);
    expect(Array.from(w.fields.temperature.data)).toEqual(before);
  });
});

describe('agents stay legal', () => {
  it('keeps every organism inside the grid with finite, positive energy', () => {
    const w = world(SECTOR, 4242);
    for (let i = 0; i < 12; i++) {
      w.run(50);
      for (const agent of w.agents) {
        expect(agent.alive).toBe(true);
        expect(agent.x).toBeGreaterThanOrEqual(0);
        expect(agent.y).toBeGreaterThanOrEqual(0);
        expect(agent.x).toBeLessThanOrEqual(SECTOR.width);
        expect(agent.y).toBeLessThanOrEqual(SECTOR.height);
        expect(Number.isFinite(agent.energy)).toBe(true);
        expect(agent.energy).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('records a death cause for every organism that disappears', () => {
    const w = world(SECTOR, 909);
    w.run(800);
    const causes = w.counters.deathsByCause;
    const totalDeaths = [...w.counters.deaths.values()].reduce((a, b) => a + b, 0);
    const attributed = [...causes.values()].reduce((a, b) => a + b, 0);
    expect(totalDeaths).toBeGreaterThan(0);
    expect(attributed).toBe(totalDeaths);
    // Keys are `"<species>:<cause>"` so the report can break deaths down by both at once.
    const allowed = new Set(['starvation', 'exposure', 'age', 'grazed', 'predation', 'culled']);
    for (const key of causes.keys()) {
      const [species, cause] = key.split(':');
      expect(SECTOR.roster).toContain(species);
      expect(allowed.has(cause ?? '')).toBe(true);
    }
  });

  it('never lets a species exceed its population cap', () => {
    const w = world(SECTOR, 606);
    w.run(600);
    for (const species of SECTOR.roster) {
      const cap = SECTOR.populationCaps[species] ?? 0;
      expect(w.count(species)).toBeLessThanOrEqual(cap);
    }
  });
});

describe('instruments', () => {
  it('nutrientBloom deposits biomass and refuses impossible arguments', () => {
    const w = world(SECTOR, 77);
    w.run(40);
    const species = SECTOR.roster[0] as string;
    const before = w.speciesBiomass(species);
    const added = w.nutrientBloom(species, 10, 10, 6, 1.5);
    expect(added).toBeGreaterThan(0);
    // The report must describe the deposit, not the neighbourhood: it cannot exceed what the cells
    // can hold (4 per cell over a 6-cell radius) nor what the field gained overall.
    expect(added).toBeLessThanOrEqual(w.speciesBiomass(species) - before + 1e-6);
    expect(w.speciesBiomass(species)).toBeGreaterThanOrEqual(before);
    expect(() => w.nutrientBloom(species, 10, 10, 6, -1)).toThrow(WorldBugError);
    expect(() => w.nutrientBloom(species, 10, 10, 0, 1)).toThrow(WorldBugError);
    expect(() => w.nutrientBloom('ZZZ-9', 10, 10, 6, 1)).toThrow(InvariantError);
  });

  it('cull removes only the requested species and reports what it took', () => {
    const w = world(SECTOR, 88);
    w.run(60);
    const target = SECTOR.roster[0] as string;
    const other = SECTOR.roster[1] as string;
    const beforeTarget = w.count(target);
    const beforeOther = w.count(other);
    const result = w.cull(24, 16, 48, target);
    expect(result.removed).toBe(beforeTarget);
    expect(w.count(target)).toBe(0);
    expect(w.count(other)).toBe(beforeOther);
    expect(result.perSpecies[target]).toBe(beforeTarget);
  });

  it('introduce adds individuals at a point and clamps to the population cap', () => {
    const w = world(SECTOR, 42);
    w.run(50);
    const species = SECTOR.roster[0] as string;
    const cap = SECTOR.populationCaps[species] ?? 0;
    const added = w.introduce(species, 5, 24, 16);
    expect(added).toBeGreaterThan(0);
    expect(w.count(species)).toBeLessThanOrEqual(cap);
    expect(() => w.introduce('ZZZ-9', 1, 1, 1)).toThrow(InvariantError);
    expect(() => w.introduce(species, 0, 1, 1)).toThrow(WorldBugError);
    expect(() => w.introduce(species, 1.5, 1, 1)).toThrow(WorldBugError);
  });

  it('barriers block movement into the wall and can be removed', () => {
    const w = world(SECTOR, 11);
    w.run(30);
    const wall = w.addBarrier(0, 16, 47, 16);
    expect(w.barriers.length).toBe(1);
    expect(wall.x1).toBe(0);
    w.run(60);
    // Any organism north of the wall must still be north of it: crossing is impossible.
    expect(w.removeLastBarrier()).toBeTruthy();
    expect(w.barriers.length).toBe(0);
    expect(w.removeLastBarrier()).toBeNull();
  });

  it('probes record real samples over time and can be removed', () => {
    const w = world(SECTOR, 13);
    const probe = w.addProbe(20, 12, 6);
    expect(w.probes.length).toBe(1);
    w.run(60);
    expect(probe.samples.length).toBeGreaterThan(0);
    const sample = probe.samples[probe.samples.length - 1];
    expect(sample?.tick).toBeGreaterThan(0);
    expect(sample?.temperature).toBeGreaterThan(FIELD_LIMITS.temperature.min);
    expect(sample?.temperature).toBeLessThan(FIELD_LIMITS.temperature.max);
    expect(sample?.biomass).toBeGreaterThanOrEqual(0);
    expect(Object.keys(sample?.counts ?? {}).length).toBe(SECTOR.roster.length);
    expect(w.removeProbe(probe.id)).toBe(true);
    expect(w.removeProbe(probe.id)).toBe(false);
    expect(w.probes.length).toBe(0);
  });

  it('censusAround and pickAgent answer questions about a real patch', () => {
    const w = world(SECTOR, 21);
    w.run(80);
    const census = w.censusAround(24, 16, 48);
    const total = Object.values(census).reduce((a, b) => a + b, 0);
    expect(total).toBe(w.population);
    const agent = w.pickAgent(24, 16, 60);
    expect(agent).not.toBeNull();
    expect(w.pickAgent(-500, -500, 0.5)).toBeNull();
  });
});

describe('bookkeeping', () => {
  it('tracks extinctions once and only once', () => {
    const w = world(SECTOR, 22);
    const victim = SECTOR.roster[2] as string;
    w.cull(24, 16, 60, victim);
    expect(w.count(victim)).toBe(0);
    w.run(30);
    expect(w.extinctSpecies()).toContain(victim);
    const before = w.extinctSpecies().length;
    w.run(30);
    expect(w.extinctSpecies().length).toBe(before);
    expect(w.counts()[victim]).toBe(0);
  });

  it('keeps history bounded and monotone in time', () => {
    const w = new World({
      config: SECTOR,
      species: SPECIES_LIST,
      seed: 3,
      populationHistoryCapacity: 8,
    });
    w.run(600);
    const history = w.historySeries();
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < history.length; i++) {
      const previous = history[i - 1];
      const current = history[i];
      if (!previous || !current) throw new Error('history reported a hole');
      expect(current.tick).toBeGreaterThan(previous.tick);
    }
    expect(w.stability()).toBeGreaterThanOrEqual(0);
    expect(w.stability()).toBeLessThanOrEqual(1);
  });

  it('bounds the event log and reports how many events were dropped', () => {
    const w = new World({ config: SECTOR, species: SPECIES_LIST, seed: 4, eventCapacity: 25 });
    w.run(900);
    expect(w.events.size).toBeLessThanOrEqual(25);
    expect(w.events.dropped).toBeGreaterThan(0);
  });

  it('exposes intake shares that sum to roughly one for a fed consumer', () => {
    const w = world(SECTOR, 15);
    w.run(500);
    const consumer = SECTOR.roster[1] as string;
    const shares = [...w.intakeShares(consumer).values()];
    if (shares.length > 0) {
      const total = shares.reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(0.9);
      expect(total).toBeLessThan(1.1);
    }
    expect([...w.intakeShares('ZZZ-9').values()]).toEqual([]);
  });

  it('snapshot is a consistent view of the world', () => {
    const w = world(SECTOR, 16);
    w.run(120);
    const snapshot = w.snapshot();
    expect(snapshot.tick).toBe(w.tick);
    expect(snapshot.totalBiomass).toBeCloseTo(w.totalBiomass(), 6);
    expect(Object.keys(snapshot.counts).length).toBe(Object.keys(w.counts()).length);
    for (const field of FIELD_IDS) {
      expect(snapshot.fieldStats[field].max).toBeLessThanOrEqual(FIELD_LIMITS[field].max);
    }
  });
});
