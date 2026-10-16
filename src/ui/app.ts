import { FIELD_IDS, FIELD_SPECS, type FieldId } from '../core/field.ts';
import { InvariantError } from '../core/errors.ts';
import { clamp } from '../core/math.ts';
import type { SectorConfig } from '../core/sim/sector.ts';
import type { SpeciesId } from '../core/sim/species.ts';
import { SECTORS } from '../content/sectors.ts';
import { SPECIES_BY_ID } from '../content/species.ts';
import type { Proposition } from '../content/laws.ts';
import { AudioBus, type SoundId } from '../game/audio.ts';
import { Mission } from '../game/session.ts';
import {
  INSTRUMENTS,
  INSTRUMENTS_BY_ID,
  type InstrumentId,
} from '../game/instruments.ts';
import {
  coerceSave,
  loadSave,
  memoryStorage,
  writeSave,
  type SaveData,
  type StorageLike,
} from '../game/persistence.ts';
import { createInitialState, formatClock, type AppState, type RightPanel, type ScreenId } from '../game/state.ts';
import { createStore, type Store } from '../game/store.ts';
import { PALETTES, paletteById, type PaletteId } from '../render/palettes.ts';
import { Renderer, type OverlayId, type RenderState } from '../render/renderer.ts';
import { Announcer, summariseWorld } from './a11y.ts';

/**
 * The application.
 *
 * Builds nothing: `index.html` owns the markup (so the DOM shell is inspectable and testable), this
 * module binds to it, renders panels from the store, and owns the frame loop. All player intent goes
 * through `dispatch`, so a jsdom test can drive the whole game without a browser event.
 */

const TICKS_PER_SECOND = 12;
const MAX_PROBES = 4;
const INSTRUMENT_PROBE_RADIUS = 5;
const TOAST_MS = 4200;

export type Action =
  | { readonly type: 'navigate'; readonly screen: ScreenId }
  | { readonly type: 'start-sector'; readonly id: string }
  | { readonly type: 'set-overlay'; readonly overlay: OverlayId }
  | { readonly type: 'select-instrument'; readonly instrument: InstrumentId | null }
  | { readonly type: 'select-species'; readonly species: SpeciesId | null }
  | { readonly type: 'set-cursor'; readonly x: number; readonly y: number }
  | { readonly type: 'move-cursor'; readonly dx: number; readonly dy: number }
  | { readonly type: 'place-probe' }
  | { readonly type: 'recover-probe' }
  | { readonly type: 'apply-instrument' }
  | { readonly type: 'undo-barrier' }
  | { readonly type: 'confirm-destructive'; readonly confirmed: boolean }
  | { readonly type: 'toggle-pause' }
  | { readonly type: 'step' }
  | { readonly type: 'set-speed'; readonly speed: number }
  | { readonly type: 'set-panel'; readonly panel: RightPanel }
  | { readonly type: 'set-log-filter'; readonly species: SpeciesId | 'all' }
  | { readonly type: 'answer'; readonly propositionId: string; readonly optionId: string }
  | { readonly type: 'confidence'; readonly propositionId: string; readonly confidence: 'low' | 'high' }
  | { readonly type: 'buy-assist'; readonly propositionId: string }
  | { readonly type: 'file-report' }
  | { readonly type: 'toggle-labels' }
  | { readonly type: 'set-settings'; readonly patch: Partial<AppState['settings']> }
  | { readonly type: 'reset-profile' }
  | { readonly type: 'toast'; readonly text: string; readonly kind?: 'info' | 'warn' | 'error' };

export interface AppOptions {
  readonly document: Document;
  readonly storage?: StorageLike;
  readonly audio?: AudioBus;
  readonly requestFrame?: (callback: (time: number) => void) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly now?: () => number;
}

export interface App {
  readonly store: Store<AppState>;
  readonly announcer: Announcer;
  getMission(): Mission | null;
  getRenderer(): Renderer;
  start(): void;
  stop(): void;
  dispatch(action: Action): void;
  /** One loop iteration; exposed so tests can advance time deterministically. */
  frame(timeMs: number): void;
  /** Forces a full UI render (tests and after state surgery). */
  render(): void;
}

function must<T extends Element>(document: Document, selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new InvariantError(`The page shell is missing required element "${selector}"`, { selector });
  }
  return element;
}

export function createApp(options: AppOptions): App {
  const { document } = options;
  const storage = options.storage ?? defaultStorage();
  const requestFrame =
    options.requestFrame ?? ((callback: (time: number) => void) => window.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle: number) => window.cancelAnimationFrame(handle));
  const now = options.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));

  const loaded = loadSave(storage);
  const store = createStore<AppState>(
    createInitialState({
      settings: {
        palette: loaded.data.settings.palette as PaletteId,
        contrast: loaded.data.settings.contrast === 'high' ? 'high' : 'normal',
        reducedMotion: loaded.data.settings.reducedMotion,
        uiScale: loaded.data.settings.uiScale,
        volume: loaded.data.settings.volume,
        muted: loaded.data.settings.muted,
        confirmDestructive: loaded.data.settings.confirmDestructive,
        autoPauseOnBlur: loaded.data.settings.autoPauseOnBlur,
      },
      unlockedSectors: loaded.data.unlockedSectors,
      ranks: loaded.data.ranks,
      saveWarning: loaded.warning,
    }),
  );

  const audio = options.audio ?? new AudioBus({ volume: 0.6, muted: false });
  const announcer = new Announcer(must(document, '#announcer'));
  const canvas = must<HTMLCanvasElement>(document, '#world');
  const renderer = new Renderer(canvas);

  let mission: Mission | null = null;
  let handle: number | null = null;
  let lastFrameTime = 0;
  let accumulator = 0;
  let uiDirty = true;
  let lastUiRender = 0;
  let labelsOn = true;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPanelSignature = '';
  const chartCache = new Map<string, string>();

  // ---------------------------------------------------------------- helpers

  const saveData = (): SaveData => {
    const state = store.get();
    return {
      version: 1,
      unlockedSectors: state.unlockedSectors,
      ranks: state.ranks,
      settings: {
        palette: state.settings.palette,
        contrast: state.settings.contrast,
        reducedMotion: state.settings.reducedMotion,
        uiScale: state.settings.uiScale,
        volume: state.settings.volume,
        muted: state.settings.muted,
        confirmDestructive: state.settings.confirmDestructive,
        autoPauseOnBlur: state.settings.autoPauseOnBlur,
      },
    };
  };

  const persist = (): void => {
    const result = writeSave(storage, saveData());
    if (!result.ok && result.reason) store.patch({ toast: { text: result.reason, kind: 'error', at: now() } });
  };

  const sound = (id: SoundId): void => {
    audio.play(id);
  };

  const toast = (text: string, kind: 'info' | 'warn' | 'error' = 'info'): void => {
    store.patch({ toast: { text, kind, at: now() } });
    uiDirty = true;
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      store.patch({ toast: null });
      uiDirty = true;
    }, TOAST_MS);
  };

  const sectorById = (id: string): SectorConfig | null =>
    SECTORS.find((sector) => sector.id === id) ?? null;

  const isUnlocked = (sector: SectorConfig): boolean => {
    const state = store.get();
    if (sector.unlockAfter === null) return true;
    const previousRank = state.ranks[sector.unlockAfter];
    return previousRank !== undefined && previousRank !== 'F';
  };

  const setSetting = (patch: Partial<AppState['settings']>): void => {
    const settings = { ...store.get().settings, ...patch };
    store.patch({ settings });
    audio.setOptions({ volume: settings.volume, muted: settings.muted });
    document.body.classList.toggle('high-contrast', settings.contrast === 'high');
    document.body.style.setProperty('--ui-scale', String(settings.uiScale));
    persist();
    uiDirty = true;
  };

  const startSector = (id: string): void => {
    const config = sectorById(id);
    if (!config) {
      toast(`Unknown sector "${id}"`, 'error');
      return;
    }
    if (!isUnlocked(config)) {
      toast(`${config.id} is not unlocked yet — file a passing report first`, 'warn');
      return;
    }
    mission = new Mission({ config });
    accumulator = 0;
    renderer.resetView();
    store.patch({
      screen: 'survey',
      paused: true,
      overlay: 'temperature',
      selectedInstrument: null,
      selectedSpecies: config.roster[0] ?? null,
      cursor: { x: Math.round(config.width / 2), y: Math.round(config.height / 2) },
      selectedAgentId: null,
      lastReportFor: null,
      pendingDestructive: null,
      barrierStart: null,
    });
    announcer.sayNow(
      `${config.id} ${config.name}. ${config.objective} The survey is paused; press Space to begin.`,
    );
    sound('unlock');
    uiDirty = true;
  };

  // ---------------------------------------------------------------- actions

  const moveCursorTo = (x: number, y: number): void => {
    if (!mission) return;
    const { width, height } = mission.config;
    store.patch({ cursor: { x: clamp(Math.round(x), 0, width - 1), y: clamp(Math.round(y), 0, height - 1) } });
    uiDirty = true;
  };

  const moveCursorBy = (dx: number, dy: number): void => {
    const { cursor } = store.get();
    moveCursorTo(cursor.x + dx, cursor.y + dy);
  };

  const togglePause = (): void => {
    if (!mission || mission.phase === 'filed') return;
    if (mission.phase === 'briefing') mission.begin();
    store.patch({ paused: !store.get().paused });
    sound('click');
    uiDirty = true;
  };

  const stepOnce = (): void => {
    if (!mission) return;
    if (mission.phase === 'briefing') mission.begin();
    store.patch({ paused: true });
    if (mission.advance(1) > 0) uiDirty = true;
  };

  const applyInstrumentAt = (): void => {
    const state = store.get();
    if (!mission) return;
    const instrumentId = state.selectedInstrument;
    if (!instrumentId) {
      toast('Pick an instrument first (keys 1–0)', 'warn');
      return;
    }
    const instrument = INSTRUMENTS_BY_ID.get(instrumentId);
    if (!instrument) return;
    if (instrument.destructive && state.settings.confirmDestructive && state.pendingDestructive !== instrumentId) {
      store.patch({ pendingDestructive: instrumentId });
      toast(`${instrument.name} is destructive — press again to confirm`, 'warn');
      return;
    }
    const isBarrier = instrument.isBarrier === true;
    const start = state.barrierStart ?? state.cursor;
    const result = mission.useInstrument({
      instrument: instrumentId,
      x: start.x,
      y: start.y,
      radius: instrumentId === 'cull' ? 6 : instrumentId === 'nutrient' ? 5 : 7,
      species: instrument.needsSpecies ? (state.selectedSpecies ?? undefined) : undefined,
      ...(isBarrier ? { x2: state.cursor.x, y2: state.cursor.y } : {}),
    });
    store.patch({ pendingDestructive: null, barrierStart: null });
    if (!result.ok) {
      toast(result.reason, 'error');
      sound('warning');
      return;
    }
    toast(result.message, 'info');
    sound(soundForInstrument(instrumentId));
    uiDirty = true;
  };

  const deployProbe = (): void => {
    const state = store.get();
    if (!mission) return;
    if (mission.world.probes.length >= MAX_PROBES) {
      toast(`All ${MAX_PROBES} probes are deployed — recover one first`, 'warn');
      return;
    }
    const probe = mission.world.addProbe(state.cursor.x, state.cursor.y, INSTRUMENT_PROBE_RADIUS);
    toast(`Probe #${probe.id} deployed at ${state.cursor.x.toFixed(0)},${state.cursor.y.toFixed(0)}`);
    sound('probe');
    uiDirty = true;
  };

  const recoverProbe = (): void => {
    if (!mission) return;
    const probes = mission.world.probes;
    const lastProbe = probes[probes.length - 1];
    if (!lastProbe) {
      toast('No probes are deployed', 'warn');
      return;
    }
    mission.world.removeProbe(lastProbe.id);
    toast(`Probe #${lastProbe.id} recovered (its recordings are kept)`);
    uiDirty = true;
  };

  const fileReport = (): void => {
    if (!mission) return;
    const result = mission.file();
    if (!result.ok) {
      toast(result.reason, 'error');
      sound('warning');
      return;
    }
    const grade = result.grade;
    if (!grade) return;
    const id = mission.config.id;
    const ranks = { ...store.get().ranks, [id]: grade.rank };
    const unlocked = new Set(store.get().unlockedSectors);
    const next = SECTORS.find((sector) => sector.unlockAfter === id);
    if (next && grade.rank !== 'F') unlocked.add(next.id);
    store.patch({
      screen: 'report',
      ranks,
      unlockedSectors: [...unlocked],
      lastReportFor: id,
      paused: true,
    });
    persist();
    sound('file');
    announcer.sayNow(
      `Report filed for ${id}. Score ${grade.score}. Rank ${grade.rank}. ${grade.results.filter((r) => r.correct).length} of ${grade.results.length} propositions correct.`,
    );
    uiDirty = true;
  };

  /**
   * Dispatch is a table, not a switch: one small handler per action, so every branch stays readable
   * and lint-checkable. A missing handler throws loudly instead of silently ignoring player input.
   */
  const handlers: { [K in Action['type']]: (action: Extract<Action, { type: K }>) => void } = {
    navigate(action) {
      audio.start();
      if (action.screen === 'survey') audio.startAmbient();
      else audio.stopAmbient();
      store.patch({ screen: action.screen, previousScreen: store.get().screen });
      uiDirty = true;
    },
    'start-sector': (action) => startSector(action.id),
    'set-overlay': (action) => {
      store.patch({ overlay: action.overlay });
      uiDirty = true;
    },
    'select-instrument': (action) => {
      store.patch({ selectedInstrument: action.instrument, pendingDestructive: null, barrierStart: null });
      uiDirty = true;
    },
    'select-species': (action) => {
      store.patch({ selectedSpecies: action.species });
      uiDirty = true;
    },
    'set-cursor': (action) => moveCursorTo(action.x, action.y),
    'move-cursor': (action) => moveCursorBy(action.dx, action.dy),
    'place-probe': () => deployProbe(),
    'recover-probe': () => recoverProbe(),
    'apply-instrument': () => applyInstrumentAt(),
    'undo-barrier': () => {
      if (!mission) return;
      const result = mission.undoBarrier();
      toast(result.ok ? result.message : result.reason, result.ok ? 'info' : 'warn');
      uiDirty = true;
    },
    'confirm-destructive': (action) => {
      store.patch({ pendingDestructive: action.confirmed ? store.get().pendingDestructive : null });
      uiDirty = true;
    },
    'toggle-pause': () => togglePause(),
    step: () => stepOnce(),
    'set-speed': (action) => {
      store.patch({ speed: clamp(Math.round(action.speed), 1, 8) });
      uiDirty = true;
    },
    'set-panel': (action) => {
      store.patch({ rightPanel: action.panel });
      uiDirty = true;
    },
    'set-log-filter': (action) => {
      store.patch({ logFilter: action.species });
      uiDirty = true;
    },
    answer: (action) => {
      if (!mission) return;
      const previous = mission.answersSnapshot().get(action.propositionId);
      const result = mission.answer(action.propositionId, action.optionId, previous?.confidence ?? 'low');
      if (!result.ok) toast(result.reason, 'error');
      sound('click');
      uiDirty = true;
    },
    confidence: (action) => {
      const previous = mission?.answersSnapshot().get(action.propositionId);
      if (!previous || !mission) {
        toast('Choose an answer before setting your confidence', 'warn');
        return;
      }
      mission.answer(action.propositionId, previous.optionId, action.confidence);
      uiDirty = true;
    },
    'buy-assist': (action) => {
      const proposition = mission?.propositions.find((candidate) => candidate.id === action.propositionId);
      if (!mission || !proposition) return;
      const result = mission.buyAssist(proposition.id, proposition.assistCost);
      toast(result.ok ? (result.text ?? result.message) : result.reason, result.ok ? 'info' : 'error');
      if (result.ok) sound('probe');
      uiDirty = true;
    },
    'file-report': () => fileReport(),
    'toggle-labels': () => {
      labelsOn = !labelsOn;
      uiDirty = true;
    },
    'set-settings': (action) => setSetting(action.patch),
    'reset-profile': () => {
      store.patch({ unlockedSectors: [], ranks: {}, toast: { text: 'Profile reset', kind: 'info', at: now() } });
      persist();
      uiDirty = true;
    },
    toast: (action) => toast(action.text, action.kind ?? 'info'),
  };

  const dispatch = (action: Action): void => {
    audio.start();
    const handler = handlers[action.type] as ((value: Action) => void) | undefined;
    if (!handler) throw new InvariantError(`Unhandled action ${String(action.type)}`);
    handler(action);
  };


  // ---------------------------------------------------------------- rendering

  const els = {
    layout: must<HTMLElement>(document, '#layout'),
    stage: must<HTMLElement>(document, '#stage'),
    screenRoot: must<HTMLElement>(document, '#screen-root'),
    sectorHeading: must<HTMLElement>(document, '#sector-heading'),
    clock: must<HTMLElement>(document, '#clock'),
    chargeReadout: must<HTMLElement>(document, '#charge-readout'),
    chargeMeter: must<HTMLElement>(document, '#charge-meter'),
    integrityReadout: must<HTMLElement>(document, '#integrity-readout'),
    integrityMeter: must<HTMLElement>(document, '#integrity-meter'),
    missionBody: must<HTMLElement>(document, '#mission-body'),
    surveyTools: must<HTMLElement>(document, '#survey-tools'),
    instrumentList: must<HTMLElement>(document, '#instrument-list'),
    playPause: must<HTMLButtonElement>(document, '#play-pause'),
    step: must<HTMLButtonElement>(document, '#step'),
    speed: must<HTMLSelectElement>(document, '#speed'),
    legend: must<HTMLElement>(document, '#legend'),
    renderStatus: must<HTMLElement>(document, '#render-status'),
    cursorReadout: must<HTMLElement>(document, '#cursor-readout'),
    organismReadout: must<HTMLElement>(document, '#organism-readout'),
    probeReadout: must<HTMLElement>(document, '#probe-readout'),
    populationTable: must<HTMLElement>(document, '#population-table'),
    probeChart: must<HTMLElement>(document, '#probe-chart'),
    codexProgress: must<HTMLElement>(document, '#codex-progress'),
    codexList: must<HTMLElement>(document, '#codex-list'),
    fileButton: must<HTMLButtonElement>(document, '#file-report'),
    logList: must<HTMLElement>(document, '#log-list'),
    logFilter: must<HTMLSelectElement>(document, '#log-filter'),
    summary: must<HTMLElement>(document, '#a11y-summary'),
    toast: must<HTMLElement>(document, '#toast'),
    tabs: {
      inspector: must<HTMLButtonElement>(document, '#tab-inspector'),
      data: must<HTMLButtonElement>(document, '#tab-data'),
      codex: must<HTMLButtonElement>(document, '#tab-codex'),
      log: must<HTMLButtonElement>(document, '#tab-log'),
    },
    panels: {
      inspector: must<HTMLElement>(document, '#panel-inspector'),
      data: must<HTMLElement>(document, '#panel-data'),
      codex: must<HTMLElement>(document, '#panel-codex'),
      log: must<HTMLElement>(document, '#panel-log'),
    },
  };

  const renderState = (state: AppState): RenderState => ({
    overlay: state.overlay,
    palette: state.settings.palette,
    contrast: state.settings.contrast,
    reducedMotion: state.settings.reducedMotion,
    cursor: state.cursor,
    target: state.selectedInstrument
      ? {
          x: state.barrierStart?.x ?? state.cursor.x,
          y: state.barrierStart?.y ?? state.cursor.y,
          radius: state.selectedInstrument === 'cull' ? 6 : 7,
          label: state.selectedInstrument,
        }
      : null,
    selectedAgentId: state.selectedAgentId,
    labels: labelsOn,
  });

  function renderScreen(state: AppState): void {
    const showingSurvey = state.screen === 'survey';
    els.layout.hidden = !showingSurvey;
    els.screenRoot.hidden = showingSurvey;
    if (showingSurvey) return;
    if (state.screen === 'title') els.screenRoot.innerHTML = titleMarkup();
    else if (state.screen === 'sector-select') els.screenRoot.innerHTML = sectorSelectMarkup(state);
    else if (state.screen === 'briefing') els.screenRoot.innerHTML = briefingMarkup(mission);
    else if (state.screen === 'report') els.screenRoot.innerHTML = reportMarkup(mission);
    else if (state.screen === 'settings') els.screenRoot.innerHTML = settingsMarkup(state, audio.getStatus());
    else if (state.screen === 'help') els.screenRoot.innerHTML = helpMarkup();
  }

  function renderHeader(state: AppState): void {
    if (!mission) {
      els.sectorHeading.textContent = 'Xenological Survey';
      els.clock.textContent = '';
      els.chargeReadout.textContent = 'Charge —';
      els.integrityReadout.textContent = 'Integrity —';
      els.chargeMeter.style.width = '0%';
      els.integrityMeter.style.width = '0%';
      return;
    }
    const budget = mission.budget;
    els.sectorHeading.textContent = `${mission.config.id} ${mission.config.name}`;
    els.clock.textContent = formatClock(mission.tick, mission.config.surveyTicks);
    els.chargeReadout.textContent = `Charge ${budget.charge}/${mission.config.startingCharge}`;
    els.integrityReadout.textContent = `Integrity ${budget.integrity}/${mission.config.startingIntegrity}`;
    els.chargeMeter.style.width = `${percent(budget.charge, mission.config.startingCharge)}%`;
    els.integrityMeter.style.width = `${percent(budget.integrity, mission.config.startingIntegrity)}%`;
    els.playPause.textContent = state.paused ? 'Play' : 'Pause';
    els.playPause.setAttribute('aria-pressed', String(!state.paused));
    els.speed.value = String(state.speed);
  }

  function renderMissionCard(): void {
    if (!mission) {
      els.missionBody.innerHTML = '<p class="clock">No mission loaded.</p>';
      return;
    }
    const config = mission.config;
    const alive = mission.worldAlive();
    els.missionBody.innerHTML = `
      <p><strong>${escapeHtml(config.name)}</strong> — ${escapeHtml(config.tagline)}</p>
      <dl class="readout">
        <dt>Designation</dt><dd>${escapeHtml(config.designation)}</dd>
        <dt>Roster</dt><dd>${config.roster.join(', ')}</dd>
        <dt>Survey window</dt><dd>${config.surveyTicks} ticks</dd>
        <dt>Biomass target</dt><dd>${config.biomassTarget.min}–${config.biomassTarget.max} (now ${mission.world.totalBiomass().toFixed(0)})</dd>
        <dt>Biosphere</dt><dd class="${alive ? 'answer-correct' : 'answer-wrong'}">${alive ? 'alive' : 'collapsed'}</dd>
      </dl>`;
  }

  function renderSurveyTools(state: AppState): void {
    const overlays: { id: OverlayId; label: string }[] = [
      { id: 'temperature', label: 'Temperature' },
      { id: 'humidity', label: 'Humidity' },
      { id: 'light', label: 'Light' },
      { id: 'biomass', label: 'Biomass' },
      { id: 'census', label: 'Census' },
      { id: 'none', label: 'No overlay' },
    ];
    els.surveyTools.innerHTML = `
      <div class="actions">${overlays
        .map(
          (overlay) =>
            `<button type="button" data-overlay="${overlay.id}" aria-pressed="${state.overlay === overlay.id}">${overlay.label}</button>`,
        )
        .join('')}</div>
      <div class="actions">
        <button type="button" data-tool="probe">Probe at cursor</button>
        <button type="button" data-tool="recover">Recover probe</button>
        <button type="button" data-tool="labels" aria-pressed="${labelsOn}">Labels</button>
      </div>`;
  }

  function renderInstruments(state: AppState): void {
    if (!mission) {
      els.instrumentList.innerHTML = '<li class="clock">Start a survey to load instruments.</li>';
      return;
    }
    els.instrumentList.innerHTML = INSTRUMENTS.filter((instrument) =>
      mission?.config.instruments.includes(instrument.id),
    )
      .map((instrument) => {
        const availability = mission?.availability(instrument) ?? { ok: false as const, reason: 'no mission' };
        const selected = state.selectedInstrument === instrument.id;
        const cost = `⚡${instrument.charge}${instrument.integrity > 0 ? ` · ♻−${instrument.integrity}` : ''}`;
        const description = `${instrument.description} Hotkey ${instrument.hotkey}.`;
        return `
          <li class="instrument ${selected ? 'selected' : ''}">
            <button type="button" class="name" data-instrument="${instrument.id}" aria-pressed="${selected}"
              title="${escapeHtml(description)}" ${availability.ok ? '' : 'data-unavailable="true"'}>
              ${escapeHtml(instrument.name)}
            </button>
            <span class="cost">${cost}</span>
            ${availability.ok ? '' : `<span class="why">${escapeHtml(availability.reason)}</span>`}
          </li>`;
      })
      .join('');
  }

  function renderCursor(state: AppState): void {
    if (!mission) {
      els.cursorReadout.innerHTML = '';
      return;
    }
    const readings = mission.readingsAt(state.cursor.x, state.cursor.y);
    const census = mission.world.censusAround(state.cursor.x, state.cursor.y, 4);
    const nearby = Object.entries(census).filter(([, count]) => count > 0);
    els.cursorReadout.innerHTML = `
      <dl class="readout">
        <dt>cell</dt><dd>${state.cursor.x.toFixed(1)}, ${state.cursor.y.toFixed(1)}</dd>
        ${FIELD_IDS.map(
          (field) =>
            `<dt>${FIELD_SPECS[field].label}</dt><dd>${readings[field].toFixed(FIELD_SPECS[field].decimals)} ${FIELD_SPECS[field].unit}</dd>`,
        ).join('')}
        <dt>nearby</dt><dd>${nearby.length ? nearby.map(([s, c]) => `${s}×${c}`).join(', ') : 'nothing'}</dd>
      </dl>`;
  }

  function renderOrganism(state: AppState): void {
    if (!mission) {
      els.organismReadout.innerHTML = '';
      return;
    }
    const agent = state.selectedAgentId === null ? null : mission.organismAt(state.cursor.x, state.cursor.y);
    if (!agent) {
      els.organismReadout.innerHTML = '<p class="clock">Click the map (or press Enter with an instrument unselected) to inspect the nearest organism.</p>';
      return;
    }
    const traits = SPECIES_BY_ID.get(agent.species)?.traits;
    const readings = mission.readingsAt(agent.x, agent.y);
    const fitness = mission.world.fitnessAt(agent.x, agent.y, agent.species);
    els.organismReadout.innerHTML = `
      <dl class="readout">
        <dt>species</dt><dd>${escapeHtml(traits?.name ?? agent.species)} (${agent.species})</dd>
        <dt>role</dt><dd>${escapeHtml(traits?.role ?? 'unknown')}</dd>
        <dt>energy</dt><dd>${agent.energy.toFixed(1)} / ${traits?.maxEnergy ?? '?'}</dd>
        <dt>age</dt><dd>${agent.age} ticks</dd>
        <dt>generation</dt><dd>${agent.generation}</dd>
        <dt>fitness here</dt><dd>${fitness.toFixed(2)}</dd>
        ${FIELD_IDS.map(
          (field) =>
            `<dt>${FIELD_SPECS[field].label}</dt><dd>${readings[field].toFixed(FIELD_SPECS[field].decimals)}</dd>`,
        ).join('')}
      </dl>`;
  }

  function renderProbes(): void {
    if (!mission) {
      els.probeReadout.innerHTML = '';
      return;
    }
    const probes = mission.world.probes;
    if (probes.length === 0) {
      els.probeReadout.innerHTML = '<p class="clock">No probes deployed. Probes are free and record continuously.</p>';
      return;
    }
    els.probeReadout.innerHTML = `<ul class="plain">${probes
      .map((probe) => {
        const latest = probe.samples[probe.samples.length - 1];
        const species = latest
          ? Object.entries(latest.counts)
              .filter(([, count]) => count > 0)
              .map(([id, count]) => `${id}×${count}`)
              .join(' ')
          : 'no samples yet';
        return `<li class="clock">#${probe.id} at ${probe.x.toFixed(0)},${probe.y.toFixed(0)} r${probe.radius} · ${probe.samples.length} samples · ${species}</li>`;
      })
      .join('')}</ul>`;
  }

  function renderData(): void {
    if (!mission) {
      els.populationTable.innerHTML = '';
      els.probeChart.innerHTML = '';
      return;
    }
    const counts = mission.world.counts();
    const biomass = mission.world.biomassReport();
    const history = mission.world.historySeries();
    const peak = Math.max(
      1,
      ...history.flatMap((sample) => Object.values(sample.counts).map((count) => count)),
    );
    els.populationTable.innerHTML = `
      <table class="data">
        <thead><tr><th>Species</th><th>Count</th><th>Biomass</th><th>Trend</th></tr></thead>
        <tbody>
          ${mission.config.roster
            .map((species) => {
              const samples = history.map((sample) => sample.counts[species] ?? 0);
              const spark = sparkline(samples, peak);
              return `<tr><td>${species}</td><td>${counts[species] ?? 0}</td><td>${(biomass[species] ?? 0).toFixed(0)}</td><td><svg width="70" height="16" role="img" aria-label="trend for ${species}">${spark}</svg></td></tr>`;
            })
            .join('')}
        </tbody>
      </table>`;

    const probes = mission.world.probes;
    if (probes.length === 0) {
      els.probeChart.innerHTML = '<p class="clock">Deploy a probe to record field series here.</p>';
      return;
    }
    const probe = probes[probes.length - 1];
    if (!probe) {
      els.probeChart.innerHTML = '';
      return;
    }
    const temperatures = probe.samples.map((sample) => sample.temperature);
    const populations = probe.samples.map((sample) =>
      Object.values(sample.counts).reduce((sum, count) => sum + count, 0),
    );
    const key = `${probe.id}:${probe.samples.length}`;
    const markup = `
      <p class="clock">Probe #${probe.id} — ${probe.samples.length} samples, newest at right.</p>
      <div class="bar-chart" role="img" aria-label="Temperature recorded by probe ${probe.id}">
        ${bars(temperatures, FIELD_SPECS.temperature.min, FIELD_SPECS.temperature.max)}
      </div>
      <div class="bar-chart" role="img" aria-label="Organisms counted in probe ${probe.id} radius">
        ${bars(populations, 0, Math.max(1, ...populations))}
      </div>
      <p class="evidence">temperature ${formatRange(temperatures, 1)} K · population ${formatRange(populations, 0)}</p>`;
    if (chartCache.get(key) !== markup) {
      chartCache.set(key, markup);
      els.probeChart.innerHTML = markup;
    }
  }

  function renderCodex(): void {
    if (!mission) {
      els.codexList.innerHTML = '';
      els.codexProgress.textContent = '';
      els.fileButton.disabled = true;
      return;
    }
    const current = mission;
    const answers = current.answersSnapshot();
    els.codexProgress.textContent = `${answers.size} of ${current.propositions.length} answered · Charge ${current.budget.charge} left · window closes in ${current.remainingTicks} ticks`;
    els.codexList.innerHTML = current.propositions
      .map((proposition) => propositionMarkup(proposition, answers.get(proposition.id), current))
      .join('');
    els.fileButton.disabled = current.phase === 'filed';
  }

  function renderLog(state: AppState): void {
    if (!mission) {
      els.logList.innerHTML = '';
      return;
    }
    const filter = state.logFilter;
    const options = ['all', ...mission.config.roster];
    if (els.logFilter.dataset.options !== options.join(',')) {
      els.logFilter.dataset.options = options.join(',');
      els.logFilter.innerHTML = options
        .map((id) => `<option value="${id}" ${id === filter ? 'selected' : ''}>${id === 'all' ? 'All species' : id}</option>`)
        .join('');
    }
    const events = mission.world.events
      .recent(400)
      .filter((event) => filter === 'all' || event.species === filter || event.target === filter)
      .slice(-120)
      .reverse();
    els.logList.innerHTML = events
      .map((event) => {
        const readings = event.readings
          ? ` · ${FIELD_IDS.map((field) => `${event.readings?.[field]?.toFixed(0)}`).join('/')}`
          : '';
        const tag = event.species ?? event.target ?? '';
        return `<li>t${String(event.tick).padStart(5, '0')} ${event.kind.padEnd(12)} ${tag.padEnd(6)} ${escapeHtml(event.message ?? event.cause ?? '')}${readings}</li>`;
      })
      .join('');
  }

  function renderLegend(state: AppState): void {
    const palette = paletteById(state.settings.palette);
    const field: FieldId | null = state.overlay === 'none' || state.overlay === 'census' || state.overlay === 'biomass'
      ? null
      : state.overlay;
    if (!field) {
      els.legend.innerHTML = `<span>Overlay: ${state.overlay}</span>`;
      return;
    }
    const spec = FIELD_SPECS[field];
    const stats = mission?.world.fields[field].stats();
    const ramp = palette.fields[field];
    const stops = [0, 0.25, 0.5, 0.75, 1]
      .map((t) => `rgb(${ramp(t).join(' ')}) ${t * 100}%`)
      .join(', ');
    els.legend.innerHTML = `
      <span class="legend-ramp">${field} <i style="background: linear-gradient(90deg, ${stops})"></i> ${spec.unit}</span>
      <span>range shown: ${(stats?.min ?? 0).toFixed(spec.decimals)} – ${(stats?.max ?? 0).toFixed(spec.decimals)} ${spec.unit}</span>`;
  }

  function renderToast(state: AppState): void {
    const toast = state.toast;
    els.toast.hidden = !toast;
    if (toast) {
      els.toast.textContent = toast.text;
      els.toast.dataset.kind = toast.kind;
    }
  }

  /**
   * Everything the panels display, in one string. Rebuilding panels costs far more than the canvas, so
   * an unchanged signature skips the DOM work entirely — that is what keeps a paused game idle and a
   * running one at exactly one rebuild per tick.
   */
  function panelSignature(state: AppState): string {
    if (!mission) return `none|${state.screen}`;
    const budget = mission.budget;
    return [
      mission.tick,
      mission.phase,
      state.rightPanel,
      state.paused,
      state.speed,
      state.overlay,
      state.selectedInstrument ?? '-',
      state.selectedSpecies ?? '-',
      state.pendingDestructive ?? '-',
      state.selectedAgentId ?? '-',
      state.logFilter,
      state.cursor.x,
      state.cursor.y,
      budget.charge,
      budget.integrity,
      mission.answeredCount,
      mission.world.probes.length,
      mission.world.events.recent(1).length,
      labelsOn ? 'labels' : '-',
      state.settings.palette,
      state.settings.contrast,
      state.toast?.text ?? '-',
      mission.grade?.score ?? '-',
    ].join('|');
  }

  /**
   * A browser without canvas 2D is still a playable game: the panels and the text summary carry every
   * measurement. Say so once, in the stage, instead of leaving the player with a black rectangle.
   */
  function renderRenderWarning(state: AppState): void {
    const status = renderer.getStatus();
    if (!status.ok) {
      if (state.renderWarning === null) store.patch({ renderWarning: status.message });
      if (!document.querySelector('.render-notice')) {
        const notice = document.createElement('p');
        notice.className = 'render-notice clock';
        notice.setAttribute('role', 'status');
        notice.textContent = status.message;
        els.stage.insertBefore(notice, els.stage.firstChild);
      }
      return;
    }
    els.renderStatus.textContent = `frame ${renderer.lastFrameMs.toFixed(1)} ms`;
    document.querySelector('.render-notice')?.remove();
  }

  function renderAll(): void {
    const state = store.get();
    renderScreen(state);
    if (state.screen !== 'survey') {
      lastPanelSignature = '';
      renderToast(state);
      uiDirty = false;
      return;
    }
    const signature = panelSignature(state);
    if (signature === lastPanelSignature) {
      uiDirty = false;
      return;
    }
    lastPanelSignature = signature;
    renderHeader(state);
    renderMissionCard();
    renderSurveyTools(state);
    renderInstruments(state);
    renderCursor(state);
    renderOrganism(state);
    renderProbes();
    renderData();
    renderCodex();
    renderLog(state);
    renderLegend(state);
    renderToast(state);
    for (const panel of ['inspector', 'data', 'codex', 'log'] as RightPanel[]) {
      const selected = state.rightPanel === panel;
      els.panels[panel].hidden = !selected;
      els.tabs[panel].setAttribute('aria-selected', String(selected));
    }
    renderRenderWarning(state);
    uiDirty = false;
  }

  // ---------------------------------------------------------------- input

  /**
   * Canvas pointer: sets the cursor and inspects whatever organism is closest. Pointer events cover
   * mouse, pen and touch in one code path (docs/DESIGN.md §7).
   */
  const onCanvasPointerDown = (event: PointerEvent): void => {
    if (!mission) return;
    const point = renderer.toWorld(mission.config, event.clientX, event.clientY);
    const agent = mission.organismAt(point.x, point.y);
    store.patch({
      cursor: { x: clamp(Math.round(point.x), 0, mission.config.width - 1), y: clamp(Math.round(point.y), 0, mission.config.height - 1) },
      selectedAgentId: agent?.id ?? null,
      rightPanel: 'inspector',
    });
    uiDirty = true;
  };

  const onCanvasWheel = (event: WheelEvent): void => {
    if (!mission) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    renderer.zoomBy(mission.config, event.deltaY < 0 ? 1.15 : 1 / 1.15, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    uiDirty = true;
  };

  /** Keyboard commands, keyed by `KeyboardEvent.key`. */
  const keyCommands: Record<string, (event: KeyboardEvent) => void> = {
    ' ': () => dispatch({ type: 'toggle-pause' }),
    Enter: () => dispatch({ type: 'apply-instrument' }),
    ArrowUp: (event) => arrow(event, 0, -1),
    ArrowDown: (event) => arrow(event, 0, 1),
    ArrowLeft: (event) => arrow(event, -1, 0),
    ArrowRight: (event) => arrow(event, 1, 0),
    ',': () => dispatch({ type: 'set-speed', speed: store.get().speed / 2 }),
    '.': () => dispatch({ type: 'set-speed', speed: store.get().speed * 2 }),
    o: () => cycleOverlay(),
    p: () => dispatch({ type: 'place-probe' }),
    r: () => dispatch({ type: 'recover-probe' }),
    f: () => dispatch({ type: 'file-report' }),
    Escape: () => dispatch({ type: 'select-instrument', instrument: null }),
  };

  const arrow = (event: KeyboardEvent, dx: number, dy: number): void => {
    if (event.shiftKey) {
      if (mission) renderer.panBy(mission.config, dx * 24, dy * 24);
      return;
    }
    dispatch({ type: 'move-cursor', dx, dy });
  };

  const cycleOverlay = (): void => {
    const order: OverlayId[] = ['temperature', 'humidity', 'light', 'biomass', 'census', 'none'];
    const index = order.indexOf(store.get().overlay);
    dispatch({ type: 'set-overlay', overlay: order[(index + 1) % order.length] ?? 'temperature' });
  };

  const isFormTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA', 'OPTION'].includes(target.tagName);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isFormTarget(event.target)) {
      if (event.key === 'Escape') (event.target as HTMLElement).blur();
      return;
    }
    const state = store.get();
    if (event.key === '?') {
      dispatch({ type: 'navigate', screen: state.screen === 'help' ? 'survey' : 'help' });
      event.preventDefault();
      return;
    }
    if (state.screen !== 'survey') {
      if (event.key === 'Escape') dispatch({ type: 'navigate', screen: 'title' });
      return;
    }
    const instrument = INSTRUMENTS.find((candidate) => candidate.hotkey === event.key);
    if (instrument) {
      dispatch({ type: 'select-instrument', instrument: instrument.id });
      event.preventDefault();
      return;
    }
    const command = keyCommands[event.key];
    if (!command) return;
    command(event);
    event.preventDefault();
  };

  /** Click routing: each entry matches one `data-*` attribute on the clicked element. */
  const clickCommands: readonly {
    readonly key: string;
    readonly run: (value: string) => void;
  }[] = [
    { key: 'overlay', run: (value) => dispatch({ type: 'set-overlay', overlay: value as OverlayId }) },
    { key: 'instrument', run: (value) => dispatch({ type: 'select-instrument', instrument: value as InstrumentId }) },
    { key: 'species', run: (value) => dispatch({ type: 'select-species', species: value }) },
    { key: 'screen', run: (value) => dispatch({ type: 'navigate', screen: value as ScreenId }) },
    { key: 'startSector', run: (value) => dispatch({ type: 'start-sector', id: value }) },
    { key: 'panel', run: (value) => dispatch({ type: 'set-panel', panel: value as RightPanel }) },
    { key: 'assist', run: (value) => dispatch({ type: 'buy-assist', propositionId: value }) },
    { key: 'tool', run: (value) => runSurveyTool(value) },
    {
      key: 'confidence',
      run: (value) => {
        const propositionId = currentConfidenceTarget;
        if (propositionId === null) return;
        dispatch({ type: 'confidence', propositionId, confidence: value === 'high' ? 'high' : 'low' });
      },
    },
    { key: 'action', run: (value) => runNamedAction(value) },
  ];

  let currentConfidenceTarget: string | null = null;

  const runSurveyTool = (value: string): void => {
    if (value === 'probe') dispatch({ type: 'place-probe' });
    else if (value === 'recover') dispatch({ type: 'recover-probe' });
    else if (value === 'labels') dispatch({ type: 'toggle-labels' });
  };

  const runNamedAction = (value: string): void => {
    if (value === 'file') dispatch({ type: 'file-report' });
    else if (value === 'toggle-pause') dispatch({ type: 'toggle-pause' });
    else if (value === 'step') dispatch({ type: 'step' });
    else if (value === 'undo-barrier') dispatch({ type: 'undo-barrier' });
    else if (value === 'reset-profile') dispatch({ type: 'reset-profile' });
    else if (value === 'recover-close') dispatch({ type: 'navigate', screen: 'survey' });
  };

  const onClick = (event: MouseEvent): void => {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    const origin = element.closest<HTMLElement>('[data-proposition]');
    currentConfidenceTarget = origin?.dataset.proposition ?? null;
    for (const command of clickCommands) {
      const value = element.dataset[command.key];
      if (typeof value === 'string') {
        command.run(value);
        return;
      }
    }
  };

  const onChange = (event: Event): void => {
    const element = event.target;
    if (element instanceof HTMLSelectElement) {
      runSelect(element);
      return;
    }
    if (element instanceof HTMLInputElement) runInput(element);
  };

  const runSelect = (element: HTMLSelectElement): void => {
    const handlers: Record<string, (value: string) => void> = {
      'log-filter': (value) => dispatch({ type: 'set-log-filter', species: value }),
      speed: (value) => dispatch({ type: 'set-speed', speed: Number(value) }),
      'setting-palette': (value) => dispatch({ type: 'set-settings', patch: { palette: value as PaletteId } }),
      'setting-contrast': (value) =>
        dispatch({ type: 'set-settings', patch: { contrast: value === 'high' ? 'high' : 'normal' } }),
      'setting-ui-scale': (value) => dispatch({ type: 'set-settings', patch: { uiScale: Number(value) } }),
    };
    handlers[element.id]?.(element.value);
  };

  const runInput = (element: HTMLInputElement): void => {
    if (element.type === 'radio' && element.name.startsWith('prop:')) {
      dispatch({ type: 'answer', propositionId: element.name.slice('prop:'.length), optionId: element.value });
      return;
    }
    const settingKey = element.dataset.setting;
    if (!settingKey) return;
    const patch: Partial<AppState['settings']> = {};
    if (settingKey === 'reducedMotion') patch.reducedMotion = element.checked;
    else if (settingKey === 'muted') patch.muted = element.checked;
    else if (settingKey === 'confirmDestructive') patch.confirmDestructive = element.checked;
    else if (settingKey === 'autoPauseOnBlur') patch.autoPauseOnBlur = element.checked;
    else if (settingKey === 'volume') patch.volume = clamp(Number(element.value), 0, 1);
    else return;
    dispatch({ type: 'set-settings', patch });
  };


  // ---------------------------------------------------------------- loop

  /**
   * One animation frame. The simulation advances by accumulated wall-clock time at the chosen speed,
   * the canvas is redrawn every frame, and the DOM panels are re-rendered at most ~11 times a second —
   * a full panel rebuild is far more expensive than a canvas paint, and the player cannot read faster
   * than that anyway.
   */
  function frame(timeMs: number): void {
    const state = store.get();
    if (state.screen === 'survey' && mission) {
      const elapsed = lastFrameTime === 0 ? 0 : clamp((timeMs - lastFrameTime) / 1000, 0, 0.25);
      lastFrameTime = timeMs;
      if (!state.paused) {
        accumulator += elapsed * TICKS_PER_SECOND * state.speed;
        const ticks = Math.floor(accumulator);
        if (ticks > 0) {
          accumulator -= ticks;
          mission.advance(ticks * (state.settings.reducedMotion ? 1 : 1));
          uiDirty = true;
        }
        if (mission.phase === 'survey' && mission.remainingTicks === 0) {
          toast('The survey window has closed — filing the report', 'warn');
          fileReport();
        }
      }
      renderer.draw(mission.world, renderState(state));
      els.summary.textContent = summariseWorld(mission.world, state.cursor, state.paused);
      for (const message of mission.drainAnnouncements()) announcer.say(message);
    } else {
      lastFrameTime = timeMs;
    }
    if (uiDirty && timeMs - lastUiRender > 90) {
      lastUiRender = timeMs;
      renderer.resize(mission?.config ?? fallbackConfig());
      renderAll();
    }
    if (handle !== null) handle = requestFrame(frame);
  }

  /** Used to size the canvas before any mission exists (the title screen). */
  function fallbackConfig(): SectorConfig {
    const first = SECTORS[0];
    if (!first) throw new InvariantError('The campaign defines no sectors');
    return first;
  }

  // ---------------------------------------------------------------- wiring

  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  canvas.addEventListener('wheel', onCanvasWheel, { passive: false });

  const unsubscribe = store.subscribe(() => {
    uiDirty = true;
  });
  store.select('settings', () => {
    audio.setOptions({ volume: store.get().settings.volume, muted: store.get().settings.muted });
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('blur', () => {
      if (store.get().settings.autoPauseOnBlur && store.get().screen === 'survey') {
        store.patch({ paused: true });
        uiDirty = true;
      }
    });
  }

  return {
    store,
    announcer,
    getMission: () => mission,
    getRenderer: () => renderer,
    start() {
      lastPanelSignature = '';
      document.body.classList.toggle('high-contrast', store.get().settings.contrast === 'high');
      document.body.style.setProperty('--ui-scale', String(store.get().settings.uiScale));
      renderAll();
      if (handle === null) handle = requestFrame(frame);
    },
    stop() {
      if (handle !== null) cancelFrame(handle);
      handle = null;
      unsubscribe();
      announcer.dispose();
      document.removeEventListener('click', onClick);
      document.removeEventListener('change', onChange);
      document.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('pointerdown', onCanvasPointerDown);
      canvas.removeEventListener('wheel', onCanvasWheel);
      audio.stopAmbient();
    },
    dispatch,
    frame,
    render: renderAll,
  };
}

// ---------------------------------------------------------------- markup helpers

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return clamp((value / total) * 100, 0, 100);
}

function soundForInstrument(id: InstrumentId): SoundId {
  if (id === 'cull') return 'cull';
  if (id === 'barrier') return 'barrier';
  if (id === 'nutrient') return 'bloom';
  if (id === 'hatchery') return 'probe';
  return 'pulse';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function titleMarkup(): string {
  return `
    <section class="screen" aria-label="Title">
      <h2>WORLDBUG</h2>
      <p><strong>ISV Meridian, Xenological Survey Division.</strong> Five sectors. Five biospheres whose
      rules nobody has written down. You are not here to conquer them: you are here to read them.</p>
      <p>Observe a living ecosystem, disturb it with a finite energy budget, deduce the laws that
      govern it, and file a Codex report before the survey window closes. A dead world is a failed
      survey, no matter how good the report.</p>
      <div class="row">
        <button type="button" data-screen="sector-select" class="primary">Begin survey</button>
        <button type="button" data-screen="help">How to play</button>
        <button type="button" data-screen="settings">Settings</button>
      </div>
    </section>`;
}

function sectorSelectMarkup(state: AppState): string {
  const rows = SECTORS.map((sector) => {
    const rank = state.ranks[sector.id];
    const unlocked =
      sector.unlockAfter === null || (state.ranks[sector.unlockAfter] !== undefined && state.ranks[sector.unlockAfter] !== 'F');
    return `
      <tr>
        <td>${sector.index}</td>
        <td><strong>${escapeHtml(sector.name)}</strong><br /><span class="clock">${escapeHtml(sector.tagline)}</span></td>
        <td>${sector.roster.join(', ')}</td>
        <td>${sector.difficulty}/5</td>
        <td>${rank ?? '—'}</td>
        <td>${
          unlocked
            ? `<button type="button" data-start-sector="${sector.id}">Survey ${sector.id}</button>`
            : `<span class="clock">unlocks after ${sector.unlockAfter}</span>`
        }</td>
      </tr>`;
  }).join('');
  return `
    <section class="screen" aria-label="Sector select">
      <h2>Select a sector</h2>
      <table class="data">
        <thead><tr><th>#</th><th>Sector</th><th>Species</th><th>Difficulty</th><th>Rank</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="row">
        <button type="button" data-screen="title">Back</button>
        <button type="button" data-screen="settings">Settings</button>
      </div>
    </section>`;
}

function briefingMarkup(mission: Mission | null): string {
  if (!mission) return '<section class="screen"><p>No mission loaded.</p></section>';
  const config = mission.config;
  return `
    <section class="screen" aria-label="Briefing">
      <h2>${config.id} · ${escapeHtml(config.name)}</h2>
      <p class="clock">${escapeHtml(config.designation)} · difficulty ${config.difficulty}/5 · ${config.surveyTicks} ticks</p>
      <p>${escapeHtml(config.brief)}</p>
      <p><strong>Objective.</strong> ${escapeHtml(config.objective)}</p>
      <p class="clock">Instruments fitted: ${config.instruments.join(', ')} · Charge ${config.startingCharge} · Integrity ${config.startingIntegrity}</p>
      <div class="row">
        <button type="button" data-start-sector="${config.id}">Start the survey</button>
        <button type="button" data-screen="sector-select">Back to sector select</button>
      </div>
    </section>`;
}

function reportMarkup(mission: Mission | null): string {
  if (!mission) return '<section class="screen"><p>No mission loaded.</p></section>';
  const grade = mission.grade;
  if (!grade) {
    return `
      <section class="screen" aria-label="Report">
        <h2>Report not filed</h2>
        <p>The survey of ${mission.config.id} has not been filed yet.</p>
        <div class="row"><button type="button" data-action="recover-close">Return to the survey</button></div>
      </section>`;
  }
  const results = grade.results
    .map(
      (result) => `
      <tr>
        <td class="${result.correct ? 'answer-correct' : 'answer-wrong'}">${result.correct ? 'correct' : 'wrong'}</td>
        <td>${escapeHtml(result.prompt)}</td>
        <td>${escapeHtml(result.chosenOptionId ?? 'unanswered')}</td>
        <td>${escapeHtml(result.correctOptionId)}</td>
        <td class="clock">${escapeHtml(result.explanation)}</td>
      </tr>`,
    )
    .join('');
  return `
    <section class="screen" aria-label="Report">
      <h2>Survey report · ${mission.config.id}</h2>
      <p><span class="rank">${grade.rank}</span> &nbsp; ${grade.score} points</p>
      <dl class="readout">
        <dt>Correctness</dt><dd>${(grade.correctness * 100).toFixed(0)}% (weighted)</dd>
        <dt>Conservation</dt><dd>${(grade.conservation * 100).toFixed(0)}% · final biomass ${grade.biomass.toFixed(0)} (target ${mission.config.biomassTarget.min}–${mission.config.biomassTarget.max})</dd>
        <dt>Efficiency</dt><dd>${(grade.efficiency * 100).toFixed(0)}% · Charge spent ${grade.spentCharge}/${mission.config.startingCharge}</dd>
        <dt>Extinctions</dt><dd>${grade.extinctionCount}</dd>
      </dl>
      <table class="data">
        <thead><tr><th></th><th>Proposition</th><th>Filed</th><th>Correct</th><th>Debrief</th></tr></thead>
        <tbody>${results}</tbody>
      </table>
      <div class="row">
        <button type="button" data-screen="sector-select">Sector select</button>
        <button type="button" data-start-sector="${mission.config.id}">Survey ${mission.config.id} again</button>
      </div>
    </section>`;
}

function settingsMarkup(state: AppState, audioStatus: string): string {
  const paletteOptions = PALETTES.map(
    (palette) =>
      `<option value="${palette.id}" ${state.settings.palette === palette.id ? 'selected' : ''}>${escapeHtml(palette.name)}</option>`,
  ).join('');
  return `
    <section class="screen" aria-label="Settings">
      <h2>Settings</h2>
      <p class="clock">Audio: ${escapeHtml(audioStatus)}</p>
      <p><label for="setting-palette">Colour palette</label><br />
        <select id="setting-palette">${paletteOptions}</select></p>
      <p><label for="setting-contrast">Contrast</label><br />
        <select id="setting-contrast">
          <option value="normal" ${state.settings.contrast === 'normal' ? 'selected' : ''}>Normal</option>
          <option value="high" ${state.settings.contrast === 'high' ? 'selected' : ''}>High contrast</option>
        </select></p>
      <p><label for="setting-ui-scale">Interface scale</label><br />
        <select id="setting-ui-scale">
          ${[0.9, 1, 1.15, 1.3]
            .map((scale) => `<option value="${scale}" ${state.settings.uiScale === scale ? 'selected' : ''}>${Math.round(scale * 100)}%</option>`)
            .join('')}
        </select></p>
      <p><label><input type="checkbox" data-setting="reducedMotion" ${state.settings.reducedMotion ? 'checked' : ''} /> Reduced motion</label></p>
      <p><label><input type="checkbox" data-setting="muted" ${state.settings.muted ? 'checked' : ''} /> Mute all audio</label></p>
      <p><label><input type="checkbox" data-setting="confirmDestructive" ${state.settings.confirmDestructive ? 'checked' : ''} /> Confirm destructive instruments</label></p>
      <p><label><input type="checkbox" data-setting="autoPauseOnBlur" ${state.settings.autoPauseOnBlur ? 'checked' : ''} /> Auto-pause when the tab loses focus</label></p>
      <div class="row">
        <button type="button" data-screen="title">Back</button>
        <button type="button" data-action="reset-profile">Reset profile</button>
      </div>
    </section>`;
}

function helpMarkup(): string {
  return `
    <section class="screen" aria-label="How to play">
      <h2>How to play</h2>
      <p><strong>The map is a measurement, not an opinion.</strong> Every organism moves, feeds,
      reproduces and dies according to hidden tolerances. Your job is to work out what those tolerances
      are, and which species eats which.</p>
      <h3>Survey tools — free, unlimited</h3>
      <ul>
        <li><strong>Overlays</strong>: switch the map between temperature, humidity, light, biomass and
        census. The temperature overlay is what makes a thermal niche visible.</li>
        <li><strong>Cursor</strong>: arrow keys move it; the panels and the text summary always report
        exactly what is under it.</li>
        <li><strong>Probes</strong>: press P to leave a sensor at the cursor. Probes record the fields
        and count every species around them, continuously, and the Data panel charts what they saw.</li>
        <li><strong>Log</strong>: births, deaths with their cause, kills, pulses. Deaths are evidence:
        a species that dies of exposure at 233 K is telling you its tolerance.</li>
      </ul>
      <h3>Instruments — they cost Charge</h3>
      <p>Select one with keys 1–0 and press Enter to apply it at the cursor. A pulse is a question you
      ask the world: raise the temperature and watch who grows. Destructive tools also cost Integrity —
      and the biosphere you damage is the thing you are graded on preserving.</p>
      <h3>Codex and report</h3>
      <p>Answer each proposition, optionally buying a Data Assist (real statistics over your own
      recordings) for Charge, then file the report. Ranks: S ≥ 900, A ≥ 750, B ≥ 550, C ≥ anything
      filed, F if the sector collapsed.</p>
      <h3>Keys</h3>
      <p class="clock">Space play/pause · 1–0 instruments · arrows cursor · Shift+arrows pan ·
      Enter apply · O cycle overlay · P probe · R recover probe · F file report · , . speed ·
      Esc cancel · ? help</p>
      <div class="row"><button type="button" data-screen="survey">Back</button></div>
    </section>`;
}

function propositionMarkup(
  proposition: Proposition,
  answer: { optionId: string; confidence: 'low' | 'high' } | undefined,
  mission: Mission,
): string {
  const options = proposition.options
    .map(
      (option) => `
      <label>
        <input type="radio" name="prop:${proposition.id}" value="${escapeHtml(option.id)}"
          ${answer?.optionId === option.id ? 'checked' : ''} />
        <span>${escapeHtml(option.label)}</span>
      </label>`,
    )
    .join('');
  const evidence = answer
    ? `<div class="evidence">${Object.entries(proposition.evidence)
        .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`)
        .join(' · ')}</div>`
    : '';
  const affordable = mission.budget.charge >= proposition.assistCost;
  return `
    <div class="proposition ${answer ? 'answered' : ''}">
      <p>${escapeHtml(proposition.prompt)}</p>
      <fieldset>${options}</fieldset>
      <div class="actions">
        <button type="button" data-assist="${proposition.id}" ${affordable ? '' : 'disabled'}>
          Data assist (⚡${proposition.assistCost})
        </button>
        <button type="button" data-confidence="low" data-proposition="${proposition.id}"
          aria-pressed="${answer?.confidence === 'low'}">Confidence: low</button>
        <button type="button" data-confidence="high" data-proposition="${proposition.id}"
          aria-pressed="${answer?.confidence === 'high'}">Confidence: high</button>
      </div>
      ${evidence}
    </div>`;
}

function bars(values: readonly number[], min: number, max: number): string {
  if (values.length === 0) return '';
  const span = Math.max(1e-6, max - min);
  return values
    .map((value) => {
      const height = clamp(((value - min) / span) * 100, 2, 100);
      return `<span style="height:${height.toFixed(1)}%" title="${value.toFixed(1)}"></span>`;
    })
    .join('');
}

function formatRange(values: readonly number[], decimals: number): string {
  if (values.length === 0) return 'no samples';
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  return `${min.toFixed(decimals)}–${max.toFixed(decimals)} (mean ${(sum / values.length).toFixed(decimals)})`;
}

function sparkline(values: readonly number[], peak: number): string {
  if (values.length === 0) return '';
  const width = 70;
  const height = 16;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - (value / peak) * height).toFixed(1)}`)
    .join(' ');
  return `<polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.4" />`;
}

function defaultStorage(): StorageLike {
  if (typeof localStorage === 'undefined') return memoryStorage();
  try {
    const probe = '__worldbug_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryStorage();
  }
}

/** Re-exported so tests can validate a save without importing the persistence module directly. */
export { coerceSave };
