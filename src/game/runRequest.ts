import type { GameMode } from '@/types';

/** What the interface asks the gameplay scene to run next. */
export interface RunRequest {
  mode: GameMode;
  startWave: number;
  floorOverride?: number;
  /** Set when resuming from a checkpoint (story) or a chosen boss (free mode). */
  checkpointWave?: number;
  bossId?: string | null;
  /** Free Mode difficulty multiplier applied to enemy stats. */
  difficultyScale?: number;
  /** Restart reason, used for UI copy. */
  reason?: 'new' | 'continue' | 'checkpoint' | 'respawn' | 'free' | 'ascension' | 'debug';
  /**
   * Which world to run: the authored wave ladder (default) or one generated strip. Dungeon mode is
   * self-contained — it never reads or writes story progress — so this is not a `GameMode`, which is
   * wired through saves, unlocks and the wave generator.
   */
  kind?: 'waves' | 'strip';
  /** Strip seed. `null`/omitted means the generator's own default, so a run is reproducible. */
  seed?: number | null;
}

let pending: RunRequest | null = null;

export function setRunRequest(request: RunRequest): void {
  pending = request;
}

export function takeRunRequest(): RunRequest | null {
  const request = pending;
  pending = null;
  return request;
}

export function peekRunRequest(): RunRequest | null {
  return pending;
}

export function defaultRunRequest(mode: GameMode = 'story'): RunRequest {
  return { mode, startWave: 1, reason: 'new' };
}
