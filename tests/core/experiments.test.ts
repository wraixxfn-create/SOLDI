import { describe, expect, it } from 'vitest';
import { ExperimentLedger } from '../../src/core/sim/experiments.ts';
import { assertValidResourceConfig } from '../../src/core/sim/resources.ts';
import { STARTER_WORLD } from '../../src/content/starter-ecosystem.ts';

describe('reference engine scenarios', () => {
  const scenarios = [
    ['empty label is rejected', () => expect(() => new ExperimentLedger().begin('', 'x', 0, {})).toThrow()],
    ['duplicate experiment id is rejected', () => { const l = new ExperimentLedger(); l.begin('a', 'A', 0, {}); expect(() => l.begin('a', 'again', 0, {})).toThrow(); }],
    ['invalid start tick is rejected', () => expect(() => new ExperimentLedger().begin('a', 'A', -1, {})).toThrow()],
    ['non-finite start tick is rejected', () => expect(() => new ExperimentLedger().begin('a', 'A', Infinity, {})).toThrow()],
    ['actions are sequence ordered', () => { const l = new ExperimentLedger(); l.begin('a', 'A', 0, {}); expect(l.record('a', 1, 'advance', 1).sequence).toBe(1); }],
    ['payloads are copied', () => { const l = new ExperimentLedger<{ v: number }, { n: number }>(); const p = { n: 1 }; l.begin('a', 'A', 0, { v: 0 }); l.record('a', 1, 'set', p); p.n = 9; expect(l.get('a').actions[0]?.payload.n).toBe(1); }],
    ['finished result is immutable copy', () => { const l = new ExperimentLedger<{ v: number }>(); l.begin('a', 'A', 0, { v: 0 }); const state = { v: 2 }; l.finish('a', 2, state); state.v = 8; expect(l.get('a').end?.state.v).toBe(2); }],
    ['cannot append after finish', () => { const l = new ExperimentLedger(); l.begin('a', 'A', 0, {}); l.finish('a', 1, {}); expect(() => l.record('a', 1, 'x', {})).toThrow(); }],
    ['compare equal runs', () => { const l = new ExperimentLedger<{ count: number }>(); for (const id of ['a', 'b']) { l.begin(id, id, 0, { count: 0 }); l.finish(id, 5, { count: 3 }); } expect(l.compare('a', 'b')).toEqual({ equal: true, tickDelta: 0 }); }],
    ['compare different runs', () => { const l = new ExperimentLedger<{ count: number }>(); for (const [id, count] of [['a', 1], ['b', 2]] as const) { l.begin(id, id, 0, { count: 0 }); l.finish(id, count, { count }); } expect(l.compare('a', 'b').equal).toBe(false); }],
    ['replay dispatches actions in order', () => { const seen: number[] = []; ExperimentLedger.replay([{ sequence: 1, tick: 1, kind: 'x', payload: 1 }, { sequence: 2, tick: 2, kind: 'x', payload: 2 }], (a) => seen.push(a.payload)); expect(seen).toEqual([1, 2]); }],
    ['undo restores checkpoint then replays prefix', () => { let n = 99; ExperimentLedger.undo(0, [{ sequence: 1, tick: 1, kind: 'add', payload: 2 }, { sequence: 2, tick: 2, kind: 'add', payload: 8 }], 1, (s) => { n = s; }, (a) => { n += a.payload; }); expect(n).toBe(2); }],
  ] as const;
  it.each(scenarios)('%s', (_name, run) => run());

  it('resource config rejects NaN, infinity, and out-of-capacity values', () => {
    expect(() => assertValidResourceConfig({ ...STARTER_WORLD.resources, water: { ...STARTER_WORLD.resources.water, initial: NaN } })).toThrow();
    expect(() => assertValidResourceConfig({ ...STARTER_WORLD.resources, nutrients: { ...STARTER_WORLD.resources.nutrients, regeneration: Infinity } })).toThrow();
    expect(() => assertValidResourceConfig({ ...STARTER_WORLD.resources, water: { ...STARTER_WORLD.resources.water, initial: 2 } })).toThrow();
    expect(() => assertValidResourceConfig(STARTER_WORLD.resources)).not.toThrow();
  });
});
