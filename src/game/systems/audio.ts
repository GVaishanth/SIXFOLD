/**
 * Procedural audio engine.
 *
 * All sound effects and the ambient music bed are synthesised at runtime with
 * the Web Audio API — no external audio packs, no licensing, no large
 * downloads. The context is created lazily and only resumed after a user
 * gesture so browser autoplay policies are respected.
 */

export type SfxName =
  | 'ui_click'
  | 'ui_back'
  | 'ui_deny'
  | 'element_switch'
  | 'attack'
  | 'hit'
  | 'crit'
  | 'dash'
  | 'skill'
  | 'ultimate'
  | 'enemy_death'
  | 'boss_enter'
  | 'boss_defeat'
  | 'unlock'
  | 'floor'
  | 'checkpoint'
  | 'death'
  | 'pickup'
  | 'wave_clear'
  | 'countdown';

interface SfxSpec {
  /** Oscillator stack: [type, frequency multiplier, detune]. */
  oscillators: [OscillatorType, number, number][];
  /** Base frequency in Hz. */
  freq: number;
  /** Frequency glide target (Hz). */
  glideTo?: number;
  duration: number;
  attack: number;
  gain: number;
  /** Noise layer amount 0..1. */
  noise?: number;
  noiseFilter?: number;
  /** Low-pass filter sweep target. */
  filterTo?: number;
  /** Random pitch variance (semitones). */
  variance?: number;
}

const SFX: Record<SfxName, SfxSpec> = {
  ui_click: {
    oscillators: [['square', 1, 0]],
    freq: 620,
    glideTo: 880,
    duration: 0.06,
    attack: 0.004,
    gain: 0.16,
  },
  ui_back: {
    oscillators: [['square', 1, 0]],
    freq: 520,
    glideTo: 320,
    duration: 0.08,
    attack: 0.004,
    gain: 0.14,
  },
  ui_deny: {
    oscillators: [['sawtooth', 1, 6]],
    freq: 180,
    glideTo: 120,
    duration: 0.16,
    attack: 0.005,
    gain: 0.16,
    noise: 0.15,
  },
  element_switch: {
    oscillators: [
      ['triangle', 1, 0],
      ['sine', 2, 4],
    ],
    freq: 420,
    glideTo: 760,
    duration: 0.22,
    attack: 0.008,
    gain: 0.18,
    noise: 0.08,
    noiseFilter: 2600,
  },
  attack: {
    oscillators: [['square', 1, 0]],
    freq: 320,
    glideTo: 520,
    duration: 0.07,
    attack: 0.002,
    gain: 0.1,
    noise: 0.22,
    noiseFilter: 3200,
    variance: 1.5,
  },
  hit: {
    oscillators: [['triangle', 1, 0]],
    freq: 240,
    glideTo: 140,
    duration: 0.09,
    attack: 0.002,
    gain: 0.14,
    noise: 0.4,
    noiseFilter: 1800,
    variance: 2,
  },
  crit: {
    oscillators: [
      ['square', 1, 0],
      ['square', 1.5, 8],
    ],
    freq: 480,
    glideTo: 220,
    duration: 0.18,
    attack: 0.002,
    gain: 0.2,
    noise: 0.5,
    noiseFilter: 2600,
    variance: 2,
  },
  dash: {
    oscillators: [['sawtooth', 1, 0]],
    freq: 240,
    glideTo: 760,
    duration: 0.14,
    attack: 0.004,
    gain: 0.12,
    noise: 0.35,
    noiseFilter: 2200,
  },
  skill: {
    oscillators: [
      ['triangle', 1, 0],
      ['sine', 1.5, 5],
    ],
    freq: 300,
    glideTo: 900,
    duration: 0.4,
    attack: 0.01,
    gain: 0.2,
    noise: 0.2,
    noiseFilter: 3000,
  },
  ultimate: {
    oscillators: [
      ['sawtooth', 1, 0],
      ['square', 0.5, -6],
      ['sine', 2, 12],
    ],
    freq: 140,
    glideTo: 900,
    duration: 0.9,
    attack: 0.02,
    gain: 0.24,
    noise: 0.3,
    noiseFilter: 3600,
  },
  enemy_death: {
    oscillators: [['square', 1, 0]],
    freq: 260,
    glideTo: 70,
    duration: 0.22,
    attack: 0.002,
    gain: 0.14,
    noise: 0.45,
    noiseFilter: 1500,
    variance: 3,
  },
  boss_enter: {
    oscillators: [
      ['sawtooth', 1, 0],
      ['square', 0.5, 4],
    ],
    freq: 90,
    glideTo: 180,
    duration: 1.3,
    attack: 0.08,
    gain: 0.26,
    noise: 0.35,
    noiseFilter: 900,
  },
  boss_defeat: {
    oscillators: [
      ['sawtooth', 1, 0],
      ['triangle', 1.5, -4],
    ],
    freq: 320,
    glideTo: 60,
    duration: 1.6,
    attack: 0.01,
    gain: 0.26,
    noise: 0.5,
    noiseFilter: 1200,
  },
  unlock: {
    oscillators: [
      ['triangle', 1, 0],
      ['sine', 2, 7],
      ['sine', 3, 12],
    ],
    freq: 520,
    glideTo: 1040,
    duration: 0.8,
    attack: 0.02,
    gain: 0.22,
  },
  floor: {
    oscillators: [
      ['triangle', 1, 0],
      ['sine', 1.5, 6],
    ],
    freq: 260,
    glideTo: 520,
    duration: 1.1,
    attack: 0.05,
    gain: 0.22,
    noise: 0.12,
    noiseFilter: 2400,
  },
  checkpoint: {
    oscillators: [
      ['triangle', 1, 0],
      ['sine', 2, 0],
    ],
    freq: 440,
    glideTo: 660,
    duration: 0.55,
    attack: 0.02,
    gain: 0.2,
  },
  death: {
    oscillators: [
      ['sawtooth', 1, 0],
      ['square', 0.5, -8],
    ],
    freq: 220,
    glideTo: 40,
    duration: 1.4,
    attack: 0.01,
    gain: 0.26,
    noise: 0.4,
    noiseFilter: 800,
  },
  pickup: {
    oscillators: [
      ['triangle', 1, 0],
      ['sine', 2, 0],
    ],
    freq: 780,
    glideTo: 1180,
    duration: 0.1,
    attack: 0.002,
    gain: 0.12,
    variance: 2,
  },
  wave_clear: {
    oscillators: [
      ['triangle', 1, 0],
      ['triangle', 1.5, 0],
    ],
    freq: 380,
    glideTo: 760,
    duration: 0.5,
    attack: 0.02,
    gain: 0.2,
  },
  countdown: {
    oscillators: [['square', 1, 0]],
    freq: 720,
    glideTo: 720,
    duration: 0.12,
    attack: 0.004,
    gain: 0.14,
  },
};

interface MusicState {
  key: string;
  bpm: number;
  scale: number[];
  root: number;
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private musicTimer: number | null = null;
  private musicStep = 0;
  private musicState: MusicState | null = null;
  private volumes = { master: 0.7, sfx: 0.85, music: 0.35 };
  private unlocked = false;
  private muted = false;

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  /** Must be called from a user gesture before any sound can be heard. */
  unlock(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      try {
        const Ctor: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.sfxBus = this.ctx.createGain();
        this.musicBus = this.ctx.createGain();
        this.sfxBus.connect(this.master);
        this.musicBus.connect(this.master);
        this.master.connect(this.ctx.destination);
        this.applyVolumes();
        this.noiseBuffer = this.createNoiseBuffer();
      } catch (error) {
        console.warn('[sixfold] audio unavailable', error);
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
    this.unlocked = true;
  }

  setVolumes(volumes: { master: number; sfx: number; music: number }): void {
    this.volumes = volumes;
    this.applyVolumes();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master || !this.sfxBus || !this.musicBus) return;
    const now = this.ctx.currentTime;
    const duck = this.muted ? 0 : 1;
    this.master.gain.setTargetAtTime(this.volumes.master * duck, now, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, now, 0.05);
    this.musicBus.gain.setTargetAtTime(this.volumes.music, now, 0.05);
  }

  private createNoiseBuffer(): AudioBuffer | null {
    if (!this.ctx) return null;
    const length = Math.floor(this.ctx.sampleRate * 0.6);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  play(name: SfxName, options: { gain?: number; rate?: number } = {}): void {
    if (!this.ctx || !this.sfxBus || !this.unlocked || this.muted) return;
    const spec = SFX[name];
    if (!spec) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const variance = spec.variance ? Math.pow(2, ((Math.random() * 2 - 1) * spec.variance) / 12) : 1;
    const rate = (options.rate ?? 1) * variance;
    const gainScale = options.gain ?? 1;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(spec.gain * gainScale, now + spec.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);
    env.connect(this.sfxBus);

    for (const [type, multiplier, detune] of spec.oscillators) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.detune.value = detune;
      const startFreq = spec.freq * multiplier * rate;
      const endFreq = (spec.glideTo ?? spec.freq) * multiplier * rate;
      osc.frequency.setValueAtTime(startFreq, now);
      if (endFreq !== startFreq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + spec.duration);
      }
      osc.connect(env);
      osc.start(now);
      osc.stop(now + spec.duration + 0.02);
    }

    if (spec.noise && this.noiseBuffer) {
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(spec.noiseFilter ?? 2000, now);
      if (spec.filterTo) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(80, spec.filterTo), now + spec.duration);
      }
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(spec.gain * spec.noise * gainScale, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);
      source.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(this.sfxBus);
      source.start(now);
      source.stop(now + spec.duration + 0.02);
    }
  }

  /** Start (or switch to) the ambient music bed for a floor. */
  startMusic(state: MusicState): void {
    if (!this.ctx || !this.musicBus) return;
    const sameTrack =
      this.musicState &&
      this.musicState.key === state.key &&
      this.musicTimer !== null;
    this.musicState = state;
    if (sameTrack) return;
    this.stopMusic();
    this.musicStep = 0;
    const stepMs = Math.max(180, (60 / Math.max(40, state.bpm)) * 1000);
    this.musicTimer = window.setInterval(() => this.tickMusic(), stepMs);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  private tickMusic(): void {
    if (!this.ctx || !this.musicBus || !this.musicState || this.muted) return;
    const { scale, root } = this.musicState;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const step = this.musicStep;
    this.musicStep = (this.musicStep + 1) % 16;

    // Root drone every four steps, arpeggio on the others.
    const isDrone = step % 4 === 0;
    const degree = scale[(step * 3) % scale.length];
    const semitone = isDrone ? 0 : degree;
    const freq = root * Math.pow(2, semitone / 12) * (isDrone ? 0.5 : 1);

    const osc = ctx.createOscillator();
    osc.type = isDrone ? 'triangle' : 'sine';
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    const peak = isDrone ? 0.16 : 0.075;
    const duration = isDrone ? 1.6 : 0.85;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(this.musicBus);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  getMusicTimerActive(): boolean {
    return this.musicTimer !== null;
  }
}

export const audioEngine = new AudioEngine();

/** Convenience wrapper used across gameplay code. */
export function sfx(name: SfxName, options?: { gain?: number; rate?: number }): void {
  audioEngine.play(name, options);
}
