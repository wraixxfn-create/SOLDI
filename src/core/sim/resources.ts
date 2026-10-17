import { ScalarField } from '../field.ts';
import { clamp } from '../math.ts';

/** Resource stocks are distinct from climate: climate describes conditions, resources are consumed. */
export type ResourceId = 'water' | 'nutrients';
export const RESOURCE_IDS: readonly ResourceId[] = ['water', 'nutrients'] as const;

/** Hard units and limits shared by validation, rules and the simulation. */
export const RESOURCE_LIMITS: Readonly<Record<ResourceId, { readonly min: number; readonly max: number }>> =
  Object.freeze({
    water: { min: 0, max: 1 },
    nutrients: { min: 0, max: 4 },
  });

/**
 * Explicit initial-world resource settings.
 *
 * Water is a normalized available-water fraction (0–1). Nutrients are abstract mineral units per
 * cell (0–4). Rates are per discrete turn: diffusion is a fraction in [0, 0.25], water recharge and
 * evaporation are fractions in [0, 1], and nutrient regeneration is units per cell per turn.
 */
export interface WorldResourceConfig {
  readonly water: {
    readonly initial: number;
    readonly recharge: number;
    readonly evaporation: number;
    readonly diffusion: number;
  };
  readonly nutrients: {
    readonly initial: number;
    readonly regeneration: number;
    readonly diffusion: number;
  };
}

export type ResourceFields = Record<ResourceId, ScalarField>;

/** Reject malformed authored resource settings before NaN/Infinity can enter a field. */
export function assertValidResourceConfig(config: WorldResourceConfig): void {
  const entries: readonly [string, unknown, number, number][] = [
    ['water.initial', config.water?.initial, 0, 1],
    ['water.recharge', config.water?.recharge, 0, 1],
    ['water.evaporation', config.water?.evaporation, 0, 1],
    ['water.diffusion', config.water?.diffusion, 0, 0.25],
    ['nutrients.initial', config.nutrients?.initial, 0, 4],
    ['nutrients.regeneration', config.nutrients?.regeneration, 0, 4],
    ['nutrients.diffusion', config.nutrients?.diffusion, 0, 0.25],
  ];
  for (const [name, value, min, max] of entries) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new RangeError(`Invalid resource parameter ${name}: ${String(value)} (expected ${min}..${max})`);
    }
  }
}

/** Builds spatial resource stocks at their explicitly authored, uniform initial values. */
export function buildResourceFields(
  width: number,
  height: number,
  config: WorldResourceConfig,
): ResourceFields {
  assertValidResourceConfig(config);
  const fields: ResourceFields = {
    water: new ScalarField(width, height, config.water.initial),
    nutrients: new ScalarField(width, height, config.nutrients.initial),
  };
  for (const id of RESOURCE_IDS) {
    const limits = RESOURCE_LIMITS[id];
    fields[id].clampTo(limits.min, limits.max);
  }
  return fields;
}

/**
 * Resource-availability phase. Available water equilibrates toward local humidity, loses water to
 * evaporation, and diffuses. Nutrients regenerate toward the fixed mineral ceiling and diffuse.
 * Consumption happens later in the interaction phase, so no agent sees another agent's future turn.
 */
export function advanceResourceFields(
  fields: Readonly<ResourceFields>,
  config: WorldResourceConfig,
  humidity: ScalarField,
): void {
  const water = fields.water.data;
  const moisture = humidity.data;
  const waterConfig = config.water;
  for (let i = 0; i < water.length; i++) {
    const current = water[i] as number;
    const target = moisture[i] as number;
    const recharged = current + (target - current) * waterConfig.recharge;
    water[i] = clamp(recharged * (1 - waterConfig.evaporation), 0, RESOURCE_LIMITS.water.max);
  }
  fields.water.diffuse(waterConfig.diffusion);
  fields.water.clampTo(RESOURCE_LIMITS.water.min, RESOURCE_LIMITS.water.max);

  const nutrients = fields.nutrients.data;
  const nutrientConfig = config.nutrients;
  for (let i = 0; i < nutrients.length; i++) {
    const current = nutrients[i] as number;
    const headroom = RESOURCE_LIMITS.nutrients.max - current;
    nutrients[i] = clamp(
      current + Math.min(headroom, nutrientConfig.regeneration),
      RESOURCE_LIMITS.nutrients.min,
      RESOURCE_LIMITS.nutrients.max,
    );
  }
  fields.nutrients.diffuse(nutrientConfig.diffusion);
  fields.nutrients.clampTo(RESOURCE_LIMITS.nutrients.min, RESOURCE_LIMITS.nutrients.max);
}

/** Applies an explicit radial resource impulse and preserves the physical stock limits. */
export function shiftResource(
  fields: Readonly<ResourceFields>,
  resource: ResourceId,
  x: number,
  y: number,
  radius: number,
  amount: number,
): void {
  const limits = RESOURCE_LIMITS[resource];
  fields[resource].addRadial(x, y, radius, amount);
  fields[resource].clampTo(limits.min, limits.max);
}
