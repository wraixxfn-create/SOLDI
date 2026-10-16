import { FIELD_IDS, FIELD_SPECS, type FieldId } from '../field.ts';
import { RESOURCE_IDS, RESOURCE_LIMITS, type ResourceId } from './resources.ts';

/** Comparisons are data, not JavaScript fragments. */
export type RuleComparison = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';
export type RuleMode = 'stack' | 'exclusive';
export type RuleFrequency = 'each-turn' | 'once';

/**
 * Safe condition language for authored ecosystem rules. This is a closed discriminated union;
 * level data can describe comparisons and boolean combinations but can never provide executable code.
 */
export type RuleCondition =
  | { readonly type: 'all'; readonly terms: readonly RuleCondition[] }
  | { readonly type: 'any'; readonly terms: readonly RuleCondition[] }
  | { readonly type: 'not'; readonly term: RuleCondition }
  | {
      readonly type: 'field-mean';
      readonly field: FieldId;
      readonly comparison: RuleComparison;
      readonly value: number;
    }
  | {
      readonly type: 'resource-mean';
      readonly resource: ResourceId;
      readonly comparison: RuleComparison;
      readonly value: number;
    }
  | {
      readonly type: 'population';
      readonly species: string;
      readonly comparison: RuleComparison;
      readonly value: number;
    }
  | {
      readonly type: 'population-ratio';
      readonly numerator: string;
      readonly denominator: string;
      readonly comparison: RuleComparison;
      readonly value: number;
    }
  | {
      readonly type: 'biomass';
      /** null means total standing biomass in the world. */
      readonly species: string | null;
      readonly comparison: RuleComparison;
      readonly value: number;
    }
  | {
      readonly type: 'tick';
      readonly comparison: RuleComparison;
      readonly value: number;
    };

/** The complete, JSON-safe rule document for a world. */
export interface EcosystemRule {
  readonly id: string;
  /** Higher priority is evaluated first; equal priorities break by rule id (code-point order). */
  readonly priority: number;
  /** stack rules can coexist; exclusive rules require a group and only the first match in it runs. */
  readonly mode: RuleMode;
  readonly group: string | null;
  /** once rules run only on the first matching turn; each-turn rules are reevaluated every turn. */
  readonly frequency: RuleFrequency;
  readonly prerequisites: RuleCondition;
  readonly effects: readonly RuleEffect[];
}

/** Closed effect language interpreted by World. No callbacks, scripts, property paths or eval. */
export type RuleEffect =
  | {
      readonly type: 'field-shift';
      readonly field: FieldId;
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly amount: number;
    }
  | {
      readonly type: 'resource-shift';
      readonly resource: ResourceId;
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly amount: number;
    }
  | { readonly type: 'metabolism-scale'; readonly species: string; readonly factor: number }
  | { readonly type: 'growth-scale'; readonly species: string; readonly factor: number }
  | { readonly type: 'reproduction-scale'; readonly species: string; readonly factor: number };

export interface RuleValidationContext {
  readonly width?: number;
  readonly height?: number;
  readonly species?: readonly string[];
}

export interface ParsedRuleSet {
  readonly rules: readonly EcosystemRule[];
  readonly issues: readonly string[];
}

export interface RuleObservation {
  readonly tick: number;
  readonly fieldMeans: Readonly<Record<FieldId, number>>;
  readonly resourceMeans: Readonly<Record<ResourceId, number>>;
  readonly populations: Readonly<Record<string, number>>;
  readonly biomass: Readonly<Record<string, number>>;
}

export interface RuleActivation {
  readonly ruleId: string;
  readonly effect: RuleEffect;
}

const COMPARISONS: readonly RuleComparison[] = ['lt', 'lte', 'eq', 'gte', 'gt'];
const MODES: readonly RuleMode[] = ['stack', 'exclusive'];
const FREQUENCIES: readonly RuleFrequency[] = ['each-turn', 'once'];
const MAX_RULES = 128;
const MAX_EFFECTS_PER_RULE = 16;
const MAX_CONDITION_DEPTH = 8;
const MAX_CONDITION_NODES = 64;

/**
 * Parse and validate untrusted JSON-level data into fresh, narrow rule objects. Unknown keys,
 * prototypes, excessive nesting, non-finite values and unknown operations are rejected.
 */
export function parseRuleSet(input: unknown, context: RuleValidationContext = {}): ParsedRuleSet {
  const issues: string[] = [];
  if (!Array.isArray(input)) return { rules: [], issues: ['rules must be an array'] };
  if (input.length > MAX_RULES) issues.push(`rules may contain at most ${MAX_RULES} entries`);
  const knownSpecies = context.species ? new Set(context.species) : null;
  const rules: EcosystemRule[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < input.length && index < MAX_RULES; index++) {
    const path = `rules[${index}]`;
    const rule = parseRule(input[index], path, issues, context, knownSpecies);
    if (!rule) continue;
    if (ids.has(rule.id)) issues.push(`${path}.id duplicates "${rule.id}"`);
    ids.add(rule.id);
    rules.push(rule);
  }
  return { rules: issues.length === 0 ? rules : [], issues };
}

// eslint-disable-next-line complexity -- keep the closed rule-header schema validated in one place.
function parseRule(
  input: unknown,
  path: string,
  issues: string[],
  context: RuleValidationContext,
  knownSpecies: ReadonlySet<string> | null,
): EcosystemRule | null {
  const value = asPlainRecord(input);
  if (!value) {
    issues.push(`${path} must be a plain object`);
    return null;
  }
  checkKeys(value, ['id', 'priority', 'mode', 'group', 'frequency', 'prerequisites', 'effects'], path, issues);

  const id = value.id;
  const priority = value.priority;
  const mode = value.mode;
  const group = value.group;
  const frequency = value.frequency;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id)) {
    issues.push(`${path}.id must be a stable 1–64 character identifier`);
  }
  if (!Number.isInteger(priority) || (priority as number) < -10_000 || (priority as number) > 10_000) {
    issues.push(`${path}.priority must be an integer in [-10000, 10000]`);
  }
  if (typeof mode !== 'string' || !MODES.includes(mode as RuleMode)) {
    issues.push(`${path}.mode must be "stack" or "exclusive"`);
  }
  if (typeof frequency !== 'string' || !FREQUENCIES.includes(frequency as RuleFrequency)) {
    issues.push(`${path}.frequency must be "each-turn" or "once"`);
  }
  if (mode === 'exclusive') {
    if (typeof group !== 'string' || !isIdentifier(group)) {
      issues.push(`${path}.group is required for exclusive rules`);
    }
  } else if (group !== null) {
    issues.push(`${path}.group must be null for stack rules`);
  }

  const nodeCount = { value: 0 };
  const prerequisites = parseCondition(
    value.prerequisites,
    `${path}.prerequisites`,
    issues,
    context,
    knownSpecies,
    0,
    nodeCount,
  );
  const effectsInput = value.effects;
  const effects: RuleEffect[] = [];
  if (!Array.isArray(effectsInput) || effectsInput.length < 1 || effectsInput.length > MAX_EFFECTS_PER_RULE) {
    issues.push(`${path}.effects must contain 1–${MAX_EFFECTS_PER_RULE} effects`);
  } else {
    effectsInput.forEach((effect, effectIndex) => {
      const parsed = parseEffect(
        effect,
        `${path}.effects[${effectIndex}]`,
        issues,
        context,
        knownSpecies,
      );
      if (parsed) effects.push(parsed);
    });
  }

  if (
    typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id) ||
    !Number.isInteger(priority) || (priority as number) < -10_000 || (priority as number) > 10_000 ||
    typeof mode !== 'string' || !MODES.includes(mode as RuleMode) ||
    typeof frequency !== 'string' || !FREQUENCIES.includes(frequency as RuleFrequency) ||
    (mode === 'exclusive' && (typeof group !== 'string' || !isIdentifier(group))) ||
    (mode === 'stack' && group !== null) || !prerequisites || effects.length !== (Array.isArray(effectsInput) ? effectsInput.length : 0)
  ) {
    return null;
  }
  return {
    id,
    priority: priority as number,
    mode: mode as RuleMode,
    group: group as string | null,
    frequency: frequency as RuleFrequency,
    prerequisites,
    effects,
  };
}

// eslint-disable-next-line complexity -- the explicit discriminant switch is the safe DSL interpreter.
function parseCondition(
  input: unknown,
  path: string,
  issues: string[],
  context: RuleValidationContext,
  knownSpecies: ReadonlySet<string> | null,
  depth: number,
  nodeCount: { value: number },
): RuleCondition | null {
  nodeCount.value++;
  if (nodeCount.value > MAX_CONDITION_NODES) {
    issues.push(`${path} exceeds the ${MAX_CONDITION_NODES}-node condition limit`);
    return null;
  }
  if (depth > MAX_CONDITION_DEPTH) {
    issues.push(`${path} exceeds the maximum condition depth of ${MAX_CONDITION_DEPTH}`);
    return null;
  }
  const value = asPlainRecord(input);
  if (!value || typeof value.type !== 'string') {
    issues.push(`${path} must be a condition object with a known type`);
    return null;
  }

  if (value.type === 'all' || value.type === 'any') {
    checkKeys(value, ['type', 'terms'], path, issues);
    if (!Array.isArray(value.terms) || value.terms.length < 1 || value.terms.length > 16) {
      issues.push(`${path}.terms must contain 1–16 conditions`);
      return null;
    }
    const terms: RuleCondition[] = [];
    value.terms.forEach((term, index) => {
      const parsed = parseCondition(term, `${path}.terms[${index}]`, issues, context, knownSpecies, depth + 1, nodeCount);
      if (parsed) terms.push(parsed);
    });
    if (terms.length !== value.terms.length) return null;
    return value.type === 'all' ? { type: 'all', terms } : { type: 'any', terms };
  }
  if (value.type === 'not') {
    checkKeys(value, ['type', 'term'], path, issues);
    const term = parseCondition(value.term, `${path}.term`, issues, context, knownSpecies, depth + 1, nodeCount);
    return term ? { type: 'not', term } : null;
  }

  const comparison = parseComparison(value.comparison, `${path}.comparison`, issues);
  const threshold = value.value;
  if (!isFiniteNumber(threshold)) issues.push(`${path}.value must be finite`);

  if (value.type === 'field-mean') {
    checkKeys(value, ['type', 'field', 'comparison', 'value'], path, issues);
    if (!FIELD_IDS.includes(value.field as FieldId)) {
      issues.push(`${path}.field is unknown`);
      return null;
    }
    if (isFiniteNumber(threshold)) {
      const spec = FIELD_SPECS[value.field as FieldId];
      if (threshold < spec.min || threshold > spec.max) issues.push(`${path}.value is outside ${value.field} limits`);
    }
    return isFiniteNumber(threshold) && comparison
      ? { type: 'field-mean', field: value.field as FieldId, comparison, value: threshold }
      : null;
  }
  if (value.type === 'resource-mean') {
    checkKeys(value, ['type', 'resource', 'comparison', 'value'], path, issues);
    if (!RESOURCE_IDS.includes(value.resource as ResourceId)) {
      issues.push(`${path}.resource is unknown`);
      return null;
    }
    if (isFiniteNumber(threshold)) {
      const limits = RESOURCE_LIMITS[value.resource as ResourceId];
      if (threshold < limits.min || threshold > limits.max) issues.push(`${path}.value is outside ${value.resource} limits`);
    }
    return isFiniteNumber(threshold) && comparison
      ? { type: 'resource-mean', resource: value.resource as ResourceId, comparison, value: threshold }
      : null;
  }
  if (value.type === 'population') {
    checkKeys(value, ['type', 'species', 'comparison', 'value'], path, issues);
    if (!isSpeciesId(value.species) || (knownSpecies && !knownSpecies.has(value.species))) {
      issues.push(`${path}.species is not in the world roster`);
    }
    if (!isFiniteNumber(threshold) || threshold < 0) issues.push(`${path}.value must be non-negative`);
    return isSpeciesId(value.species) && isFiniteNumber(threshold) && threshold >= 0 && comparison
      ? { type: 'population', species: value.species, comparison, value: threshold }
      : null;
  }
  if (value.type === 'population-ratio') {
    checkKeys(value, ['type', 'numerator', 'denominator', 'comparison', 'value'], path, issues);
    for (const key of ['numerator', 'denominator'] as const) {
      if (!isSpeciesId(value[key]) || (knownSpecies && !knownSpecies.has(value[key]))) {
        issues.push(`${path}.${key} is not in the world roster`);
      }
    }
    if (!isFiniteNumber(threshold) || threshold < 0) issues.push(`${path}.value must be non-negative`);
    return isSpeciesId(value.numerator) && isSpeciesId(value.denominator) && isFiniteNumber(threshold) && threshold >= 0 && comparison
      ? { type: 'population-ratio', numerator: value.numerator, denominator: value.denominator, comparison, value: threshold }
      : null;
  }
  if (value.type === 'biomass') {
    checkKeys(value, ['type', 'species', 'comparison', 'value'], path, issues);
    if (value.species !== null && (!isSpeciesId(value.species) || (knownSpecies && !knownSpecies.has(value.species)))) {
      issues.push(`${path}.species must be null or a species in the world roster`);
    }
    if (!isFiniteNumber(threshold) || threshold < 0) issues.push(`${path}.value must be non-negative`);
    return (value.species === null || isSpeciesId(value.species)) && isFiniteNumber(threshold) && threshold >= 0 && comparison
      ? { type: 'biomass', species: value.species, comparison, value: threshold }
      : null;
  }
  if (value.type === 'tick') {
    checkKeys(value, ['type', 'comparison', 'value'], path, issues);
    if (!Number.isInteger(threshold) || (threshold as number) < 0) issues.push(`${path}.value must be a non-negative integer tick`);
    return Number.isInteger(threshold) && (threshold as number) >= 0 && comparison
      ? { type: 'tick', comparison, value: threshold as number }
      : null;
  }

  issues.push(`${path}.type "${value.type}" is not supported`);
  return null;
}

// eslint-disable-next-line complexity -- effect variants must be exhaustively range-checked at this boundary.
function parseEffect(
  input: unknown,
  path: string,
  issues: string[],
  context: RuleValidationContext,
  knownSpecies: ReadonlySet<string> | null,
): RuleEffect | null {
  const value = asPlainRecord(input);
  if (!value || typeof value.type !== 'string') {
    issues.push(`${path} must be an effect object with a known type`);
    return null;
  }
  if (value.type === 'field-shift' || value.type === 'resource-shift') {
    const isField = value.type === 'field-shift';
    checkKeys(value, ['type', isField ? 'field' : 'resource', 'x', 'y', 'radius', 'amount'], path, issues);
    const target = isField ? value.field : value.resource;
    const validTarget = isField
      ? FIELD_IDS.includes(target as FieldId)
      : RESOURCE_IDS.includes(target as ResourceId);
    if (!validTarget) issues.push(`${path}.${isField ? 'field' : 'resource'} is unknown`);
    const x = value.x;
    const y = value.y;
    const radius = value.radius;
    const amount = value.amount;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(radius) || radius <= 0 || !isFiniteNumber(amount) || amount === 0) {
      issues.push(`${path} needs finite coordinates, a positive radius and a non-zero amount`);
      return null;
    }
    if (context.width !== undefined && (x < 0 || x >= context.width)) issues.push(`${path}.x is outside the world`);
    if (context.height !== undefined && (y < 0 || y >= context.height)) issues.push(`${path}.y is outside the world`);
    if (context.width !== undefined && context.height !== undefined && radius > Math.max(context.width, context.height) * 2) {
      issues.push(`${path}.radius exceeds the safe world bound`);
    }
    const limit = isField
      ? FIELD_SPECS[target as FieldId].max - FIELD_SPECS[target as FieldId].min
      : RESOURCE_LIMITS[target as ResourceId].max - RESOURCE_LIMITS[target as ResourceId].min;
    if (Math.abs(amount) > limit) issues.push(`${path}.amount exceeds the target's physical range`);
    if (!validTarget || issues.some((issue) => issue.startsWith(path))) return null;
    return isField
      ? { type: 'field-shift', field: target as FieldId, x, y, radius, amount }
      : { type: 'resource-shift', resource: target as ResourceId, x, y, radius, amount };
  }

  if (value.type === 'metabolism-scale' || value.type === 'growth-scale' || value.type === 'reproduction-scale') {
    checkKeys(value, ['type', 'species', 'factor'], path, issues);
    const species = value.species;
    const factor = value.factor;
    if (!isSpeciesId(species) || (knownSpecies && !knownSpecies.has(species))) {
      issues.push(`${path}.species is not in the world roster`);
    }
    if (!isFiniteNumber(factor) || factor < 0.1 || factor > 4) {
      issues.push(`${path}.factor must be in [0.1, 4]`);
    }
    if (!isSpeciesId(species) || !isFiniteNumber(factor) || factor < 0.1 || factor > 4) return null;
    if (value.type === 'metabolism-scale') return { type: 'metabolism-scale', species, factor };
    if (value.type === 'growth-scale') return { type: 'growth-scale', species, factor };
    return { type: 'reproduction-scale', species, factor };
  }

  issues.push(`${path}.type "${value.type}" is not supported`);
  return null;
}

function parseComparison(value: unknown, path: string, issues: string[]): RuleComparison | null {
  if (typeof value !== 'string' || !COMPARISONS.includes(value as RuleComparison)) {
    issues.push(`${path} must be one of lt, lte, eq, gte or gt`);
    return null;
  }
  return value as RuleComparison;
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path} has unsupported key "${key}"`);
  }
}

function asPlainRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return input as Record<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSpeciesId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value);
}

function compare(actual: number, operator: RuleComparison, expected: number): boolean {
  switch (operator) {
    case 'lt': return actual < expected;
    case 'lte': return actual <= expected;
    case 'eq': return actual === expected;
    case 'gte': return actual >= expected;
    case 'gt': return actual > expected;
  }
}

/** Pure condition evaluator: all reads come from an immutable turn observation. */
export function evaluateCondition(condition: RuleCondition, observation: RuleObservation): boolean {
  switch (condition.type) {
    case 'all': return condition.terms.every((term) => evaluateCondition(term, observation));
    case 'any': return condition.terms.some((term) => evaluateCondition(term, observation));
    case 'not': return !evaluateCondition(condition.term, observation);
    case 'field-mean': return compare(observation.fieldMeans[condition.field], condition.comparison, condition.value);
    case 'resource-mean': return compare(observation.resourceMeans[condition.resource], condition.comparison, condition.value);
    case 'population': return compare(observation.populations[condition.species] ?? 0, condition.comparison, condition.value);
    case 'population-ratio': {
      const numerator = observation.populations[condition.numerator] ?? 0;
      const denominator = observation.populations[condition.denominator] ?? 0;
      const ratio = denominator > 0 ? numerator / denominator : numerator > 0 ? Number.MAX_SAFE_INTEGER : 0;
      return compare(ratio, condition.comparison, condition.value);
    }
    case 'biomass': {
      const amount = condition.species === null
        ? Object.values(observation.biomass).reduce((sum, value) => sum + value, 0)
        : observation.biomass[condition.species] ?? 0;
      return compare(amount, condition.comparison, condition.value);
    }
    case 'tick': return compare(observation.tick, condition.comparison, condition.value);
  }
}

/**
 * Stateful, deterministic rule scheduler. It takes one observation per turn, sorts rules by priority
 * and stable id, and returns only enumerated effect records for World to interpret.
 */
export class RuleEngine {
  private readonly orderedRules: readonly EcosystemRule[];
  private readonly firedOnce = new Set<string>();

  constructor(rules: readonly EcosystemRule[]) {
    this.orderedRules = [...rules].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  evaluate(observation: RuleObservation): readonly RuleActivation[] {
    const activations: RuleActivation[] = [];
    const claimedGroups = new Set<string>();
    for (const rule of this.orderedRules) {
      if (rule.frequency === 'once' && this.firedOnce.has(rule.id)) continue;
      if (!evaluateCondition(rule.prerequisites, observation)) continue;
      if (rule.mode === 'exclusive') {
        const group = rule.group;
        if (group === null || claimedGroups.has(group)) continue;
        claimedGroups.add(group);
      }
      if (rule.frequency === 'once') this.firedOnce.add(rule.id);
      for (const effect of rule.effects) activations.push({ ruleId: rule.id, effect });
    }
    return activations;
  }

  firedRuleIds(): readonly string[] {
    return [...this.firedOnce].sort();
  }
}
