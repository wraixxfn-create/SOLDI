/**
 * Per-species trace diagnostic.
 *
 * Companion to `tools/balance.ts`: when a species collapses, this prints *why* — mean energy,
 * climate fitness, local food availability, age distribution and death causes over time — so the
 * fix is based on measurement instead of guesswork.
 *
 * Usage:
 *   npm run trace -- KEL-4 ORS-9            # 100-tick samples for the whole survey window
 *   npm run trace -- VOX-9 SCU-4 800 50     # custom horizon and sampling interval
 */

import { SPECIES_LIST, SPECIES_BY_ID } from '../src/content/species.ts';
import { SECTORS, sectorByDesignation } from '../src/content/sectors.ts';
import { World } from '../src/core/sim/world.ts';
import { DEATH_CAUSE_LABELS, type DeathCause } from '../src/core/sim/events.ts';

function main(): void {
  const [designation, speciesId, horizonArg, intervalArg, seedArg] = process.argv.slice(2);
  if (!designation || !speciesId) {
    console.error('usage: npm run trace -- <SECTOR-ID> <SPECIES-ID> [ticks] [interval]');
    process.exitCode = 2;
    return;
  }
  const sector = sectorByDesignation(designation) ?? SECTORS.find((s) => s.id === designation);
  if (!sector) {
    console.error(`unknown sector "${designation}"`);
    process.exitCode = 2;
    return;
  }
  const traits = SPECIES_BY_ID.get(speciesId)?.traits;
  if (!traits) {
    console.error(`unknown species "${speciesId}"`);
    process.exitCode = 2;
    return;
  }
  const horizon = horizonArg ? Number.parseInt(horizonArg, 10) : sector.surveyTicks;
  const interval = intervalArg ? Number.parseInt(intervalArg, 10) : 100;

  // Number() rather than parseInt(…, 10) so a hex seed like 0xc0da49b2 can be pasted straight in.
  const seed = seedArg ? Number(seedArg) >>> 0 : sector.seed;
  const world = new World({ config: sector, species: SPECIES_LIST, seed });
  console.log(`trace ${speciesId} in ${sector.designation} for ${horizon} ticks (every ${interval})`);
  console.log(
    '   tick   count  meanE  minE   meanFit  meanFood  hungry%  deaths(starvation/exposure/age/grazed/predation)',
  );

  const deathStart = new Map<string, number>();
  for (let t = 1; t <= horizon; t++) {
    world.step();
    if (t % interval !== 0 && t !== horizon) continue;

    const members = world.agents.filter((a) => a.species === speciesId);
    let sumEnergy = 0;
    let minEnergy = Number.POSITIVE_INFINITY;
    let sumFit = 0;
    let sumFood = 0;
    let hungry = 0;
    for (const agent of members) {
      sumEnergy += agent.energy;
      minEnergy = Math.min(minEnergy, agent.energy);
      if (agent.energy < traits.reproEnergy) hungry++;
      sumFit += world.fitnessAt(agent.x, agent.y, speciesId);
      if (traits.dietKind !== 'none') {
        sumFood += foodScore(world, agent.x, agent.y, speciesId);
      }
    }
    const n = Math.max(1, members.length);

    const causes: string[] = [];
    for (const cause of ['starvation', 'exposure', 'age', 'grazed', 'predation'] as DeathCause[]) {
      const value = world.counters.deathsByCause.get(`${speciesId}:${cause}`) ?? 0;
      const start = deathStart.get(cause) ?? 0;
      deathStart.set(cause, value);
      causes.push(String(value - start));
    }

    console.log(
      [
        t.toString().padStart(7),
        members.length.toString().padStart(6),
        (sumEnergy / n).toFixed(1).padStart(6),
        (members.length ? minEnergy : 0).toFixed(1).padStart(5),
        (sumFit / n).toFixed(2).padStart(8),
        (sumFood / n).toFixed(2).padStart(9),
        (((hungry / n) * 100).toFixed(0) + '%').padStart(7),
        causes.join('/'),
      ].join(' '),
    );
  }

  const deaths = world.counters.deathsByCause;
  console.log('cumulative deaths by cause:');
  for (const [key, value] of deaths) {
    if (!key.startsWith(`${speciesId}:`)) continue;
    const cause = key.split(':')[1] as DeathCause;
    console.log(`  ${DEATH_CAUSE_LABELS[cause] ?? cause}: ${value}`);
  }
  console.log(`births: ${world.counters.births.get(speciesId) ?? 0}`);
  const shares = [...world.intakeShares(speciesId).entries()]
    .map(([prey, share]) => `${prey}=${(share * 100).toFixed(0)}%`)
    .join(' ');
  console.log(`intake shares: ${shares || 'none'}`);
}

/** Mirrors the foraging signal the simulation uses, so the trace is directly comparable. */
function foodScore(world: World, x: number, y: number, speciesId: string): number {
  const traits = world.getSpecies(speciesId);
  let total = 0;
  if (traits.dietKind === 'biomass') {
    for (const prey of traits.diet) {
      const field = world.biomassFields.get(prey);
      if (!field) continue;
      for (let cy = -2; cy <= 2; cy++) {
        for (let cx = -2; cx <= 2; cx++) {
          total += field.getAt(x + cx, y + cy);
        }
      }
    }
  } else if (traits.dietKind === 'predation') {
    for (const other of world.agents) {
      if (!traits.diet.includes(other.species)) continue;
      if (Math.hypot(other.x - x, other.y - y) <= traits.sense) total += 1;
    }
  }
  return total;
}

main();
