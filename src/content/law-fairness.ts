import { FIELD_SPECS, type FieldId } from '../core/field.ts';
import { ContentError } from '../core/errors.ts';
import {
  analyseGating,
  fitnessAt,
  fitnessFactor,
  type SpeciesTraits,
} from '../core/sim/species.ts';
import {
  buildFields,
  computeFieldDistributions,
  type SectorConfig,
} from '../core/sim/sector.ts';
import {
  bandIdFor,
  canonicalObservation,
  propositionsFor,
  type Proposition,
} from './laws.ts';
import { SPECIES_BY_ID } from './species.ts';

/**
 * Fairness audit for the deduction layer.
 *
 * A Codex proposition is only allowed to exist in the campaign if a player could actually work out
 * the answer from what the world shows them. This module states that requirement as code so it can
 * be *executed*: `tools/laws.ts` (the content audit) and `tests/core/laws.test.ts` (the regression
 * suite) both call `auditSectorLaws`, so a rule can never drift between the two.
 *
 * The rules, and the reason for each one:
 *
 * 1. **Unambiguous answer** — the correct option must be measurably better than every alternative.
 *    A reproduction driver that wins by 1 % of growth is a coin flip, not a deduction.
 * 2. **Verifiable in play** — every proposition must be checkable with the instruments the sector
 *    actually ships (you cannot prove a law about temperature with no thermal or cryo instrument).
 * 3. **Consistent with observation** — the claim must not be contradicted by the player's own data:
 *    a species must breed only where its own tolerances allow it to live, and must be able to reach
 *    its claimed flourishing condition somewhere on the map.
 * 4. **Honest evidence** — every proposition carries real numbers, and none of them are NaN.
 */

export const MIN_GATING_MARGIN = 0.08;
export const MIN_TROPHIC_SHARE = 0.55;
/** Fraction of the sector's climate that must lie inside a claimed tolerance band. */
export const MIN_BAND_PRESENCE = 0.01;
/** Best fitness the species must be able to reach inside its claimed band, somewhere in the sector. */
export const MIN_IN_BAND_FITNESS = 0.6;
/** The species' own factor at its observed birth sites must be at least this (consistent, not proof). */
export const MIN_BIRTH_FACTOR = 0.5;

export interface LawIssue {
  readonly sectorId: string;
  readonly propositionId: string;
  readonly kind: string;
  readonly detail: string;
}

const FIELD_INSTRUMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  temperature: ['thermal', 'cryo'],
  humidity: ['humidifier', 'desiccator'],
  light: ['illuminator', 'umbra'],
});

function traitsOf(species: string): SpeciesTraits | undefined {
  return SPECIES_BY_ID.get(species)?.traits;
}

type Report = (detail: string) => void;

function auditRole(proposition: Proposition, traits: SpeciesTraits, report: Report): void {
  if (proposition.correctOptionId !== traits.role) report('role answer disagrees with the traits');
}

function auditStress(proposition: Proposition, traits: SpeciesTraits, report: Report): void {
  if (proposition.correctOptionId !== traits.stressResponse) {
    report('stress answer disagrees with the traits');
  }
}

function auditTolerance(
  config: SectorConfig,
  proposition: Proposition,
  traits: SpeciesTraits,
  classify: (field: FieldId, value: number) => string,
  report: Report,
): void {
  const field = proposition.field;
  if (!field) {
    report('tolerance proposition without a field');
    return;
  }
  const optimum = traits.tolerance[field].ideal;
  if (classify(field, optimum) !== proposition.correctOptionId) {
    report(`optimum ${optimum} is not in the claimed band`);
  }
  // Verifiable in play: either the sector already has that band, or an instrument can make it.
  const presence = bandPresence(config, field, proposition.correctOptionId, classify);
  const instruments = instrumentsForField(config, field);
  if (presence < MIN_BAND_PRESENCE && instruments.length === 0) {
    report(
      `the ${proposition.correctOptionId} band is absent (${(presence * 100).toFixed(1)} %) and no instrument in ${config.id} can create it`,
    );
  }
  // The claimed flourishing condition must be reachable here.
  const inBand = bestFitnessInBand(config, traits, field, proposition.correctOptionId, classify);
  if (inBand < MIN_IN_BAND_FITNESS) {
    report(`best fitness inside the claimed band is only ${inBand.toFixed(2)} (< ${MIN_IN_BAND_FITNESS})`);
  }
  // Observation must not contradict the claim. A species can be *pushed* to the edge of its tolerance
  // by food or predators, so this checks consistency (it lives within its tolerance), not proof — the
  // proof is that the player can create the band and watch growth improve.
  const observed = canonicalObservation(config).birthFieldMean(proposition.subject, field);
  if (observed.samples > 0) {
    const factor = fitnessFactor(traits, field, observed.value);
    if (factor < MIN_BIRTH_FACTOR) {
      report(
        `species bred at ${observed.value.toFixed(2)} ${FIELD_SPECS[field].unit}, where its own ${field} factor is only ${factor.toFixed(2)}`,
      );
    }
  }
}

function auditReproDriver(
  config: SectorConfig,
  proposition: Proposition,
  traits: SpeciesTraits,
  report: Report,
): void {
  const field = proposition.field;
  if (!field) {
    report('driver proposition without a field');
    return;
  }
  // Unambiguous: the same gating analysis the proposition was built from must show a margin.
  const analysis = analyseGating(traits, computeFieldDistributions(config));
  if (analysis.field !== proposition.correctOptionId) {
    report(`driver answer ${proposition.correctOptionId} != measured ${analysis.field}`);
  }
  if (analysis.margin < MIN_GATING_MARGIN) {
    report(
      `driver wins by only ${(analysis.margin * 100).toFixed(1)} points (< ${(MIN_GATING_MARGIN * 100).toFixed(0)})`,
    );
  }
  if (instrumentsForField(config, field).length === 0) {
    report(`no instrument in ${config.id} can change ${field}`);
  }
}

function auditTrophic(
  config: SectorConfig,
  proposition: Proposition,
  traits: SpeciesTraits,
  report: Report,
): void {
  if (traits.dietKind === 'none') {
    if (proposition.correctOptionId !== 'ambient') report('a producer was given a consumer diet');
    return;
  }
  const measured = canonicalObservation(config).primaryPrey.get(proposition.subject);
  if (!measured) {
    report('a consumer never took in any energy during the canonical observation');
    return;
  }
  if (measured.share < MIN_TROPHIC_SHARE) {
    report(
      `dominant source is only ${(measured.share * 100).toFixed(0)} % of intake (< ${(MIN_TROPHIC_SHARE * 100).toFixed(0)} %)`,
    );
  }
  if (!traits.diet.includes(measured.prey)) {
    report(`measured prey ${measured.prey} is not in the declared diet`);
  }
  if (proposition.correctOptionId !== measured.prey) {
    report('trophic answer disagrees with the measurement');
  }
}

/** Instruments available in this sector that can move the given field. */
export function instrumentsForField(config: SectorConfig, field: string): readonly string[] {
  const usable = FIELD_INSTRUMENTS[field] ?? [];
  return usable.filter((instrument) => config.instruments.includes(instrument));
}

/** Share of a sector's climate that falls inside a tolerance band of the given field. */
export function bandPresence(
  config: SectorConfig,
  field: FieldId,
  bandId: string,
  classify: (field: FieldId, value: number) => string,
): number {
  const distribution = computeFieldDistributions(config)[field];
  const step = (distribution.max - distribution.min) / Math.max(1, distribution.bins - 1);
  let weight = 0;
  for (let i = 0; i < distribution.bins; i++) {
    if (classify(field, distribution.min + step * i) === bandId) {
      weight += distribution.weights[i] as number;
    }
  }
  return weight;
}

/** Best fitness a species reaches in this sector among cells whose field falls in the given band. */
export function bestFitnessInBand(
  config: SectorConfig,
  traits: SpeciesTraits,
  field: FieldId,
  bandId: string,
  classify: (field: FieldId, value: number) => string,
): number {
  const fields = buildFields(config);
  let best = 0;
  for (let y = 0; y < config.height; y++) {
    for (let x = 0; x < config.width; x++) {
      const readings = {
        temperature: fields.temperature.sampleBilinear(x + 0.5, y + 0.5),
        humidity: fields.humidity.sampleBilinear(x + 0.5, y + 0.5),
        light: fields.light.sampleBilinear(x + 0.5, y + 0.5),
      };
      if (classify(field, readings[field]) !== bandId) continue;
      const fit = fitnessAt(traits, readings);
      if (fit > best) best = fit;
    }
  }
  return best;
}

/** Audits one proposition. `classify` maps a field value to a band id (see `bandFor`). */
export function auditProposition(
  config: SectorConfig,
  proposition: Proposition,
  classify: (field: FieldId, value: number) => string = bandIdFor,
): LawIssue[] {
  const issues: LawIssue[] = [];
  const report = (detail: string): void => {
    issues.push({ sectorId: config.id, propositionId: proposition.id, kind: proposition.kind, detail });
  };

  // 4. Honest evidence.
  if (proposition.options.length < 2) report('fewer than two options');
  if (!proposition.options.some((option) => option.id === proposition.correctOptionId)) {
    report(`correct option "${proposition.correctOptionId}" is not among the choices`);
  }
  if (!(proposition.weight > 0)) report('non-positive weight');
  const evidence = Object.entries(proposition.evidence);
  if (evidence.length < 2) report('fewer than two pieces of evidence');
  for (const [key, value] of evidence) {
    if (/NaN|undefined|Infinity/.test(String(value))) report(`evidence "${key}" is not a real reading`);
  }

  const traits = traitsOf(proposition.subject);
  if (!traits) {
    report(`unknown species ${proposition.subject}`);
    return issues;
  }

  const byKind: Record<string, () => void> = {
    role: () => auditRole(proposition, traits, report),
    stress: () => auditStress(proposition, traits, report),
    tolerance: () => auditTolerance(config, proposition, traits, classify, report),
    reproDriver: () => auditReproDriver(config, proposition, traits, report),
    trophic: () => auditTrophic(config, proposition, traits, report),
  };
  const check = byKind[proposition.kind];
  if (!check) {
    report(`unknown proposition kind ${String(proposition.kind)}`);
    return issues;
  }
  check();
  return issues;
}

/**
 * Audits every proposition of a sector.
 *
 * @param classify band classifier, normally `bandFor` from `laws.ts` (injected to keep this module
 *   free of a circular import).
 */
export function auditSectorLaws(
  config: SectorConfig,
  classify: (field: FieldId, value: number) => string = bandIdFor,
): LawIssue[] {
  const issues: LawIssue[] = [];
  for (const proposition of propositionsFor(config)) {
    issues.push(...auditProposition(config, proposition, classify));
  }
  if (issues.length > 0 && propositionsFor(config).length === 0) {
    issues.push({
      sectorId: config.id,
      propositionId: '-',
      kind: '-',
      detail: 'sector has no propositions at all',
    });
  }
  return issues;
}

/** Throws a `ContentError` listing every unfair proposition; used by content pipelines. */
export function assertLawsFair(
  config: SectorConfig,
  classify: (field: FieldId, value: number) => string = bandIdFor,
): void {
  const issues = auditSectorLaws(config, classify);
  if (issues.length === 0) return;
  throw new ContentError(
    `Unfair propositions in ${config.id}: ${issues.map((issue) => issue.detail).join('; ')}`,
    { issues },
  );
}
