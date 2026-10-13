import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ELEMENT_REGISTRY, STARTER_ELEMENT_IDS } from '@/data/elements';
import { FLOOR_REGISTRY } from '@/data/floors';
import { useSaveStore } from '@/store/saveStore';
import { audioEngine } from '@/game/systems/audio';
import { useUiStore } from '@/store/uiStore';
import { useAtmosphere, previewElement } from '@/hooks/useAtmosphere';
import { Button, ModalCard } from '@/components/ui/primitives';
import type { ElementId } from '@/types';
import { Screen } from '@/components/ui/Screen';

const NAME_MAX = 14;

/**
 * The Binding.
 *
 * Choosing a starting element is the first real decision in the game, so it is
 * staged as a ritual rather than a form: three pedestals over the ruin, each one
 * lighting the world behind the screen when you touch it, each with its own
 * pitch, its own sigil and its own consequences written out below.
 *
 * The starter is permanent for the save and seeds exactly one unlocked element —
 * never two, never all three.
 */
export function NewGameScreen() {
  const navigate = useUiStore((s) => s.navigate);
  const workingSlot = useUiStore((s) => s.workingSlot);
  const pushToast = useUiStore((s) => s.pushToast);
  const createSave = useSaveStore((s) => s.createSave);

  const [name, setName] = useState('');
  const [starter, setStarter] = useState<ElementId>('fire');
  const [confirming, setConfirming] = useState(false);
  const ringRef = useRef<HTMLSpanElement | null>(null);

  const starters = useMemo(() => STARTER_ELEMENT_IDS.map((id) => ELEMENT_REGISTRY[id]), []);
  const starterDef = ELEMENT_REGISTRY[starter];
  const slot = workingSlot < 0 ? 0 : workingSlot;

  useAtmosphere('focus', {
    accent: starterDef.colorInt,
    intensity: 1,
  });

  /** One-shot ignition ring on the chosen pedestal. Never loops. */
  const spinRing = useCallback(() => {
    const node = ringRef.current;
    if (!node) return;
    node.animate(
      [
        { opacity: 0.9, transform: 'scale(0.72) rotate(-18deg)' },
        { opacity: 0, transform: 'scale(1.28) rotate(8deg)' },
      ],
      { duration: 520, easing: 'cubic-bezier(0.18, 0.9, 0.3, 1)' },
    );
  }, []);

  const choose = (id: ElementId, index: number) => {
    if (id !== starter) audioEngine.play('ui_click', { rate: 0.82 + index * 0.14 });
    setStarter(id);
    previewElement(id);
    spinRing();
  };

  useEffect(() => () => previewElement(null), []);

  const finalise = () => {
    const trimmed = name.trim() || 'Warden';
    const created = createSave(slot, trimmed, starter);
    if (!created) {
      pushToast({ title: 'COULD NOT CREATE SAVE', body: 'Storage unavailable — check browser settings.', color: '#FF5C6C' });
      return;
    }
    audioEngine.unlock();
    audioEngine.play('unlock');
    pushToast({
      title: 'WARDEN BOUND',
      body: `${trimmed} begins with ${ELEMENT_REGISTRY[starter].name}.`,
      color: starterDef.color,
      glyph: starterDef.symbol,
    });
    navigate('hub');
  };

  return (
    <Screen className="binding-screen">
      <div className="binding-frame">
        <header className="binding-head" data-anim="lead">
          <span className="panel-kicker">SLOT {slot + 1} · PERMANENT BINDING</span>
          <h1 className="title-xl">CHOOSE YOUR FLAME</h1>
          <p className="subtitle">
            One element walks in with you. The other twenty-four are taken from waves, wardens and essence.
          </p>
        </header>

        <label className="name-plate">
          <span className="plaque-label">WARDEN NAME</span>
          <span className="name-plate-row">
            <input
              className="text-input"
              value={name}
              maxLength={NAME_MAX}
              placeholder="Warden"
              aria-label="Warden name"
              onChange={(event) => setName(event.target.value.slice(0, NAME_MAX))}
            />
            <span className="tiny muted">
              {name.trim().length}/{NAME_MAX}
            </span>
          </span>
        </label>

        <div className="pedestal-row">
          {starters.map((def, index) => {
            const selected = def.id === starter;
            return (
              <button
                key={def.id}
                type="button"
                className={`pedestal ${selected ? 'is-selected' : ''}`}
                style={{ '--el': def.color, '--el-core': def.colorCore } as React.CSSProperties}
                onClick={() => choose(def.id, index)}
                onPointerEnter={() => previewElement(def.id)}
                onMouseLeave={() => previewElement(starter)}
                onFocus={() => previewElement(def.id)}
                aria-pressed={selected}
              >
                <span className="pedestal-sigil" aria-hidden="true">
                  {selected ? <span className="pedestal-ring" ref={ringRef} /> : null}
                  <span className="pedestal-glyph">{def.symbol}</span>
                </span>
                <span className="pedestal-name">{def.name.toUpperCase()}</span>
                <span className="pedestal-identity">{def.identity}</span>
                <span className="pedestal-loadout">
                  {def.attack.label} · {def.skill.name} · {def.ultimate.name}
                </span>
                <span className="pedestal-base" aria-hidden="true" />
              </button>
            );
          })}
        </div>

        <section className="binding-scroll">
          <div className="scroll-col">
            <span className="panel-kicker">PASSIVE</span>
            <p>{starterDef.passive.description}</p>
          </div>
          <div className="scroll-col">
            <span className="panel-kicker">FIRST GROUND</span>
            <p>{FLOOR_REGISTRY[1]?.name} — twenty waves before the first warden answers.</p>
          </div>
          <div className="scroll-col">
            <span className="panel-kicker">THE ROAD</span>
            <p>200 waves · 10 floors · 20 wardens. Then Ascension.</p>
          </div>
        </section>

        <div className="binding-actions">
          <Button variant="primary" onClick={() => setConfirming(true)}>
            BIND AND BEGIN
          </Button>
          <Button onClick={() => navigate('slotselect')}>BACK TO THE VAULT</Button>
        </div>
      </div>

      {confirming ? (
        <div className="overlay-layer" role="dialog" aria-modal="true" aria-label="Confirm new game">
          <ModalCard label="BINDING" tone="gold" onEscape={() => setConfirming(false)}>
            <h2 className="overlay-title">BEGIN THE ASCENT?</h2>
            <p className="overlay-sub">
              {name.trim() || 'Warden'} · {starterDef.name} · slot {slot + 1}. The starter cannot be changed later; it
              is what the codex remembers you by.
            </p>
            <div className="modal-actions">
              <Button
                variant="primary"
                onClick={() => {
                  setConfirming(false);
                  finalise();
                }}
              >
                CREATE WARDEN
              </Button>
              <Button onClick={() => setConfirming(false)}>NOT YET</Button>
            </div>
          </ModalCard>
        </div>
      ) : null}
    </Screen>
  );
}
