import { useCallback, useEffect, useRef, useState } from 'react';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { gameBus } from '@/game/systems/eventBus';
import { useSaveStore } from '@/store/saveStore';
import { selectUnlockMoment, useUiStore } from '@/store/uiStore';
import { Button, Tag } from '@/components/ui/primitives';
import { drawLine, fadeOut, isReducedMotion, popIn, staggerIn } from '@/utils/motion';
import type { ElementId } from '@/types';

/** How long the card holds before it gets out of the way on its own. */
const HOLD_MS = 2600;
const HOLD_REDUCED_MS = 1500;

/**
 * §29 — an unlock is a moment, not a log line.
 *
 * The card answers the five questions a transition has to answer: what changed
 * (a new element, named in the display face), why (the reason the progression
 * system gave), where it came from (it opens from the glyph outward, and a rule
 * draws between the glyph and the copy), what to look at (the glyph first, then
 * the action row), and what is interactive now (EQUIP or CONTINUE — both real,
 * neither required, because the card dismisses itself and never eats the stick).
 *
 * It deliberately does *not* pause the run. A celebration that freezes combat is
 * a pause the player can trigger on purpose, and element unlocks happen in the
 * middle of a wave. The world-side half of the moment is a short `fx.hitStop`
 * plus a ring at the warden, which scales time instead of stopping it.
 */
export function UnlockCelebration() {
  const moment = useUiStore(selectUnlockMoment);
  const clearUnlockMoment = useUiStore((s) => s.clearUnlockMoment);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const ruleRef = useRef<HTMLSpanElement | null>(null);
  const closing = useRef(false);
  const [full, setFull] = useState(false);

  const dismiss = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setFull(false);
    // The card leaves the way it came, so the exit runs before the state clears.
    // The claim timestamp is captured first: a second unlock that lands during
    // those 150 ms owns the card now, and this dismissal must not wipe it.
    const mine = useUiStore.getState().unlockMoment?.at;
    void fadeOut(cardRef.current, 150).finally(() => {
      const current = useUiStore.getState().unlockMoment;
      if (!current || current.at === mine) clearUnlockMoment();
      else closing.current = false;
    });
  }, [clearUnlockMoment]);

  // Know whether "EQUIP" has a slot to fill, so the button can promise the
  // truth: an exhausted loadout says REPLACE ACTIVE and means it.
  useEffect(() => {
    if (!moment) return;
    const data = useSaveStore.getState().data;
    setFull(Boolean(data && data.loadout.slots.every((slot) => slot !== null)));
  }, [moment]);

  useEffect(() => {
    if (!moment) return;
    closing.current = false;
    popIn(cardRef.current, 0.92);
    drawLine(ruleRef.current, 340);
    const card = cardRef.current;
    if (card) {
      staggerIn(Array.from(card.querySelectorAll<HTMLElement>('.unlock-row')));
    }
    const hold = isReducedMotion() ? HOLD_REDUCED_MS : HOLD_MS;
    const timer = window.setTimeout(dismiss, hold);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Capture on window: the card swallows Esc before it can open the pause
      // menu, so dismissing the moment never leaves a hidden pause behind it.
      event.stopPropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [moment, dismiss]);

  if (!moment) return null;
  const def = ELEMENT_REGISTRY[moment.element as ElementId];
  if (!def) return null;

  const equip = () => {
    const store = useSaveStore.getState();
    const data = store.data;
    if (!data) return dismiss();
    const slots = [...data.loadout.slots];
    const already = slots.indexOf(moment.element);
    let activeSlot: number;
    if (already >= 0) {
      activeSlot = already;
    } else {
      const empty = slots.findIndex((slot) => slot === null);
      if (empty >= 0) {
        slots[empty] = moment.element;
        activeSlot = empty;
      } else {
        activeSlot = data.loadout.activeSlot;
        if (activeSlot < 0 || activeSlot >= slots.length) activeSlot = 0;
        slots[activeSlot] = moment.element;
      }
    }
    const result = store.setLoadout(slots, activeSlot);
    if (!result.ok) {
      useUiStore.getState().pushToast({
        title: 'CANNOT EQUIP',
        body: result.reason ?? 'The loadout rejected the change.',
        color: '#FF5C6C',
      });
    } else {
      // The live run owns its own copy of the loadout; without this the button
      // would only take effect after the next respawn.
      gameBus.emit('command:setLoadout', { slots, activeSlot });
    }
    dismiss();
  };

  return (
    <div className="unlock-moment">
      <div
        ref={cardRef}
        className="unlock-card panel-2"
        role="status"
        aria-live="polite"
        style={{ ['--chip' as string]: def.color }}
      >
        <header className="unlock-head">
          <span className="unlock-glyph" aria-hidden>
            {def.symbol}
          </span>
          <div className="unlock-title">
            <div className="unlock-kicker">NEW ELEMENT</div>
            <div className="unlock-name">{def.name.toUpperCase()}</div>
            <div className="tiny muted">
              {def.tier.toUpperCase()} · {def.damageType.toUpperCase()}
            </div>
          </div>
          <Tag tone="gold">LV 1</Tag>
        </header>
        <span className="unlock-rule" ref={ruleRef} aria-hidden />
        <p className="unlock-row unlock-flavor">{def.identity}</p>
        <p className="unlock-row unlock-reason">{moment.reason}</p>
        <div className="unlock-row unlock-actions">
          <Button size="small" variant="primary" onClick={equip}>
            {full ? 'REPLACE ACTIVE' : 'EQUIP'}
          </Button>
          <Button size="small" variant="ghost" onClick={dismiss}>
            CONTINUE
          </Button>
        </div>
      </div>
    </div>
  );
}
