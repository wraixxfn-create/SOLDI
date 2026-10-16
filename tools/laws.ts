/**
 * Law audit harness.
 *
 * Prints every proposition of every sector together with the measurements behind it, then runs the
 * same fairness audit the test-suite runs (`src/content/law-fairness.ts`) and exits non-zero if any
 * proposition is unfair: an ambiguous answer, a claim no instrument can verify, a measurement that
 * contradicts the species' own tolerances, or evidence containing a non-number.
 *
 * Run it after touching `src/content/laws.ts`, `src/content/species.ts` or a sector's climate.
 */
import { SECTORS } from '../src/content/sectors.ts';
import { propositionsFor, totalWeight, type Proposition } from '../src/content/laws.ts';
import {
  MIN_BAND_PRESENCE,
  MIN_BIRTH_FACTOR,
  MIN_GATING_MARGIN,
  MIN_IN_BAND_FITNESS,
  MIN_TROPHIC_SHARE,
  auditSectorLaws,
} from '../src/content/law-fairness.ts';
import { computeFieldDistributions } from '../src/core/sim/sector.ts';
import { analyseGating } from '../src/core/sim/species.ts';
import { SPECIES_BY_ID } from '../src/content/species.ts';
import { bandIdFor, bandFor, canonicalObservation } from '../src/content/laws.ts';

const showMargins = process.argv.includes('--margins');

if (showMargins) {
  console.log('gating margins per sector (winner / runner-up / margin)');
  for (const sector of SECTORS) {
    const distributions = computeFieldDistributions(sector);
    console.log(`\n${sector.id}`);
    const rows = sector.roster
      .map((id) => {
        const traits = SPECIES_BY_ID.get(id)?.traits;
        if (!traits) return `  ${id}  (no traits found)`;
        const analysis = analyseGating(traits, distributions);
        const runnerUp = analysis.losses[analysis.field] - analysis.margin;
        const flag = analysis.margin < MIN_GATING_MARGIN ? '  <-- too close to call, unusable' : '';
        return `  ${id}  winner=${analysis.field.padEnd(11)} ${(analysis.losses[analysis.field] * 100)
          .toFixed(0)
          .padStart(3)}%  runner-up=${(runnerUp * 100).toFixed(0).padStart(3)}%  margin=${(
          analysis.margin * 100
        )
          .toFixed(1)
          .padStart(5)} pts${flag}`;
      })
      .sort();
    for (const row of rows) console.log(row);
  }
}

function optionLabel(proposition: Proposition): string {
  const option = proposition.options.find((o) => o.id === proposition.correctOptionId);
  return option ? `${option.id} — ${option.label}` : proposition.correctOptionId;
}

let issueCount = 0;

for (const sector of SECTORS) {
  const propositions = propositionsFor(sector);
  console.log(
    `\n=== ${sector.id} ${sector.name} — ${propositions.length} proposition(s), total weight ${totalWeight(propositions).toFixed(2)} ===`,
  );
  for (const proposition of propositions) {
    console.log(`  [${proposition.kind}] ${proposition.prompt}`);
    console.log(`      answer: ${optionLabel(proposition)}  (weight ${proposition.weight.toFixed(2)})`);
    for (const [key, value] of Object.entries(proposition.evidence)) {
      console.log(`      · ${key}: ${value}`);
    }
    if (proposition.kind === 'tolerance' && proposition.field) {
      const observed = canonicalObservation(sector).birthFieldMean(proposition.subject, proposition.field);
      if (observed.samples > 0) {
        const band = bandFor(proposition.field, observed.value);
        console.log(
          `      · observed: ${observed.samples} births, mean ${observed.value.toFixed(2)} (${band.id} band)` +
            `${band.id === proposition.correctOptionId ? '' : '  <-- differs from the claimed band'}`,
        );
      }
    }
  }

  const issues = auditSectorLaws(sector, bandIdFor);
  issueCount += issues.length;
  for (const issue of issues) console.log(`  !! UNFAIR ${issue.propositionId} [${issue.kind}]: ${issue.detail}`);
}

console.log(
  `\nlaws: rules enforced — gating margin >= ${MIN_GATING_MARGIN}, dominant prey share >= ${MIN_TROPHIC_SHARE},` +
    ` band present >= ${MIN_BAND_PRESENCE * 100}% or creatable by an instrument, in-band fitness >= ${MIN_IN_BAND_FITNESS},` +
    ` birth-site factor >= ${MIN_BIRTH_FACTOR}`,
);

if (issueCount > 0) {
  console.log(`laws: ${issueCount} unfair proposition(s)`);
  process.exitCode = 1;
} else {
  console.log('laws: every proposition is unambiguous, verifiable with the sector\'s own instruments, and consistent with observation');
}
