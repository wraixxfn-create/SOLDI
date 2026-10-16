import type { SectorConfig } from '../core/sim/sector.ts';
import type { SpeciesId } from '../core/sim/species.ts';
import type { World } from '../core/sim/world.ts';
import { totalWeight, type Proposition } from '../content/laws.ts';
import { clamp01 } from '../core/math.ts';

/**
 * Report grading.
 *
 * The formula is the one in docs/DESIGN.md §6 and is implemented here, once:
 *
 *     correctness  = weighted correct propositions / total weight
 *     conservation = f(final biomass vs. the sector's target band, extinctions)
 *     efficiency   = 1 − spentCharge / initialCharge × 0.5      (clamped to 0.5…1)
 *     score        = 1000 × correctness^1.3 × (0.6 + 0.25·conservation + 0.15·efficiency)
 *
 * Nothing here is random and nothing is fudged: every input is a real measurement of the mission.
 */

export interface ReportAnswer {
  readonly propositionId: string;
  readonly optionId: string;
  readonly confidence: 'low' | 'high';
}

export interface PropositionResult {
  readonly propositionId: string;
  readonly subject: SpeciesId;
  readonly kind: Proposition['kind'];
  readonly prompt: string;
  readonly chosenOptionId: string | null;
  readonly correctOptionId: string;
  readonly correct: boolean;
  readonly weight: number;
  readonly confidence: 'low' | 'high' | 'unanswered';
  readonly explanation: string;
  readonly evidence: Readonly<Record<string, string>>;
}

export interface Grade {
  readonly score: number;
  readonly rank: Rank;
  readonly correctness: number;
  readonly conservation: number;
  readonly efficiency: number;
  readonly results: readonly PropositionResult[];
  readonly biomass: number;
  readonly extinctionCount: number;
  readonly spentCharge: number;
  readonly spentIntegrity: number;
}

export type Rank = 'S' | 'A' | 'B' | 'C' | 'F';

export const RANK_THRESHOLDS: readonly { readonly rank: Rank; readonly min: number }[] = Object.freeze([
  { rank: 'S', min: 900 },
  { rank: 'A', min: 750 },
  { rank: 'B', min: 550 },
  { rank: 'C', min: 1 },
  { rank: 'F', min: 0 },
]);

export function rankFor(score: number): Rank {
  for (const threshold of RANK_THRESHOLDS) {
    if (score >= threshold.min) return threshold.rank;
  }
  return 'F';
}

/**
 * Conservation score (0…1).
 *
 * Inside the sector's target band with no extinctions: 1. Below the band: falls off with how much of
 * the band's lower edge is missing. Above it: falls off more gently (an over-grown sector is still a
 * live sector, but it is no longer the one that was surveyed). Each extinct species costs a fifth of
 * the remaining score — a local extinction is recoverable knowledge, a collapse is not.
 */
export function conservationScore(
  config: SectorConfig,
  biomass: number,
  extinctSpecies: number,
  rosterSize: number,
): number {
  const { min, max } = config.biomassTarget;
  let band = 1;
  if (biomass < min) band = min <= 0 ? 0 : biomass / min;
  else if (biomass > max) band = max <= 0 ? 0 : Math.max(0, 1 - (biomass - max) / max);
  const extinctions = rosterSize <= 0 ? 0 : clamp01(extinctSpecies / rosterSize);
  return clamp01(clamp01(band) * (1 - 0.2 * extinctions));
}

export function efficiencyScore(initialCharge: number, spentCharge: number): number {
  if (initialCharge <= 0) return 0.5;
  return clamp01(1 - (spentCharge / initialCharge) * 0.5) * 0.5 + 0.5;
}

export interface GradeInput {
  readonly config: SectorConfig;
  readonly propositions: readonly Proposition[];
  readonly answers: ReadonlyMap<string, ReportAnswer>;
  readonly world: World;
  readonly budget: { readonly charge: number; readonly spentCharge: number; readonly spentIntegrity: number };
}

export function gradeReport(input: GradeInput): Grade {
  const results: PropositionResult[] = [];
  let earned = 0;
  for (const proposition of input.propositions) {
    const answer = input.answers.get(proposition.id);
    // Confidence is recorded for the player's own reading of the report; it does not change the
    // score. Guessing high-confidence wrong answers is still wrong.
    const chosen = answer?.optionId ?? null;
    const correct = chosen === proposition.correctOptionId;
    if (correct) earned += proposition.weight;
    results.push({
      propositionId: proposition.id,
      subject: proposition.subject,
      kind: proposition.kind,
      prompt: proposition.prompt,
      chosenOptionId: chosen,
      correctOptionId: proposition.correctOptionId,
      correct,
      weight: proposition.weight,
      confidence: answer?.confidence ?? 'unanswered',
      explanation: proposition.explanation,
      evidence: proposition.evidence,
    });
  }

  const total = totalWeight(input.propositions);
  const correctness = total > 0 ? clamp01(earned / total) : 0;
  const extinct = input.world.extinctSpecies();
  const conservation = conservationScore(
    input.config,
    input.world.totalBiomass(),
    extinct.length,
    input.config.roster.length,
  );
  const efficiency = efficiencyScore(input.config.startingCharge, input.budget.spentCharge);
  const score = Math.round(
    1000 * Math.pow(correctness, 1.3) * (0.6 + 0.25 * conservation + 0.15 * efficiency),
  );

  return {
    score,
    rank: rankFor(score),
    correctness,
    conservation,
    efficiency,
    results,
    biomass: input.world.totalBiomass(),
    extinctionCount: extinct.length,
    spentCharge: input.budget.spentCharge,
    spentIntegrity: input.budget.spentIntegrity,
  };
}
