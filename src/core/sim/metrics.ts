import type { FieldId } from '../field.ts';
import { safeDiv, stdev, mean } from '../math.ts';
import type { SpeciesId } from './species.ts';

/**
 * Derived measurements: population history, per-field birth statistics, probe recordings and the
 * stability index used by the mission scoring. Everything here is computed from what the simulation
 * actually produced — nothing is synthesised for presentation (contract rule 7).
 */

export interface PopulationSample {
  readonly tick: number;
  readonly counts: Readonly<Record<SpeciesId, number>>;
  readonly biomass: Readonly<Record<SpeciesId, number>>;
  readonly totalBiomass: number;
}

/** Running per-field statistics of the field readings observed at birth events. */
export interface FieldMoments {
  n: number;
  temperature: number;
  humidity: number;
  light: number;
  temperatureSq: number;
  humiditySq: number;
  lightSq: number;
}

export function createMoments(): FieldMoments {
  return {
    n: 0,
    temperature: 0,
    humidity: 0,
    light: 0,
    temperatureSq: 0,
    humiditySq: 0,
    lightSq: 0,
  };
}

export function addReading(moments: FieldMoments, readings: Readonly<Record<FieldId, number>>): void {
  moments.n++;
  moments.temperature += readings.temperature;
  moments.humidity += readings.humidity;
  moments.light += readings.light;
  moments.temperatureSq += readings.temperature * readings.temperature;
  moments.humiditySq += readings.humidity * readings.humidity;
  moments.lightSq += readings.light * readings.light;
}

export function momentsMean(moments: FieldMoments, field: FieldId): number {
  if (field === 'temperature') return safeDiv(moments.temperature, moments.n);
  if (field === 'humidity') return safeDiv(moments.humidity, moments.n);
  return safeDiv(moments.light, moments.n);
}

export function momentsSd(moments: FieldMoments, field: FieldId): number {
  const n = moments.n;
  if (n < 2) return 0;
  const meanValue = momentsMean(moments, field);
  const sumSq =
    field === 'temperature'
      ? moments.temperatureSq
      : field === 'humidity'
        ? moments.humiditySq
        : moments.lightSq;
  const variance = Math.max(0, sumSq / n - meanValue * meanValue);
  return Math.sqrt(variance);
}

/**
 * Standardised association between a field value and the occurrence of an event, given the sector's
 * own distribution of that field. Positive means "events happen where the field is above the
 * sector average for that field". This is the statistic the player reads in the Data panel when
 * asking "which factor drives reproduction?".
 *
 * It is a *real* statistic over recorded data: |z| is exactly the standardised deviation of the
 * event-mean from the sector-mean multiplied by sqrt(n), which is the one-sample z statistic. We
 * expose both `mean`, `sectorMean` and `n` so the player can sanity-check it.
 */
export interface Association {
  readonly field: FieldId;
  readonly n: number;
  readonly eventMean: number;
  readonly sectorMean: number;
  readonly sectorSd: number;
  readonly z: number;
}

export function association(
  moments: FieldMoments,
  field: FieldId,
  sectorMean: number,
  sectorSd: number,
): Association {
  const eventMean = momentsMean(moments, field);
  const sd = sectorSd > 1e-6 ? sectorSd : 1e-6;
  const z = safeDiv(eventMean - sectorMean, sd) * Math.sqrt(Math.max(0, moments.n));
  return {
    field,
    n: moments.n,
    eventMean,
    sectorMean,
    sectorSd,
    z,
  };
}

/** A probe is a stationary sensor the player places; it records a bounded window of readings. */
export interface ProbeSample {
  readonly tick: number;
  readonly temperature: number;
  readonly humidity: number;
  readonly light: number;
  readonly counts: Readonly<Record<SpeciesId, number>>;
  readonly biomass: number;
}

export interface ProbeState {
  readonly id: number;
  x: number;
  y: number;
  radius: number;
  readonly samples: ProbeSample[];
  readonly capacity: number;
}

export function createProbe(id: number, x: number, y: number, radius: number, capacity = 240): ProbeState {
  return { id, x, y, radius, samples: [], capacity };
}

export function recordProbeSample(probe: ProbeState, sample: ProbeSample): void {
  probe.samples.push(sample);
  if (probe.samples.length > probe.capacity) probe.samples.shift();
}

/** Simple linear regression used by the Data panel to draw a real trend line on probe charts. */
export function linearTrend(
  xs: readonly number[],
  ys: readonly number[],
): { slope: number; intercept: number; r2: number } {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { slope: 0, intercept: n > 0 ? (ys[0] as number) : 0, r2: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] as number;
    const y = ys[i] as number;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denominator = n * sxx - sx * sx;
  if (Math.abs(denominator) < 1e-9) return { slope: 0, intercept: sy / n, r2: 0 };
  const slope = (n * sxy - sx * sy) / denominator;
  const intercept = (sy - slope * sx) / n;
  let ssTot = 0;
  let ssRes = 0;
  const my = sy / n;
  for (let i = 0; i < n; i++) {
    const y = ys[i] as number;
    const predicted = slope * (xs[i] as number) + intercept;
    ssTot += (y - my) ** 2;
    ssRes += (y - predicted) ** 2;
  }
  const r2 = ssTot < 1e-9 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

/**
 * Stability index in [0, 1]: combines how much of the initial biomass survives, how even the
 * species distribution is, and how much the population fluctuated. Used by the mission report and
 * shown live in the HUD, so the player can see the cost of destructive experiments immediately.
 */
export function stabilityIndex(history: readonly PopulationSample[], speciesCount: number): number {
  if (history.length === 0 || speciesCount === 0) return 0;
  const latest = history[history.length - 1] as PopulationSample;
  const first = history[0] as PopulationSample;
  const retention = safeDiv(latest.totalBiomass, Math.max(1e-6, first.totalBiomass), 1);

  const alive = Object.values(latest.counts).filter((c) => c > 0).length;
  const richness = speciesCount === 0 ? 0 : alive / speciesCount;

  const totals = history.map((s) => s.totalBiomass);
  const sd = stdev(totals);
  const avg = Math.max(1e-6, mean(totals));
  const volatility = Math.min(1, sd / avg);

  const retentionScore = Math.min(1, retention);
  const stability = 0.5 * retentionScore + 0.3 * richness + 0.2 * (1 - volatility);
  return Math.max(0, Math.min(1, stability));
}
