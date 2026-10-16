import { describe, expect, it } from 'vitest';
import {
  ASSIST_COST,
  FIELD_BANDS,
  LAW_SPECS,
  bandIdFor,
  buildPropositions,
  canonicalObservation,
  propositionsFor,
  totalWeight,
  type Proposition,
} from '../../src/content/laws.ts';
import { SECTORS } from '../../src/content/sectors.ts';
import { SPECIES_BY_ID } from '../../src/content/species.ts';
import { computeFieldDistributions } from '../../src/core/sim/sector.ts';
import { FIELD_IDS } from '../../src/core/field.ts';
import { analyseGating, fitnessFactor } from '../../src/core/sim/species.ts';
import {
  MIN_BIRTH_FACTOR,
  MIN_GATING_MARGIN,
  MIN_IN_BAND_FITNESS,
  MIN_TROPHIC_SHARE,
  assertLawsFair,
  auditSectorLaws,
  bestFitnessInBand,
  instrumentsForField,
} from '../../src/content/law-fairness.ts';
import type { FieldId } from '../../src/core/field.ts';
import type { SectorConfig } from '../../src/core/sim/sector.ts';
import { ContentError } from '../../src/core/errors.ts';

const everyProposition: Array<{ sector: SectorConfig; proposition: Proposition }> = SECTORS.flatMap(
  (sector) => propositionsFor(sector).map((proposition) => ({ sector, proposition })),
);

describe('law specifications', () => {
  it('covers every shipped sector and no phantom sectors', () => {
    expect(Object.keys(LAW_SPECS).sort()).toEqual(SECTORS.map((sector) => sector.id).sort());
  });

  it('names only roster members as subjects', () => {
    for (const sector of SECTORS) {
      for (const spec of LAW_SPECS[sector.id] ?? []) {
        expect(sector.roster).toContain(spec.species);
        expect(SPECIES_BY_ID.has(spec.species)).toBe(true);
        if (spec.kind === 'tolerance') expect(FIELD_IDS).toContain(spec.field);
      }
    }
  });

  it('builds the same propositions every time (pure function of the configuration)', () => {
    const sector = SECTORS[4] as SectorConfig;
    const a = buildPropositions(sector);
    const b = buildPropositions(sector);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(propositionsFor(sector)).toBe(propositionsFor(sector));
  });

  it('refuses to build propositions for an unknown sector', () => {
    const phantom: SectorConfig = { ...(SECTORS[0] as SectorConfig), id: 'ZZZ-0' };
    expect(() => buildPropositions(phantom)).toThrow(ContentError);
  });
});

describe('proposition shape', () => {
  it('is well formed: unique ids, at least two distinct options and a correct answer', () => {
    for (const { proposition } of everyProposition) {
      expect(proposition.id.length).toBeGreaterThan(0);
      expect(proposition.prompt.length).toBeGreaterThan(10);
      expect(proposition.explanation.length).toBeGreaterThan(20);
      expect(proposition.weight).toBeGreaterThan(0);
      expect(proposition.assistCost).toBe(ASSIST_COST);
      expect(proposition.options.length).toBeGreaterThanOrEqual(2);
      const optionIds = proposition.options.map((option) => option.id);
      expect(new Set(optionIds).size).toBe(optionIds.length);
      expect(optionIds).toContain(proposition.correctOptionId);
      for (const option of proposition.options) expect(option.label.length).toBeGreaterThan(3);
    }
  });

  it('has unique ids across the whole campaign', () => {
    const ids = everyProposition.map(({ proposition }) => `${proposition.subject}/${proposition.id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shows the player real evidence for every answer', () => {
    for (const { proposition } of everyProposition) {
      const values = Object.entries(proposition.evidence);
      expect(values.length).toBeGreaterThanOrEqual(2);
      for (const [key, value] of values) {
        expect(key.length).toBeGreaterThan(0);
        expect(String(value).length).toBeGreaterThan(0);
        expect(String(value)).not.toMatch(/NaN|undefined|Infinity/);
      }
    }
  });

  it('does not leak the answer in the evidence of the same proposition', () => {
    for (const { proposition } of everyProposition) {
      if (proposition.kind !== 'tolerance') continue;
      // The band label is revealed with the debrief; the prompt must not name it.
      const band = FIELD_BANDS[proposition.field ?? 'temperature'].find(
        (candidate) => candidate.id === proposition.correctOptionId,
      );
      const keyword = band?.label.split(' ')[0] ?? '';
      expect(proposition.prompt.toLowerCase()).not.toContain(keyword.toLowerCase());
    }
  });
});

describe('fairness audit (shared with tools/laws.ts)', () => {
  it('finds no unfair proposition in any shipped sector', () => {
    const issues = SECTORS.flatMap((sector) => auditSectorLaws(sector));
    expect(
      issues.map((issue) => `${issue.sectorId} ${issue.propositionId}: ${issue.detail}`),
    ).toEqual([]);
  });

  it('assertLawsFair throws a ContentError listing what is unfair', () => {
    // ORP-2's laws name temperature as the limiting factor for two species. Take away the thermal and
    // cryo instruments and the player could never test that claim, so the pipeline must refuse it.
    const crippled: SectorConfig = { ...(SECTORS[3] as SectorConfig), instruments: ['probe'] };
    expect(() => assertLawsFair(crippled)).toThrow(ContentError);
    expect(() => assertLawsFair(crippled)).toThrow(/no instrument .*can change temperature/);
  });

  it('flags a band classifier that disagrees with the answer it audits', () => {
    // Sanity check on the auditor itself: inverting the classifier must produce issues.
    const inverted = (_field: FieldId, _value: number): string => 'nowhere';
    const issues = auditSectorLaws(SECTORS[0] as SectorConfig, inverted);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => /claimed band/.test(issue.detail))).toBe(true);
  });

  it('reports the per-sector margin and share limits it enforces', () => {
    expect(MIN_GATING_MARGIN).toBeGreaterThan(0);
    expect(MIN_TROPHIC_SHARE).toBeGreaterThan(0.5);
    expect(MIN_IN_BAND_FITNESS).toBeGreaterThan(0.5);
    expect(MIN_BIRTH_FACTOR).toBeGreaterThan(0);
  });
});

describe('every tolerance law is observable', () => {
  it('agrees with where the species actually reproduced', () => {
    for (const { sector, proposition } of everyProposition) {
      if (proposition.kind !== 'tolerance' || !proposition.field) continue;
      const field = proposition.field;
      const traits = SPECIES_BY_ID.get(proposition.subject)?.traits;
      if (!traits) throw new Error('missing traits');
      const observed = canonicalObservation(sector).birthFieldMean(proposition.subject, field);
      if (observed.samples === 0) continue; // a species that did not breed proves nothing
      // Consistency, not proof: the species must have bred inside its own tolerance for that field.
      expect(fitnessFactor(traits, field, observed.value)).toBeGreaterThanOrEqual(MIN_BIRTH_FACTOR);
    }
  });

  it('is realisable: the species can flourish inside the band it claims', () => {
    for (const { sector, proposition } of everyProposition) {
      if (proposition.kind !== 'tolerance' || !proposition.field) continue;
      const traits = SPECIES_BY_ID.get(proposition.subject)?.traits;
      if (!traits) throw new Error('missing traits');
      const field = proposition.field;
      const best = bestFitnessInBand(sector, traits, field, proposition.correctOptionId, bandIdFor);
      expect(best, `${sector.id}/${proposition.subject} cannot flourish in ${field}`).toBeGreaterThanOrEqual(
        MIN_IN_BAND_FITNESS,
      );
    }
  });
});

describe('every reproduction-driver law is unambiguous and actionable', () => {
  it('wins by a measurable margin, on the factor the gating analysis names', () => {
    for (const { sector, proposition } of everyProposition) {
      if (proposition.kind !== 'reproDriver') continue;
      const traits = SPECIES_BY_ID.get(proposition.subject)?.traits;
      if (!traits) throw new Error('missing traits');
      const analysis = analyseGating(traits, computeFieldDistributions(sector));
      expect(proposition.correctOptionId).toBe(analysis.field);
      expect(analysis.margin).toBeGreaterThanOrEqual(MIN_GATING_MARGIN);
      expect(proposition.evidence['winning margin']).toBeTruthy();
    }
  });

  it('can be acted on with the instruments that sector actually gives the player', () => {
    for (const { sector, proposition } of everyProposition) {
      if (proposition.kind !== 'reproDriver' || !proposition.field) continue;
      expect(
        instrumentsForField(sector, proposition.field).length,
        `${sector.id}: no instrument can change ${proposition.field}`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('every trophic law describes what really happened', () => {
  it('names the dominant measured energy source', () => {
    for (const { sector, proposition } of everyProposition) {
      if (proposition.kind !== 'trophic') continue;
      const traits = SPECIES_BY_ID.get(proposition.subject)?.traits;
      if (!traits) throw new Error('missing traits');
      if (traits.dietKind === 'none') {
        expect(proposition.correctOptionId).toBe('ambient');
        continue;
      }
      const measured = canonicalObservation(sector).primaryPrey.get(proposition.subject);
      expect(measured, `${sector.id}/${proposition.subject} never ate anything`).toBeTruthy();
      expect(proposition.correctOptionId).toBe(measured?.prey);
      expect(measured?.share ?? 0).toBeGreaterThanOrEqual(MIN_TROPHIC_SHARE);
      expect(traits.diet).toContain(proposition.correctOptionId);
    }
  });

  it('is deterministic: the same sector observation always yields the same answer', () => {
    for (const sector of SECTORS) {
      const first = canonicalObservation(sector);
      const second = canonicalObservation(sector);
      expect(first).toBe(second); // cached, therefore identical for every player
      expect(first.ticks).toBeGreaterThan(0);
      for (const measurement of first.primaryPrey.values()) {
        expect(measurement.share).toBeGreaterThanOrEqual(measurement.runnerUp);
      }
    }
  });
});

describe('campaign difficulty curve', () => {
  it('grows in proposition count or weight as the campaign progresses', () => {
    const weights = SECTORS.map((sector) => totalWeight(propositionsFor(sector)));
    expect(weights[0]).toBeLessThan(weights[weights.length - 1] as number);
    for (const weight of weights) expect(weight).toBeGreaterThan(0);
  });

  it('gives the first sector the smallest workload and the last the largest', () => {
    const counts = SECTORS.map((sector) => propositionsFor(sector).length);
    expect(counts[0]).toBe(Math.min(...counts));
    expect(counts[counts.length - 1]).toBe(Math.max(...counts));
  });

  it('mentions the assist cost on every proposition so the Charge price is never a surprise', () => {
    for (const { proposition } of everyProposition) expect(proposition.assistCost).toBe(ASSIST_COST);
  });
});
