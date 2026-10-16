import type { FieldId } from '../core/field.ts';
import { FIELD_IDS, FIELD_SPECS } from '../core/field.ts';
import type { World } from '../core/sim/world.ts';

/**
 * Accessibility layer.
 *
 * The canvas is decorative *as far as information goes*: everything the map shows is also written as
 * text (population table, field extrema, cursor readings, instrument availability). This module owns
 * the polite live region, the announcer queue, and the text summary — all plain DOM, all testable in
 * jsdom (ADR-007).
 */

export class Announcer {
  private readonly region: HTMLElement;
  private queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(region: HTMLElement) {
    this.region = region;
  }

  /** Queues a message; messages are spoken one at a time so long reports stay intelligible. */
  say(message: string): void {
    const text = message.trim();
    if (text.length === 0) return;
    this.queue.push(text);
    if (this.timer === null) this.flush();
  }

  /** Immediately replaces the live region, interrupting the queue (used for hard state changes). */
  sayNow(message: string): void {
    this.queue.length = 0;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.region.textContent = message;
  }

  private flush(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.timer = null;
      return;
    }
    this.region.textContent = next;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 2200);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }
}

export interface SummaryInput {
  readonly sectorId: string;
  readonly tick: number;
  readonly totalTicks: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly biomass: Readonly<Record<string, number>>;
  readonly fieldMeans: Readonly<Record<FieldId, number>>;
  readonly cursor: { readonly x: number; readonly y: number };
  readonly cursorReadings: Readonly<Record<FieldId, number>>;
  readonly nearby: Readonly<Record<string, number>>;
  readonly paused: boolean;
}

/**
 * One line of real text describing the world state. Deliberately dense: a screen-reader user gets
 * populations, mean climate, and exactly what is under the cursor.
 */
export function buildSummary(input: SummaryInput): string {
  const populations = Object.entries(input.counts)
    .filter(([, count]) => count > 0)
    .map(([species, count]) => `${species} ${count}`)
    .join(', ');
  const biomass = Object.entries(input.biomass)
    .filter(([, value]) => value > 1)
    .map(([species, value]) => `${species} ${value.toFixed(0)}`)
    .join(', ');
  const means = FIELD_IDS.map((field) => {
    const spec = FIELD_SPECS[field];
    return `${spec.label.toLowerCase()} ${(input.fieldMeans[field] ?? 0).toFixed(spec.decimals)} ${spec.unit}`;
  }).join(', ');
  const cursor = FIELD_IDS.map((field) => {
    const spec = FIELD_SPECS[field];
    return `${spec.label.toLowerCase()} ${(input.cursorReadings[field] ?? 0).toFixed(spec.decimals)}`;
  }).join(', ');
  const nearby = Object.entries(input.nearby)
    .filter(([, count]) => count > 0)
    .map(([species, count]) => `${species} ${count}`)
    .join(', ');
  return (
    `${input.sectorId}, ${input.paused ? 'paused' : 'running'}, tick ${input.tick} of ${input.totalTicks}. ` +
    `Populations: ${populations || 'none'}. Biomass: ${biomass || 'none'}. ` +
    `Mean climate: ${means}. ` +
    `Cursor at ${input.cursor.x.toFixed(1)}, ${input.cursor.y.toFixed(1)}: ${cursor}. ` +
    `Within four cells: ${nearby || 'nothing'}.`
  );
}

/** Convenience: builds the summary straight from a world and a cursor position. */
export function summariseWorld(
  world: World,
  cursor: { x: number; y: number },
  paused: boolean,
): string {
  return buildSummary({
    sectorId: `${world.config.id} ${world.config.name}`,
    tick: world.tick,
    totalTicks: world.config.surveyTicks,
    counts: world.counts(),
    biomass: world.biomassReport(),
    fieldMeans: world.fieldMeans(),
    cursor,
    cursorReadings: world.readingsAt(cursor.x, cursor.y),
    nearby: world.censusAround(cursor.x, cursor.y, 4),
    paused,
  });
}

/**
 * Traps Tab inside a dialog while it is open; returns a disposer. Used by Help/Settings so keyboard
 * users never tab out of a modal into the hidden game behind it.
 */
export function trapFocus(container: HTMLElement): () => void {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const focusable = [...container.querySelectorAll<HTMLElement>(selector)].filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKeyDown);
  return () => container.removeEventListener('keydown', onKeyDown);
}
