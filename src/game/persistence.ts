import { PersistenceError } from '../core/errors.ts';
import type { Rank } from './grading.ts';

/**
 * Save data.
 *
 * A single versioned JSON record in `localStorage`. Corrupt or foreign data is never trusted: it is
 * moved aside to a quarantine key and the player is told, instead of the game failing to boot or
 * silently wiping progress (ARCHITECTURE.md §5).
 */

export const SAVE_KEY = 'worldbug.save';
export const QUARANTINE_KEY = 'worldbug.save.corrupt';
export const SAVE_VERSION = 1;

export interface SaveData {
  readonly version: number;
  readonly unlockedSectors: readonly string[];
  readonly ranks: Readonly<Record<string, Rank>>;
  readonly settings: {
    readonly palette: string;
    readonly contrast: string;
    readonly reducedMotion: boolean;
    readonly uiScale: number;
    readonly volume: number;
    readonly muted: boolean;
    readonly confirmDestructive: boolean;
    readonly autoPauseOnBlur: boolean;
  };
}

export interface SaveLoadResult {
  readonly data: SaveData;
  /** Set when the stored record could not be used; the message is player-facing. */
  readonly warning: string | null;
}

/** Minimal storage contract, so tests can inject a fake and the game survives blocked storage. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function emptySave(): SaveData {
  return {
    version: SAVE_VERSION,
    unlockedSectors: [],
    ranks: {},
    settings: {
      palette: 'aurora',
      contrast: 'normal',
      reducedMotion: false,
      uiScale: 1,
      volume: 0.6,
      muted: false,
      confirmDestructive: true,
      autoPauseOnBlur: true,
    },
  };
}

/**
 * Validates a parsed record. Returns the usable subset merged over defaults, so a save written by an
 * older build (missing a field) still loads, while a structurally broken record is rejected.
 */
export function coerceSave(value: unknown): SaveData {
  const record = asRecord(value);
  const defaults = emptySave();
  return {
    version: SAVE_VERSION,
    unlockedSectors: coerceUnlocked(record.unlockedSectors, defaults.unlockedSectors),
    ranks: coerceRanks(record.ranks),
    settings: coerceSettings(record.settings, defaults.settings),
  };
}

function asRecord(value: unknown): Partial<SaveData> {
  if (typeof value !== 'object' || value === null) {
    throw new PersistenceError('Save data is not an object', { value });
  }
  const record = value as Partial<SaveData>;
  if (record.version !== SAVE_VERSION) {
    throw new PersistenceError(`Unsupported save version ${String(record.version)}`, {
      expected: SAVE_VERSION,
    });
  }
  return record;
}

function coerceUnlocked(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.filter((id): id is string => typeof id === 'string'))];
}

function coerceRanks(value: unknown): Record<string, Rank> {
  const ranks: Record<string, Rank> = {};
  if (typeof value !== 'object' || value === null) return ranks;
  for (const [id, rank] of Object.entries(value)) {
    if (isRank(rank)) ranks[id] = rank;
  }
  return ranks;
}

function isRank(value: unknown): value is Rank {
  return value === 'S' || value === 'A' || value === 'B' || value === 'C' || value === 'F';
}

function coerceSettings(value: unknown, defaults: SaveData['settings']): SaveData['settings'] {
  const settings = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    SaveData['settings']
  >;
  return {
    palette: coerceString(settings.palette, defaults.palette),
    contrast: coerceString(settings.contrast, defaults.contrast),
    reducedMotion: coerceBoolean(settings.reducedMotion, defaults.reducedMotion),
    uiScale: coerceNumber(settings.uiScale, defaults.uiScale, 0.8, 1.6),
    volume: coerceNumber(settings.volume, defaults.volume, 0, 1),
    muted: coerceBoolean(settings.muted, defaults.muted),
    confirmDestructive: coerceBoolean(settings.confirmDestructive, defaults.confirmDestructive),
    autoPauseOnBlur: coerceBoolean(settings.autoPauseOnBlur, defaults.autoPauseOnBlur),
  };
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function coerceNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** Reads a save, quarantining anything unusable. Never throws: a broken save must not break boot. */
export function loadSave(storage: StorageLike): SaveLoadResult {
  const read = tryRead(storage);
  if (!read.ok) return { data: emptySave(), warning: read.reason };
  if (read.raw === null) return { data: emptySave(), warning: null };
  try {
    return { data: coerceSave(JSON.parse(read.raw)), warning: null };
  } catch (error) {
    quarantine(storage, read.raw);
    return {
      data: emptySave(),
      warning: `The saved profile could not be read (${describe(error)}). It has been set aside and a fresh profile started.`,
    };
  }
}

type ReadResult =
  | { readonly ok: true; readonly raw: string | null }
  | { readonly ok: false; readonly reason: string };

function tryRead(storage: StorageLike): ReadResult {
  try {
    return { ok: true, raw: storage.getItem(SAVE_KEY) };
  } catch (error) {
    return {
      ok: false,
      reason: `Browser storage is unavailable (${describe(error)}), so progress will not be saved.`,
    };
  }
}

function quarantine(storage: StorageLike, raw: string): void {
  try {
    storage.setItem(QUARANTINE_KEY, raw);
    storage.removeItem(SAVE_KEY);
  } catch {
    // Quarantine is best-effort; the point is that we do not use the bad record.
  }
}

export interface SaveWriteResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export function writeSave(storage: StorageLike, data: SaveData): SaveWriteResult {
  try {
    storage.setItem(SAVE_KEY, JSON.stringify({ ...data, version: SAVE_VERSION }));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Could not save progress: ${describe(error)}` };
  }
}

export function clearSave(storage: StorageLike): void {
  try {
    storage.removeItem(SAVE_KEY);
    storage.removeItem(QUARANTINE_KEY);
  } catch {
    // Nothing to do: clearing is best-effort.
  }
}

/** In-memory storage for tests and for browsers where storage is blocked. */
export function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
