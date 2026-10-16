import { clamp, clamp01, finite } from './math.ts';

/** The three environmental scalar fields that define every niche in WORLDBUG. */
export type FieldId = 'temperature' | 'humidity' | 'light';

export const FIELD_IDS: readonly FieldId[] = ['temperature', 'humidity', 'light'] as const;

/** Static metadata for a field: used by the UI, the charts and the deduction layer. */
export interface FieldSpec {
  readonly id: FieldId;
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly decimals: number;
}

export const FIELD_SPECS: Readonly<Record<FieldId, FieldSpec>> = Object.freeze({
  temperature: {
    id: 'temperature',
    label: 'Temperature',
    unit: 'K',
    min: 150,
    max: 450,
    decimals: 1,
  },
  humidity: { id: 'humidity', label: 'Humidity', unit: 'sat', min: 0, max: 1, decimals: 2 },
  light: { id: 'light', label: 'Irradiance', unit: 'lux', min: 0, max: 1, decimals: 2 },
});

export interface FieldStats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

/**
 * A dense scalar grid with wrapping-free (clamped) boundaries.
 *
 * Invariants:
 * - `data.length === width * height`.
 * - All mutating operations keep values inside `[min(clampMin), max(clampMax)]` and never write a
 *   non-finite number: `setAt`/`addRadial`/`diffuse` sanitise their input through `finite()`.
 * - Reads outside the grid are clamped to the nearest edge rather than throwing: field sampling
 *   happens in the hot loop for agents that can momentarily be exactly on the border, and "the
 *   edge of the sector has the same climate as its neighbour cell" is the intended behaviour.
 */
export class ScalarField {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;

  private readonly scratch: Float32Array;
  private dirtyStats = true;
  private cachedStats: FieldStats = { min: 0, max: 0, mean: 0 };

  constructor(width: number, height: number, initial = 0) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError(`ScalarField requires positive integer dimensions, got ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height);
    this.scratch = new Float32Array(width * height);
    if (initial !== 0) this.fill(initial);
  }

  get length(): number {
    return this.data.length;
  }

  index(x: number, y: number): number {
    return this.clampY(y) * this.width + this.clampX(x);
  }

  private clampX(x: number): number {
    return clamp(Math.floor(x), 0, this.width - 1) | 0;
  }

  private clampY(y: number): number {
    return clamp(Math.floor(y), 0, this.height - 1) | 0;
  }

  /** Cell read (clamped coordinates). */
  getAt(x: number, y: number): number {
    return this.data[this.index(x, y)] as number;
  }

  /** Cell write (clamped coordinates, sanitised value). */
  setAt(x: number, y: number, value: number): void {
    this.data[this.index(x, y)] = finite(value);
    this.dirtyStats = true;
  }

  /** Adds a delta to a cell, keeping the running value finite. */
  addAt(x: number, y: number, delta: number): void {
    const i = this.index(x, y);
    this.data[i] = finite((this.data[i] as number) + delta);
    this.dirtyStats = true;
  }

  fill(value: number): void {
    this.data.fill(finite(value));
    this.dirtyStats = true;
  }

  clone(): ScalarField {
    const out = new ScalarField(this.width, this.height);
    out.data.set(this.data);
    return out;
  }

  /**
   * Bilinear sample at continuous grid coordinates (cell centres at integer coordinates ±0.5).
   * Used by every agent to read the environment at its actual position.
   */
  sampleBilinear(x: number, y: number): number {
    const fx = clamp(x - 0.5, 0, this.width - 1);
    const fy = clamp(y - 0.5, 0, this.height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, this.width - 1);
    const y1 = Math.min(y0 + 1, this.height - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const d = this.data;
    const c00 = d[y0 * this.width + x0] as number;
    const c10 = d[y0 * this.width + x1] as number;
    const c01 = d[y1 * this.width + x0] as number;
    const c11 = d[y1 * this.width + x1] as number;
    const top = c00 + (c10 - c00) * tx;
    const bottom = c01 + (c11 - c01) * tx;
    return top + (bottom - top) * ty;
  }

  /** Mean of a square block around a cell (used for biome / region readouts). */
  blockMean(cx: number, cy: number, radius: number): number {
    const x0 = this.clampX(cx - radius);
    const x1 = this.clampX(cx + radius);
    const y0 = this.clampY(cy - radius);
    const y1 = this.clampY(cy + radius);
    let sum = 0;
    let count = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * this.width;
      for (let x = x0; x <= x1; x++) {
        sum += this.data[row + x] as number;
        count++;
      }
    }
    return count === 0 ? 0 : sum / count;
  }

  /**
   * Applies a smooth radial impulse. `strength` > 0 pushes values up, < 0 down; the falloff follows
   * smoothstep so instrument edges are visually and physically soft (no teleporting organisms).
   */
  addRadial(cx: number, cy: number, radius: number, strength: number, relaxToward?: number): void {
    if (!(radius > 0) || !Number.isFinite(strength) || strength === 0) return;
    const r2 = radius * radius;
    const x0 = this.clampX(cx - radius - 1);
    const x1 = this.clampX(cx + radius + 1);
    const y0 = this.clampY(cy - radius - 1);
    const y1 = this.clampY(cy + radius + 1);
    const mode = relaxToward === undefined ? 'add' : 'relax';
    const target = relaxToward ?? 0;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const t = 1 - Math.sqrt(d2) / radius;
        const weight = t * t * (3 - 2 * t);
        const i = y * this.width + x;
        const current = this.data[i] as number;
        const next =
          mode === 'add'
            ? current + strength * weight
            : current + (target - current) * clamp01(strength * weight);
        this.data[i] = finite(next);
      }
    }
    this.dirtyStats = true;
  }

  /** 5-point diffusion. `rate` in [0, 0.25]; edges copy their neighbour (zero-flux). */
  diffuse(rate: number): void {
    if (!(rate > 0)) return;
    const r = clamp(rate, 0, 0.25);
    const w = this.width;
    const h = this.height;
    const src = this.data;
    const dst = this.scratch;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const up = (y > 0 ? y - 1 : y) * w;
      const down = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) {
        const left = x > 0 ? x - 1 : x;
        const right = x < w - 1 ? x + 1 : x;
        const self = src[row + x] as number;
        const avg =
          ((src[row + left] as number) +
            (src[row + right] as number) +
            (src[up + x] as number) +
            (src[down + x] as number)) *
          0.25;
        dst[row + x] = self + (avg - self) * r;
      }
    }
    src.set(dst);
    this.dirtyStats = true;
  }

  /** Pulls values toward a constant baseline (environmental healing after a disturbance). */
  relaxTowardBaseline(baseline: number, rate: number): void {
    if (!(rate > 0)) return;
    const k = clamp01(rate);
    const d = this.data;
    const target = finite(baseline);
    for (let i = 0; i < d.length; i++) {
      const v = d[i] as number;
      d[i] = v + (target - v) * k;
    }
    this.dirtyStats = true;
  }

  clampTo(min: number, max: number): void {
    const d = this.data;
    for (let i = 0; i < d.length; i++) {
      d[i] = clamp(d[i] as number, min, max);
    }
    this.dirtyStats = true;
  }

  stats(): FieldStats {
    if (this.dirtyStats) {
      this.cachedStats = computeStats(this.data);
      this.dirtyStats = false;
    }
    return this.cachedStats;
  }

  /** Writes the field into an RGBA buffer using a caller-supplied colour ramp. */
  paint(
    pixels: Uint8ClampedArray,
    scaleX: number,
    scaleY: number,
    ramp: (value: number) => readonly [number, number, number],
  ): void {
    const w = this.width;
    const h = this.height;
    for (let y = 0; y < Math.min(h * scaleY, h * scaleY); y++) {
      const sy = Math.min(h - 1, Math.floor(y / scaleY));
      for (let x = 0; x < w * scaleX; x++) {
        const sx = Math.min(w - 1, Math.floor(x / scaleX));
        const value = this.data[sy * w + sx] as number;
        const [r, g, b] = ramp(value);
        const idx = (y * w * scaleX + x) * 4;
        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = 255;
      }
    }
  }
}

function computeStats(data: Float32Array): FieldStats {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] as number;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  if (data.length === 0) return { min: 0, max: 0, mean: 0 };
  return { min, max, mean: sum / data.length };
}

/** Aggregates several fields into one for rendering a composite overlay. */
export function fieldExtrema(field: ScalarField): { min: number; max: number } {
  const s = field.stats();
  return { min: s.min, max: s.max };
}
