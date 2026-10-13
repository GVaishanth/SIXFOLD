import { useCallback, useMemo, useState } from 'react';
import { SAVE_SLOT_COUNT } from '@/types';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { formatTime, formatNumber } from '@/utils/math';
import { getSlotMetas } from '@/app/saveService';
import { useSaveStore } from '@/store/saveStore';
import { useUiStore } from '@/store/uiStore';
import { audioEngine } from '@/game/systems/audio';
import { success } from '@/utils/motion';
import { Button, EmptyState, KV, ModalCard, Tag } from '@/components/ui/primitives';
import { Screen } from '@/components/ui/Screen';

type Mode = 'load' | 'new';

/**
 * The vault.
 *
 * Slots are not cards in a grid: they are crystals on plinths, coloured by the
 * element the warden started with, lit in proportion to how far that warden got.
 * Hovering reveals the ledger; pressing fires the crystal once and asks before
 * it destroys anything. Three slots, and an occupied one is never overwritten
 * without an explicit confirmation.
 */
export function SlotSelectScreen() {
  const navigate = useUiStore((s) => s.navigate);
  const setWorkingSlot = useUiStore((s) => s.setWorkingSlot);
  const pushToast = useUiStore((s) => s.pushToast);
  const file = useSaveStore((s) => s.file);
  // Derived from the file reference rather than calling the store getter inside
  // the selector, which would return a fresh array on every render.
  const metas = useMemo(() => getSlotMetas(file), [file]);
  const activeSlot = useSaveStore((s) => s.activeSlot);
  const selectSlot = useSaveStore((s) => s.selectSlot);
  const deleteSave = useSaveStore((s) => s.deleteSave);

  const [mode, setMode] = useState<Mode>(file.slots.some(Boolean) ? 'load' : 'new');
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<number | null>(null);
  const [reveal, setReveal] = useState<number | null>(null);

  const ignite = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const shards = node.querySelectorAll<HTMLElement>('.crystal-spark');
    shards.forEach((shard, index) => {
      shard.animate(
        [
          { opacity: 0, transform: 'translate(0, 0) scale(0.4)' },
          { opacity: 1, transform: `translate(${(index % 2 ? 1 : -1) * (6 + index * 3)}px, ${-10 - index * 2}px) scale(1)`, offset: 0.35 },
          { opacity: 0, transform: `translate(${(index % 2 ? 1 : -1) * (14 + index * 5)}px, ${-24 - index * 4}px) scale(0.4)` },
        ],
        { duration: 620, delay: index * 22, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' },
      );
    });
  }, []);

  const handleSlot = (slot: number, node: HTMLElement | null) => {
    const meta = metas[slot];
    ignite(node);
    if (mode === 'load') {
      if (meta.empty) {
        audioEngine.play('ui_deny');
        pushToast({ title: 'EMPTY PLINTH', body: 'Switch to NEW WARDEN to raise one here.', color: '#8B96A9' });
        return;
      }
      selectSlot(slot);
      success(node);
      pushToast({ title: 'SLOT LINKED', body: meta.name, color: '#6BE39A' });
      navigate('hub');
      return;
    }

    if (!meta.empty) {
      setPendingOverwrite(slot);
      return;
    }
    success(node);
    setWorkingSlot(slot);
    navigate('newgame');
  };

  return (
    <Screen>
      <div className="screen-inner vault-inner">
        <header className="vault-head" data-anim="lead">
          <div>
            <span className="panel-kicker">LOCAL ARCHIVE</span>
            <h1 className="title-xl">THE VAULT</h1>
          </div>
          <div className="mode-switch" role="group" aria-label="Vault mode">
            <button
              type="button"
              className={`mode-option ${mode === 'load' ? 'is-on' : ''}`}
              onClick={() => setMode('load')}
            >
              LINK EXISTING
            </button>
            <button
              type="button"
              className={`mode-option ${mode === 'new' ? 'is-on' : ''}`}
              onClick={() => setMode('new')}
            >
              NEW WARDEN
            </button>
          </div>
        </header>

        <p className="vault-note">
          {mode === 'load'
            ? 'Choose a crystal to bind this session to it. Nothing is written until a wave, warden or floor is cleared.'
            : 'An empty plinth raises a new warden. An occupied one asks before it erases anything.'}
        </p>

        <div className="slot-vault">
          {Array.from({ length: SAVE_SLOT_COUNT }, (_, index) => {
            const meta = metas[index];
            const def = meta.starter ? ELEMENT_REGISTRY[meta.starter] : undefined;
            const fill = def?.color ?? '#26324a';
            const core = def?.colorCore ?? '#111827';
            // Progress decides how bright a crystal burns — the glow is data.
            const charge = meta.empty ? 0 : Math.min(1, 0.25 + meta.highestWave / 200);
            return (
              <div
                key={`slot-${index}`}
                role="button"
                tabIndex={0}
                className={`slot-plinth ${meta.empty ? 'is-empty' : ''} ${reveal === index ? 'is-open' : ''}`}
                style={
                  {
                    '--slot-color': fill,
                    '--slot-core': core,
                    '--slot-charge': charge,
                  } as React.CSSProperties
                }
                onMouseEnter={() => setReveal(index)}
                onMouseLeave={() => setReveal((current) => (current === index ? null : current))}
                onFocus={() => setReveal(index)}
                onBlur={() => setReveal((current) => (current === index ? null : current))}
                onClick={(event) => handleSlot(index, event.currentTarget)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  handleSlot(index, event.currentTarget);
                }}
                aria-label={meta.empty ? `Slot ${index + 1}: empty` : `Slot ${index + 1}: ${meta.name}`}
              >
                <span className="crystal" aria-hidden="true">
                  <svg viewBox="0 0 40 56" role="presentation">
                    <defs>
                      <linearGradient id={`crystal-${index}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={fill} />
                        <stop offset="100%" stopColor={core} />
                      </linearGradient>
                    </defs>
                    <polygon
                      points="20,2 37,18 30,52 10,52 3,18"
                      fill={meta.empty ? 'none' : `url(#crystal-${index})`}
                      stroke={fill}
                      strokeWidth="1.5"
                      opacity={meta.empty ? 0.32 : 0.92}
                    />
                    {!meta.empty ? (
                      <>
                        <polyline points="20,2 20,52" stroke="rgba(255,255,255,0.35)" strokeWidth="1" fill="none" />
                        <polyline points="3,18 20,26 37,18" stroke="rgba(255,255,255,0.25)" strokeWidth="1" fill="none" />
                        <polygon points="20,26 30,52 10,52" fill="rgba(4,6,12,0.35)" />
                      </>
                    ) : null}
                  </svg>
                  <i className="crystal-spark" />
                  <i className="crystal-spark" />
                  <i className="crystal-spark" />
                  <i className="crystal-spark" />
                  <i className="crystal-spark" />
                  <i className="crystal-spark" />
                </span>

                <span className="plinth-plate">
                  <span className="plinth-slot">SLOT {index + 1}</span>
                  <span className="plinth-name">{meta.empty ? 'UNBOUND' : meta.name}</span>
                  {index === activeSlot && !meta.empty ? <Tag tone="gold">LINKED</Tag> : null}
                </span>

                {meta.empty ? (
                  <span className="plinth-hint">
                    <EmptyState glyph="◇" title="NO SIGNATURE" body="Raise a warden on this plinth." />
                  </span>
                ) : (
                  <>
                    <span className="plinth-summary">
                      WAVE {meta.highestWave} · FLOOR {meta.floor} · {meta.unlockedCount}/25 ELEMENTS
                    </span>
                    <span className="plinth-ledger">
                      <KV label="Starter" value={def?.name ?? '—'} accent={fill} />
                      <KV label="Essence" value={formatNumber(file.slots[index]?.progression.essence ?? 0)} />
                      <KV label="Ascension" value={meta.highestAscensionWave ? `W${meta.highestAscensionWave}` : '—'} />
                      <KV label="Playtime" value={formatTime(meta.playtime)} />
                      {meta.corrupted ? (
                        <span className="tiny danger">
                          Damaged and repaired from defaults — playable, but some history is lost.
                        </span>
                      ) : null}
                      <span className="plinth-actions" onClick={(event) => event.stopPropagation()}>
                        <Button size="small" variant="primary">
                          {mode === 'load' ? 'LINK' : 'REPLACE'}
                        </Button>
                        {pendingDelete === index ? (
                          <>
                            <Button
                              size="small"
                              variant="danger"
                              onClick={() => {
                                deleteSave(index);
                                setPendingDelete(null);
                                pushToast({ title: 'CRYSTAL SHATTERED', body: `Slot ${index + 1} is empty.`, color: '#FF5C6C' });
                              }}
                            >
                              CONFIRM
                            </Button>
                            <Button size="small" onClick={() => setPendingDelete(null)}>
                              KEEP
                            </Button>
                          </>
                        ) : (
                          <Button size="small" variant="ghost" onClick={() => setPendingDelete(index)}>
                            SHATTER
                          </Button>
                        )}
                      </span>
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {pendingOverwrite !== null ? (
          <div className="overlay-layer" role="dialog" aria-modal="true" aria-label="Overwrite slot">
            <ModalCard label="DESTRUCTION" tone="danger" onEscape={() => setPendingOverwrite(null)}>
              <h2 className="overlay-title danger">ERASE SLOT {pendingOverwrite + 1}?</h2>
              <p className="overlay-sub">
                {metas[pendingOverwrite].name} — wave {metas[pendingOverwrite].highestWave},{' '}
                {metas[pendingOverwrite].unlockedCount} elements. The crystal is ground to dust and a new warden takes
                its place. This cannot be undone.
              </p>
              <div className="modal-actions">
                <Button
                  variant="danger"
                  onClick={() => {
                    deleteSave(pendingOverwrite);
                    setWorkingSlot(pendingOverwrite);
                    setPendingOverwrite(null);
                    navigate('newgame');
                  }}
                >
                  ERASE AND RAISE
                </Button>
                <Button onClick={() => setPendingOverwrite(null)}>KEEP IT</Button>
              </div>
            </ModalCard>
          </div>
        ) : null}

        <div className="vault-foot">
          <Button onClick={() => navigate('mainmenu')}>BACK</Button>
          <span className="tiny muted">
            {metas.filter((m) => !m.empty).length}/{SAVE_SLOT_COUNT} plinths bound · stored in this browser only
          </span>
        </div>
      </div>
    </Screen>
  );
}
