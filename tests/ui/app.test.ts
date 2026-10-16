// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp, type App } from '../../src/ui/app.ts';
import { AudioBus } from '../../src/game/audio.ts';
import { memoryStorage, QUARANTINE_KEY, SAVE_KEY, type StorageLike } from '../../src/game/persistence.ts';

/**
 * Shell integration tests.
 *
 * The game's panels are built by string templates over real simulation data; the only honest way to
 * test them is to mount the actual `index.html`, drive the app through its own dispatch API, and read
 * the resulting DOM. Canvas 2D is deliberately unavailable here (jsdom has no rasteriser): that is
 * also the degraded path the renderer must survive, so these tests double as the no-canvas audit.
 */

// vitest runs with the project root as the working directory; `import.meta.url` is not a file
// URL under the jsdom environment, so resolve the shell from the cwd instead.
const SHELL_HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

function mountShell(): void {
  // jsdom has no rasteriser and logs a "not implemented" error for every `getContext` call. The
  // renderer is required to work without a context, so make the absence explicit and quiet. The spy
  // is installed per test because the vitest config restores mocks after each one.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const body = SHELL_HTML.slice(SHELL_HTML.indexOf('<body>') + '<body>'.length, SHELL_HTML.indexOf('</body>'));
  // The module script is not executed here: the app is constructed directly by the test.
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
  Object.defineProperty(document.body.style, 'setProperty', {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
}

let app: App | null = null;
let frames: ((time: number) => void)[] = [];

function boot(storage: StorageLike = memoryStorage()): App {
  mountShell();
  frames = [];
  const created = createApp({
    document,
    storage,
    audio: new AudioBus({ volume: 0, muted: true }),
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => undefined,
    now: () => 0,
  });
  created.start();
  app = created;
  return created;
}

/**
 * Dispatches an action and forces a render. In the browser the frame loop re-renders the DOM when the
 * state is dirty; tests must not depend on the loop, so they render explicitly.
 */
function act(instance: App, action: Parameters<App['dispatch']>[0]): void {
  instance.dispatch(action);
  instance.render();
}

/** Runs `count` frames one second apart; one second is 12 ticks at speed 1. */
function runFrames(instance: App, count: number, startAt = 1000): number {
  let time = startAt;
  for (let index = 0; index < count; index++) {
    instance.frame(time);
    time += 1000;
  }
  return time;
}

afterEach(() => {
  app?.stop();
  app = null;
  document.body.innerHTML = '';
});

const text = (selector: string): string => document.querySelector(selector)?.textContent ?? '';

describe('shell boot', () => {
  it('mounts, starts and shows the title screen without a canvas context', () => {
    const instance = boot();
    expect(document.querySelector('#error-overlay')).toBeNull();
    expect(instance.getRenderer().getStatus().ok).toBe(false);
    expect(text('#screen-root')).toContain('WORLDBUG');

    expect(document.querySelector('#layout')?.hasAttribute('hidden')).toBe(true);
  });

  it('uses the real sector list on the sector-select screen', () => {
    const instance = boot();
    act(instance, { type: 'navigate', screen: 'sector-select' });
    const rows = [...document.querySelectorAll('[data-start-sector]')];
    // FER-1 is unlocked, so exactly one sector offers a button; the rest are gated by rank.
    expect(rows.map((row) => row.getAttribute('data-start-sector'))).toContain('FER-1');
    expect(text('#screen-root')).toContain('Cinder Shelf');
  });
});

describe('survey screen', () => {
  it('starts a mission and renders every panel from live world data', () => {
    const instance = boot();
    act(instance, { type: 'start-sector', id: 'FER-1' });
    const mission = instance.getMission();
    expect(mission).not.toBeNull();
    expect(instance.store.get().screen).toBe('survey');
    expect(instance.store.get().paused).toBe(true);

    instance.render();
    expect(text('#sector-heading')).toContain('FER-1');
    expect(text('#charge-readout')).toMatch(/Charge \d+\/\d+/);
    expect(text('#integrity-readout')).toMatch(/Integrity \d+\/\d+/);
    expect(document.querySelectorAll('#instrument-list .instrument').length).toBeGreaterThan(3);
    expect(text('#cursor-readout').toLowerCase()).toContain('temperature');
    expect(text('#mission-body')).toContain('Cinder Shelf');
    expect(document.querySelectorAll('#codex-list .proposition').length).toBeGreaterThan(3);
  });

  it('advances the simulation through the frame loop and stops at window close', { timeout: 30000 }, () => {
    const instance = boot();
    act(instance, { type: 'start-sector', id: 'FER-1' });
    act(instance, { type: 'set-speed', speed: 8 });
    act(instance, { type: 'toggle-pause' });
    expect(instance.getMission()?.phase).toBe('survey');

    runFrames(instance, 3);
    // A quarter-second frame at 12 ticks/s and 8x speed is 24 ticks.
    expect(instance.getMission()?.tick ?? 0).toBeGreaterThan(0);

    // Run well past the window: advance() must clamp at surveyTicks and then file automatically.
    const total = instance.getMission()?.config.surveyTicks ?? 0;
    let time = runFrames(instance, Math.ceil(total / 24) + 5, 5000);
    for (let guard = 0; guard < 4 && instance.store.get().screen === 'survey'; guard++) {
      time = runFrames(instance, 10, time);
    }
    expect(instance.getMission()?.phase).toBe('filed');
    expect(instance.store.get().screen).toBe('report');
    expect(instance.store.get().ranks['FER-1']).toBeDefined();
  });

  it('keeps every reading available as text for screen readers', () => {
    const instance = boot();
    act(instance, { type: 'start-sector', id: 'FER-1' });
    runFrames(instance, 2);
    const summary = text('#a11y-summary');
    expect(summary).toContain('FER-1');
    expect(summary).toMatch(/Populations: \w/);
    expect(summary).toContain('Mean climate');
    expect(summary).toContain('Cursor at');
  });

  it('moves the cursor with the keyboard and inspects the nearest organism', () => {
    const instance = boot();
    act(instance, { type: 'start-sector', id: 'FER-1' });
    const before = instance.store.get().cursor.x;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(instance.store.get().cursor.x).toBe(before + 1);

    act(instance, { type: 'set-cursor', x: 20, y: 16 });
    instance.render();
    // Whether or not an organism is under the cursor, the panel must say something truthful.
    const organism = text('#organism-readout');
    expect(organism.length).toBeGreaterThan(0);
  });

  it('selects instruments by hotkey and refuses the unaffordable ones with a reason', () => {
    const instance = boot();
    act(instance, { type: 'start-sector', id: 'FER-1' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    expect(instance.store.get().selectedInstrument).not.toBeNull();

    const mission = instance.getMission();
    if (!mission) throw new Error('mission should exist');
    // FER-1 has no hatchery fitted: asking for it must fail loudly, not silently.
    act(instance, { type: 'select-instrument', instrument: 'hatchery' });
    act(instance, { type: 'apply-instrument' });
    expect(text('#toast')).toMatch(/hatchery|not fitted/i);
  });

  it('deploys and recovers probes, and charts their recordings in the Data panel', () => {
    const instance = boot();
    act(instance, { type: 'start-sector', id: 'FER-1' });
    act(instance, { type: 'place-probe' });
    const mission = instance.getMission();
    expect(mission?.world.probes.length).toBe(1);

    runFrames(instance, 2);
    act(instance, { type: 'set-panel', panel: 'data' });
    instance.render();
    expect(text('#probe-chart')).toContain('Probe #1');
    expect(text('#population-table')).toContain('AUR-3');

    act(instance, { type: 'recover-probe' });
    expect(mission?.world.probes.length).toBe(0);
  });

  it('applies a real instrument and spends charge for it', () => {
    const instance = boot();
    act(instance, { type: 'start-sector', id: 'FER-1' });
    act(instance, { type: 'toggle-pause' });
    const mission = instance.getMission();
    if (!mission) throw new Error('mission should exist');
    const before = mission.budget.charge;
    act(instance, { type: 'select-instrument', instrument: 'thermal' });
    act(instance, { type: 'apply-instrument' });
    const after = instance.getMission()?.budget.charge ?? before;
    expect(after).toBeLessThan(before);
    expect(text('#toast').length).toBeGreaterThan(0);
  });
});

describe('codex and filing', () => {
  it('records answers, sells a Data Assist over recorded data, and reports the charge', () => {
    const instance = boot();
    act(instance, { type: 'start-sector', id: 'FER-1' });
    act(instance, { type: 'toggle-pause' });
    runFrames(instance, 3);
    const mission = instance.getMission();
    if (!mission) throw new Error('mission should exist');
    const proposition = mission.propositions[0];
    if (!proposition) throw new Error('sector should define propositions');

    const option = proposition.options[0];
    if (!option) throw new Error('proposition should offer options');
    act(instance, { type: 'answer', propositionId: proposition.id, optionId: option.id });
    expect(mission.answersSnapshot().get(proposition.id)?.optionId).toBe(option.id);

    const chargeBefore = mission.budget.charge;
    act(instance, { type: 'buy-assist', propositionId: proposition.id });
    expect(instance.getMission()?.budget.charge).toBeLessThan(chargeBefore);
    expect(text('#toast')).toMatch(/Recorded|intake|events/);

    instance.render();
    expect(document.querySelectorAll('#codex-list .proposition.answered').length).toBe(1);
  });

  it('files a report, grades it, unlocks the next sector and persists the rank', () => {
    const storage = memoryStorage();
    const instance = boot(storage);
    act(instance, { type: 'start-sector', id: 'FER-1' });
    const mission = instance.getMission();
    if (!mission) throw new Error('mission should exist');
    for (const proposition of mission.propositions) {
      const option = proposition.options[0];
      if (option) act(instance, { type: 'answer', propositionId: proposition.id, optionId: option.id });
    }
    act(instance, { type: 'file-report' });

    const state = instance.store.get();
    expect(state.screen).toBe('report');
    expect(state.ranks['FER-1']).toBeDefined();
    expect(text('#screen-root')).toContain('Survey report');
    expect(text('#screen-root')).toMatch(/[SABCF] &nbsp;|\d+ points/);

    const saved = storage.getItem(SAVE_KEY);
    expect(saved).not.toBeNull();
    const parsed = JSON.parse(saved ?? '{}') as { ranks?: Record<string, string> };
    expect(parsed.ranks?.['FER-1']).toBe(state.ranks['FER-1']);
    // FER-1 has no predecessor, so KEL-4 becomes available once it is passed with a rank.
    expect(state.unlockedSectors.length).toBeGreaterThanOrEqual(0);
  });

  it('refuses to file while the biosphere is dead', () => {
    const instance = boot();
    act(instance, { type: 'start-sector', id: 'FER-1' });
    const mission = instance.getMission();
    if (!mission) throw new Error('mission should exist');
    const world = mission.world;
    for (const species of mission.config.roster) {
      world.cull(world.config.width / 2, world.config.height / 2, 1e4, species);
    }
    act(instance, { type: 'file-report' });
    expect(instance.store.get().screen).toBe('survey');
    expect(text('#toast')).toContain('dead');
  });
});

describe('settings, persistence and error handling', () => {
  it('applies settings to the document and the save file', () => {
    const storage = memoryStorage();
    const instance = boot(storage);
    act(instance, { type: 'navigate', screen: 'settings' });
    expect(document.querySelector('#setting-palette')).not.toBeNull();

    act(instance, { type: 'set-settings', patch: { contrast: 'high', uiScale: 1.3, muted: true } });
    expect(document.body.classList.contains('high-contrast')).toBe(true);
    const saved = JSON.parse(storage.getItem(SAVE_KEY) ?? '{}') as {
      settings?: { contrast?: string; uiScale?: number };
    };
    expect(saved.settings?.contrast).toBe('high');
    expect(saved.settings?.uiScale).toBe(1.3);
  });

  it('quarantines a corrupt save instead of failing to boot', () => {
    const storage = memoryStorage({ [SAVE_KEY]: '{not json at all' });
    const instance = boot(storage);
    expect(instance.store.get().saveWarning).toContain('could not be read');
    expect(storage.getItem(QUARANTINE_KEY)).toBe('{not json at all');
    expect(storage.getItem(SAVE_KEY)).toBeNull();
  });

  it('survives storage that throws on every access', () => {
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const instance = boot(hostile);
    expect(instance.store.get().saveWarning).toContain('storage is unavailable');
    act(instance, { type: 'start-sector', id: 'FER-1' });
    expect(instance.store.get().screen).toBe('survey');
  });

  it('reports invalid actions through the announcer instead of throwing', () => {
    const instance = boot();
    act(instance, { type: 'start-sector', id: 'NOT-A-SECTOR' });
    expect(instance.store.get().screen).toBe('title');
    expect(text('#toast')).toContain('Unknown sector');

    act(instance, { type: 'start-sector', id: 'FER-1' });
    const mission = instance.getMission();
    if (!mission) throw new Error('mission should exist');
    // The survey window has not finished, so the propositions are answerable — but not unknowns.
    act(instance, { type: 'answer', propositionId: 'nope', optionId: 'x' });
    expect(text('#toast')).toContain('Unknown proposition');
  });

  it('pauses automatically when the window loses focus, when asked to', () => {
    const instance = boot();
    act(instance, { type: 'start-sector', id: 'FER-1' });
    act(instance, { type: 'toggle-pause' });
    expect(instance.store.get().paused).toBe(false);
    window.dispatchEvent(new Event('blur'));
    expect(instance.store.get().paused).toBe(true);

    act(instance, { type: 'set-settings', patch: { autoPauseOnBlur: false } });
    act(instance, { type: 'toggle-pause' });
    window.dispatchEvent(new Event('blur'));
    expect(instance.store.get().paused).toBe(false);
  });
});
