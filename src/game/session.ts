import { ContentError, WorldBugError } from '../core/errors.ts';
import type { FieldId } from '../core/field.ts';
import { clamp } from '../core/math.ts';
import type { SectorConfig } from '../core/sim/sector.ts';
import type { SpeciesId } from '../core/sim/species.ts';
import { World } from '../core/sim/world.ts';
import { SPECIES_LIST } from '../content/species.ts';
import { propositionsFor, type Proposition } from '../content/laws.ts';
import {
  FIELD_FOR_INSTRUMENT,
  INSTRUMENTS_BY_ID,
  INSTRUMENT_STRENGTH,
  checkAffordable,
  requireInstrument,
  validateRequest,
  type Budget,
  type InstrumentId,
  type InstrumentRequest,
  type InstrumentSpec,
} from './instruments.ts';
import { gradeReport, type Grade, type ReportAnswer } from './grading.ts';

/**
 * One survey mission.
 *
 * Owns the `World` instance, the tick budget, the Charge/Integrity pools and the Codex answers, and
 * is the only place player actions touch the simulation. Every action returns a structured outcome
 * (`{ ok: true, ... } | { ok: false, reason }`) so the UI can always tell the player *why* something
 * did not happen — the game never has a button that silently does nothing.
 */

export type MissionPhase = 'briefing' | 'survey' | 'filed';

export interface ActionSuccess {
  readonly ok: true;
  readonly message: string;
  /** Charge actually spent. */
  readonly charge: number;
  readonly integrity: number;
}

export interface ActionFailure {
  readonly ok: false;
  readonly reason: string;
}

export type ActionResult = ActionSuccess | ActionFailure;

export interface SessionOptions {
  readonly config: SectorConfig;
  readonly seed?: number;
}

export interface FieldReadout {
  readonly temperature: number;
  readonly humidity: number;
  readonly light: number;
}

export class Mission {
  readonly config: SectorConfig;
  readonly world: World;
  readonly propositions: readonly Proposition[];

  private readonly answers = new Map<string, ReportAnswer>();
  private readonly budgetState: { charge: number; integrity: number; spentCharge: number; spentIntegrity: number };
  private readonly announces: string[] = [];
  private currentPhase: MissionPhase = 'briefing';
  private filedGrade: Grade | null = null;
  private assistedCount = 0;

  constructor(options: SessionOptions) {
    this.config = options.config;
    this.world = new World({
      config: options.config,
      species: SPECIES_LIST,
      seed: options.seed ?? options.config.seed,
    });
    this.propositions = propositionsFor(options.config);
    this.budgetState = {
      charge: options.config.startingCharge,
      integrity: options.config.startingIntegrity,
      spentCharge: 0,
      spentIntegrity: 0,
    };
  }

  // ---------------------------------------------------------------- state

  get phase(): MissionPhase {
    return this.currentPhase;
  }

  get tick(): number {
    return this.world.tick;
  }

  get remainingTicks(): number {
    return Math.max(0, this.config.surveyTicks - this.world.tick);
  }

  get budget(): Budget {
    return { ...this.budgetState };
  }

  get grade(): Grade | null {
    return this.filedGrade;
  }

  get answeredCount(): number {
    return this.answers.size;
  }

  get assistCount(): number {
    return this.assistedCount;
  }

  answersSnapshot(): ReadonlyMap<string, ReportAnswer> {
    return new Map(this.answers);
  }

  /** Starts the survey (leaves the briefing screen). */
  begin(): void {
    if (this.currentPhase === 'briefing') this.currentPhase = 'survey';
  }

  /** Advances the simulation by `ticks`, stopping exactly at the end of the survey window. */
  advance(ticks: number): number {
    if (this.currentPhase !== 'survey') return 0;
    const count = clamp(Math.floor(ticks), 0, this.remainingTicks);
    if (count <= 0) return 0;
    this.world.run(count);
    if (this.remainingTicks === 0) {
      this.announces.push('The survey window has closed. File the Codex report.');
    }
    return count;
  }

  // ---------------------------------------------------------------- reads

  readingsAt(x: number, y: number): FieldReadout {
    return this.world.readingsAt(x, y);
  }

  /** The inspectable organism nearest a point, if any. */
  organismAt(x: number, y: number): ReturnType<World['pickAgent']> {
    return this.world.pickAgent(x, y);
  }

  /** Instrument availability, with the reason when unavailable. */
  availability(instrument: InstrumentSpec): ActionFailure | { ok: true } {
    return checkAffordable(this.config, this.budgetState, instrument, this.remainingTicks);
  }

  // ---------------------------------------------------------------- actions

  /**
   * Applies an instrument request. Order of checks matters: validate the request (a programming or
   * input error), then validate affordability, then apply — so a rejected action never spends Charge.
   */
  useInstrument(request: InstrumentRequest): ActionResult {
    if (this.currentPhase !== 'survey') {
      return { ok: false, reason: 'The survey is not running' };
    }
    const instrument = INSTRUMENTS_BY_ID.get(request.instrument);
    if (!instrument) return { ok: false, reason: `Unknown instrument "${request.instrument}"` };

    const valid = validateRequest(request, this.config, this.config.roster);
    if (!valid.ok) return valid;
    const affordable = checkAffordable(this.config, this.budgetState, instrument, this.remainingTicks);
    if (!affordable.ok) return affordable;

    const message = this.applyInstrument(instrument, request);
    if (!message.ok) return message;

    this.budgetState.charge -= instrument.charge;
    this.budgetState.spentCharge += instrument.charge;
    this.budgetState.integrity -= instrument.integrity;
    this.budgetState.spentIntegrity += instrument.integrity;
    this.announces.push(message.message);
    return {
      ok: true,
      message: message.message,
      charge: instrument.charge,
      integrity: instrument.integrity,
    };
  }

  private applyInstrument(
    instrument: InstrumentSpec,
    request: InstrumentRequest,
  ): ActionSuccess | ActionFailure {
    const { x, y, radius } = request;
    try {
      switch (instrument.id) {
        case 'thermal':
        case 'cryo':
        case 'humidifier':
        case 'desiccator':
        case 'illuminator':
        case 'umbra': {
          const field = FIELD_FOR_INSTRUMENT[instrument.id];
          if (!field) throw new ContentError(`No field mapped for ${instrument.id}`);
          const amount = INSTRUMENT_STRENGTH[instrument.id];
          this.world.pulseField(field, x, y, radius, amount);
          return {
            ok: true,
            message: `${instrument.name}: ${field} ${amount > 0 ? '+' : ''}${amount} over a ${radius}-cell radius`,
            charge: instrument.charge,
            integrity: instrument.integrity,
          };
        }
        case 'nutrient': {
          const species = request.species as SpeciesId;
          const added = this.world.nutrientBloom(species, x, y, radius, INSTRUMENT_STRENGTH.nutrient);
          return {
            ok: true,
            message: `Nutrient bloom: ${added.toFixed(1)} biomass deposited for ${species}`,
            charge: instrument.charge,
            integrity: instrument.integrity,
          };
        }
        case 'barrier': {
          const x2 = request.x2 ?? x;
          const y2 = request.y2 ?? y;
          const barrier = this.world.addBarrier(x, y, x2, y2);
          return {
            ok: true,
            message: `Containment barrier #${barrier.id} laid — it blocks movement, not fields`,
            charge: instrument.charge,
            integrity: instrument.integrity,
          };
        }
        case 'cull': {
          const result = this.world.cull(x, y, radius, request.species);
          return {
            ok: true,
            message: `Cull wave removed ${result.removed} organism(s)`,
            charge: instrument.charge,
            integrity: instrument.integrity,
          };
        }
        case 'hatchery': {
          const species = request.species as SpeciesId;
          const placed = this.world.introduce(species, INSTRUMENT_STRENGTH.hatchery, x, y);
          if (placed === 0) {
            return { ok: false, reason: `${species} is already at its population cap here` };
          }
          return {
            ok: true,
            message: `Hatchery released ${placed} × ${species}`,
            charge: instrument.charge,
            integrity: instrument.integrity,
          };
        }
        default: {
          return { ok: false, reason: `${instrument.name} is not implemented` };
        }
      }
    } catch (error) {
      // A rejected instrument must never spend Charge, and a bug must reach the player as a message
      // rather than a crash (the error overlay in main.ts also catches anything that escapes).
      if (error instanceof WorldBugError) return { ok: false, reason: error.message };
      throw error;
    }
  }

  /** Removes the most recent barrier (a free undo; containment is cheap to place and to lift). */
  undoBarrier(): ActionResult {
    const removed = this.world.removeLastBarrier();
    if (!removed) return { ok: false, reason: 'There is no barrier to remove' };
    this.announces.push(`Barrier #${removed.id} recovered`);
    return { ok: true, message: `Barrier #${removed.id} recovered`, charge: 0, integrity: 0 };
  }

  // ---------------------------------------------------------------- Codex

  answer(propositionId: string, optionId: string, confidence: 'low' | 'high'): ActionResult {
    const proposition = this.propositions.find((p) => p.id === propositionId);
    if (!proposition) return { ok: false, reason: `Unknown proposition "${propositionId}"` };
    if (!proposition.options.some((option) => option.id === optionId)) {
      return { ok: false, reason: `"${optionId}" is not one of the offered answers` };
    }
    this.answers.set(propositionId, { propositionId, optionId, confidence });
    return { ok: true, message: `${proposition.id} recorded`, charge: 0, integrity: 0 };
  }

  clearAnswer(propositionId: string): void {
    this.answers.delete(propositionId);
  }

  /**
   * Spends Charge on a Data Assist. The assist returns *measured* statistics over what this mission
   * actually recorded (probe samples and the event log); it never contains the answer.
   */
  buyAssist(propositionId: string, cost: number): ActionResult & { readonly text?: string } {
    const proposition = this.propositions.find((p) => p.id === propositionId);
    if (!proposition) return { ok: false, reason: `Unknown proposition "${propositionId}"` };
    if (this.currentPhase !== 'survey') return { ok: false, reason: 'The survey is not running' };
    if (this.budgetState.charge < cost) {
      return { ok: false, reason: `Not enough Charge (${cost} needed, ${this.budgetState.charge} left)` };
    }
    const text = this.assistText(proposition);
    this.budgetState.charge -= cost;
    this.budgetState.spentCharge += cost;
    this.assistedCount++;
    this.announces.push(`Data assist purchased for ${proposition.id}`);
    return { ok: true, message: text, charge: cost, integrity: 0, text };
  }

  /** Real statistics over this mission's own recordings, shaped by the proposition being answered. */
  assistText(proposition: Proposition): string {
    const field = proposition.field;
    const events = this.world.events.toArray();
    const birthEvents = events.filter(
      (event) => event.kind === 'birth' && event.species === proposition.subject,
    );
    const deathEvents = events.filter(
      (event) => event.kind === 'death' && event.species === proposition.subject,
    );
    const killEvents = events.filter(
      (event) => event.kind === 'kill' && event.target === proposition.subject,
    );
    const readingsOf = (list: typeof events, key: FieldId): number[] =>
      list
        .map((event) => event.readings?.[key])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    const describe = (key: FieldId): string => {
      const births = readingsOf(birthEvents, key);
      const deaths = readingsOf(deathEvents, key);
      const mean = (values: number[]): string =>
        values.length === 0
          ? 'no samples'
          : `${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)} (n=${values.length})`;
      return `${key}: births mean ${mean(births)}, deaths mean ${mean(deaths)}`;
    };

    if (proposition.kind === 'trophic') {
      const shares = [...this.world.intakeShares(proposition.subject).entries()].sort(
        (a, b) => b[1] - a[1],
      );
      const rendered = shares
        .slice(0, 3)
        .map(([prey, share]) => `${prey} ${(share * 100).toFixed(0)}%`)
        .join(', ');
      return `Recorded intake of ${proposition.subject} since the survey began: ${rendered || 'nothing recorded yet'}. Prey deaths attributed to predation: ${killEvents.length}.`;
    }
    if (proposition.kind === 'role' || proposition.kind === 'reproDriver') {
      const key: FieldId = field ?? 'temperature';
      return `Recorded ${proposition.subject} events — ${describe(key)}. Gross births logged: ${birthEvents.length}.`;
    }
    const key: FieldId = field ?? 'temperature';
    return (
      `Recorded ${proposition.subject} events — ${describe(key)}. ` +
      `Deaths by cause: ${summariseDeaths(deathEvents)}.`
    );
  }

  // ---------------------------------------------------------------- filing

  /**
   * Files the Codex report. Refuses while the biosphere is dead — the survey board rejects a report
   * on a world that no longer exists (docs/DESIGN.md §6).
   */
  file(): ActionResult & { readonly grade?: Grade } {
    if (this.currentPhase === 'filed') return { ok: false, reason: 'The report has already been filed' };
    if (!this.worldAlive()) {
      return { ok: false, reason: 'The sector is dead: every species is extinct, so there is nothing left to report on' };
    }
    const grade = gradeReport({
      config: this.config,
      propositions: this.propositions,
      answers: this.answers,
      world: this.world,
      budget: this.budgetState,
    });
    this.filedGrade = grade;
    this.currentPhase = 'filed';
    this.announces.push(`Report filed: score ${grade.score}, rank ${grade.rank}`);
    return { ok: true, message: `Report filed — ${grade.score} points, rank ${grade.rank}`, charge: 0, integrity: 0, grade };
  }

  /** True while at least one species is alive. */
  worldAlive(): boolean {
    for (const species of this.config.roster) {
      if (this.world.count(species) > 0) return true;
    }
    return false;
  }

  /** Messages queued for the announcer; draining clears the queue. */
  drainAnnouncements(): string[] {
    const out = [...this.announces];
    this.announces.length = 0;
    return out;
  }
}

function summariseDeaths(
  events: readonly { cause?: string }[],
): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    const cause = event.cause ?? 'unknown';
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  if (counts.size === 0) return 'none recorded';
  return [...counts.entries()].map(([cause, count]) => `${cause} ${count}`).join(', ');
}

export function instrumentById(id: string): InstrumentSpec {
  return requireInstrument(id);
}

export type { InstrumentId };
