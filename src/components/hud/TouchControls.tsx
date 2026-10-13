import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { gameBus } from '@/game/systems/eventBus';
import { useRunStore, selectLoadout, selectCooldowns } from '@/store/runStore';
import { useUiStore } from '@/store/uiStore';
import { pulse } from '@/utils/haptics';

const JOYSTICK_RADIUS = 54;

/**
 * Mobile controls.
 *
 * A draggable virtual joystick on the left, four action buttons on the right
 * and a compact element switcher within thumb reach. Everything uses pointer
 * events with `touch-action: none` so page scrolling never interferes, and the
 * layout honours safe-area insets.
 */
export function TouchControls() {
  const loadout = useRunStore(useShallow(selectLoadout));
  const cooldowns = useRunStore(useShallow(selectCooldowns));
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const activePointer = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });

  const sendMovement = useCallback((x: number, y: number) => {
    gameBus.emit('command:setMovement', { x, y });
  }, []);

  // A full-screen card (pause, death, floor transition, run summary) owns the
  // screen: the stick disappears and releases everything it was holding, so no
  // input can leak behind a modal.
  const modalOpen = useUiStore(
    (state) => state.paused || state.deathOpen || state.summary !== null || state.transition !== null,
  );

  useEffect(() => {
    return () => sendMovement(0, 0);
  }, [sendMovement]);

  useEffect(() => {
    if (!modalOpen) return;
    activePointer.current = null;
    setKnob({ x: 0, y: 0 });
    sendMovement(0, 0);
    gameBus.emit('command:setAttack', { held: false });
  }, [modalOpen, sendMovement]);

  const onJoystickDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    activePointer.current = event.pointerId;
    const rect = element.getBoundingClientRect();
    origin.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    updateFromPoint(event.clientX, event.clientY);
  };

  const updateFromPoint = (clientX: number, clientY: number) => {
    const dx = clientX - origin.current.x;
    const dy = clientY - origin.current.y;
    const distance = Math.hypot(dx, dy);
    const clamped = Math.min(distance, JOYSTICK_RADIUS);
    const angle = Math.atan2(dy, dx);
    const kx = Math.cos(angle) * clamped;
    const ky = Math.sin(angle) * clamped;
    setKnob({ x: kx, y: ky });
    const strength = clamped / JOYSTICK_RADIUS;
    const deadZone = 0.14;
    if (strength < deadZone) {
      sendMovement(0, 0);
      return;
    }
    const normalized = (strength - deadZone) / (1 - deadZone);
    sendMovement(Math.cos(angle) * normalized, Math.sin(angle) * normalized);
  };

  const onJoystickMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) return;
    updateFromPoint(event.clientX, event.clientY);
  };

  const onJoystickUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) return;
    activePointer.current = null;
    setKnob({ x: 0, y: 0 });
    sendMovement(0, 0);
  };

  /* A finger gets no key click and no hover, so the press itself has to be
     answered: the pattern is immediate, and the motor is the only channel that
     reaches through the glass. */
  const holdHandlers = (down: () => void, up: () => void) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pulse('press');
      down();
    },
    onPointerUp: () => up(),
    onPointerCancel: () => up(),
    onPointerLeave: () => up(),
  });

  if (modalOpen) return null;

  return (
    <div className="touch-layer">
      <div
        className="touch-zone joystick"
        onPointerDown={onJoystickDown}
        onPointerMove={onJoystickMove}
        onPointerUp={onJoystickUp}
        onPointerCancel={onJoystickUp}
        role="presentation"
      >
        <div className="joystick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
      </div>

      <div className="touch-actions">
        <button
          type="button"
          className={`touch-btn primary ${cooldowns.skillReady >= 1 ? '' : 'cooling'}`}
          {...holdHandlers(
            () => gameBus.emit('command:setAttack', { held: true }),
            () => gameBus.emit('command:setAttack', { held: false }),
          )}
        >
          ATTACK
        </button>
        <button
          type="button"
          className={`touch-btn ${cooldowns.skillReady >= 1 ? '' : 'cooling'}`}
          {...holdHandlers(
            () => gameBus.emit('command:useSkill', undefined),
            () => undefined,
          )}
        >
          SKILL
        </button>
        <button
          type="button"
          className={`touch-btn ${cooldowns.dashReady >= 1 ? '' : 'cooling'}`}
          {...holdHandlers(
            () => gameBus.emit('command:dash', undefined),
            () => undefined,
          )}
        >
          DASH
        </button>
        <button
          type="button"
          className={`touch-btn ${cooldowns.ultimateReady >= 1 ? '' : 'cooling'}`}
          {...holdHandlers(
            () => gameBus.emit('command:useUltimate', undefined),
            () => undefined,
          )}
        >
          ULT
        </button>
      </div>

      <div className="touch-elements">
        {loadout.slots.map((element, index) => {
          const def = element ? ELEMENT_REGISTRY[element] : null;
          if (!def) return null;
          return (
            <button
              key={`touch-slot-${index}`}
              type="button"
              className="element-slot"
              style={{
                color: def.color,
                borderColor: loadout.activeSlot === index ? def.color : undefined,
              }}
              onClick={() => {
                pulse('switch');
                gameBus.emit('command:switchElement', { slot: index });
              }}
              aria-label={`Switch to ${def.name}`}
            >
              <span className="glyph">{def.symbol}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
