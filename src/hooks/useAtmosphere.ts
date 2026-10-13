import { useEffect } from 'react';
import { UI_CONFIG } from '@/config/gameConfig';
import type { AtmosphereMood } from '@/game/scenes/atmosphere';
import { gameBus } from '@/game/systems/eventBus';
import type { ElementId } from '@/types';

/**
 * Bridge from React screens to the Phaser atmosphere.
 *
 * Screens state the mood they want; the scene paints it. The effect restores
 * the previous mood on unmount, so leaving a screen never leaves the backdrop
 * stuck in the wrong colour, and no screen reaches into the game directly.
 */
/**
 * A screen that only names a mood still gets the palette's colour for it: `atmosphere` carries
 * one accent per `AtmosphereMood`, and the type guarantees it. An explicit `accent` — an
 * element's own colour, a floor's palette — wins, which is what the hub and the binder do.
 */
export function useAtmosphere(mood: AtmosphereMood, options?: { accent?: number; intensity?: number }): void {
  const accent = options?.accent ?? UI_CONFIG.atmosphere[mood];
  const intensity = options?.intensity ?? 1;

  useEffect(() => {
    gameBus.emit('ui:atmosphere', { accent, mood, intensity });
    return () => {
      gameBus.emit('ui:atmosphere', { accent: UI_CONFIG.atmosphere.story, mood: 'calm', intensity: 1 });
      gameBus.emit('ui:elementPreview', { element: null });
    };
  }, [accent, mood, intensity]);
}

/** Let a screen touch the world: hovering an element previews it in the backdrop. */
export function previewElement(element: ElementId | null): void {
  gameBus.emit('ui:elementPreview', { element });
}

/** Acknowledge a real achievement in the world layer (unlock, floor, boss). */
export function celebrate(kind: 'unlock' | 'floor' | 'boss', element: ElementId | null = null): void {
  gameBus.emit('ui:celebrate', { kind, element });
}
