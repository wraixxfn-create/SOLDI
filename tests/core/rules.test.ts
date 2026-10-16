import { describe, expect, it } from 'vitest';
import {
  RuleEngine,
  evaluateCondition,
  parseRuleSet,
  type EcosystemRule,
  type RuleObservation,
} from '../../src/core/sim/rules.ts';

const observation: RuleObservation = {
  tick: 12,
  fieldMeans: { temperature: 305, humidity: 0.62, light: 0.45 },
  resourceMeans: { water: 0.51, nutrients: 0.7 },
  populations: { 'PHY-1': 20, 'PRE-1': 5, 'DEC-1': 8, 'SYM-1': 10 },
  biomass: { 'PHY-1': 9, 'PRE-1': 1, 'DEC-1': 0, 'SYM-1': 3 },
};

function rule(
  id: string,
  priority: number,
  mode: EcosystemRule['mode'],
  group: string | null,
  frequency: EcosystemRule['frequency'],
  factor: number,
): EcosystemRule {
  return {
    id,
    priority,
    mode,
    group,
    frequency,
    prerequisites: {
      type: 'all',
      terms: [
        { type: 'field-mean', field: 'temperature', comparison: 'gt', value: 300 },
        { type: 'population-ratio', numerator: 'PHY-1', denominator: 'PRE-1', comparison: 'gte', value: 2 },
        { type: 'not', term: { type: 'tick', comparison: 'lt', value: 1 } },
      ],
    },
    effects: [{ type: 'metabolism-scale', species: 'PHY-1', factor }],
  };
}

describe('typed ecosystem rules', () => {
  it('evaluates boolean conditions and ecological population ratios from a fixed observation', () => {
    const condition: EcosystemRule['prerequisites'] = {
      type: 'any',
      terms: [
        { type: 'resource-mean', resource: 'water', comparison: 'lt', value: 0.4 },
        {
          type: 'all',
          terms: [
            { type: 'population-ratio', numerator: 'PHY-1', denominator: 'PRE-1', comparison: 'gt', value: 3 },
            { type: 'biomass', species: null, comparison: 'gte', value: 10 },
          ],
        },
      ],
    };
    expect(evaluateCondition(condition, observation)).toBe(true);
    expect(evaluateCondition({ type: 'population', species: 'PRE-1', comparison: 'eq', value: 0 }, observation)).toBe(false);
  });

  it('sorts by priority then stable id, supports exclusive groups and runs one-shot rules once', () => {
    const rules = [
      rule('exclusive-low', 10, 'exclusive', 'climate', 'each-turn', 0.5),
      rule('repeat', 0, 'stack', null, 'each-turn', 1.1),
      rule('one-shot', 5, 'stack', null, 'once', 0.8),
      rule('exclusive-high', 20, 'exclusive', 'climate', 'each-turn', 0.75),
    ];
    const engine = new RuleEngine(rules);
    expect(engine.evaluate(observation).map((activation) => activation.ruleId)).toEqual([
      'exclusive-high',
      'one-shot',
      'repeat',
    ]);
    expect(engine.firedRuleIds()).toEqual(['one-shot']);
    expect(engine.evaluate(observation).map((activation) => activation.ruleId)).toEqual([
      'exclusive-high',
      'repeat',
    ]);
  });

  it('parses and copies an explicit data-only rule set with bounded parameters', () => {
    const source = [rule('valid-rule', 10, 'stack', null, 'each-turn', 1.25)];
    const parsed = parseRuleSet(source, {
      width: 32,
      height: 24,
      species: ['PHY-1', 'PRE-1', 'DEC-1', 'SYM-1'],
    });
    expect(parsed.issues).toEqual([]);
    expect(parsed.rules).toEqual(source);
    expect(parsed.rules[0]).not.toBe(source[0]);
  });

  it('rejects executable-looking level input, unknown operations and unrecognized properties', () => {
    const untrusted = [
      {
        id: 'unsafe',
        priority: 1,
        mode: 'stack',
        group: null,
        frequency: 'each-turn',
        prerequisites: { type: 'eval', source: 'globalThis.compromised = true' },
        effects: [{ type: 'field-shift', field: 'temperature', x: 2, y: 2, radius: 1, amount: 5 }],
        execute: 'arbitrary code is not part of this schema',
      },
    ];
    const parsed = parseRuleSet(untrusted, { width: 32, height: 24, species: ['PHY-1'] });
    expect(parsed.rules).toEqual([]);
    expect(parsed.issues.join(' ')).toMatch(/unsupported key|not supported/);
    expect((globalThis as typeof globalThis & { compromised?: boolean }).compromised).toBeUndefined();
  });

  it('rejects unsafe coordinates, unknown species, unbounded factors and duplicate ids', () => {
    const base = rule('bounded', 1, 'stack', null, 'each-turn', 1);
    const outOfBounds: EcosystemRule = {
      ...base,
      effects: [{ type: 'field-shift', field: 'temperature', x: 40, y: 1, radius: 2, amount: 10 }],
    };
    const invalid = parseRuleSet([base, { ...base }, outOfBounds], {
      width: 32,
      height: 24,
      species: ['PHY-1'],
    });
    expect(invalid.issues.join(' ')).toMatch(/duplicates/);
    expect(invalid.issues.join(' ')).toMatch(/not in the world roster/);
    expect(invalid.issues.join(' ')).toMatch(/outside the world/);

    const badFactor = parseRuleSet([
      { ...base, effects: [{ type: 'growth-scale', species: 'PHY-1', factor: 99 }] },
    ], { width: 32, height: 24, species: ['PHY-1'] });
    expect(badFactor.issues.join(' ')).toMatch(/factor must be in/);
  });
});
