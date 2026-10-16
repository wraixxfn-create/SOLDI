/**
 * Deterministic pseudo-randomness.
 *
 * The whole simulation must be reproducible from `(sectorConfig, seed, orderedActions)`
 * (ADR-002), so `core/` must never touch `Math.random`. Every stochastic subsystem receives an
 * `Rng` instance and the world owns a documented sequence of *forked* streams, so adding a new
 * random consumer in one subsystem cannot shift the numbers consumed by another.
 */

/** mulberry32: tiny, fast, well-distributed 32-bit PRNG with a stable output sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Coerces arbitrary user input (string seeds, names, etc.) into a 32-bit integer seed. */
export function hashSeed(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return 0;
    return Math.trunc(input) >>> 0;
  }
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Creates a stable stream id (used for `Rng.fork`) from a label and an index. */
export function streamId(label: string, index = 0): number {
  const base = hashSeed(label);
  return (base ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
}

/** Small facade over a `() => number` generator with the sampling helpers the simulation needs. */
export class Rng {
  private readonly next: () => number;

  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }

  /** Uniform in [0, 1). */
  unit(): number {
    return this.next();
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform float in [-0.5, 0.5). */
  around(radius: number): number {
    return (this.next() - 0.5) * radius * 2;
  }

  /** Bernoulli trial. */
  chance(probability: number): boolean {
    if (probability <= 0) return false;
    if (probability >= 1) return true;
    return this.next() < probability;
  }

  /** Random element of a non-empty array (throws on empty input rather than returning undefined). */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Rng.pick called with an empty array');
    }
    const index = Math.min(items.length - 1, Math.floor(this.next() * items.length));
    return items[index] as T;
  }

  /**
   * Approximate standard normal via the sum of three uniforms (bounded at ±3σ, which is what a
   * trait jitter distribution needs — no unrealistic outliers).
   */
  gauss(): number {
    return ((this.next() + this.next() + this.next()) / 1.5 - 1) * 1.7320508;
  }

  /** Deterministic child stream: adding a new consumer cannot disturb existing sequences. */
  fork(label: string, index = 0): Rng {
    return new Rng((this.seed ^ streamId(label, index)) >>> 0);
  }
}

/** Derives a fresh seed for "new run" actions while staying reproducible from the session seed. */
export function deriveSeed(base: number, salt: string): number {
  return (hashSeed(salt) ^ (base * 2654435761)) >>> 0;
}
