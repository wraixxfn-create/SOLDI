import { describe, expect, it } from 'vitest';
import { World as WorldImplementation } from '../../src/core/sim/world.ts';
import { SECTORS } from '../../src/content/sectors.ts';
import { SPECIES_LIST } from '../../src/content/species.ts';
import { emptySave } from '../../src/game/persistence.ts';
import type { Challenge, SimulationState, World } from '../../src/domain/contracts.ts';
import { validateChallengeData, validatePlayerProgress } from '../../src/domain/validation.ts';

const firstSector = SECTORS.find((sector) => sector.index === 1);
if (!firstSector) throw new Error('Expected an authored first sector');

function cloneSector(): Record<string, unknown> {
  return structuredClone(firstSector) as unknown as Record<string, unknown>;
}

describe('domain contracts and runtime boundary validation', () => {
  it('accepts a valid authored challenge and derives rules from its validated sector', () => {
    const result = validateChallengeData({ sector: cloneSector() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const challenge: Challenge = result.value;
    expect(challenge.id).toBe(firstSector.id);
    expect(challenge.environment.width).toBe(firstSector.width);
    expect(challenge.environment.resources).toEqual(firstSector.resources);
    expect(challenge.environment.rules).toEqual(firstSector.rules);
    expect(challenge.rules.length).toBeGreaterThan(0);
    expect(challenge.objective.mustKeepOneSpeciesAlive).toBe(true);
  });

  it('rejects malformed or semantically invalid imported data without throwing', () => {
    expect(validateChallengeData(null)).toMatchObject({ ok: false });

    const malformed = cloneSector();
    malformed.sources = [{ id: 'broken', kind: 'not-a-terrain-kind' }];
    const result = validateChallengeData(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain('sources[0]');

    const invalidSector = cloneSector();
    invalidSector.width = 3;
    expect(validateChallengeData(invalidSector)).toMatchObject({ ok: false });

    const unsafeRules = cloneSector();
    unsafeRules.rules = [{
      id: 'unsafe',
      priority: 1,
      mode: 'stack',
      group: null,
      frequency: 'each-turn',
      prerequisites: { type: 'script', source: 'throw new Error()' },
      effects: [{ type: 'run-code', source: 'arbitrary level code' }],
    }];
    const unsafeResult = validateChallengeData(unsafeRules);
    expect(unsafeResult.ok).toBe(false);
    if (!unsafeResult.ok) expect(unsafeResult.issues.join(' ')).toMatch(/not supported/);
  });

  it('validates progress through the save schema and rejects unsupported versions', () => {
    const accepted = validatePlayerProgress(emptySave());
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value.version).toBe(1);

    expect(validatePlayerProgress({ version: 900, unlockedSectors: [] })).toMatchObject({ ok: false });
  });

  it('keeps public world and snapshot contracts structurally compatible with the simulation', () => {
    const concrete = new WorldImplementation({
      config: firstSector,
      species: SPECIES_LIST,
      seed: firstSector.seed,
    });
    // The type assignments are the compile-time contract; assertions also prove the runtime methods.
    const world: World = concrete;
    const snapshot: SimulationState = world.snapshot();
    expect(snapshot.tick).toBe(0);
    expect(world.config.id).toBe(firstSector.id);
  });
});
