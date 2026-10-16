// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { FIELD_IDS, FIELD_SPECS } from '../../src/core/field.ts';
import { World } from '../../src/core/sim/world.ts';
import { SECTOR_CINDER_SHELF } from '../../src/content/sectors.ts';
import { SPECIES_LIST } from '../../src/content/species.ts';
import { Renderer, type RenderState } from '../../src/render/renderer.ts';
import type { PaletteId } from '../../src/render/palettes.ts';

/**
 * Renderer tests.
 *
 * jsdom has no rasteriser, so the renderer is driven against a *recording* 2D context: every call it
 * makes is captured. That is enough to prove the draw path never throws, that it actually paints for
 * each overlay mode, that a missing context degrades instead of crashing, and that the coordinate
 * transforms round-trip — none of which can be checked by a screenshot.
 */

class RecordingContext {
  readonly calls: string[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  font = '';
  globalAlpha = 1;
  imageSmoothingEnabled = true;

  private record(name: string): void {
    this.calls.push(name);
  }

  count(name: string): number {
    return this.calls.filter((call) => call === name).length;
  }

  save(): void {
    this.record('save');
  }
  restore(): void {
    this.record('restore');
  }
  setTransform(): void {
    this.record('setTransform');
  }
  clearRect(): void {
    this.record('clearRect');
  }
  fillRect(): void {
    this.record('fillRect');
  }
  strokeRect(): void {
    this.record('strokeRect');
  }
  beginPath(): void {
    this.record('beginPath');
  }
  arc(): void {
    this.record('arc');
  }
  fill(): void {
    this.record('fill');
  }
  stroke(): void {
    this.record('stroke');
  }
  moveTo(): void {
    this.record('moveTo');
  }
  lineTo(): void {
    this.record('lineTo');
  }
  fillText(): void {
    this.record('fillText');
  }
  setLineDash(): void {
    this.record('setLineDash');
  }
  drawImage(): void {
    this.record('drawImage');
  }
  createImageData(width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
    this.record('createImageData');
    return { data: new Uint8ClampedArray(width * height * 4), width, height };
  }
  putImageData(): void {
    this.record('putImageData');
  }
}

interface Harness {
  readonly renderer: Renderer;
  readonly context: RecordingContext;
  readonly canvas: HTMLCanvasElement;
}

function makeHarness(withContext = true, width = 800, height = 600): Harness {
  const canvas = document.createElement('canvas');
  const context = new RecordingContext();
  vi.spyOn(canvas, 'getContext').mockImplementation(() =>
    withContext ? (context as unknown as CanvasRenderingContext2D) : null,
  );
  canvas.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect;
  // The scratch canvas the renderer creates internally must also return a 2D context.
  const originalCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const element = originalCreate(tag);
    if (tag === 'canvas') {
      vi.spyOn(element as HTMLCanvasElement, 'getContext').mockImplementation(
        () => context as unknown as CanvasRenderingContext2D,
      );
    }
    return element;
  });
  return { renderer: new Renderer(canvas), context, canvas };
}

const FER = SECTOR_CINDER_SHELF;

function makeWorld(seed = FER.seed): World {
  return new World({ config: FER, species: SPECIES_LIST, seed });
}

function state(overrides: Partial<RenderState> = {}): RenderState {
  return {
    overlay: 'temperature',
    palette: 'aurora' satisfies PaletteId,
    contrast: 'normal',
    reducedMotion: false,
    cursor: { x: 22, y: 15 },
    target: null,
    selectedAgentId: null,
    labels: true,
    ...overrides,
  };
}

describe('renderer without a context', () => {
  it('reports the degradation instead of throwing, and every other call stays safe', () => {
    const { renderer } = makeHarness(false);
    const world = makeWorld();
    expect(renderer.getStatus().ok).toBe(false);
    expect(renderer.getStatus().message).toMatch(/2D/);

    renderer.resize(FER);
    renderer.draw(world, state());
    renderer.zoomBy(FER, 1.4);
    renderer.panBy(FER, 30, -30);
    renderer.resetView();
    // The text fallback still describes the cursor, which is what the panels show instead.
    expect(renderer.describeCursor(world, { x: 10, y: 10 }).toLowerCase()).toContain('temperature');
  });
});

describe('renderer painting', () => {
  it('paints the field overlays and the biomass/census modes', () => {
    const { renderer, context } = makeHarness();
    const world = makeWorld();
    renderer.resize(FER);

    for (const overlay of FIELD_IDS) {
      context.calls.length = 0;
      renderer.draw(world, state({ overlay }));
      expect(context.count('putImageData'), `overlay ${overlay} should paint a field`).toBeGreaterThan(0);
      expect(context.count('fillRect')).toBeGreaterThan(0);
      expect(context.count('save')).toBe(context.count('restore'));
    }

    context.calls.length = 0;
    renderer.draw(world, state({ overlay: 'biomass' }));
    expect(context.count('fillRect')).toBeGreaterThan(0);
    expect(context.count('putImageData')).toBe(0);
    expect(context.count('save')).toBe(context.count('restore'));
  });

  it('does not alter seeded gameplay, even when drawing every turn', () => {
    const { renderer } = makeHarness();
    const rendered = makeWorld(0x2345);
    const headless = makeWorld(0x2345);
    renderer.resize(FER);

    for (let tick = 0; tick < 24; tick++) {
      rendered.step();
      renderer.draw(rendered, state({ overlay: FIELD_IDS[tick % FIELD_IDS.length] ?? 'temperature' }));
      headless.step();
    }
    const canonical = (world: World) => ({
      tick: world.tick,
      counts: world.counts(),
      biomass: world.biomassReport(),
      agents: [...world.agents]
        .sort((a, b) => a.id - b.id)
        .map(({ id, species, x, y, dx, dy, energy, age, generation, stress, cooldown }) =>
          ({ id, species, x, y, dx, dy, energy, age, generation, stress, cooldown })),
      fields: Object.fromEntries(FIELD_IDS.map((id) => [id, Array.from(world.fields[id].data)])),
      resources: {
        water: Array.from(world.resources.water.data),
        nutrients: Array.from(world.resources.nutrients.data),
      },
      events: world.events.toArray(),
    });
    expect(canonical(rendered)).toEqual(canonical(headless));
  });

  it('draws organisms, labels, the cursor and the instrument target', () => {
    const { renderer, context } = makeHarness();
    const world = makeWorld();
    renderer.resize(FER);
    world.run(60);
    expect(world.count('AUR-3')).toBeGreaterThan(0);

    context.calls.length = 0;
    renderer.draw(world, state({ labels: true, target: { x: 10, y: 10, radius: 7, label: 'thermal' } }));
    expect(context.count('arc')).toBeGreaterThan(0);
    expect(context.count('fillText')).toBeGreaterThan(0);
    expect(context.count('setLineDash')).toBeGreaterThan(0);

    const withLabels = context.count('fillText');
    context.calls.length = 0;
    renderer.draw(world, state({ labels: false }));
    expect(context.count('fillText')).toBeLessThan(withLabels);
  });

  it('draws probes, barriers, a selected organism and the no-overlay grid', () => {
    const { renderer, context } = makeHarness();
    const world = makeWorld();
    renderer.resize(FER);
    world.run(40);
    world.addProbe(12, 12, 5);
    const firstAgent = world.agents[0];
    if (!firstAgent) throw new Error('the world should have organisms after 40 ticks');
    world.addBarrier(4, 4, 20, 4);

    context.calls.length = 0;
    renderer.draw(
      world,
      state({ overlay: 'none', selectedAgentId: firstAgent.id, reducedMotion: true }),
    );
    expect(context.count('strokeRect')).toBeGreaterThan(0);
    expect(context.count('arc')).toBeGreaterThan(0);
    expect(context.count('save')).toBe(context.count('restore'));
  });

  it('survives an empty world and the end of the survey', () => {
    const { renderer, context } = makeHarness();
    const world = makeWorld();
    renderer.resize(FER);
    for (const species of FER.roster) {
      world.cull(FER.width / 2, FER.height / 2, 1e4, species);
    }
    for (const overlay of ['temperature', 'biomass', 'census', 'none'] as const) {
      context.calls.length = 0;
      expect(() => renderer.draw(world, state({ overlay, labels: true }))).not.toThrow();
      expect(context.count('save')).toBe(context.count('restore'));
    }
  });
});

describe('renderer viewport', () => {
  it('round-trips world and screen coordinates', () => {
    const { renderer } = makeHarness();
    renderer.resize(FER);
    const metrics = renderer.metrics(FER);
    const screen = renderer.fromWorld(FER, 10, 8);
    const back = renderer.toWorld(FER, screen.x, screen.y);
    expect(back.x).toBeCloseTo(10, 1);
    expect(back.y).toBeCloseTo(8, 1);
    expect(metrics.cellSize).toBeGreaterThan(0);
  });

  it('zooms about an anchor and clamps panning to the slack around the grid', () => {
    const { renderer } = makeHarness();
    renderer.resize(FER);
    const before = renderer.metrics(FER).cellSize;
    renderer.zoomBy(FER, 2, { x: 400, y: 300 });
    const after = renderer.metrics(FER).cellSize;
    expect(after).toBeGreaterThan(before);

    renderer.panBy(FER, 100000, 100000);
    const viewport = renderer.getViewport();
    expect(Number.isFinite(viewport.panX)).toBe(true);
    expect(Number.isFinite(viewport.panY)).toBe(true);

    // Zoom-out is clamped (MIN_ZOOM) so the grid can never collapse to a dot.
    renderer.zoomBy(FER, 0.0001);
    expect(renderer.getViewport().zoom).toBeGreaterThan(0.4);
    expect(renderer.getViewport().zoom).toBeLessThanOrEqual(1);
    renderer.resetView();
    expect(renderer.getViewport()).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it('describes the cursor with real readings, for the text-only path', () => {
    const { renderer } = makeHarness();
    const world = makeWorld();
    world.run(30);
    const description = renderer.describeCursor(world, { x: 5.5, y: 6.25 }).toLowerCase();
    // describeCursor speaks the player's language: field labels, units and the local census.
    for (const field of FIELD_IDS) expect(description).toContain(FIELD_SPECS[field].label.toLowerCase());
    expect(description).toContain(FIELD_SPECS.temperature.unit.toLowerCase());
    expect(description).toMatch(/\d/);
  });
});
