import { describe, expect, it } from 'vitest';
import {
  approach,
  bellFit,
  clamp,
  clamp01,
  clampIndex,
  dist,
  dist2,
  finite,
  formatNumber,
  inRect,
  invLerp,
  lerp,
  mean,
  percentChange,
  roundTo,
  safeDiv,
  smoothstep,
  stdev,
  valueNoise2D,
  wrap,
} from '../../src/core/math.ts';

describe('clamping and interpolation', () => {
  it('clamp bounds values and tolerates inverted or degenerate ranges', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
    expect(clamp(0.5, 0, 0)).toBe(0);
    expect(clamp(3, 10, 0)).toBe(3); // inverted bounds are normalised, not swapped blindly
  });

  it('clamp01 is the unit-range case', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(9)).toBe(1);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('lerp / invLerp are inverses', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.25)).toBeCloseTo(12.5, 12);
    expect(invLerp(10, 20, 12.5)).toBeCloseTo(0.25, 12);
    expect(invLerp(0, 0, 5)).toBe(0); // degenerate range: no NaN
  });

  it('smoothstep is clamped, monotone and flat at both ends', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(-2)).toBe(0);
    expect(smoothstep(3)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 12);
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const value = smoothstep(t);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = value;
    }
  });

  it('approach moves toward the target without overshooting', () => {
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(0, 10, 100)).toBe(10);
    expect(approach(10, 0, 4)).toBe(6);
    expect(approach(5, 5, 1)).toBe(5);
    expect(approach(0, 10, 0)).toBe(0);
  });
});

describe('numeric safety', () => {
  it('safeDiv returns the fallback on a zero denominator', () => {
    expect(safeDiv(6, 3)).toBe(2);
    expect(safeDiv(6, 0)).toBe(0);
    expect(safeDiv(6, 0, -1)).toBe(-1);
    expect(safeDiv(Number.NaN, 2)).toBe(0);
    expect(safeDiv(1, Number.NaN)).toBe(0);
  });

  it('finite replaces NaN and infinities', () => {
    expect(finite(3.5)).toBe(3.5);
    expect(finite(Number.NaN, 7)).toBe(7);
    expect(finite(Number.POSITIVE_INFINITY, 7)).toBe(7);
    expect(finite(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('bellFit peaks at the ideal value and vanishes at the width', () => {
    expect(bellFit(312, 312, 40)).toBe(1);
    expect(bellFit(312 + 40, 312, 40)).toBe(0);
    expect(bellFit(312 - 40, 312, 40)).toBe(0);
    expect(bellFit(312 + 20, 312, 40)).toBeCloseTo(0.5, 12);
    expect(bellFit(0, 312, 40)).toBe(0); // far outside never goes negative
    expect(bellFit(312, 312, 0)).toBe(1); // zero width means exact match only
    expect(bellFit(400, 312, 0)).toBe(0);
  });

  it('wrap and clampIndex keep indices in range', () => {
    expect(wrap(5, 4)).toBe(1);
    expect(wrap(-1, 4)).toBe(3);
    expect(wrap(4, 4)).toBe(0);
    expect(wrap(2, 0)).toBe(0);
    expect(clampIndex(-3, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(2, 5)).toBe(2);
  });
});

describe('statistics helpers', () => {
  it('mean and stdev handle empty and single-value input', () => {
    expect(mean([])).toBe(0);
    expect(mean([4])).toBe(4);
    expect(mean([1, 2, 3, 4])).toBeCloseTo(2.5, 12);
    expect(stdev([])).toBe(0);
    expect(stdev([7])).toBe(0);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 6);
  });

  it('percentChange reports relative change and survives a zero baseline', () => {
    expect(percentChange(100, 150)).toBeCloseTo(0.5, 12);
    expect(percentChange(100, 50)).toBeCloseTo(-0.5, 12);
    expect(percentChange(0, 5)).toBe(1); // growth from nothing is reported as +100 %
    expect(percentChange(0, 0)).toBe(0);
  });

  it('roundTo and formatNumber produce stable display strings', () => {
    expect(roundTo(1.2345, 2)).toBe(1.23);
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(formatNumber(1.2345)).toBe('1.2');
    expect(formatNumber(1.2345, 3)).toBe('1.235');
    expect(formatNumber(Number.NaN)).toBe('—'); // em dash, so the UI can show "no reading"
  });
});

describe('geometry and noise', () => {
  it('dist and dist2 agree', () => {
    expect(dist2(0, 0, 3, 4)).toBe(25);
    expect(dist(0, 0, 3, 4)).toBe(5);
    expect(dist2(1, 1, 1, 1)).toBe(0);
  });

  it('inRect is inclusive on all four edges', () => {
    expect(inRect(0, 0, 0, 0, 10, 10)).toBe(true);
    expect(inRect(9.9, 9.9, 0, 0, 10, 10)).toBe(true);
    expect(inRect(10, 10, 0, 0, 10, 10)).toBe(true);
    expect(inRect(10.01, 5, 0, 0, 10, 10)).toBe(false);
    expect(inRect(-0.1, 5, 0, 0, 10, 10)).toBe(false);
  });

  it('valueNoise2D is deterministic, in [0, 1) and varies across the grid', () => {
    const seen = new Set<number>();
    for (let x = 0; x < 40; x++) {
      for (let y = 0; y < 40; y++) {
        const value = valueNoise2D(x, y, 1234);
        expect(value).toBe(valueNoise2D(x, y, 1234));
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
        seen.add(Math.round(value * 100));
      }
    }
    expect(seen.size).toBeGreaterThan(50);
    expect(valueNoise2D(3, 7, 1)).not.toBe(valueNoise2D(3, 7, 2));
  });
});
