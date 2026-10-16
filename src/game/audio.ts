/**
 * Synthesised audio.
 *
 * No assets, no libraries: every sound is built from oscillators and a noise buffer at runtime
 * (ADR-006). The whole module degrades to a no-op when the Web Audio API is unavailable, when the
 * context cannot be created, or when the player has muted — audio failure must never break play.
 */

export type SoundId =
  | 'click'
  | 'pulse'
  | 'bloom'
  | 'cull'
  | 'barrier'
  | 'probe'
  | 'file'
  | 'warning'
  | 'unlock';

export interface AudioOptions {
  readonly volume: number;
  readonly muted: boolean;
}

export class AudioBus {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambient: { oscillators: readonly OscillatorNode[]; gain: GainNode } | null = null;
  private unavailableReason: string | null = null;
  private options: AudioOptions;

  constructor(options: AudioOptions) {
    this.options = options;
  }

  /** True when sound can actually be produced; false means every call is a safe no-op. */
  get available(): boolean {
    return this.unavailableReason === null;
  }

  getStatus(): string {
    return this.unavailableReason ?? (this.context ? 'audio running' : 'audio waiting for a gesture');
  }

  setOptions(options: AudioOptions): void {
    this.options = options;
    if (this.master && this.context) {
      this.master.gain.value = options.muted ? 0 : options.volume;
    }
    if (options.muted) this.stopAmbient();
  }

  /** Must be called from a user gesture (a click or key press) for browsers to allow sound. */
  start(): boolean {
    if (this.unavailableReason !== null) return false;
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume();
      return true;
    }
    const Ctor = typeof window === 'undefined' ? undefined : window.AudioContext;
    if (!Ctor) {
      this.unavailableReason = 'This browser does not provide the Web Audio API';
      return false;
    }
    try {
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = this.options.muted ? 0 : this.options.volume;
      this.master.connect(this.context.destination);
      return true;
    } catch (error) {
      this.unavailableReason = `Audio could not start (${error instanceof Error ? error.message : String(error)})`;
      this.context = null;
      this.master = null;
      return false;
    }
  }

  play(sound: SoundId): void {
    if (!this.start() || !this.context || !this.master || this.options.muted) return;
    const recipe = RECIPES[sound];
    const now = this.context.currentTime;
    if (recipe.noise) {
      this.playNoise(now, recipe.duration, recipe.gain, recipe.filterHz ?? 900);
      return;
    }
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = recipe.wave ?? 'sine';
    oscillator.frequency.setValueAtTime(recipe.from, now);
    if (recipe.to !== recipe.from) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, recipe.to), now + recipe.duration);
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, recipe.gain), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + recipe.duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + recipe.duration + 0.02);
  }

  /** A quiet two-oscillator drone; started only after a user gesture. */
  startAmbient(): void {
    if (this.ambient || !this.start() || !this.context || !this.master || this.options.muted) return;
    const base = this.context.createOscillator();
    const fifth = this.context.createOscillator();
    const gain = this.context.createGain();
    base.type = 'sine';
    fifth.type = 'triangle';
    base.frequency.value = 55;
    fifth.frequency.value = 82.5;
    gain.gain.value = 0.045;
    base.connect(gain);
    fifth.connect(gain);
    gain.connect(this.master);
    base.start();
    fifth.start();
    // Both oscillators are kept: an oscillator that is not referenced cannot be stopped later, and a
    // drone that cannot be stopped keeps sounding after the survey ends (defect found in review).
    this.ambient = { oscillators: [base, fifth], gain };
  }

  stopAmbient(): void {
    if (!this.ambient) return;
    for (const oscillator of this.ambient.oscillators) {
      try {
        oscillator.stop();
      } catch {
        // Stopping an already-stopped oscillator is not an error worth surfacing.
      }
    }
    this.ambient = null;
  }

  private playNoise(at: number, duration: number, gainValue: number, filterHz: number): void {
    if (!this.context || !this.master) return;
    const frames = Math.max(1, Math.floor(this.context.sampleRate * duration));
    const buffer = this.context.createBuffer(1, frames, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      // Deterministic pseudo-noise: no Math.random, so tests and replays stay reproducible.
      channel[i] = (((i * 1103515245 + 12345) % 65536) / 32768 - 1) * 0.6;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterHz;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(gainValue, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(at);
  }
}

interface Recipe {
  readonly from: number;
  readonly to: number;
  readonly duration: number;
  readonly gain: number;
  readonly wave?: OscillatorType;
  readonly noise?: boolean;
  readonly filterHz?: number;
}

const RECIPES: Readonly<Record<SoundId, Recipe>> = Object.freeze({
  click: { from: 880, to: 660, duration: 0.06, gain: 0.05, wave: 'triangle' },
  pulse: { from: 220, to: 520, duration: 0.32, gain: 0.09, wave: 'sine' },
  bloom: { from: 320, to: 180, duration: 0.4, gain: 0.08, wave: 'triangle' },
  cull: { from: 90, to: 40, duration: 0.5, gain: 0.14, wave: 'sawtooth' },
  barrier: { from: 140, to: 140, duration: 0.22, gain: 0.07, wave: 'square' },
  probe: { from: 660, to: 990, duration: 0.12, gain: 0.05, wave: 'sine' },
  file: { from: 440, to: 1320, duration: 0.55, gain: 0.1, wave: 'triangle' },
  warning: { from: 300, to: 120, duration: 0.45, gain: 0.12, wave: 'square' },
  unlock: { from: 523, to: 1046, duration: 0.7, gain: 0.1, wave: 'sine' },
});
