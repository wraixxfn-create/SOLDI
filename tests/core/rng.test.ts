import { describe, expect, it } from 'vitest';
import { Rng, deriveSeed, hashSeed, mulberry32, streamId } from '../../src/core/rng.ts';

describe('mulberry32', () => {
  it('is deterministic for a given seed and stays in [0, 1)', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('produces different streams for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let differences = 0;
    for (let i = 0; i < 100; i++) {
      if (a() !== b()) differences++;
    }
    expect(differences).toBeGreaterThan(90);
  });

  it('handles seed 0 and negative seeds without collapsing', () => {
    for (const seed of [0, -1, -123456789, 4294967295]) {
      const rng = mulberry32(seed);
      const values = new Set<number>();
      for (let i = 0; i < 50; i++) values.add(rng());
      expect(values.size).toBeGreaterThan(40);
    }
  });
});

describe('hashSeed / streamId / deriveSeed', () => {
  it('hashes strings and numbers to unsigned 32-bit integers', () => {
    for (const input of ['temperature', 'VOX-9', 0, 42, -7]) {
      const hash = hashSeed(input);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('is stable across calls (FNV-1a, no per-process salt)', () => {
    expect(hashSeed('lumen-reef')).toBe(hashSeed('lumen-reef'));
    expect(hashSeed('lumen-reef')).not.toBe(hashSeed('lumen-reef '));
  });

  it('derives independent streams from a base seed and a label', () => {
    const base = 0xc0da49b2;
    const a = deriveSeed(base, 'field/temperature');
    const b = deriveSeed(base, 'field/humidity');
    expect(a).not.toBe(b);
    expect(deriveSeed(base, 'field/temperature')).toBe(a);
    expect(streamId('agents', 3)).not.toBe(streamId('agents', 4));
  });
});

describe('Rng', () => {
  const make = () => new Rng(0xabcdef);

  it('unit() is uniform-ish and deterministic per seed', () => {
    const a = make();
    const b = make();
    let sum = 0;
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 20000; i++) {
      const value = a.unit();
      expect(value).toBe(b.unit());
      sum += value;
      const bucket = Math.min(9, Math.floor(value * 10));
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    expect(sum / 20000).toBeCloseTo(0.5, 1);
    for (const count of buckets) expect(count).toBeGreaterThan(1400);
  });

  it('int() respects inclusive bounds and covers every value', () => {
    const r = make();
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const value = r.int(3, 7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      seen.add(value);
    }
    expect(seen.size).toBe(5);
    // Degenerate bounds must not throw or escape the range.
    expect(r.int(4, 4)).toBe(4);
    expect(r.int(9, 2)).toBe(9);
  });

  it('range() stays within bounds and covers the interval', () => {
    const r = make();
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 5000; i++) {
      const value = r.range(-2, 5);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    expect(min).toBeGreaterThanOrEqual(-2);
    expect(max).toBeLessThan(5);
    expect(min).toBeLessThan(-1.5);
    expect(max).toBeGreaterThan(4.5);
  });

  it('around() is centred on zero and bounded by its radius', () => {
    const r = make();
    let sum = 0;
    let extreme = 0;
    for (let i = 0; i < 10000; i++) {
      const value = r.around(0.4);
      sum += value;
      extreme = Math.max(extreme, Math.abs(value));
    }
    expect(Math.abs(sum / 10000)).toBeLessThan(0.02);
    expect(extreme).toBeLessThanOrEqual(0.4);
    expect(extreme).toBeGreaterThan(0.39);
  });

  it('chance() is sharply bounded at 0 and 1 and matches its probability', () => {
    const r = make();
    for (let i = 0; i < 200; i++) {
      expect(r.chance(0)).toBe(false);
      expect(r.chance(1)).toBe(true);
      expect(r.chance(-3)).toBe(false);
      expect(r.chance(4)).toBe(true);
    }
    let hits = 0;
    const trials = 40000;
    for (let i = 0; i < trials; i++) if (r.chance(0.25)) hits++;
    expect(hits / trials).toBeGreaterThan(0.23);
    expect(hits / trials).toBeLessThan(0.27);
  });

  it('pick() returns members of the array and throws on an empty one', () => {
    const r = make();
    const options = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const picked = r.pick(options);
      expect(options).toContain(picked);
      seen.add(picked);
    }
    expect(seen.size).toBe(3);
    expect(() => r.pick([])).toThrow(/empty/i);
  });

  it('gauss() is centred, symmetric-ish and never runs away', () => {
    const r = make();
    let sum = 0;
    let extreme = 0;
    let negative = 0;
    for (let i = 0; i < 20000; i++) {
      const value = r.gauss();
      sum += value;
      if (value < 0) negative++;
      extreme = Math.max(extreme, Math.abs(value));
    }
    expect(Math.abs(sum / 20000)).toBeLessThan(0.05);
    expect(negative / 20000).toBeGreaterThan(0.45);
    expect(negative / 20000).toBeLessThan(0.55);
    expect(extreme).toBeLessThanOrEqual(1.74);
  });

  it('fork() gives deterministic, independent child streams', () => {
    const parent = make();
    expect(parent.fork('agents', 0).unit()).toBe(parent.fork('agents', 0).unit());
    expect(parent.fork('agents', 0).unit()).not.toBe(parent.fork('agents', 1).unit());
    // Forking must not consume the parent's own sequence.
    const control = new Rng(0xabcdef);
    parent.fork('agents', 0);
    expect(parent.unit()).toBe(control.unit());
  });
});
