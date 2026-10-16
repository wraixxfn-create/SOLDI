import type { FieldId, FieldStats } from '../core/field.ts';
import type { SectorConfig, TerrainSource, EnvironmentalPulse } from '../core/sim/sector.ts';
import type { EcosystemRule } from '../core/sim/rules.ts';
import type { ResourceFields, WorldResourceConfig } from '../core/sim/resources.ts';
import type { SpeciesId, SpeciesTraits } from '../core/sim/species.ts';
import type { Barrier, WorldSnapshot } from '../core/sim/world.ts';
import type { ProbeState, PopulationSample } from '../core/sim/metrics.ts';
import type { PropositionKind, PropositionOption } from '../content/laws.ts';
import type { InstrumentRequest, InstrumentSpec } from '../game/instruments.ts';
import type { Rank } from '../game/grading.ts';
import type { ScalarField } from '../core/field.ts';

/** Immutable catalogue entry. Simulation values belong to Organism, not Species. */
export interface Species {
  readonly id: SpeciesId;
  readonly traits: SpeciesTraits;
}

/** Mutable live organism. Do not persist this object as player progress. */
export interface Organism {
  readonly id: number;
  readonly species: SpeciesId;
  x: number;
  y: number;
  dx: number;
  dy: number;
  energy: number;
  age: number;
  cooldown: number;
  stress: number;
  generation: number;
  alive: boolean;
}

/** Environment definition is immutable authored input. Fields in EnvironmentState evolve per tick. */
export interface Environment {
  readonly width: number;
  readonly height: number;
  readonly baseline: Readonly<Record<FieldId, number>>;
  readonly resources: WorldResourceConfig;
  readonly sources: readonly TerrainSource[];
  readonly pulses: readonly EnvironmentalPulse[];
  readonly rules: readonly EcosystemRule[];
}

/** Mutable state of the environmental scalar grids during a mission. */
export interface EnvironmentState {
  readonly fields: Record<FieldId, ScalarField>;
  readonly resources: ResourceFields;
}

/** A Codex rule/proposition is content, not a mutable answer. */
export interface Rule {
  readonly id: string;
  readonly kind: PropositionKind;
  readonly subject: SpeciesId;
  readonly field?: FieldId;
  readonly prompt: string;
  readonly options: readonly PropositionOption[];
  readonly correctOptionId: string;
  readonly explanation: string;
  readonly evidence: Readonly<Record<string, string>>;
  readonly weight: number;
  readonly assistCost: number;
}

/** A requested experiment and its immutable catalogue entry; request effects are applied by Mission. */
export interface Experiment {
  readonly request: InstrumentRequest;
  readonly instrument: InstrumentSpec;
}

/** Static objective; scoring observations are stored separately in SimulationState/Grade. */
export interface Objective {
  readonly id: string;
  readonly description: string;
  readonly biomassTarget: Readonly<{ min: number; max: number }>;
  readonly mustKeepOneSpeciesAlive: boolean;
}

/** Complete authored challenge, assembled from validated sector data and derived Codex rules. */
export interface Challenge {
  readonly id: string;
  readonly sector: SectorConfig;
  readonly environment: Environment;
  readonly species: readonly Species[];
  readonly rules: readonly Rule[];
  readonly objective: Objective;
}

/** Read-only projection for UI, renderer and replay assertions. */
export interface SimulationState {
  readonly tick: number;
  readonly counts: Readonly<Record<SpeciesId, number>>;
  readonly biomass: Readonly<Record<SpeciesId, number>>;
  readonly totalBiomass: number;
  readonly fieldStats: Readonly<Record<FieldId, FieldStats>>;
  readonly agents: readonly Readonly<Organism>[];
  readonly probes: readonly ProbeState[];
  readonly history: readonly PopulationSample[];
  readonly stability: number;
  readonly barriers: readonly Barrier[];
  readonly fields: Readonly<Record<FieldId, ScalarField>>;
  readonly resources: ResourceFields;
  readonly biomassFields: ReadonlyMap<SpeciesId, ScalarField>;
  readonly extinctions: readonly SpeciesId[];
}

/** Small runtime-facing world interface; concrete implementation remains core/sim/world.ts. */
export interface World {
  readonly config: SectorConfig;
  readonly seed: number;
  readonly tick: number;
  readonly agents: readonly Organism[];
  readonly fields: Readonly<Record<FieldId, ScalarField>>;
  readonly resources: ResourceFields;
  step(): void;
  run(ticks: number): void;
  snapshot(): WorldSnapshot;
}

/** Persisted player profile only. No live organisms, world fields or in-progress mission state. */
export interface PlayerProgress {
  readonly version: number;
  readonly unlockedSectors: readonly string[];
  readonly ranks: Readonly<Record<string, Rank>>;
  readonly settings: Readonly<{
    palette: string;
    contrast: string;
    reducedMotion: boolean;
    uiScale: number;
    volume: number;
    muted: boolean;
    confirmDestructive: boolean;
    autoPauseOnBlur: boolean;
  }>;
}

/** Explicit pairing of an instrument request with its catalogue identity. */
export function experimentFor(
  request: InstrumentRequest,
  instrument: InstrumentSpec,
): Experiment {
  return { request, instrument };
}

