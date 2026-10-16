import { describe, expect, it } from 'vitest';
import type { FieldId } from '../../src/core/field.ts';
import { ContentError } from '../../src/core/errors.ts';
import {
  FIELD_LIMITS,
  TERRAIN_PROFILES,
  assertValidSector,
  buildFields,
  computeFieldDistributions,
  requireSectorById,
  validateSector,
} from '../../src/core/sim/sector.ts';
import { SECTORS } from '../../src/content/sectors.ts';
import { SPECIES_BY_ID } from '../../src/content/species.ts';
import { World } from '../../src/core/sim/world.ts';
import { SPECIES_LIST } from '../../src/content/species.ts';
import type { SectorConfig } from '../../src/core/sim/sector.ts';

const first = SECTORS[0] as SectorConfig;

/** Clones a real sector with one field broken, so every test exercises a *rejected* configuration. */
function broken(overrides: Partial<SectorConfig>): SectorConfig {
  return { ...first, ...overrides };
}

function problemsFor(config: SectorConfig): string[] {
  return validateSector(config, SPECIES_BY_ID);
}

describe('shipped sectors', () => {
  it('all of them validate, with unique ids and 1-based campaign order', () => {
    const ids = new Set<string>();
    for (const sector of SECTORS) {
      expect(validateSector(sector, SPECIES_BY_ID)).toEqual([]);
      expect(() => assertValidSector(sector, SPECIES_BY_ID)).not.toThrow();
      expect(ids.has(sector.id)).toBe(false);
      ids.add(sector.id);
    }
    const indexes = SECTORS.map((sector) => sector.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it('chains unlocks so the campaign is reachable in order', () => {
    for (const sector of SECTORS) {
      if (sector.index === 1) {
        expect(sector.unlockAfter).toBeNull();
        continue;
      }
      const previous = SECTORS.find((s) => s.index === sector.index - 1);
      expect(previous, `sector ${sector.id} has no predecessor`).toBeTruthy();
      expect(sector.unlockAfter).toBe(previous?.id);
    }
  });

  it('starts every species with a positive population the caps can hold', () => {
    for (const sector of SECTORS) {
      for (const species of sector.roster) {
        const start = sector.initialPopulations[species] ?? 0;
        const cap = sector.populationCaps[species] ?? 0;
        expect(start).toBeGreaterThan(0);
        expect(cap).toBeGreaterThanOrEqual(start);
      }
    }
  });
});

describe('validateSector rejection cases', () => {
  it('reports an empty id, bad index, bad dimensions and bad seed', () => {
    expect(problemsFor(broken({ id: '' })).join()).toMatch(/id must not be empty/);
    expect(problemsFor(broken({ index: 0 })).join()).toMatch(/index must be >= 1/);
    expect(problemsFor(broken({ width: 4 })).join()).toMatch(/width must be an integer in/);
    expect(problemsFor(broken({ height: 200 })).join()).toMatch(/height must be an integer in/);
    expect(problemsFor(broken({ seed: 1.5 })).join()).toMatch(/seed must be an integer/);
  });

  it('reports an unknown or duplicated species', () => {
    const roster = [...first.roster, 'ZZZ-9'];
    expect(problemsFor(broken({ roster })).join()).toMatch(/unknown species "ZZZ-9"/);
    const duplicated = [first.roster[0] as string, first.roster[0] as string];
    expect(problemsFor(broken({ roster: duplicated })).join()).toMatch(/listed twice/);
  });

  it('reports population tables that disagree with the roster', () => {
    expect(
      problemsFor(broken({ initialPopulations: { ...first.initialPopulations, 'ZZZ-9': 5 } })).join(),
    ).toMatch(/initialPopulations mentions "ZZZ-9"/);
    expect(
      problemsFor(broken({ populationCaps: { ...first.populationCaps, 'ZZZ-9': 5 } })).join(),
    ).toMatch(/populationCaps mentions "ZZZ-9"/);
    const species = first.roster[0] as string;
    expect(
      problemsFor(broken({ populationCaps: { ...first.populationCaps, [species]: 1 } })).join(),
    ).toMatch(/cap for .* must be an integer >= its initial population/);
    expect(
      problemsFor(broken({ initialPopulations: { ...first.initialPopulations, [species]: 0 } })).join(),
    ).toMatch(/initial population for/);
  });

  it('reports a baseline outside physical limits', () => {
    const limits = FIELD_LIMITS.temperature;
    const baseline = { ...first.baseline, temperature: limits.max + 10 };
    expect(problemsFor(broken({ baseline })).join()).toMatch(/baseline temperature=/);
  });

  it('reports malformed terrain sources', () => {
    const base = { ...(first.sources[0] as (typeof first.sources)[number]) };
    expect(problemsFor(broken({ sources: [{ ...base, id: 'dup' }, { ...base, id: 'dup' }] })).join())
      .toMatch(/duplicate terrain source id/);
    expect(problemsFor(broken({ sources: [{ ...base, x: -1 }] })).join()).toMatch(/outside the grid/);
    expect(problemsFor(broken({ sources: [{ ...base, radius: 0 }] })).join()).toMatch(/needs a radius/);
    expect(problemsFor(broken({ sources: [{ ...base, strength: 0 }] })).join()).toMatch(/non-zero strength/);
    expect(problemsFor(broken({ sources: [{ ...base, persistence: 0.9 }] })).join())
      .toMatch(/persistence must be in/);
  });

  it('reports malformed environmental pulses', () => {
    const config = SECTORS[1] as SectorConfig;
    const base = { ...(config.pulses[0] as (typeof config.pulses)[number]) };
    const withPulses = (pulses: SectorConfig['pulses']) => ({ ...config, pulses });
    expect(problemsFor(withPulses([{ ...base, id: 'x' }, { ...base, id: 'x' }])).join()).toMatch(
      /duplicate pulse id/,
    );
    expect(problemsFor(withPulses([{ ...base, period: 10 }])).join()).toMatch(/period must be >= 120/);
    expect(problemsFor(withPulses([{ ...base, amount: 0 }])).join()).toMatch(/amount must be non-zero/);
    expect(problemsFor(withPulses([{ ...base, x: 999 }])).join()).toMatch(/origin is outside the grid/);
  });

  it('refuses a sector too sparse to survey, or with no instruments', () => {
    const scarce = Object.fromEntries(Object.keys(first.initialPopulations).map((id) => [id, 1]));
    expect(problemsFor(broken({ initialPopulations: scarce })).join()).toMatch(
      /initial population .* is too sparse/,
    );
    expect(problemsFor(broken({ instruments: [] })).join()).toMatch(/at least one instrument/);
    expect(problemsFor(broken({ startingCharge: 0 })).join()).toMatch(/startingCharge must be positive/);
    expect(problemsFor(broken({ surveyTicks: 10 })).join()).toMatch(/surveyTicks must allow a real experiment/);
    expect(problemsFor(broken({ difficulty: 9 as 1 })).join()).toMatch(/difficulty must be in \[1, 5\]/);
  });

  it('refuses a consumer whose prey is absent from the roster', () => {
    // FER-7 eats AUR-3 only; dropping AUR-3 from a roster that still lists FER-7 must be rejected.
    const predatorOnly = first.roster.filter((id) => id !== 'AUR-3');
    const problems = problemsFor(broken({ roster: predatorOnly })).join();
    expect(problems).toMatch(/consumer "FER-7" has none of its diet species on the roster/);
  });

  it('assertValidSector throws a ContentError naming every problem', () => {
    try {
      assertValidSector(broken({ width: 4, height: 4 }), SPECIES_BY_ID);
      expect.unreachable('assertValidSector should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ContentError);
      const message = (error as Error).message;
      expect(message).toMatch(/width must be an integer in/);
      expect(message).toMatch(/height must be an integer in/);
    }
  });
});

describe('requireSectorById', () => {
  it('returns the sector and throws a ContentError for an unknown id', () => {
    expect(requireSectorById(SECTORS, first.id)).toBe(first);
    expect(() => requireSectorById(SECTORS, 'NOPE-0')).toThrow(ContentError);
    expect(() => requireSectorById(SECTORS, 'NOPE-0')).toThrow(/unknown sector/i);
  });
});

describe('field construction', () => {
  it('is deterministic and applies the terrain polarity of every source', () => {
    for (const sector of SECTORS) {
      const a = buildFields(sector);
      const b = buildFields(sector);
      for (const id of ['temperature', 'humidity', 'light'] as const) {
        expect(Array.from(a[id].data)).toEqual(Array.from(b[id].data));
      }
      for (const source of sector.sources) {
        const profile = TERRAIN_PROFILES[source.kind];
        const field = a[profile.field];
        const atSource = field.getAt(source.x, source.y);
        const baseline = sector.baseline[profile.field];
        const delta = atSource - baseline;
        expect(Math.sign(delta), `${sector.id}/${source.id} polarity`).toBe(
          Math.sign(profile.polarity * source.strength),
        );
      }
    }
  });

  it('clamps everything inside physical limits', () => {
    for (const sector of SECTORS) {
      const fields = buildFields(sector);
      for (const id of ['temperature', 'humidity', 'light'] as const) {
        const limits = FIELD_LIMITS[id];
        const stats = fields[id].stats();
        expect(stats.min).toBeGreaterThanOrEqual(limits.min);
        expect(stats.max).toBeLessThanOrEqual(limits.max);
      }
    }
  });
});

describe('computeFieldDistributions', () => {
  it('produces normalised weights whose mean lies inside the sampled range', () => {
    for (const sector of SECTORS) {
      const distributions = computeFieldDistributions(sector);
      for (const id of ['temperature', 'humidity', 'light'] as FieldId[]) {
        const distribution = distributions[id];
        const total = distribution.weights.reduce((sum, weight) => sum + weight, 0);
        expect(total).toBeCloseTo(1, 9);
        expect(distribution.mean).toBeGreaterThanOrEqual(distribution.min);
        expect(distribution.mean).toBeLessThanOrEqual(distribution.max);
        expect(distribution.bins).toBe(32);
      }
    }
  });

  it('is cached per sector id (same object, no recomputation)', () => {
    const sector = SECTORS[3] as SectorConfig;
    const a = computeFieldDistributions(sector);
    const b = computeFieldDistributions(sector);
    expect(a).toBe(b);
  });
});

describe('pulses reach the world', () => {
  it('a pulse raises the field near its epicentre on its scheduled tick', () => {
    const sector = SECTORS[1] as SectorConfig;
    const pulse = sector.pulses[0];
    if (!pulse) throw new Error('KEL-4 must define a pulse for this test to mean anything');
    const world = new World({ config: sector, species: SPECIES_LIST, seed: sector.seed });
    const atEpicentre = () => world.fields[pulse.field].sampleBilinear(pulse.x + 0.5, pulse.y + 0.5);

    // `step()` advances the tick *before* applying pulses, so a pulse lands exactly at `phase`.
    if (pulse.phase > 0) world.run(pulse.phase - 1);
    expect(world.tick).toBe(pulse.phase - 1);
    const before = atEpicentre();
    world.step();
    const after = atEpicentre();

    expect(Math.sign(pulse.amount)).toBe(1);
    // The impulse must survive the physical clamp: less than half of it arriving means the content
    // placed the pulse on saturated ground and the event is invisible (validateSector rejects this).
    expect(after - before).toBeGreaterThan(Math.abs(pulse.amount) * 0.5);
    const pulses = world.events.toArray().filter((event) => event.kind === 'pulse');
    expect(pulses.length).toBe(1);
    expect(pulses[0]?.message).toMatch(/surge \+/);

    // ... and the environment relaxes back afterwards, so the flare is an event, not a state change.
    world.run(pulse.period + 60);
    expect(atEpicentre()).toBeLessThan(after);
  });
});
