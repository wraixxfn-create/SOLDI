import {
  assertValidSector,
  type SectorConfig,
  type TerrainSource,
} from '../core/sim/sector.ts';
import { ContentError } from '../core/errors.ts';
import { AURELIA, FERRAX, KELPIA, VELLUM, ORSAX, VOXA, SCUTA, MYCORRHIZA, ORPA, CALYX, GLIRRA, TAUROS, SPECIES_BY_ID } from './species.ts';

/**
 * Campaign content: five authored sectors.
 *
 * Authoring rules (enforced by `validateSector` at import time):
 * - Coordinates are cells; use the `s()` helper with fractional grid positions for readability.
 * - Every consumer must have at least one of its diet species on the roster (otherwise its trophic
 *   law would be unobservable).
 * - Terrain sources carry a magnitude only: the field and its polarity come from the terrain kind.
 * - The sector must start populated enough to survey (>= 1.5 % of the grid).
 */

function s(
  width: number,
  height: number,
  id: string,
  kind: TerrainSource['kind'],
  fx: number,
  fy: number,
  radius: number,
  strength: number,
  persistence = 0.24,
): TerrainSource {
  return {
    id,
    kind,
    x: Math.round(fx * (width - 1)),
    y: Math.round(fy * (height - 1)),
    radius,
    strength,
    persistence,
  };
}

// ---------------------------------------------------------------------------- 1. CINDER SHELF

const CINDER_WIDTH = 44;
const CINDER_HEIGHT = 30;

export const SECTOR_CINDER_SHELF: SectorConfig = {
  id: 'FER-1',
  index: 1,
  name: 'Cinder Shelf',
  designation: 'FER-1',
  tagline: 'A warm plume on a cold shelf. Learn to read the world.',
  brief:
    'The ISV Meridian has parked over a fractured shelf of basalt. Two thermal vents keep a corridor ' +
    'of the surface habitable; everything beyond it drops toward cryogenic night. A photosynthetic ' +
    'mat and a small grazer share this corridor, and the survey board wants to know how.',
  objective:
    'Determine the environmental tolerances and the feeding relationship of AURELIA THERMICA and ' +
    'FERRAX REPENS, then file a Codex report. Keep both populations alive: a dead biosphere is a ' +
    'failed survey.',
  width: CINDER_WIDTH,
  height: CINDER_HEIGHT,
  seed: 0x5eed_1001,
  baseline: { temperature: 246, humidity: 0.42, light: 0.66 },
  sources: [
    s(CINDER_WIDTH, CINDER_HEIGHT, 'vent-alpha', 'thermal', 0.28, 0.36, 9, 96, 0.26),
    s(CINDER_WIDTH, CINDER_HEIGHT, 'vent-beta', 'thermal', 0.7, 0.68, 8, 84, 0.26),
    s(CINDER_WIDTH, CINDER_HEIGHT, 'seep-north', 'cryo', 0.86, 0.1, 6, 40),
    s(CINDER_WIDTH, CINDER_HEIGHT, 'seep-west', 'cryo', 0.05, 0.82, 7, 46),
    s(CINDER_WIDTH, CINDER_HEIGHT, 'mist-basin', 'mist', 0.5, 0.9, 9, 0.3),
    s(CINDER_WIDTH, CINDER_HEIGHT, 'arid-ridge', 'arid', 0.9, 0.44, 5, 0.2),
    s(CINDER_WIDTH, CINDER_HEIGHT, 'lumen-field', 'lumen', 0.5, 0.5, 12, 0.2, 0.12),
  ],
  pulses: [],
  roster: [AURELIA.id, FERRAX.id],
  initialPopulations: { [AURELIA.id]: 130, [FERRAX.id]: 34 },
  populationCaps: { [AURELIA.id]: 700, [FERRAX.id]: 320 },
  startingCharge: 10,
  surveyTicks: 2600,
  instruments: ['thermal', 'cryo', 'humidifier', 'desiccator', 'nutrient'],
  unlockAfter: null,
  difficulty: 1,
};

// ----------------------------------------------------------------------------- 2. VAULT BASIN

const VAULT_WIDTH = 48;
const VAULT_HEIGHT = 32;

export const SECTOR_VAULT_BASIN: SectorConfig = {
  id: 'KEL-4',
  index: 2,
  name: 'Vault Basin',
  designation: 'KEL-4',
  tagline: 'Cold, wet and dim. Something here eats something else.',
  brief:
    'A collapsed lava vault, flooded with mist and lit only through a single fracture in its roof. ' +
    'A pale photosynthetic mat lines the floor, a grazer strips it, and a predator hunts the grazer. ' +
    'Three species, one closed system, and no obvious food chain written on the wall.',
  objective:
    'Map the trophic structure of the basin, determine the tolerance limits of KELPIA UMBROSA and ' +
    'establish how VELLUM VAGANS responds to stress. File the report before the window closes.',
  width: VAULT_WIDTH,
  height: VAULT_HEIGHT,
  seed: 0x5eed_2002,
  baseline: { temperature: 300, humidity: 0.6, light: 0.34 },
  sources: [
    s(VAULT_WIDTH, VAULT_HEIGHT, 'cryo-gallery', 'cryo', 0.2, 0.24, 10, 92, 0.28),
    s(VAULT_WIDTH, VAULT_HEIGHT, 'cryo-deep', 'cryo', 0.8, 0.74, 9, 78, 0.28),
    s(VAULT_WIDTH, VAULT_HEIGHT, 'mist-heart', 'mist', 0.5, 0.52, 13, 0.36),
    s(VAULT_WIDTH, VAULT_HEIGHT, 'dry-ledge', 'arid', 0.92, 0.18, 4, 0.22),
    s(VAULT_WIDTH, VAULT_HEIGHT, 'roof-fracture', 'lumen', 0.1, 0.82, 6, 0.62, 0.3),
    s(VAULT_WIDTH, VAULT_HEIGHT, 'canopy-shade', 'shade', 0.64, 0.34, 11, 0.26, 0.3),
    s(VAULT_WIDTH, VAULT_HEIGHT, 'warm-spring', 'thermal', 0.86, 0.9, 6, 54, 0.26),
  ],
  pulses: [
    {
      id: 'roof-flare',
      field: 'light',
      period: 620,
      amount: 0.32,
      radius: 10,
      // 13,28 — just outside the permanent roof-fracture opening. It used to be placed *on* the
      // opening (light 0.96 of a 1.00 ceiling), so the +0.32 flare was clipped away and the event
      // the sector brief advertises never did anything. On the dark floor the burst is fully
      // visible: the corridor briefly enters the dim/bright band and the canopy growers respond.
      x: 13,
      y: 28,
      phase: 300,
      label: 'vent flare through the roof fracture',
    },
  ],
  roster: [KELPIA.id, VELLUM.id, ORSAX.id],
  initialPopulations: { [KELPIA.id]: 140, [VELLUM.id]: 40, [ORSAX.id]: 16 },
  populationCaps: { [KELPIA.id]: 700, [VELLUM.id]: 320, [ORSAX.id]: 70 },
  startingCharge: 12,
  surveyTicks: 3000,
  instruments: ['thermal', 'cryo', 'humidifier', 'desiccator', 'illuminator', 'umbra', 'nutrient'],
  unlockAfter: 'FER-1',
  difficulty: 2,
};

// ------------------------------------------------------------------------------ 3. LUMEN REEF

const REEF_WIDTH = 48;
const REEF_HEIGHT = 32;

export const SECTOR_LUMEN_REEF: SectorConfig = {
  id: 'VOX-9',
  index: 3,
  name: 'Lumen Reef',
  designation: 'VOX-9',
  tagline: 'A reef that lives on light — and the shadows between its teeth.',
  brief:
    'Lumen crystals grow through the plate here, throwing bright islands across a darkened plain. ' +
    'The reef architecture is built by a light-hungry autotroph; the animals that live on it have ' +
    'quietly specialised for the fringes. Grazing pressure is high and one species never sees the ' +
    'sun at all.',
  objective:
    'Characterise the light niches of VOXA LUCIDA, SCUTA LIMAX and MYCORRHIZA PALLENS, identify ' +
    'the reef predator, and report how the reef feeds itself.',
  width: REEF_WIDTH,
  height: REEF_HEIGHT,
  seed: 0x5eed_3003,
  baseline: { temperature: 316, humidity: 0.48, light: 0.26 },
  sources: [
    s(REEF_WIDTH, REEF_HEIGHT, 'lumen-a', 'lumen', 0.3, 0.3, 14, 0.66, 0.3),
    s(REEF_WIDTH, REEF_HEIGHT, 'lumen-b', 'lumen', 0.72, 0.58, 12, 0.62, 0.3),
    s(REEF_WIDTH, REEF_HEIGHT, 'lumen-c', 'lumen', 0.14, 0.8, 10, 0.56, 0.28),
    s(REEF_WIDTH, REEF_HEIGHT, 'lumen-d', 'lumen', 0.5, 0.72, 9, 0.54, 0.28),
    s(REEF_WIDTH, REEF_HEIGHT, 'shade-trench', 'shade', 0.56, 0.86, 8, 0.26, 0.3),
    s(REEF_WIDTH, REEF_HEIGHT, 'shade-overhang', 'shade', 0.9, 0.34, 6, 0.22, 0.3),
    s(REEF_WIDTH, REEF_HEIGHT, 'mist-plume', 'mist', 0.44, 0.14, 8, 0.3),
    s(REEF_WIDTH, REEF_HEIGHT, 'dry-pan', 'arid', 0.2, 0.58, 6, 0.22),
    s(REEF_WIDTH, REEF_HEIGHT, 'vent-rift', 'thermal', 0.62, 0.22, 7, 62, 0.28),
    s(REEF_WIDTH, REEF_HEIGHT, 'cryo-chimney', 'cryo', 0.04, 0.5, 6, 58, 0.28),
  ],
  pulses: [],
  roster: [VOXA.id, SCUTA.id, MYCORRHIZA.id, GLIRRA.id],
  initialPopulations: {
    [VOXA.id]: 120,
    [SCUTA.id]: 40,
    [MYCORRHIZA.id]: 40,
    [GLIRRA.id]: 12,
  },
  populationCaps: { [VOXA.id]: 700, [SCUTA.id]: 320, [MYCORRHIZA.id]: 300, [GLIRRA.id]: 70 },
  startingCharge: 13,
  surveyTicks: 3200,
  instruments: [
    'thermal',
    'cryo',
    'humidifier',
    'desiccator',
    'illuminator',
    'umbra',
    'nutrient',
    'barrier',
    'cull',
  ],
  unlockAfter: 'KEL-4',
  difficulty: 3,
};

// ---------------------------------------------------------------------------------- 4. ASHFALL

const ASH_WIDTH = 52;
const ASH_HEIGHT = 34;

export const SECTOR_ASHFALL: SectorConfig = {
  id: 'ORP-2',
  index: 4,
  name: 'Ashfall',
  designation: 'ORP-2',
  tagline: 'The plains burn on a timer. Everything here is a question of shelter.',
  brief:
    'A tide-locked plain at 352 K, hot enough to boil a temperate world and cold enough to freeze ' +
    'the wrong organism at dusk. Every 780 ticks the crust splits along the meridian and a heat ' +
    'pulse sweeps the basin. Two ecosystems survive here: one that embraces the heat, and one that ' +
    'hides from it in cryogenic pockets.',
  objective:
    'Report the heat regulation of both producers, explain why CALYX FERVENS dies where it stands, ' +
    'and record the predator that follows it.',
  width: ASH_WIDTH,
  height: ASH_HEIGHT,
  seed: 0x5eed_4004,
  baseline: { temperature: 352, humidity: 0.36, light: 0.7 },
  // Two "oases" of stacked cryo + mist + shade. A niche is the intersection of all three fields:
  // KELPIA needs cold AND damp AND dim at once, so a lone cryo seep in a 352 K desert stays dead
  // (measured: 0 % liveable area before this change).
  sources: [
    s(ASH_WIDTH, ASH_HEIGHT, 'oasis-nw-cryo', 'cryo', 0.1, 0.16, 8, 96, 0.3),
    s(ASH_WIDTH, ASH_HEIGHT, 'oasis-nw-mist', 'mist', 0.1, 0.16, 8, 0.36, 0.26),
    s(ASH_WIDTH, ASH_HEIGHT, 'oasis-nw-shade', 'shade', 0.1, 0.16, 9, 0.5, 0.3),
    s(ASH_WIDTH, ASH_HEIGHT, 'oasis-se-cryo', 'cryo', 0.9, 0.84, 7, 90, 0.3),
    s(ASH_WIDTH, ASH_HEIGHT, 'oasis-se-mist', 'mist', 0.9, 0.84, 7, 0.34, 0.26),
    s(ASH_WIDTH, ASH_HEIGHT, 'oasis-se-shade', 'shade', 0.9, 0.84, 8, 0.46, 0.3),
    s(ASH_WIDTH, ASH_HEIGHT, 'lumen-spire', 'lumen', 0.48, 0.18, 9, 0.3),
    s(ASH_WIDTH, ASH_HEIGHT, 'vent-mid', 'thermal', 0.34, 0.56, 6, 46, 0.26),
  ],
  pulses: [
    {
      id: 'meridian-surge',
      field: 'temperature',
      period: 780,
      amount: 64,
      radius: 11,
      x: Math.round(0.5 * (ASH_WIDTH - 1)),
      y: Math.round(0.5 * (ASH_HEIGHT - 1)),
      phase: 420,
      label: 'meridian heat surge',
    },
  ],
  roster: [ORPA.id, KELPIA.id, CALYX.id, GLIRRA.id],
  initialPopulations: { [ORPA.id]: 110, [KELPIA.id]: 45, [CALYX.id]: 42, [GLIRRA.id]: 7 },
  populationCaps: { [ORPA.id]: 700, [KELPIA.id]: 320, [CALYX.id]: 320, [GLIRRA.id]: 70 },
  startingCharge: 15,
  surveyTicks: 3600,
  instruments: [
    'thermal',
    'cryo',
    'humidifier',
    'desiccator',
    'illuminator',
    'umbra',
    'nutrient',
    'barrier',
    'cull',
  ],
  unlockAfter: 'VOX-9',
  difficulty: 4,
};

// -------------------------------------------------------------------------- 5. GHOST MERIDIAN

const GHOST_WIDTH = 50;
const GHOST_HEIGHT = 34;

export const SECTOR_GHOST_MERIDIAN: SectorConfig = {
  id: 'TAU-7',
  index: 5,
  name: 'Ghost Meridian',
  designation: 'TAU-7',
  tagline: 'A world that was in balance last season. Diagnose what changed.',
  brief:
    'Three native species shared this meridian: a warm-mat autotroph, a cold-basin autotroph and a ' +
    'grazer between them. Our previous survey logged a balanced biosphere. Something arrived since ' +
    'then — a generalist that out-survives everything without being better at anything. The natives ' +
    'are in decline and the board wants to know why before the window closes.',
  objective:
    'Identify the invasive organism, explain why it out-competes the natives, determine which ' +
    'native is most at risk, and file a report that the board can act on.',
  width: GHOST_WIDTH,
  height: GHOST_HEIGHT,
  seed: 0x5eed_5005,
  baseline: { temperature: 310, humidity: 0.56, light: 0.52 },
  sources: [
    s(GHOST_WIDTH, GHOST_HEIGHT, 'vent-warm', 'thermal', 0.34, 0.72, 9, 68, 0.28),
    s(GHOST_WIDTH, GHOST_HEIGHT, 'cryo-trench', 'cryo', 0.76, 0.26, 9, 62, 0.28),
    s(GHOST_WIDTH, GHOST_HEIGHT, 'trench-mist', 'mist', 0.76, 0.26, 9, 0.22, 0.26),
    s(GHOST_WIDTH, GHOST_HEIGHT, 'trench-shade', 'shade', 0.76, 0.26, 8, 0.34, 0.28),
    s(GHOST_WIDTH, GHOST_HEIGHT, 'mist-hollow', 'mist', 0.2, 0.3, 9, 0.32),
    s(GHOST_WIDTH, GHOST_HEIGHT, 'dry-scarp', 'arid', 0.82, 0.72, 7, 0.26),
    s(GHOST_WIDTH, GHOST_HEIGHT, 'lumen-outcrop', 'lumen', 0.5, 0.44, 8, 0.46, 0.28),
    s(GHOST_WIDTH, GHOST_HEIGHT, 'shade-gully', 'shade', 0.62, 0.88, 7, 0.3, 0.28),
  ],
  pulses: [],
  roster: [AURELIA.id, KELPIA.id, FERRAX.id, ORSAX.id, TAUROS.id],
  initialPopulations: {
    [AURELIA.id]: 110,
    [KELPIA.id]: 55,
    [FERRAX.id]: 30,
    [ORSAX.id]: 12,
    [TAUROS.id]: 24,
  },
  populationCaps: {
    [AURELIA.id]: 700,
    [KELPIA.id]: 420,
    [FERRAX.id]: 280,
    [ORSAX.id]: 70,
    [TAUROS.id]: 420,
  },
  startingCharge: 16,
  surveyTicks: 3600,
  instruments: [
    'thermal',
    'cryo',
    'humidifier',
    'desiccator',
    'illuminator',
    'umbra',
    'nutrient',
    'barrier',
    'cull',
    'hatchery',
  ],
  unlockAfter: 'ORP-2',
  difficulty: 5,
};

export const SECTORS: readonly SectorConfig[] = [
  SECTOR_CINDER_SHELF,
  SECTOR_VAULT_BASIN,
  SECTOR_LUMEN_REEF,
  SECTOR_ASHFALL,
  SECTOR_GHOST_MERIDIAN,
];

// Validate every sector at import time: bad content must fail loudly and immediately.
for (const sector of SECTORS) {
  assertValidSector(sector, SPECIES_BY_ID);
}

const duplicateIds = new Set<string>();
for (const sector of SECTORS) {
  if (duplicateIds.has(sector.id)) {
    throw new ContentError(`Duplicate sector id "${sector.id}"`);
  }
  duplicateIds.add(sector.id);
}

export function sectorByIndex(index: number): SectorConfig | null {
  return SECTORS.find((sector) => sector.index === index) ?? null;
}

export function sectorByDesignation(designation: string): SectorConfig | null {
  return SECTORS.find((sector) => sector.designation === designation) ?? null;
}

/** Species definitions on a sector's roster, in roster order. */
export function sectorSpecies(config: SectorConfig) {
  return config.roster.map((id) => {
    const def = SPECIES_BY_ID.get(id);
    if (!def) throw new ContentError(`Sector ${config.id} rosters unknown species "${id}"`);
    return def;
  });
}
