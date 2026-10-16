import type { SpeciesId } from '../core/sim/species.ts';
import type { OverlayId } from '../render/renderer.ts';
import type { ContrastMode, PaletteId } from '../render/palettes.ts';
import type { Rank } from './grading.ts';
import type { InstrumentId } from './instruments.ts';

/**
 * The application state tree.
 *
 * One plain object in a store (store.ts). Screens are exclusive; the survey extras only exist while a
 * mission is loaded. The mission object itself is *not* cloned — it holds the live world, and it is
 * mutated only through its own methods.
 */

export type ScreenId = 'title' | 'sector-select' | 'briefing' | 'survey' | 'report' | 'settings' | 'help';

export type RightPanel = 'inspector' | 'data' | 'codex' | 'log';

export interface Settings {
  palette: PaletteId;
  contrast: ContrastMode;
  reducedMotion: boolean;
  uiScale: number;
  volume: number;
  muted: boolean;
  confirmDestructive: boolean;
  autoPauseOnBlur: boolean;
}

export interface Toast {
  readonly text: string;
  readonly kind: 'info' | 'warn' | 'error';
  readonly at: number;
}

export interface AppState {
  readonly screen: ScreenId;
  readonly previousScreen: ScreenId;
  readonly settings: Settings;
  readonly unlockedSectors: readonly string[];
  readonly ranks: Readonly<Record<string, Rank>>;
  /** Set once the survey of the current sector has been filed. */
  readonly lastReportFor: string | null;
  readonly toast: Toast | null;
  readonly saveWarning: string | null;
  /** Survey-screen state. */
  readonly paused: boolean;
  readonly speed: number;
  readonly overlay: OverlayId;
  readonly rightPanel: RightPanel;
  readonly selectedInstrument: InstrumentId | null;
  readonly selectedSpecies: SpeciesId | null;
  readonly cursor: { readonly x: number; readonly y: number };
  readonly selectedAgentId: number | null;
  readonly logFilter: SpeciesId | 'all';
  readonly barrierStart: { readonly x: number; readonly y: number } | null;
  readonly pendingDestructive: InstrumentId | null;
  /** Set when the renderer could not acquire a 2D context. */
  readonly renderWarning: string | null;
}

export const SPEEDS: readonly number[] = Object.freeze([0, 1, 2, 4, 8]);

export function createInitialState(overrides: Partial<AppState> = {}): AppState {
  return {
    screen: 'title',
    previousScreen: 'title',
    settings: {
      palette: 'aurora',
      contrast: 'normal',
      reducedMotion: false,
      uiScale: 1,
      volume: 0.6,
      muted: false,
      confirmDestructive: true,
      autoPauseOnBlur: true,
    },
    unlockedSectors: [],
    ranks: {},
    lastReportFor: null,
    toast: null,
    saveWarning: null,
    paused: true,
    speed: 1,
    overlay: 'temperature',
    rightPanel: 'inspector',
    selectedInstrument: null,
    selectedSpecies: null,
    cursor: { x: 22, y: 15 },
    selectedAgentId: null,
    logFilter: 'all',
    barrierStart: null,
    pendingDestructive: null,
    renderWarning: null,
    ...overrides,
  };
}

/** Formats a tick count as the survey clock the player sees. */
export function formatClock(tick: number, total: number): string {
  const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
  const fraction = total <= 0 ? 0 : clamp01(tick / total);
  const days = Math.floor(fraction * 30);
  const hours = Math.floor((fraction * 30 - days) * 24);
  return `survey day ${days + 1}/30 · ${String(hours).padStart(2, '0')}h · tick ${tick}/${total}`;
}
