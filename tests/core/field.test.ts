import { describe, expect, it } from 'vitest';
import { ScalarField, fieldExtrema } from '../../src/core/field.ts';

function grid(values: number[][]): ScalarField {
  const field = new ScalarField(values[0]?.length ?? 0, values.length);
  values.forEach((row, y) => row.forEach((value, x) => field.setAt(x, y, value)));
  return field;
}

describe('ScalarField construction and access', () => {
  it('rejects invalid dimensions instead of allocating a broken buffer', () => {
    expect(() => new ScalarField(0, 4)).toThrow(/positive integer dimensions/);
    expect(() => new ScalarField(4, -1)).toThrow(/positive integer dimensions/);
    expect(() => new ScalarField(4.5, 4)).toThrow(/positive integer dimensions/);
  });

  it('fills with an initial value and reports its length', () => {
    const field = new ScalarField(4, 3, 2.5);
    expect(field.length).toBe(12);
    expect(field.getAt(0, 0)).toBe(2.5);
    expect(field.getAt(3, 2)).toBe(2.5);
  });

  it('clamps out-of-range coordinates instead of returning undefined', () => {
    const field = grid([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(field.getAt(-5, -5)).toBe(1);
    expect(field.getAt(99, 99)).toBe(6);
    expect(field.getAt(1.9, 1.9)).toBe(5); // floor semantics: 1.9 lands in cell 1
  });

  it('sanitises non-finite writes', () => {
    const field = new ScalarField(2, 2);
    field.setAt(0, 0, Number.NaN);
    expect(field.getAt(0, 0)).toBe(0);
    field.addAt(0, 0, Number.POSITIVE_INFINITY);
    expect(Number.isFinite(field.getAt(0, 0))).toBe(true);
  });

  it('clone() is a deep copy', () => {
    const field = grid([[1, 2], [3, 4]]);
    const copy = field.clone();
    copy.setAt(1, 1, 99);
    expect(field.getAt(1, 1)).toBe(4);
    expect(copy.getAt(1, 1)).toBe(99);
  });
});

describe('sampleBilinear', () => {
  it('reproduces exact cell values on cell centres', () => {
    const field = grid([
      [0, 10],
      [20, 30],
    ]);
    expect(field.sampleBilinear(0.5, 0.5)).toBeCloseTo(0, 6);
    expect(field.sampleBilinear(1.5, 0.5)).toBeCloseTo(10, 6);
    expect(field.sampleBilinear(0.5, 1.5)).toBeCloseTo(20, 6);
    expect(field.sampleBilinear(1.5, 1.5)).toBeCloseTo(30, 6);
  });

  it('interpolates in the middle of a cell', () => {
    const field = grid([
      [0, 10],
      [20, 30],
    ]);
    expect(field.sampleBilinear(1, 1)).toBeCloseTo(15, 6);
  });

  it('is clamped at the borders (no wrap-around, no extrapolation)', () => {
    const field = grid([
      [0, 10],
      [20, 30],
    ]);
    expect(field.sampleBilinear(-50, -50)).toBeCloseTo(0, 6);
    expect(field.sampleBilinear(50, 50)).toBeCloseTo(30, 6);
    const constant = new ScalarField(4, 4, 7);
    expect(constant.sampleBilinear(2.3, 1.7)).toBeCloseTo(7, 6);
  });
});

describe('blockMean', () => {
  it('averages the square neighbourhood around a cell', () => {
    const field = grid([
      [0, 0, 0],
      [0, 9, 0],
      [0, 0, 0],
    ]);
    expect(field.blockMean(1, 1, 0)).toBeCloseTo(9, 6);
    expect(field.blockMean(1, 1, 1)).toBeCloseTo(1, 6);
  });

  it('clips the block at the borders', () => {
    const field = new ScalarField(3, 3, 4);
    expect(field.blockMean(0, 0, 5)).toBeCloseTo(4, 6);
  });
});

describe('addRadial', () => {
  it('adds a smooth falloff peaking at the centre', () => {
    const field = new ScalarField(9, 9);
    field.addRadial(4, 4, 3, 10);
    const centre = field.getAt(4, 4);
    const edge = field.getAt(6, 4);
    const outside = field.getAt(8, 8);
    expect(centre).toBeCloseTo(10, 4);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(centre);
    expect(outside).toBe(0);
  });

  it('ignores degenerate impulses instead of throwing', () => {
    const field = new ScalarField(4, 4, 1);
    field.addRadial(2, 2, 0, 5);
    field.addRadial(2, 2, 2, Number.NaN);
    field.addRadial(2, 2, 2, 0);
    field.addRadial(2, 2, -3, 5);
    expect(field.getAt(2, 2)).toBe(1);
  });

  it('relax mode pulls values toward the target, never past it', () => {
    const field = new ScalarField(5, 5, 100);
    field.addRadial(2, 2, 2, 0.5, 0);
    expect(field.getAt(2, 2)).toBeCloseTo(50, 4);
    expect(field.getAt(2, 2)).toBeGreaterThanOrEqual(0);
    // Repeated application converges toward the target without overshoot.
    for (let i = 0; i < 50; i++) field.addRadial(2, 2, 2, 0.5, 0);
    expect(field.getAt(2, 2)).toBeGreaterThanOrEqual(0);
    expect(field.getAt(2, 2)).toBeLessThan(1);
  });
});

describe('diffuse / relax / clamp', () => {
  it('diffusion conserves the total and smooths a spike', () => {
    const field = new ScalarField(9, 9);
    field.setAt(4, 4, 81);
    const total = (f: ScalarField) => f.data.reduce((sum, v) => sum + v, 0);
    const before = total(field);
    field.diffuse(0.2);
    expect(total(field)).toBeCloseTo(before, 2);
    expect(field.getAt(4, 4)).toBeLessThan(81);
    expect(field.getAt(3, 4)).toBeGreaterThan(0);
  });

  it('diffusion with rate 0 or negative is a no-op', () => {
    const field = grid([[5]]);
    field.diffuse(0);
    field.diffuse(-1);
    expect(field.getAt(0, 0)).toBe(5);
  });

  it('relaxTowardBaseline approaches the baseline monotonically', () => {
    const field = new ScalarField(4, 4, 10);
    field.relaxTowardBaseline(2, 0.5);
    expect(field.getAt(0, 0)).toBeCloseTo(6, 6);
    field.relaxTowardBaseline(2, 0.5);
    expect(field.getAt(0, 0)).toBeCloseTo(4, 6);
    field.relaxTowardBaseline(2, 0);
    expect(field.getAt(0, 0)).toBeCloseTo(4, 6);
  });

  it('clampTo enforces explicit limits', () => {
    const field = grid([[-5, 0.5, 5]]);
    field.clampTo(0, 1);
    expect(field.getAt(0, 0)).toBe(0);
    expect(field.getAt(1, 0)).toBe(0.5);
    expect(field.getAt(2, 0)).toBe(1);
  });
});

describe('stats', () => {
  it('computes min/max/mean and invalidates its cache on mutation', () => {
    const field = grid([[1, 2, 3]]);
    expect(field.stats()).toEqual({ min: 1, max: 3, mean: 2 });
    field.setAt(0, 0, 10);
    expect(field.stats()).toEqual({ min: 2, max: 10, mean: 5 });
    field.addAt(2, 0, -3);
    expect(field.stats()).toEqual({ min: 0, max: 10, mean: 4 });
    field.fill(2);
    expect(field.stats()).toEqual({ min: 2, max: 2, mean: 2 });
  });

  it('hands out a frozen shared object that callers cannot corrupt', () => {
    const field = grid([[1, 2]]);
    const stats = field.stats();
    expect(field.stats()).toBe(stats); // no per-call allocation
    expect(Object.isFrozen(stats)).toBe(true);
    expect(() => Object.assign(stats, { min: -100 })).toThrow(TypeError);
    expect(field.stats().min).toBe(1);
    expect(fieldExtrema(field)).toEqual({ min: 1, max: 2 });
  });
});

describe('paint', () => {
  const ramp = (value: number): [number, number, number] => [value, value * 2, value * 3];

  it('maps cells to scaled RGBA pixels with the correct stride', () => {
    const field = grid([
      [1, 2],
      [3, 4],
    ]);
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    field.paint(pixels, 2, 2, ramp);
    const pixelAt = (x: number, y: number) => {
      const i = (y * 4 + x) * 4;
      return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
    };
    expect(pixelAt(0, 0)).toEqual([1, 2, 3, 255]);
    expect(pixelAt(1, 0)).toEqual([1, 2, 3, 255]);
    expect(pixelAt(2, 0)).toEqual([2, 4, 6, 255]);
    expect(pixelAt(3, 3)).toEqual([4, 8, 12, 255]);
    expect(pixelAt(0, 2)).toEqual([3, 6, 9, 255]);
  });

  it('rejects invalid scales and undersized buffers', () => {
    const field = grid([[1]]);
    expect(() => field.paint(new Uint8ClampedArray(4), 0, 1, ramp)).toThrow(/positive integer/);
    expect(() => field.paint(new Uint8ClampedArray(4), 1.5, 1, ramp)).toThrow(/positive integer/);
    expect(() => field.paint(new Uint8ClampedArray(3), 1, 1, ramp)).toThrow(/RGBA buffer/);
  });
});
