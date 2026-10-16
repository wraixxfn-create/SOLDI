import { FIELD_IDS, type FieldId } from '../core/field.ts';
import { validateSector, type SectorConfig, type TerrainKind, type TerrainSource, type EnvironmentalPulse } from '../core/sim/sector.ts';
import type { SpeciesDefinition, SpeciesId } from '../core/sim/species.ts';
import { SPECIES_BY_ID } from '../content/species.ts';
import { propositionsFor } from '../content/laws.ts';
import { INSTRUMENTS } from '../game/instruments.ts';
import { coerceSave } from '../game/persistence.ts';
import type { Challenge, Environment, Objective, PlayerProgress, Rule } from './contracts.ts';

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

const TERRAIN_KINDS: readonly TerrainKind[] = ['thermal', 'cryo', 'mist', 'arid', 'lumen', 'shade'];

/**
 * Validates untrusted, imported sector/challenge JSON before it reaches simulation code.
 * Accepts either a raw SectorConfig document or `{ sector: SectorConfig }`; Codex rules are always
 * regenerated from validated content and never accepted from the imported document.
 */
export function validateChallengeData(
  input: unknown,
  speciesById: ReadonlyMap<SpeciesId, SpeciesDefinition> = SPECIES_BY_ID,
): ValidationResult<Challenge> {
  const root = asRecord(input);
  const rawSector = root && 'sector' in root ? root.sector : input;
  const parsed = parseSectorConfig(rawSector);
  if (!parsed.ok) return parsed;

  try {
    const contentIssues = validateSector(parsed.value, speciesById);
    if (contentIssues.length > 0) return { ok: false, issues: contentIssues };
    const sector = parsed.value;
    const rules: readonly Rule[] = propositionsFor(sector);
    const environment: Environment = {
      width: sector.width,
      height: sector.height,
      baseline: sector.baseline,
      sources: sector.sources,
      pulses: sector.pulses,
    };
    const objective: Objective = {
      id: `${sector.id}:survey-objective`,
      description: sector.objective,
      biomassTarget: sector.biomassTarget,
      mustKeepOneSpeciesAlive: true,
    };
    const species = sector.roster.flatMap((id) => {
      const definition = speciesById.get(id);
      return definition ? [definition] : [];
    });
    return {
      ok: true,
      value: { id: sector.id, sector, environment, species, rules, objective },
    };
  } catch (error) {
    return {
      ok: false,
      issues: [`Challenge validation failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/** Validates imported save/profile data using the same schema rules as normal boot. */
export function validatePlayerProgress(input: unknown): ValidationResult<PlayerProgress> {
  try {
    return { ok: true, value: coerceSave(input) };
  } catch (error) {
    return {
      ok: false,
      issues: [`Player progress is invalid: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function parseSectorConfig(input: unknown): ValidationResult<SectorConfig> {
  const value = asRecord(input);
  if (!value) return invalid('Sector data must be an object');

  const issues: string[] = [];
  validateTextFields(value, issues);
  validateNumericFields(value, issues);

  const baseline = parseBaseline(value.baseline, issues);
  const roster = parseStringArray(value.roster, 'roster', issues);
  const initialPopulations = parseNumberMap(value.initialPopulations, 'initialPopulations', issues);
  const populationCaps = parseNumberMap(value.populationCaps, 'populationCaps', issues);
  const sources = parseSources(value.sources, issues);
  const pulses = parsePulses(value.pulses, issues);
  const instruments = parseStringArray(value.instruments, 'instruments', issues);
  if (instruments) validateInstrumentIds(instruments, issues);
  const biomassTarget = parseBiomassTarget(value.biomassTarget, issues);

  const parts: SectorParts = {
    baseline, roster, initialPopulations, populationCaps, sources, pulses, instruments, biomassTarget,
  };
  if (!hasSectorParts(parts)) {
    return { ok: false, issues: issues.length > 0 ? issues : ['Sector data is incomplete'] };
  }
  if (issues.length > 0) return { ok: false, issues };

  const config: SectorConfig = {
    id: value.id as string,
    index: value.index as number,
    name: value.name as string,
    designation: value.designation as string,
    tagline: value.tagline as string,
    brief: value.brief as string,
    objective: value.objective as string,
    width: value.width as number,
    height: value.height as number,
    seed: value.seed as number,
    baseline: parts.baseline,
    sources: parts.sources,
    pulses: parts.pulses,
    roster: parts.roster,
    initialPopulations: parts.initialPopulations,
    populationCaps: parts.populationCaps,
    startingCharge: value.startingCharge as number,
    startingIntegrity: value.startingIntegrity as number,
    biomassTarget: parts.biomassTarget,
    surveyTicks: value.surveyTicks as number,
    instruments: parts.instruments,
    unlockAfter: value.unlockAfter as string | null,
    difficulty: value.difficulty as 1 | 2 | 3 | 4 | 5,
  };
  return { ok: true, value: config };
}

interface SectorParts {
  readonly baseline: Readonly<Record<FieldId, number>> | null;
  readonly roster: readonly string[] | null;
  readonly initialPopulations: Record<SpeciesId, number> | null;
  readonly populationCaps: Record<SpeciesId, number> | null;
  readonly sources: readonly TerrainSource[] | null;
  readonly pulses: readonly EnvironmentalPulse[] | null;
  readonly instruments: readonly string[] | null;
  readonly biomassTarget: Readonly<{ min: number; max: number }> | null;
}

function hasSectorParts(parts: SectorParts): parts is {
  readonly baseline: Readonly<Record<FieldId, number>>;
  readonly roster: readonly string[];
  readonly initialPopulations: Record<SpeciesId, number>;
  readonly populationCaps: Record<SpeciesId, number>;
  readonly sources: readonly TerrainSource[];
  readonly pulses: readonly EnvironmentalPulse[];
  readonly instruments: readonly string[];
  readonly biomassTarget: Readonly<{ min: number; max: number }>;
} {
  return Boolean(
    parts.baseline && parts.roster && parts.initialPopulations && parts.populationCaps &&
    parts.sources && parts.pulses && parts.instruments && parts.biomassTarget,
  );
}

function validateTextFields(value: Record<string, unknown>, issues: string[]): void {
  const keys = ['id', 'name', 'designation', 'tagline', 'brief', 'objective'] as const;
  for (const key of keys) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      issues.push(`${key} must be a non-empty string`);
    }
  }
  if (value.unlockAfter !== null && typeof value.unlockAfter !== 'string') {
    issues.push('unlockAfter must be a string or null');
  }
}

function validateNumericFields(value: Record<string, unknown>, issues: string[]): void {
  const integers = ['index', 'width', 'height', 'seed', 'startingIntegrity', 'surveyTicks'] as const;
  for (const key of integers) {
    if (!Number.isInteger(value[key])) issues.push(`${key} must be an integer`);
  }
  if (!Number.isInteger(value.width) || (value.width as number) < 16 || (value.width as number) > 128) {
    issues.push('width must be an integer in [16, 128]');
  }
  if (!Number.isInteger(value.height) || (value.height as number) < 12 || (value.height as number) > 128) {
    issues.push('height must be an integer in [12, 128]');
  }
  if (!isFiniteNumber(value.startingCharge)) issues.push('startingCharge must be finite');
  if (!Number.isInteger(value.difficulty) || (value.difficulty as number) < 1 || (value.difficulty as number) > 5) {
    issues.push('difficulty must be an integer in [1, 5]');
  }
}

function parseBaseline(input: unknown, issues: string[]): Readonly<Record<FieldId, number>> | null {
  const value = asRecord(input);
  if (!value) {
    issues.push('baseline must be an object');
    return null;
  }
  const result = {} as Record<FieldId, number>;
  for (const field of FIELD_IDS) {
    if (!isFiniteNumber(value[field])) issues.push(`baseline.${field} must be finite`);
    else result[field] = value[field];
  }
  return issues.some((issue) => issue.startsWith('baseline.')) ? null : result;
}

function parseStringArray(input: unknown, label: string, issues: string[]): string[] | null {
  if (!Array.isArray(input) || !input.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    issues.push(`${label} must be an array of non-empty strings`);
    return null;
  }
  return input;
}

function validateInstrumentIds(instruments: readonly string[], issues: string[]): void {
  const knownIds = new Set<string>(INSTRUMENTS.map((instrument) => instrument.id));
  for (const id of instruments) {
    if (!knownIds.has(id)) issues.push(`Unknown instrument "${id}"`);
  }
}

function parseNumberMap(input: unknown, label: string, issues: string[]): Record<SpeciesId, number> | null {
  const value = asRecord(input);
  if (!value) {
    issues.push(`${label} must be an object of finite numbers`);
    return null;
  }
  const result: Record<SpeciesId, number> = {};
  for (const [key, amount] of Object.entries(value)) {
    if (!isFiniteNumber(amount)) issues.push(`${label}.${key} must be finite`);
    else result[key] = amount;
  }
  return issues.some((issue) => issue.startsWith(`${label}.`)) ? null : result;
}

function parseSources(input: unknown, issues: string[]): readonly TerrainSource[] | null {
  if (!Array.isArray(input)) {
    issues.push('sources must be an array');
    return null;
  }
  const result: TerrainSource[] = [];
  input.forEach((entry, index) => {
    const value = asRecord(entry);
    if (!value || typeof value.id !== 'string' || !TERRAIN_KINDS.includes(value.kind as TerrainKind) ||
        !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.radius) ||
        !isFiniteNumber(value.strength) || !isFiniteNumber(value.persistence)) {
      issues.push(`sources[${index}] has an invalid shape`);
      return;
    }
    result.push({
      id: value.id,
      kind: value.kind as TerrainKind,
      x: value.x,
      y: value.y,
      radius: value.radius,
      strength: value.strength,
      persistence: value.persistence,
    });
  });
  return result.length === input.length ? result : null;
}

function parsePulses(input: unknown, issues: string[]): readonly EnvironmentalPulse[] | null {
  if (!Array.isArray(input)) {
    issues.push('pulses must be an array');
    return null;
  }
  const result: EnvironmentalPulse[] = [];
  input.forEach((entry, index) => {
    const value = asRecord(entry);
    if (!value || typeof value.id !== 'string' || typeof value.label !== 'string' ||
        !FIELD_IDS.includes(value.field as FieldId) || !isFiniteNumber(value.period) || !Number.isInteger(value.period) ||
        !isFiniteNumber(value.amount) || !isFiniteNumber(value.radius) || value.radius <= 0 ||
        !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.phase) || !Number.isInteger(value.phase)) {
      issues.push(`pulses[${index}] has an invalid shape`);
      return;
    }
    result.push({
      id: value.id,
      field: value.field as FieldId,
      period: value.period,
      amount: value.amount,
      radius: value.radius,
      x: value.x,
      y: value.y,
      phase: value.phase,
      label: value.label,
    });
  });
  return result.length === input.length ? result : null;
}

function parseBiomassTarget(
  input: unknown,
  issues: string[],
): Readonly<{ min: number; max: number }> | null {
  const value = asRecord(input);
  if (!value || !isFiniteNumber(value.min) || !isFiniteNumber(value.max)) {
    issues.push('biomassTarget must contain finite min and max');
    return null;
  }
  return { min: value.min, max: value.max };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function invalid<T>(issue: string): ValidationResult<T> {
  return { ok: false, issues: [issue] };
}

