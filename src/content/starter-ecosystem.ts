import { assertValidWorldConfig, type SectorConfig } from '../core/sim/sector.ts';
import { STARTER_SPECIES, STARTER_SPECIES_BY_ID } from './species.ts';

/**
 * Compact, fully explicit reference world for the four starter strategies. The campaign continues to
 * use its five authored sectors; this configuration is also a convenient template for new worlds.
 */
export const STARTER_WORLD: SectorConfig = {
  id: 'ECO-0',
  index: 1,
  name: 'Genesis Terrarium',
  designation: 'ECO-0',
  tagline: 'A small, closed world with four interdependent strategies.',
  brief: 'A bounded temperate basin with a producer, predator, decomposer and mutualist.',
  objective: 'Observe resource cycling and the effects of symbiosis.',
  width: 32,
  height: 24,
  seed: 0x51a7_0001,
  baseline: { temperature: 300, humidity: 0.6, light: 0.65 },
  resources: {
    water: { initial: 0.6, recharge: 0.04, evaporation: 0.002, diffusion: 0.05 },
    nutrients: { initial: 1.65, regeneration: 0.0015, diffusion: 0.035 },
  },
  sources: [
    { id: 'warm-spring', kind: 'thermal', x: 9, y: 11, radius: 7, strength: 28, persistence: 0.22 },
    { id: 'mist-garden', kind: 'mist', x: 22, y: 13, radius: 8, strength: 0.16, persistence: 0.2 },
    { id: 'shade-rock', kind: 'shade', x: 17, y: 19, radius: 5, strength: 0.18, persistence: 0.2 },
  ],
  pulses: [],
  rules: [
    {
      id: 'mineral-relief',
      priority: 10,
      mode: 'stack',
      group: null,
      frequency: 'each-turn',
      prerequisites: {
        type: 'resource-mean',
        resource: 'nutrients',
        comparison: 'lt',
        value: 0.8,
      },
      effects: [
        { type: 'resource-shift', resource: 'nutrients', x: 16, y: 12, radius: 5, amount: 0.025 },
      ],
    },
  ],
  roster: STARTER_SPECIES.map((definition) => definition.id),
  initialPopulations: { 'PHY-1': 68, 'PRE-1': 12, 'DEC-1': 22, 'SYM-1': 34 },
  populationCaps: { 'PHY-1': 360, 'PRE-1': 110, 'DEC-1': 180, 'SYM-1': 260 },
  startingCharge: 10,
  startingIntegrity: 12,
  biomassTarget: { min: 100, max: 1_500 },
  surveyTicks: 1_200,
  instruments: ['thermal', 'humidifier', 'nutrient'],
  unlockAfter: null,
  difficulty: 1,
};

// Fail at module load during development if the reference data and its species ever diverge.
assertValidWorldConfig(STARTER_WORLD, STARTER_SPECIES_BY_ID);
