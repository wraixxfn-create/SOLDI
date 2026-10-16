import type { FieldId } from '../core/field.ts';

/**
 * Colour ramps.
 *
 * Three colour-vision-safe palettes plus a high-contrast variant. A ramp is a pure function from a
 * normalised value (0…1) to an RGB triple, so it can be handed straight to `ScalarField.paint`.
 */

export type Rgb = readonly [number, number, number];
export type Ramp = (value01: number) => Rgb;

export type PaletteId = 'aurora' | 'ember' | 'mono';
export type ContrastMode = 'normal' | 'high';

export interface Palette {
  readonly id: PaletteId;
  readonly name: string;
  /** Field ramps, in "this is what the number means" order. */
  readonly fields: Readonly<Record<FieldId, Ramp>>;
  readonly background: Rgb;
  readonly grid: Rgb;
  readonly text: Rgb;
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Builds a ramp from evenly spaced control colours. */
export function ramp(stops: readonly Rgb[]): Ramp {
  if (stops.length === 0) throw new Error('ramp() needs at least one colour');
  if (stops.length === 1) return () => stops[0] as Rgb;
  return (value01) => {
    const t = value01 <= 0 ? 0 : value01 >= 1 ? 1 : value01;
    const scaled = t * (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(scaled));
    const from = stops[index] as Rgb;
    const to = stops[index + 1] as Rgb;
    return lerpRgb(from, to, scaled - index);
  };
}

const AURORA: Palette = {
  id: 'aurora',
  name: 'Aurora (blue–teal–magenta)',
  fields: {
    temperature: ramp([
      [24, 42, 92],
      [32, 96, 148],
      [58, 168, 168],
      [214, 196, 110],
      [226, 122, 78],
      [188, 60, 92],
    ]),
    humidity: ramp([
      [38, 30, 58],
      [58, 62, 116],
      [70, 124, 152],
      [116, 178, 176],
      [196, 226, 216],
    ]),
    light: ramp([
      [10, 12, 26],
      [30, 44, 84],
      [72, 96, 140],
      [154, 168, 178],
      [236, 236, 224],
    ]),
  },
  background: [9, 12, 20],
  grid: [46, 56, 74],
  text: [226, 232, 240],
};

const EMBER: Palette = {
  id: 'ember',
  name: 'Ember (amber–rust–sand)',
  fields: {
    temperature: ramp([
      [30, 24, 40],
      [92, 40, 52],
      [166, 70, 44],
      [216, 128, 42],
      [244, 196, 96],
      [252, 240, 200],
    ]),
    humidity: ramp([
      [44, 32, 26],
      [96, 72, 44],
      [150, 122, 74],
      [196, 178, 128],
      [234, 226, 198],
    ]),
    light: ramp([
      [26, 22, 28],
      [78, 58, 44],
      [140, 106, 62],
      [198, 166, 96],
      [248, 232, 176],
    ]),
  },
  background: [16, 12, 12],
  grid: [70, 52, 44],
  text: [244, 236, 224],
};

const MONO: Palette = {
  id: 'mono',
  name: 'Monochrome (highest readability)',
  fields: {
    temperature: ramp([
      [18, 18, 22],
      [70, 70, 80],
      [130, 130, 140],
      [190, 190, 198],
      [248, 248, 252],
    ]),
    humidity: ramp([
      [22, 22, 26],
      [78, 78, 88],
      [140, 140, 150],
      [200, 200, 208],
      [250, 250, 254],
    ]),
    light: ramp([
      [12, 12, 16],
      [66, 66, 74],
      [132, 132, 142],
      [196, 196, 204],
      [255, 255, 255],
    ]),
  },
  background: [8, 8, 10],
  grid: [64, 64, 70],
  text: [240, 240, 244],
};

export const PALETTES: readonly Palette[] = Object.freeze([AURORA, EMBER, MONO]);

export function paletteById(id: PaletteId): Palette {
  return PALETTES.find((palette) => palette.id === id) ?? AURORA;
}

/** High contrast is a modifier, not a palette: it flattens ramps to two tones and lifts the grid. */
export function applyContrast(palette: Palette, mode: ContrastMode): Palette {
  if (mode === 'normal') return palette;
  const threshold = (): Ramp => (value01) => (value01 < 0.5 ? [12, 12, 16] : [250, 250, 255]);
  return {
    ...palette,
    fields: {
      temperature: threshold(),
      humidity: threshold(),
      light: threshold(),
    },
    grid: [150, 150, 160],
  };
}

/** Turns an RGB triple into a CSS colour string. */
export function css([r, g, b]: Rgb): string {
  return `rgb(${r} ${g} ${b})`;
}
