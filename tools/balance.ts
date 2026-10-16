/**
 * Headless balance harness (ADR-003).
 *
 * Runs every sector without any player intervention and reports the ecosystem's trajectory:
 * populations, biomass, death causes, extinctions, stability and simulation throughput. This is the
 * tool used to tune the constants in `core/sim/world.ts` and the species catalogue — it measures the
 * *actual* simulation, not a model of it.
 *
 * Usage:
 *   npm run balance              # default horizon per sector
 *   npm run balance -- 4000      # custom horizon in ticks
 *   npm run balance -- 4000 KEL-4
 */

import { SPECIES_LIST, SPECIES_BY_ID } from '../src/content/species.ts';
import { SECTORS } from '../src/content/sectors.ts';
import { World } from '../src/core/sim/world.ts';
import { assertValidSector } from '../src/core/sim/sector.ts';
import { fitnessAt } from '../src/core/sim/species.ts';
import { DEATH_CAUSE_LABELS, type DeathCause } from '../src/core/sim/events.ts';

interface Options {
  ticks: number;
  only?: string;
  /** Number of *different* world seeds to test per sector (replayability check). */
  seeds: number;
}

function parseArgs(argv: readonly string[]): Options {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const seedFlag = argv.find((a) => a.startsWith('--seeds='));
  const ticks = positional[0] ? Number.parseInt(positional[0], 10) : 0;
  const seeds = seedFlag ? Number.parseInt(seedFlag.split('=')[1] ?? '1', 10) : 1;
  return {
    ticks: Number.isFinite(ticks) && ticks > 0 ? ticks : 0,
    only: positional[1],
    seeds: Number.isFinite(seeds) && seeds > 0 ? seeds : 1,
  };
}

/**
 * Fraction of the sector where each species can sustain itself. A viable sector needs its producers
 * above ~25 % of liveable area and its consumers above ~15 % (they also need prey, not just
 * climate). Printed before the run so a bad sector is obvious before interpreting the trajectory.
 */
function reportHabitability(
  sector: (typeof SECTORS)[number],
  world: World,
): void {
  const rows: string[] = [];
  for (const [i, id] of sector.roster.entries()) {
    const traits = SPECIES_BY_ID.get(id)?.traits;
    if (!traits) throw new ContentError(`sector ${sector.id} rosters unknown species ${id}`);
    const t = traits;
    let liveable = 0;
    let good = 0;
    let sum = 0;
    for (let y = 0; y < sector.height; y++) {
      for (let x = 0; x < sector.width; x++) {
        const fit = fitnessAt(t, world.readingsAt(x + 0.5, y + 0.5));
        if (fit > 0.3) liveable++;
        if (fit > 0.6) good++;
        sum += fit;
      }
    }
    const cells = sector.width * sector.height;
    rows.push(
      `${id} liveable=${((liveable / cells) * 100).toFixed(0)}% good=${((good / cells) * 100).toFixed(0)}% meanFit=${(sum / cells).toFixed(2)} (rank ${i + 1})`,
    );
  }
  console.log('  habitability: ' + rows.join(' | '));
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  let failures = 0;

  for (let seedIndex = 0; seedIndex < options.seeds; seedIndex++) {
  for (const sector of SECTORS) {
    if (options.only && sector.id !== options.only) continue;
    assertValidSector(sector, SPECIES_BY_ID);
    const horizon = options.ticks || sector.surveyTicks;
    const worldSeed = (sector.seed ^ Math.imul(seedIndex + 1, 0x9e3779b1)) >>> 0;
    const world = new World({ config: sector, species: SPECIES_LIST, seed: worldSeed });

    // Habitability diagnostic: how much of the map can each species actually live on at tick 0?
    reportHabitability(sector, world);

    const start = process.hrtime.bigint();
    const checkpoints = new Set([Math.floor(horizon / 4), Math.floor(horizon / 2), horizon]);
    const initial = world.counts();

    console.log('');
    console.log(
      `=== ${sector.designation} ${sector.name} — ${horizon} ticks, seed 0x${worldSeed.toString(16)} (${seedIndex + 1}/${options.seeds}) ===`,
    );
    for (let t = 1; t <= horizon; t++) {
      world.step();
      if (checkpoints.has(t)) {
        const counts = world.counts();
        const parts = sector.roster.map((id) => `${id}=${counts[id] ?? 0}`);
        console.log(
          `  t=${pad(String(t), 5)} ${parts.join(' ')}  biomass=${world.totalBiomass().toFixed(0)}  stability=${world.stability().toFixed(2)}`,
        );
      }
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    console.log('  initial: ' + sector.roster.map((id) => `${id}=${initial[id] ?? 0}`).join(' '));
    console.log(
      `  throughput: ${((horizon / elapsedMs) * 1000).toFixed(0)} ticks/s, ${(elapsedMs / horizon).toFixed(2)} ms/tick`,
    );

    const deaths = world.counters.deathsByCause;
    const causeTotals = new Map<DeathCause, number>();
    for (const [key, value] of deaths) {
      const cause = key.split(':')[1] as DeathCause;
      causeTotals.set(cause, (causeTotals.get(cause) ?? 0) + value);
    }
    const causeReport = [...causeTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cause, n]) => `${DEATH_CAUSE_LABELS[cause] ?? cause}=${n}`)
      .join(', ');
    console.log(`  deaths: ${causeReport || 'none'}`);
    console.log(
      `  births: ${sector.roster.map((id) => `${id}=${world.counters.births.get(id) ?? 0}`).join(' ')}`,
    );

    const finalCounts = world.counts();
    const extinct = sector.roster.filter((id) => (finalCounts[id] ?? 0) === 0);
    if (extinct.length > 0) {
      console.log(`  !! local extinctions: ${extinct.join(', ')}`);
      failures++;
    }
    for (const id of sector.roster) {
      const before = initial[id] ?? 0;
      const after = finalCounts[id] ?? 0;
      if (before > 0 && after === 0) {
        console.log(`  !! ${id} died out entirely (${before} -> 0)`);
      }
    }
  }

  }
  console.log('');
  console.log(
    failures === 0
      ? `balance: no local extinctions in the surveyed horizon (${options.seeds} seed(s) per sector)`
      : `balance: ${failures} collapsed run(s)`,
  );
  if (failures > 0) process.exitCode = 1;
}

main();
