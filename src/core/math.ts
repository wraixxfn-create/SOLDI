/**
 * Numeric helpers shared by simulation, rendering and UI. Pure, allocation-free, total functions:
 * no helper in this file may return `NaN` or throw for finite numeric input, because these feed the
 * simulation's hot loop and a single NaN would silently poison the whole world.
 */

/** Clamps `value` into [min, max]; tolerates min > max by normalising the bounds. */
export function clamp(value: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (Number.isNaN(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

/** Clamps into [0, 1]. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp clamped to [0, 1]; returns 0 for a degenerate range instead of dividing by zero. */
export function invLerp(a: number, b: number, value: number): number {
  if (b === a) return 0;
  return clamp01((value - a) / (b - a));
}

/** Hermite smoothing of the unit interval. */
export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Safe division: returns `fallback` when the denominator is ~0 or non-finite. */
export function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) return fallback;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : fallback;
}

/** Replaces non-finite values with `fallback` (guards the simulation against NaN propagation). */
export function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Two-sided bell fitness centred on `ideal` with half-width `width`.
 * Returns exactly 1 at the ideal, 0 at and beyond `ideal ± width`, smooth (C¹) in between.
 * This is the single function that defines every tolerance law in the game, so its shape *is* the
 * game's physics: linear falloff was chosen over Gaussian because a player must be able to see the
 * "lethal edge" of a niche on a field overlay and trust it.
 */
export function bellFit(value: number, ideal: number, width: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!(width > 0)) return value === ideal ? 1 : 0;
  const d = Math.abs(value - ideal) / width;
  if (d >= 1) return 0;
  return 1 - d * d * (3 - 2 * d); // smoothstep(1 - d)
}

/** Positive modulo that always returns a value in [0, m). */
export function wrap(value: number, m: number): number {
  if (!(m > 0)) return 0;
  const r = value % m;
  return r < 0 ? r + m : r;
}

/** Nearest-grid-index wrap for torus-free clamped grids. */
export function clampIndex(index: number, size: number): number {
  if (size <= 0) return 0;
  return clamp(Math.floor(index), 0, size - 1);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population standard deviation; 0 for fewer than two samples. */
export function stdev(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return Math.sqrt(acc / n);
}

/** Rounds to a fixed number of decimals without floating-point string surprises. */
export function roundTo(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Formats a number with a fixed number of decimals and no locale surprises (stable in tests). */
export function formatNumber(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '—';
  return roundTo(value, decimals).toFixed(decimals);
}

/**
 * Extremely cheap deterministic value noise in [0, 1] for cosmetic variation (terrain tint, static
 * texture). Not cryptographic, not a simulation input.
 */
export function valueNoise2D(x: number, y: number, seed = 0): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

/** Squared distance — avoids the sqrt in hot comparisons. */
export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

/** Axis-aligned bounding-box hit test. */
export function inRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  return px >= x && px <= x + w && py >= y && py <= y + h;
}

/** Moves `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return target;
}

/** Signed percentage change from `from` to `to`, safe against a zero baseline. */
export function percentChange(from: number, to: number): number {
  if (Math.abs(from) < 1e-9) return to > 0 ? 1 : 0;
  return (to - from) / Math.abs(from);
}
