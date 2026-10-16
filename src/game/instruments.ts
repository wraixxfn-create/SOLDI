import type { FieldId } from '../core/field.ts';
import type { SpeciesId } from '../core/sim/species.ts';
import type { SectorConfig } from '../core/sim/sector.ts';

/**
 * The instrument catalogue.
 *
 * Every entry here is a real capability of `World`; `applies()` is the *only* place that decides
 * whether an action is legal, so the UI can never offer a button that does nothing (the UI disables
 * the button and shows `unavailableReason`). Prices are the ones in docs/DESIGN.md §4.2.
 */

export type InstrumentId =
  | 'thermal'
  | 'cryo'
  | 'humidifier'
  | 'desiccator'
  | 'illuminator'
  | 'umbra'
  | 'nutrient'
  | 'barrier'
  | 'cull'
  | 'hatchery';

export interface InstrumentSpec {
  readonly id: InstrumentId;
  readonly name: string;
  readonly description: string;
  /** Charge spent per use. */
  readonly charge: number;
  /** Integrity spent per use (0 for non-destructive instruments). */
  readonly integrity: number;
  /** True for instruments that ask the player to pick a species as well as a point. */
  readonly needsSpecies: boolean;
  /** True for the barrier, which is drawn on the map and can be undone for free. */
  readonly isBarrier?: boolean;
  /** True for instruments the player should be warned about before confirming. */
  readonly destructive?: boolean;
  /** Instruments are offered in this order in the palette. */
  readonly hotkey: string;
}

export const INSTRUMENTS: readonly InstrumentSpec[] = Object.freeze([
  {
    id: 'thermal',
    name: 'Thermal pulse',
    description: 'Raises the temperature in a radius. It decays back toward the sector baseline.',
    charge: 2,
    integrity: 0,
    needsSpecies: false,
    hotkey: '1',
  },
  {
    id: 'cryo',
    name: 'Cryo pulse',
    description: 'Lowers the temperature in a radius.',
    charge: 2,
    integrity: 0,
    needsSpecies: false,
    hotkey: '2',
  },
  {
    id: 'humidifier',
    name: 'Humidifier',
    description: 'Raises humidity in a radius.',
    charge: 2,
    integrity: 0,
    needsSpecies: false,
    hotkey: '3',
  },
  {
    id: 'desiccator',
    name: 'Desiccator',
    description: 'Lowers humidity in a radius.',
    charge: 2,
    integrity: 0,
    needsSpecies: false,
    hotkey: '4',
  },
  {
    id: 'illuminator',
    name: 'Illuminator',
    description: 'Raises light in a radius. The reef answers to this one.',
    charge: 2,
    integrity: 0,
    needsSpecies: false,
    hotkey: '5',
  },
  {
    id: 'umbra',
    name: 'Umbra field',
    description: 'Lowers light in a radius.',
    charge: 2,
    integrity: 0,
    needsSpecies: false,
    hotkey: '6',
  },
  {
    id: 'nutrient',
    name: 'Nutrient bloom',
    description: 'Injects standing biomass for one producer species. Feeds everything above it.',
    charge: 3,
    integrity: 0,
    needsSpecies: true,
    hotkey: '7',
  },
  {
    id: 'barrier',
    name: 'Containment barrier',
    description: 'Blocks movement across a short wall. Repeatable, and removable at no cost.',
    charge: 3,
    integrity: 1,
    needsSpecies: false,
    isBarrier: true,
    hotkey: '8',
  },
  {
    id: 'cull',
    name: 'Cull wave',
    description: 'Removes organisms in a radius, optionally one species only. Costs Integrity.',
    charge: 4,
    integrity: 6,
    needsSpecies: false,
    destructive: true,
    hotkey: '9',
  },
  {
    id: 'hatchery',
    name: 'Hatchery',
    description: 'Releases individuals of a chosen species at a point. Costs Integrity.',
    charge: 5,
    integrity: 2,
    needsSpecies: true,
    destructive: true,
    hotkey: '0',
  },
]);

export const INSTRUMENTS_BY_ID: ReadonlyMap<InstrumentId, InstrumentSpec> = new Map(
  INSTRUMENTS.map((instrument) => [instrument.id, instrument]),
);

export function requireInstrument(id: string): InstrumentSpec {
  const instrument = INSTRUMENTS_BY_ID.get(id as InstrumentId);
  if (!instrument) throw new Error(`Unknown instrument "${id}"`);
  return instrument;
}

/** A request to use an instrument: where, on what, and how hard. */
export interface InstrumentRequest {
  readonly instrument: InstrumentId;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** Required for `nutrient` and `hatchery`. */
  readonly species?: SpeciesId;
  /** For `barrier`: the second endpoint of the wall. */
  readonly x2?: number;
  readonly y2?: number;
}

export interface Budget {
  readonly charge: number;
  readonly integrity: number;
  readonly spentCharge: number;
  readonly spentIntegrity: number;
}

/** Numeric magnitudes, in the units of each field. */
export const INSTRUMENT_STRENGTH = Object.freeze({
  thermal: 46,
  cryo: -46,
  humidifier: 0.22,
  desiccator: -0.22,
  illuminator: 0.3,
  umbra: -0.3,
  /** Biomass units deposited at the epicentre of a bloom for a producer species. */
  nutrient: 2.4,
  /** Individuals released by one hatchery use. */
  hatchery: 8,
});

export const FIELD_FOR_INSTRUMENT: Readonly<Partial<Record<InstrumentId, FieldId>>> = Object.freeze({
  thermal: 'temperature',
  cryo: 'temperature',
  humidifier: 'humidity',
  desiccator: 'humidity',
  illuminator: 'light',
  umbra: 'light',
});

export interface AffordabilityIssue {
  readonly ok: false;
  readonly reason: string;
}

export type Affordability = { readonly ok: true } | AffordabilityIssue;

/** Can this mission pay for the instrument, and does the mission offer it at all? */
export function checkAffordable(
  sector: SectorConfig,
  budget: Budget,
  instrument: InstrumentSpec,
  remainingCharge?: number,
): Affordability {
  if (!sector.instruments.includes(instrument.id)) {
    return { ok: false, reason: `${instrument.name} is not fitted to this mission` };
  }
  if (remainingCharge !== undefined && instrument.charge > remainingCharge) {
    return { ok: false, reason: `${instrument.name} needs a larger survey window than remains` };
  }
  if (budget.charge < instrument.charge) {
    return {
      ok: false,
      reason: `not enough Charge (${instrument.charge} needed, ${budget.charge} left)`,
    };
  }
  if (budget.integrity < instrument.integrity) {
    return {
      ok: false,
      reason: `not enough Integrity (${instrument.integrity} needed, ${budget.integrity} left)`,
    };
  }
  return { ok: true };
}

/**
 * Validates a request independently of affordability; returns a player-readable reason when invalid.
 * Split into point, species and barrier checks so each rule stays independently testable.
 */
export function validateRequest(
  request: InstrumentRequest,
  sector: SectorConfig,
  roster: readonly SpeciesId[],
): Affordability {
  const instrument = INSTRUMENTS_BY_ID.get(request.instrument);
  if (!instrument) return { ok: false, reason: `Unknown instrument "${request.instrument}"` };
  const point = validatePoint(request, sector);
  if (!point.ok) return point;
  const species = validateSpecies(request, instrument, roster);
  if (!species.ok) return species;
  if (!instrument.isBarrier) return { ok: true };
  return validateBarrier(request, sector);
}

function validatePoint(request: InstrumentRequest, sector: SectorConfig): Affordability {
  if (!Number.isFinite(request.x) || !Number.isFinite(request.y)) {
    return { ok: false, reason: 'Pick a point inside the sector' };
  }
  if (request.x < 0 || request.y < 0 || request.x > sector.width || request.y > sector.height) {
    return { ok: false, reason: 'That point is outside the sector' };
  }
  if (!(request.radius > 0) || !Number.isFinite(request.radius)) {
    return { ok: false, reason: 'The instrument needs a positive radius' };
  }
  return { ok: true };
}

function validateSpecies(
  request: InstrumentRequest,
  instrument: InstrumentSpec,
  roster: readonly SpeciesId[],
): Affordability {
  if (!instrument.needsSpecies) return { ok: true };
  if (!request.species) return { ok: false, reason: `${instrument.name} needs a target species` };
  if (!roster.includes(request.species)) {
    return { ok: false, reason: `${request.species} does not live in this sector` };
  }
  return { ok: true };
}

function validateBarrier(request: InstrumentRequest, sector: SectorConfig): Affordability {
  const { x2, y2 } = request;
  if (x2 === undefined || y2 === undefined) {
    return { ok: false, reason: 'A barrier needs both endpoints' };
  }
  if (!Number.isFinite(x2) || !Number.isFinite(y2) || x2 < 0 || y2 < 0 || x2 > sector.width || y2 > sector.height) {
    return { ok: false, reason: 'The barrier endpoint is outside the sector' };
  }
  if (Math.hypot(x2 - request.x, y2 - request.y) < 2) {
    return { ok: false, reason: 'The barrier is too short to contain anything' };
  }
  return { ok: true };
}
