import type { FieldId } from '../core/field.ts';
import { FIELD_IDS, FIELD_SPECS } from '../core/field.ts';
import { clamp } from '../core/math.ts';
import type { SectorConfig } from '../core/sim/sector.ts';
import type { SpeciesTraits } from '../core/sim/species.ts';
import type { World } from '../core/sim/world.ts';
import { applyContrast, paletteById, type ContrastMode, type Palette, type PaletteId } from './palettes.ts';
import { css } from './palettes.ts';

/**
 * Canvas renderer.
 *
 * A pure function of the snapshot it is handed (ARCHITECTURE.md §2): it owns no game logic, mutates
 * no simulation state, and degrades to a descriptive status instead of throwing when there is no 2D
 * context (jsdom, or a browser refusing the context).
 *
 * Layers, painted in order: background → field overlay → biomass mats → barriers → organisms →
 * instrument footprint → probes → cursor → status.
 */

export type OverlayId = FieldId | 'biomass' | 'census' | 'none';

export interface RenderTarget {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly label: string;
}

export interface RenderState {
  readonly overlay: OverlayId;
  readonly palette: PaletteId;
  readonly contrast: ContrastMode;
  readonly reducedMotion: boolean;
  /** Cursor in world cells. */
  readonly cursor: { readonly x: number; readonly y: number };
  /** Instrument footprint preview, if any. */
  readonly target: RenderTarget | null;
  /** Highlighted organism id (from the inspector). */
  readonly selectedAgentId: number | null;
  /** Show species codes next to organisms when zoomed in. */
  readonly labels: boolean;
}

export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

export interface RendererStatus {
  readonly ok: boolean;
  readonly message: string;
}

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 4;
/** Above this many living organisms, only bioluminescent species are labelled (see paintOrganisms). */
const LABEL_CROWD_LIMIT = 300;

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly scratch: HTMLCanvasElement | null;
  private scratchContext: CanvasRenderingContext2D | null = null;
  private status: RendererStatus = { ok: true, message: 'ready' };
  private cssWidth = 0;
  private cssHeight = 0;
  private readonly viewport: Viewport = { zoom: 1, panX: 0, panY: 0 };
  /** Last measured frame cost, used for adaptive quality (documented, surfaced in Settings). */
  lastFrameMs = 0;
  quality: 'full' | 'reduced' = 'full';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.scratch = typeof document === 'undefined' ? null : document.createElement('canvas');
    if (!this.context) {
      this.status = {
        ok: false,
        message: 'Canvas 2D is unavailable, so the map cannot be drawn. Every reading is also shown as text in the panels.',
      };
    }
  }

  getStatus(): RendererStatus {
    return this.status;
  }

  getViewport(): Viewport {
    return this.viewport;
  }

  /** Resizes the backing store to the CSS box at the current device pixel ratio. */
  resize(config: SectorConfig): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = clamp(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 1, 2.5);
    this.cssWidth = Math.max(1, Math.round(rect.width));
    this.cssHeight = Math.max(1, Math.round(rect.height));
    const width = Math.round(this.cssWidth * dpr);
    const height = Math.round(this.cssHeight * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (this.scratch) {
      this.scratch.width = config.width;
      this.scratch.height = config.height;
      this.scratchContext = this.scratch.getContext('2d');
    }
    this.clampPan(config);
  }

  private clampPan(config: SectorConfig): void {
    const { cellSize } = this.metrics(config);
    const worldWidth = config.width * cellSize;
    const worldHeight = config.height * cellSize;
    const slackX = Math.max(0, (this.cssWidth - worldWidth) / 2);
    const slackY = Math.max(0, (this.cssHeight - worldHeight) / 2);
    this.viewport.panX = clamp(this.viewport.panX, -slackX, slackX);
    this.viewport.panY = clamp(this.viewport.panY, -slackY, slackY);
  }

  /** Cell size in CSS pixels for the current zoom, plus the top-left corner of the grid. */
  metrics(config: SectorConfig): {
    cellSize: number;
    originX: number;
    originY: number;
  } {
    const fit = Math.min(this.cssWidth / config.width, this.cssHeight / config.height);
    const cellSize = Math.max(2, fit * this.viewport.zoom);
    const originX = (this.cssWidth - config.width * cellSize) / 2 + this.viewport.panX;
    const originY = (this.cssHeight - config.height * cellSize) / 2 + this.viewport.panY;
    return { cellSize, originX, originY };
  }

  /** Canvas CSS coordinates → world cell coordinates. */
  toWorld(config: SectorConfig, clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const { cellSize, originX, originY } = this.metrics(config);
    return {
      x: (clientX - rect.left - originX) / cellSize,
      y: (clientY - rect.top - originY) / cellSize,
    };
  }

  /** World cell coordinates → canvas CSS coordinates. */
  fromWorld(config: SectorConfig, x: number, y: number): { x: number; y: number } {
    const { cellSize, originX, originY } = this.metrics(config);
    return { x: originX + x * cellSize, y: originY + y * cellSize };
  }

  zoomBy(config: SectorConfig, factor: number, anchor?: { x: number; y: number }): void {
    const before = this.viewport.zoom;
    const next = clamp(before * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === before) return;
    if (anchor) {
      const { cellSize, originX, originY } = this.metrics(config);
      const worldX = (anchor.x - originX) / cellSize;
      const worldY = (anchor.y - originY) / cellSize;
      this.viewport.zoom = next;
      const after = this.metrics(config);
      this.viewport.panX += anchor.x - (after.originX + worldX * after.cellSize);
      this.viewport.panY += anchor.y - (after.originY + worldY * after.cellSize);
    } else {
      this.viewport.zoom = next;
    }
    this.clampPan(config);
  }

  panBy(config: SectorConfig, dx: number, dy: number): void {
    this.viewport.panX += dx;
    this.viewport.panY += dy;
    this.clampPan(config);
  }

  resetView(): void {
    this.viewport.zoom = 1;
    this.viewport.panX = 0;
    this.viewport.panY = 0;
  }

  private paletteFor(state: RenderState): Palette {
    return applyContrast(paletteById(state.palette), state.contrast);
  }

  draw(world: World, state: RenderState): void {
    const context = this.context;
    if (!context) return;
    const startedAt = typeof performance === 'undefined' ? 0 : performance.now();
    const config = world.config;
    const palette = this.paletteFor(state);
    const dpr = this.canvas.width / Math.max(1, this.cssWidth);
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    context.fillStyle = css(palette.background);
    context.fillRect(0, 0, this.cssWidth, this.cssHeight);

    const { cellSize, originX, originY } = this.metrics(config);

    if (state.overlay !== 'none') {
      this.paintFieldOverlay(context, world, state.overlay, palette, originX, originY, cellSize);
    } else {
      this.paintGrid(context, config, palette, originX, originY, cellSize);
    }

    this.paintBiomass(context, world, state, palette, originX, originY, cellSize);
    this.paintBarriers(context, world, palette, originX, originY, cellSize);

    const traitsOf = (species: string): SpeciesTraits | undefined => world.traits.get(species);
    this.paintOrganisms(context, world, state, originX, originY, cellSize, traitsOf);
    this.paintProbes(context, world, palette, originX, originY, cellSize);
    this.paintTarget(context, state, originX, originY, cellSize);
    this.paintCursor(context, state, originX, originY, cellSize, palette);

    if (!this.status.ok) {
      context.fillStyle = 'rgba(10,10,14,0.75)';
      context.fillRect(0, 0, this.cssWidth, 28);
      context.fillStyle = '#f4f4f8';
      context.font = '13px system-ui, sans-serif';
      context.fillText(this.status.message, 12, 18);
    }
    context.restore();

    if (startedAt > 0) {
      const elapsed = performance.now() - startedAt;
      this.lastFrameMs = elapsed;
      // Adaptive quality: a long frame drops organism labels and mat shading before it ever drops
      // the simulation tick rate (docs/DESIGN.md §8).
      this.quality = elapsed > 12 ? 'reduced' : 'full';
    }
  }

  private paintFieldOverlay(
    context: CanvasRenderingContext2D,
    world: World,
    overlay: OverlayId,
    palette: Palette,
    originX: number,
    originY: number,
    cellSize: number,
  ): void {
    const config = world.config;
    const isField = overlay !== 'biomass' && overlay !== 'census' && overlay !== 'none';
    const field: FieldId | null = isField ? overlay : null;
    if (!field) {
      this.paintGrid(context, config, palette, originX, originY, cellSize);
      return;
    }
    const source = world.fields[field];
    if (!this.scratch || !this.scratchContext) {
      this.paintGrid(context, config, palette, originX, originY, cellSize);
      return;
    }
    const stats = source.stats();
    const span = Math.max(1e-6, stats.max - stats.min);
    const ramp = palette.fields[field];
    const image = this.scratchContext.createImageData(config.width, config.height);
    // The per-cell colouring lives in `ScalarField.paint`, which is unit-tested; the renderer only
    // supplies the normalisation and the palette ramp.
    source.paint(image.data, 1, 1, (value) => ramp(clamp((value - stats.min) / span, 0, 1)));
    this.scratchContext.putImageData(image, 0, 0);
    context.imageSmoothingEnabled = this.quality === 'full';
    context.drawImage(
      this.scratch,
      0,
      0,
      config.width,
      config.height,
      originX,
      originY,
      config.width * cellSize,
      config.height * cellSize,
    );
    context.imageSmoothingEnabled = true;
    this.paintGrid(context, config, palette, originX, originY, cellSize);
  }

  private paintGrid(
    context: CanvasRenderingContext2D,
    config: SectorConfig,
    palette: Palette,
    originX: number,
    originY: number,
    cellSize: number,
  ): void {
    if (this.quality === 'reduced') return;
    context.save();
    context.strokeStyle = `rgba(${palette.grid[0]}, ${palette.grid[1]}, ${palette.grid[2]}, 0.35)`;
    context.lineWidth = 1;
    const step = Math.max(1, Math.round(4 / Math.max(0.001, cellSize)) * 4);
    context.beginPath();
    for (let x = 0; x <= config.width; x += step) {
      const px = Math.round(originX + x * cellSize) + 0.5;
      context.moveTo(px, originY);
      context.lineTo(px, originY + config.height * cellSize);
    }
    for (let y = 0; y <= config.height; y += step) {
      const py = Math.round(originY + y * cellSize) + 0.5;
      context.moveTo(originX, py);
      context.lineTo(originX + config.width * cellSize, py);
    }
    context.stroke();
    context.strokeStyle = `rgba(${palette.text[0]}, ${palette.text[1]}, ${palette.text[2]}, 0.5)`;
    context.strokeRect(originX + 0.5, originY + 0.5, config.width * cellSize, config.height * cellSize);
    context.restore();
  }

  private paintBiomass(
    context: CanvasRenderingContext2D,
    world: World,
    state: RenderState,
    palette: Palette,
    originX: number,
    originY: number,
    cellSize: number,
  ): void {
    const wide = state.overlay === 'biomass';
    for (const species of world.config.roster) {
      const field = world.biomassFields.get(species);
      if (!field) continue;
      const traits = world.traits.get(species);
      if (!traits) continue;
      const tint = hexToRgb(traits.color);
      for (let y = 0; y < world.config.height; y++) {
        for (let x = 0; x < world.config.width; x++) {
          const value = field.getAt(x, y);
          if (value <= 0.01) continue;
          // Mats are painted at low opacity by default so the field overlay stays readable; the
          // dedicated biomass overlay is deliberately stronger.
          const alpha = clamp(value / 4, 0, 1) * (wide ? 0.85 : this.quality === 'full' ? 0.4 : 0.24);
          context.fillStyle = `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, ${alpha})`;
          context.fillRect(
            originX + x * cellSize,
            originY + y * cellSize,
            cellSize + 0.5,
            cellSize + 0.5,
          );
        }
      }
    }
    void palette;
  }

  private paintBarriers(
    context: CanvasRenderingContext2D,
    world: World,
    palette: Palette,
    originX: number,
    originY: number,
    cellSize: number,
  ): void {
    context.save();
    context.strokeStyle = css(palette.text);
    context.lineWidth = Math.max(2, cellSize * 0.16);
    for (const barrier of world.barriers) {
      context.beginPath();
      context.moveTo(originX + barrier.x1 * cellSize, originY + barrier.y1 * cellSize);
      context.lineTo(originX + barrier.x2 * cellSize, originY + barrier.y2 * cellSize);
      context.stroke();
    }
    context.restore();
  }

  private paintOrganisms(
    context: CanvasRenderingContext2D,
    world: World,
    state: RenderState,
    originX: number,
    originY: number,
    cellSize: number,
    traitsOf: (species: string) => SpeciesTraits | undefined,
  ): void {
    // Labels must never be a switch that does nothing: they are drawn for every organism while the
    // population is manageable, and only for the bioluminescent species above that, so a crowded
    // sector stays readable. Quality gating (measured frame cost) also removes them on slow machines.
    const crowded = world.agents.length > LABEL_CROWD_LIMIT;
    const showLabels = state.labels && this.quality === 'full' && cellSize >= 7;
    for (const agent of world.agents) {
      if (!agent.alive) continue;
      const traits = traitsOf(agent.species);
      if (!traits) continue;
      const px = originX + agent.x * cellSize;
      const py = originY + agent.y * cellSize;
      const size = Math.max(1.6, cellSize * 0.34 * Math.max(0.5, traits.size / 1.8));
      context.fillStyle = traits.color;
      context.globalAlpha = state.selectedAgentId === agent.id ? 1 : 0.92;
      context.beginPath();
      context.arc(px, py, size, 0, Math.PI * 2);
      context.fill();
      if (state.selectedAgentId === agent.id) {
        context.globalAlpha = 1;
        context.strokeStyle = '#ffffff';
        context.lineWidth = 2;
        context.beginPath();
        context.arc(px, py, size + 3, 0, Math.PI * 2);
        context.stroke();
      }
      if (showLabels && (!crowded || traits.glow > 0.3)) {
        context.globalAlpha = 0.75;
        context.fillStyle = '#0b0f14';
        context.font = `${Math.round(cellSize * 0.5)}px system-ui, sans-serif`;
        context.fillText(traits.code, px + size + 2, py - size);
      }
    }
    context.globalAlpha = 1;
  }

  private paintProbes(
    context: CanvasRenderingContext2D,
    world: World,
    palette: Palette,
    originX: number,
    originY: number,
    cellSize: number,
  ): void {
    context.save();
    for (const probe of world.probes) {
      const px = originX + probe.x * cellSize;
      const py = originY + probe.y * cellSize;
      context.strokeStyle = `rgba(${palette.text[0]}, ${palette.text[1]}, ${palette.text[2]}, 0.55)`;
      context.setLineDash([4, 4]);
      context.lineWidth = 1;
      context.beginPath();
      context.arc(px, py, probe.radius * cellSize, 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = css(palette.text);
      context.fillRect(px - 2, py - 2, 4, 4);
    }
    context.restore();
  }

  private paintTarget(
    context: CanvasRenderingContext2D,
    state: RenderState,
    originX: number,
    originY: number,
    cellSize: number,
  ): void {
    const target = state.target;
    if (!target) return;
    context.save();
    context.strokeStyle = '#ffd166';
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.beginPath();
    context.arc(
      originX + target.x * cellSize,
      originY + target.y * cellSize,
      target.radius * cellSize,
      0,
      Math.PI * 2,
    );
    context.stroke();
    context.restore();
  }

  private paintCursor(
    context: CanvasRenderingContext2D,
    state: RenderState,
    originX: number,
    originY: number,
    cellSize: number,
    palette: Palette,
  ): void {
    const px = originX + state.cursor.x * cellSize;
    const py = originY + state.cursor.y * cellSize;
    context.save();
    context.strokeStyle = css(palette.text);
    context.lineWidth = 1.5;
    context.strokeRect(px - cellSize / 2, py - cellSize / 2, cellSize, cellSize);
    context.restore();
  }

  /** Human-readable description of the current position for the screen-reader summary. */
  describeCursor(world: World, cursor: { x: number; y: number }): string {
    const readings = world.readingsAt(clamp(cursor.x, 0, world.config.width), clamp(cursor.y, 0, world.config.height));
    const parts = FIELD_IDS.map((field) => {
      const spec = FIELD_SPECS[field];
      return `${spec.label} ${readings[field].toFixed(spec.decimals)} ${spec.unit}`;
    });
    const census = world.censusAround(cursor.x, cursor.y, 4);
    const present = Object.entries(census)
      .filter(([, count]) => count > 0)
      .map(([species, count]) => `${species} ×${count}`)
      .join(', ');
    return `Cursor at ${cursor.x.toFixed(1)}, ${cursor.y.toFixed(1)}. ${parts.join('. ')}. Nearby: ${present || 'no organisms'}.`;
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const normalised = hex.replace('#', '');
  const full =
    normalised.length === 3
      ? normalised
          .split('')
          .map((character) => character + character)
          .join('')
      : normalised;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return [255, 255, 255];
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
