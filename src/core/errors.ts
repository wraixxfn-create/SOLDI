/**
 * Typed error hierarchy for WORLDBUG.
 *
 * Policy (see docs/ARCHITECTURE.md §5):
 * - `WorldBugError` subclasses signal *programming* or *content* mistakes (bad sector config,
 *   unknown species id, impossible instrument payload). They are thrown and must fail loudly during
 *   development and tests.
 * - Player-triggered edge cases (insufficient charge, tool out of range, no target under cursor)
 *   are NOT exceptions: they are reported through the `ActionResult` union in `game/state.ts` so the
 *   UI can explain what happened.
 */

export class WorldBugError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WorldBugError';
    this.code = code;
    this.details = Object.freeze({ ...details });
    // Restore prototype chain for down-levelled targets / instanceof across realms.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Human-readable one-liner used by the diagnostics overlay and the test reporter. */
  describe(): string {
    const keys = Object.keys(this.details);
    if (keys.length === 0) return `${this.name}[${this.code}]: ${this.message}`;
    const rendered = keys.map((k) => `${k}=${formatDetail(this.details[k])}`).join(' ');
    return `${this.name}[${this.code}]: ${this.message} (${rendered})`;
  }
}

function formatDetail(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Invalid or inconsistent content data (sector config, species traits, proposition options). */
export class ContentError extends WorldBugError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('CONTENT', message, details);
    this.name = 'ContentError';
  }
}

/** A value violated a documented invariant of the simulation. */
export class InvariantError extends WorldBugError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('INVARIANT', message, details);
    this.name = 'InvariantError';
  }
}

/** A save file could not be understood; callers fall back to a clean profile. */
export class PersistenceError extends WorldBugError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PERSISTENCE', message, details);
    this.name = 'PersistenceError';
  }
}

/**
 * Assertion helper used across `core/` and `content/`. Kept dependency-free (no `node:assert`) so
 * the same code runs in the browser bundle, in Node tests and in the balance harness.
 */
export function invariant(
  condition: unknown,
  message: string,
  details: Record<string, unknown> = {},
): asserts condition {
  if (!condition) throw new InvariantError(message, details);
}

export function assertContent(
  condition: unknown,
  message: string,
  details: Record<string, unknown> = {},
): asserts condition {
  if (!condition) throw new ContentError(message, details);
}

/** Narrowing helper for exhaustiveness checks over discriminated unions. */
export function unreachable(value: never, context: string): never {
  throw new WorldBugError('UNREACHABLE', `Unhandled case in ${context}`, { value });
}
