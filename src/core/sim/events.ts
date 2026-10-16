import type { FieldId } from '../field.ts';
import type { SpeciesId } from './species.ts';

/**
 * The world event log is the player's *evidence*. Two rules make it trustworthy:
 * 1. Every entry is emitted by the simulation at the moment something actually happened; there is
 *    no "flavour" event that is not backed by a state change.
 * 2. Entries that matter for deduction carry a snapshot of the field readings at the event site
 *    (`readings`), so the Data panel can compute genuinely derived statistics (see `game/evidence.ts`).
 */

export type EventKind =
  | 'birth'
  | 'death'
  | 'kill'
  | 'graze'
  | 'extinction'
  | 'introduction'
  | 'cull'
  | 'pulse'
  | 'instrument'
  | 'note';

export type DeathCause = 'starvation' | 'exposure' | 'age' | 'grazed' | 'predation' | 'culled';

export const DEATH_CAUSE_LABELS: Readonly<Record<DeathCause, string>> = Object.freeze({
  starvation: 'starvation (energy exhausted)',
  exposure: 'exposure (sustained intolerable conditions)',
  age: 'old age (lifespan reached)',
  grazed: 'consumed as food',
  predation: 'killed by a predator',
  culled: 'removed by a cull wave',
});

export interface WorldEvent {
  readonly id: number;
  readonly tick: number;
  readonly kind: EventKind;
  /** Species the event is about (the prey for kills, the removed species for culls). */
  readonly species?: SpeciesId;
  /** Secondary species: the predator for kills, the introduced species for hatcheries. */
  readonly target?: SpeciesId;
  readonly x: number;
  readonly y: number;
  readonly cause?: DeathCause;
  readonly readings?: Readonly<Record<FieldId, number>>;
  readonly amount?: number;
  readonly message?: string;
}

export interface EventFilter {
  kinds?: readonly EventKind[];
  species?: SpeciesId;
  fromTick?: number;
  toTick?: number;
}

/**
 * Bounded circular log. Capacity is fixed at construction so a long survey cannot grow memory
 * without bound; `dropped` records how many entries were overwritten (shown in the UI so the player
 * knows the log is a window, not the whole history — the aggregate counters keep the long history).
 */
export class EventLog {
  readonly capacity: number;

  private readonly buffer: (WorldEvent | undefined)[];
  private cursor = 0;
  private count = 0;
  private nextId = 1;
  private droppedCount = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`EventLog capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buffer = new Array<WorldEvent | undefined>(capacity).fill(undefined);
  }

  get size(): number {
    return this.count;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  push(event: Omit<WorldEvent, 'id'>): WorldEvent {
    const stored: WorldEvent = { ...event, id: this.nextId++ };
    if (this.count === this.capacity) {
      this.droppedCount++;
    } else {
      this.count++;
    }
    this.buffer[this.cursor] = stored;
    this.cursor = (this.cursor + 1) % this.capacity;
    return stored;
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.cursor = 0;
    this.count = 0;
    this.droppedCount = 0;
  }

  /** Chronological snapshot (oldest → newest). Allocates; call at UI cadence, not per tick. */
  toArray(): WorldEvent[] {
    const out: WorldEvent[] = [];
    const start = this.count === this.capacity ? this.cursor : 0;
    for (let i = 0; i < this.count; i++) {
      const entry = this.buffer[(start + i) % this.capacity];
      if (entry) out.push(entry);
    }
    return out;
  }

  /** Newest `limit` entries, newest first. */
  recent(limit: number): WorldEvent[] {
    const out: WorldEvent[] = [];
    const n = Math.min(limit, this.count);
    for (let i = 0; i < n; i++) {
      const index = (this.cursor - 1 - i + this.capacity * 2) % this.capacity;
      const entry = this.buffer[index];
      if (entry) out.push(entry);
    }
    return out;
  }

  filter(filter: EventFilter): WorldEvent[] {
    return this.toArray().filter((e) => matches(e, filter));
  }

  countBy<K extends string>(key: (event: WorldEvent) => K | undefined): Map<K, number> {
    const out = new Map<K, number>();
    for (const event of this.toArray()) {
      const k = key(event);
      if (k === undefined) continue;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
    return out;
  }
}

function matches(event: WorldEvent, filter: EventFilter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.species && event.species !== filter.species && event.target !== filter.species) {
    return false;
  }
  if (filter.fromTick !== undefined && event.tick < filter.fromTick) return false;
  if (filter.toTick !== undefined && event.tick > filter.toTick) return false;
  return true;
}

export interface EventCounters {
  births: Map<SpeciesId, number>;
  deaths: Map<SpeciesId, number>;
  deathsByCause: Map<string, number>;
  kills: Map<string, number>;
  grazingRemoved: Map<SpeciesId, number>;
}

export function createEventCounters(): EventCounters {
  return {
    births: new Map(),
    deaths: new Map(),
    deathsByCause: new Map(),
    kills: new Map(),
    grazingRemoved: new Map(),
  };
}

export function bump<K>(map: Map<K, number>, key: K, delta = 1): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

/**
 * Record an event into the aggregate counters. Counters survive the event-log window, so a survey
 * that runs for 10 000 ticks still reports exact totals for the whole run.
 */
export function countEvent(counters: EventCounters, event: WorldEvent): void {
  switch (event.kind) {
    case 'birth':
      if (event.species) bump(counters.births, event.species);
      break;
    case 'death':
      if (event.species) bump(counters.deaths, event.species);
      if (event.cause) bump(counters.deathsByCause, `${event.species ?? '?'}:${event.cause}`);
      break;
    case 'kill':
      if (event.species && event.target) bump(counters.kills, `${event.target}->${event.species}`);
      break;
    case 'graze':
      if (event.species && event.amount) {
        accumulateGrazing(counters, event.species, event.amount);
      }
      break;
    default:
      break;
  }
}

function accumulateGrazing(counters: EventCounters, species: SpeciesId, amount: number): void {
  counters.grazingRemoved.set(species, (counters.grazingRemoved.get(species) ?? 0) + amount);
}
