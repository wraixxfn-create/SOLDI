/**
 * Replay-friendly experiment ledger. Actions are data, not closures: a caller supplies the one
 * authoritative action dispatcher used both during play and replay. Snapshots are caller-provided
 * immutable projections, keeping this module independent of World internals.
 */
export interface RecordedAction<P = unknown> {
  readonly sequence: number;
  readonly tick: number;
  readonly kind: string;
  readonly payload: P;
}

export interface ExperimentSnapshot<S> {
  readonly tick: number;
  readonly state: S;
}

export interface ExperimentRecord<S, P = unknown> {
  readonly id: string;
  readonly label: string;
  readonly startedAtTick: number;
  endedAtTick: number | null;
  readonly start: ExperimentSnapshot<S>;
  end: ExperimentSnapshot<S> | null;
  readonly actions: RecordedAction<P>[];
}

export class ExperimentLedger<S, P = unknown> {
  private readonly records: ExperimentRecord<S, P>[] = [];
  private nextSequence = 1;

  begin(id: string, label: string, tick: number, state: S): ExperimentRecord<S, P> {
    if (!id.trim() || this.records.some((r) => r.id === id)) throw new Error(`Invalid or duplicate experiment id: ${id}`);
    assertTick(tick);
    const record: ExperimentRecord<S, P> = {
      id, label, startedAtTick: tick, end: null, endedAtTick: null,
      start: { tick, state: clone(state) }, actions: [],
    };
    this.records.push(record);
    return record;
  }

  record(id: string, tick: number, kind: string, payload: P): RecordedAction<P> {
    const experiment = this.require(id);
    assertTick(tick);
    if (experiment.end || tick < experiment.startedAtTick) throw new Error('Action is outside the active experiment');
    const action = { sequence: this.nextSequence++, tick, kind, payload: clone(payload) };
    experiment.actions.push(action);
    return action;
  }

  finish(id: string, tick: number, state: S): ExperimentSnapshot<S> {
    const experiment = this.require(id);
    assertTick(tick);
    if (experiment.end || tick < experiment.startedAtTick) throw new Error('Experiment is already finished or tick moved backwards');
    const end = { tick, state: clone(state) };
    experiment.end = end;
    experiment.endedAtTick = tick;
    return end;
  }

  get(id: string): ExperimentRecord<S, P> { return clone(this.require(id)); }
  list(): readonly ExperimentRecord<S, P>[] { return clone(this.records); }

  compare(a: string, b: string, equal: (left: S, right: S) => boolean = structuralEqual): { readonly equal: boolean; readonly tickDelta: number | null } {
    const left = this.require(a).end;
    const right = this.require(b).end;
    if (!left || !right) throw new Error('Both experiments must be finished before comparison');
    return { equal: equal(left.state, right.state), tickDelta: left.tick - right.tick };
  }

  /** Replay an action log using the same dispatcher as live execution; it does not reimplement rules. */
  static replay<P>(actions: readonly RecordedAction<P>[], dispatch: (action: RecordedAction<P>) => void): void {
    let sequence = 0;
    for (const action of actions) {
      if (action.sequence <= sequence) throw new Error('Action sequence must be strictly increasing');
      assertTick(action.tick);
      sequence = action.sequence;
      dispatch(action);
    }
  }

  /** Undo is a checkpoint restore followed by replay, never a second implementation of engine logic. */
  static undo<S, P>(checkpoint: S, actions: readonly RecordedAction<P>[], throughSequence: number,
    restore: (state: S) => void, dispatch: (action: RecordedAction<P>) => void): void {
    restore(clone(checkpoint));
    ExperimentLedger.replay(actions.filter((action) => action.sequence <= throughSequence), dispatch);
  }

  private require(id: string): ExperimentRecord<S, P> {
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new Error(`Unknown experiment: ${id}`);
    return record;
  }
}

function assertTick(tick: number): void {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError(`Tick must be a non-negative safe integer: ${tick}`);
}
function clone<T>(value: T): T { return structuredClone(value); }
function structuralEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
