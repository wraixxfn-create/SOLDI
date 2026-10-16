import { describe, expect, it } from 'vitest';
import { World } from '../../src/core/sim/world.ts';
import { SECTORS } from '../../src/content/sectors.ts';
import { SPECIES_LIST } from '../../src/content/species.ts';
import type { SectorConfig } from '../../src/core/sim/sector.ts';
import { DEATH_CAUSE_LABELS } from '../../src/core/sim/events.ts';

/**
 * Headless viability regression: every shipped sector must still hold every species it starts with
 * for its whole survey horizon, with no player intervention, on its own seed.
 *
 * This is the guard against the class of bug that is invisible in a unit test and fatal in play: a
 * sector that starts fully populated and quietly empties out (or explodes) while the player is
 * reading the brief. It is deliberately slow — a handful of seconds per sector — because it *is* the
 * simulation. `npm run balance` runs the same thing over many seeds.
 *
 * When a species does die out here, `npm run trace -- <sector> <species>` shows why (starvation,
 * exposure, predation or a reproduction stall), and `npm run laws` shows whether the sector's laws
 * still hold.
 */

const EXTINCTION_TOLERANCE = 0; // zero: a shipped sector must not lose a species unprompted
const TIMEOUT = 180_000;

interface Report {
  readonly sector: SectorConfig;
  readonly extinct: readonly string[];
  readonly deaths: Map<string, number>;
  readonly births: number;
  readonly finalCounts: Record<string, number>;
  readonly ticksPerSecond: number;
}

function survey(sector: SectorConfig): Report {
  const world = new World({ config: sector, species: SPECIES_LIST, seed: sector.seed });
  const started = Date.now();
  world.run(sector.surveyTicks);
  const elapsed = Math.max(1, Date.now() - started);
  const deaths = new Map<string, number>();
  for (const [key, count] of world.counters.deathsByCause) {
    const cause = key.split(':')[1] ?? key;
    deaths.set(cause, (deaths.get(cause) ?? 0) + count);
  }
  let births = 0;
  for (const count of world.counters.births.values()) births += count;
  return {
    sector,
    extinct: world.extinctSpecies(),
    deaths,
    births,
    finalCounts: world.counts(),
    ticksPerSecond: (sector.surveyTicks / elapsed) * 1000,
  };
}

describe('sector viability over a full survey', () => {
  for (const sector of SECTORS) {
    it(
      `${sector.id} ${sector.name} keeps every species alive for ${sector.surveyTicks} ticks`,
      () => {
        const report = survey(sector);
        const detail = {
          extinct: report.extinct,
          finalCounts: report.finalCounts,
          deaths: Object.fromEntries(report.deaths),
          births: report.births,
        };
        expect(report.extinct.length, JSON.stringify(detail)).toBeLessThanOrEqual(EXTINCTION_TOLERANCE);
        for (const species of sector.roster) {
          expect(report.finalCounts[species], `${species} vanished: ${JSON.stringify(detail)}`).toBeGreaterThan(0);
        }
        // A world where nothing ever reproduces is not alive either.
        expect(report.births).toBeGreaterThan(0);
        // Every death must carry a cause the reports can name.
        for (const cause of report.deaths.keys()) {
          expect(Object.keys(DEATH_CAUSE_LABELS)).toContain(cause);
        }
      },
      TIMEOUT,
    );
  }
});

describe('throughput', () => {
  it(
    'simulates the heaviest sector fast enough for interactive play (>= 60 ticks/s)',
    () => {
      const sector = SECTORS.reduce((heaviest, candidate) =>
        candidate.width * candidate.height * candidate.roster.length >
        heaviest.width * heaviest.height * heaviest.roster.length
          ? candidate
          : heaviest,
      );
      const report = survey({ ...sector, surveyTicks: 600 });
      // 60 ticks/s leaves the renderer room to draw at 60 fps while advancing at least one tick.
      expect(report.ticksPerSecond).toBeGreaterThan(60);
    },
    TIMEOUT,
  );
});
