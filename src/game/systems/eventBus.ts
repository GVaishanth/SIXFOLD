/**
 * Typed event bus bridging the React interface, the Phaser scenes and the
 * Zustand stores. Deliberately framework-free so neither layer has to import
 * the other.
 */

import type { ElementId } from '@/types';

export interface GameEvents {
  /* React → Phaser commands */
  'command:dash': { x: number; y: number } | undefined;
  'command:switchElement': { slot: number };
  'command:cycleElement': { direction: 1 | -1 };
  'command:useSkill': undefined;
  'command:useUltimate': undefined;
  'command:setMovement': { x: number; y: number };
  'command:setAttack': { held: boolean };
  'command:pause': undefined;
  'command:resume': undefined;
  'command:respawn': undefined;
  'command:restartRun': { wave?: number; mode?: 'story' | 'free' | 'ascension' };
  'command:setLoadout': { slots: (string | null)[]; activeSlot: number };
  'command:grantCheat': { hp?: number; energy?: number; killAll?: boolean; nextWave?: boolean };

  /* React → Phaser, presentation only: menu atmosphere and element previews.
     These never carry gameplay state — they exist so the world acknowledges
     what the interface is doing. */
  'ui:atmosphere': { accent: number; mood: 'calm' | 'focus' | 'danger' | 'triumph'; intensity: number };
  'ui:elementPreview': { element: string | null };
  'ui:celebrate': { element: string | null; kind: 'unlock' | 'floor' | 'boss' };

  /* Phaser → React */
  'game:ready': undefined;
  'game:runStarted': { mode: 'story' | 'free' | 'ascension'; wave: number; floor: number; floorName: string };
  'game:waveCountdown': { wave: number; seconds: number };
  'game:waveStarted': { wave: number; floor: number; isBoss: boolean; label: string; total: number };
  /** The strip's guide stone was walked into. The card it opens is HUD-side, and it never freezes the run. */
  'game:guideOpened': { at: number };
  'game:waveCleared': {
    wave: number;
    floor: number;
    essence: number;
    /** Shards the run actually collected during this wave — never a guess. */
    shards: number;
    nextWave: number;
    /** True when the next wave opens a new floor: the chapter card takes over. */
    chapter: boolean;
    elapsedMs: number;
  };
  'game:enemyKilled': { defId: string; rank: string; isBoss: boolean; essence: number; shards: number };
  'game:playerDamaged': { amount: number };
  'game:playerDied': { wave: number; floor: number };
  'game:bossSpawned': {
    bossId: string;
    name: string;
    title: string;
    description: string;
    element: ElementId;
    color: string;
    rank: 'major' | 'miniboss';
    wave: number;
    floor: number;
    floorName: string;
    hp: number;
    phases: { name: string; banner: string }[];
  };
  'game:bossPhase': { bossId: string; phase: number; banner: string };
  'game:bossDefeated': { bossId: string; rank: 'major' | 'miniboss'; essence: number; drops: string[] };
  'game:floorCleared': { floor: number; floorName: string; nextFloor: number; nextFloorName: string };
  'game:loot': { id: string; amount: number; kind: string };
  /** A dungeon strip finished, either end or death. Debug/telemetry only — the save never sees it. */
  'game:dungeonEnded': {
    seed: number | null;
    reason: 'end' | 'death';
    seconds: number;
    kills: number;
    ledger: number;
    cells: number;
    partnerDown: boolean;
    /** Waypoint hops the run used. Counted, not forgiven: a warp is on the record like a scar is. */
    warps: number;
    waystonesLinked: number;
  };
  'game:hallUpgrade': { floor: number; bossName: string; hp: number; attack: number; defense: number; crit: number };
  'game:elementUnlocked': { element: string; reason: string };
  'game:checkpointReached': { bossId: string; bossName: string; floor: number; wave: number };
  'game:ascensionUnlocked': { cycle: number };
  'game:requestAutosave': { reason: string };
  'game:requestSummary': { cause: 'death' | 'exit' | 'complete' };
  'game:error': { message: string; where: string };
}

type Listener<K extends keyof GameEvents> = (payload: GameEvents[K]) => void;

class TypedEventBus {
  private listeners = new Map<keyof GameEvents, Set<Listener<never>>>();

  on<K extends keyof GameEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<K extends keyof GameEvents>(event: K, listener: Listener<K>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try {
        (listener as Listener<K>)(payload);
      } catch (error) {
        console.error(`[sixfold] event listener failed for "${String(event)}"`, error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const gameBus = new TypedEventBus();
export type GameBus = typeof gameBus;

// Development-only escape hatch so the bus can be driven from the console or a
// browser-automation script. Removed from production bundles by the bundler.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__sixfoldBus = gameBus;
}
