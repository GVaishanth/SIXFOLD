import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ALL_ELEMENTS, ELEMENT_REGISTRY, computeResonances } from '@/data/elements';
import { bestLoadout } from '@/game/systems/loadoutAdvisor';
import { createPortal } from 'react-dom';
import { autoCastAccuracy } from '@/game/systems/autoCast';
import { computePlayerStats, liveRunBuffs } from '@/game/systems/statEngine';
import { gameBus } from '@/game/systems/eventBus';
import { useSaveStore } from '@/store/saveStore';
import { useUiStore } from '@/store/uiStore';
import type { ElementId } from '@/types';
import { Button, Panel, pressRefusal, StatCell, Tag } from '@/components/ui/primitives';
import { ElementChip, ElementDetailCard, masteryDetails } from '@/components/ui/elementVisuals';
import { Pager } from '@/components/ui/Pager';
import { Screen } from '@/components/ui/Screen';

/**
 * Loadout screen.
 *
 * Six slots, no duplicates, at least one element equipped.
 *
 * The picker used to live at the bottom of the page while the slots lived at the
 * top, which made the only "real" interaction — dragging an element 600 px across
 * a phone — unusable on touch. Two paths replace it: tap a slot and the element
 * chooser opens *inside* that slot, or press EQUIP on any element and it lands in
 * the first free slot. Drag and drop is still there for a mouse, and AUTO-BEST
 * does the whole job in one press.
 */
export function LoadoutScreen() {
  const back = useUiStore((s) => s.back);
  const pushToast = useUiStore((s) => s.pushToast);
  /**
   * Opened from the pause card rather than the hub, this screen is editing a run in
   * progress. `isRunSubscreen` in the scene is what keeps that run frozen while the
   * screen is up; the band reads `paused` because that is the flag the pause card set
   * on the way in, and a note claiming a frozen simulation had to be true by
   * construction rather than by inference from the navigation stack.
   */
  const inRun = useUiStore((s) => s.paused);
  const data = useSaveStore(useShallow((s) => s.data));
  const setLoadout = useSaveStore((s) => s.setLoadout);

  const [picked, setPicked] = useState<ElementId | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [selected, setSelected] = useState<ElementId | null>(null);
  /** The slot whose chooser is open — the picker opens where the work is. */
  const [chooser, setChooser] = useState<number | null>(null);
  const [onlyFree, setOnlyFree] = useState(false);
  const chooserRef = useRef<HTMLDivElement | null>(null);
  /** Where the anchored picker sits, measured from the slot that asked for it. */
  const [chooserStyle, setChooserStyle] = useState<React.CSSProperties | null>(null);
  /** The slot the picker is hanging off, so a scroll can move it instead of closing it. */
  const chooserFrom = useRef<HTMLElement | null>(null);

  /**
   * The picker opens *beside* the slot rather than inside it.
   *
   * Inline, a popover grows the slot card, reflows the grid under it and can be
   * clipped by the panel's own overflow — and a six-hundred-pixel walk to an
   * element list is what made this screen awkward to use in the first place. So
   * the chooser is portalled to the document, measured from the slot's rect,
   * width-matched to it, and flipped above when the viewport is short below.
   */
  const toggleChooser = (next: number | null, from: HTMLElement | null): void => {
    if (next === null || !from) {
      setChooser(null);
      setChooserStyle(null);
      chooserFrom.current = null;
      return;
    }
    setChooser(next);
    chooserFrom.current = from;
    positionChooser();
  };

  /**
   * Measure the picker against its slot. Scroll and resize run through here, so the
   * popover follows the slot it belongs to rather than being dismissed by a wheel
   * — and it only lets go once the slot has actually left the screen.
   */
  const positionChooser = (): void => {
    const from = chooserFrom.current;
    if (!from) return;
    const rect = from.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 300), window.innerWidth - 20);
    const left = Math.min(Math.max(10, rect.left), Math.max(10, window.innerWidth - width - 10));
    const opensUp = rect.bottom + 300 > window.innerHeight && rect.top > window.innerHeight - rect.bottom;
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      setChooser(null);
      setChooserStyle(null);
      return;
    }
    const style: React.CSSProperties = { left, width };
    if (opensUp) style.bottom = Math.max(10, window.innerHeight - rect.top + 6);
    else style.top = Math.min(rect.bottom + 6, window.innerHeight - 48);
    setChooserStyle(style);
  };

  const slots = data?.loadout.slots ?? [null, null, null, null, null, null];
  const activeSlot = data?.loadout.activeSlot ?? 0;
  const unlocked = data?.unlockedElements ?? [];

  const resonances = useMemo(() => computeResonances(slots), [slots]);
  /* Run buffs belong in the number this panel quotes — and it opens from the pause
     menu too, where a live buff is in effect. Same helper the scene uses, with `null`
     for the clock because a screen has no scene time. */
  const stats = useMemo(
    () => computePlayerStats(data, slots[activeSlot] ?? slots.find(Boolean) ?? null, liveRunBuffs(data, null)),
    [data, slots, activeSlot],
  );

  const equippedList = useMemo(() => slots.filter(Boolean) as ElementId[], [slots]);

  const unlockedPool = useMemo(() => ALL_ELEMENTS.filter((def) => unlocked.includes(def.id)), [unlocked]);
  const nothingFree = useMemo(
    () => unlockedPool.every((def) => equippedList.includes(def.id)),
    [unlockedPool, equippedList],
  );

  const chooserOptions = useMemo(() => {
    // A filter with nothing left to offer is a dead end, not a decision. When
    // every unlocked element is already placed, the list falls back to the whole
    // unlocked set — moving an element into this slot is still a real move.
    const filtering = onlyFree && !nothingFree;
    const pool = filtering ? unlockedPool.filter((def) => !equippedList.includes(def.id)) : unlockedPool;
    // The element this slot already holds is not a choice, it is the status quo.
    return [...pool].sort((a, b) =>
      equippedList.includes(a.id) === equippedList.includes(b.id)
        ? a.index - b.index
        : equippedList.includes(a.id)
          ? 1
          : -1,
    );
  }, [unlockedPool, onlyFree, nothingFree, equippedList]);

  const commit = (nextSlots: (ElementId | null)[], nextActive = activeSlot) => {
    const result = setLoadout(nextSlots, nextActive);
    if (!result.ok) {
      pushToast({ title: 'LOADOUT REJECTED', body: result.reason, color: '#FF5C6C' });
      return false;
    }
    gameBus.emit('command:setLoadout', { slots: nextSlots, activeSlot: nextActive });
    return true;
  };

  const place = (index: number, element: ElementId) => {
    const next = [...slots];
    const existing = next.indexOf(element);
    if (existing >= 0) next[existing] = next[index];
    next[index] = element;
    // Placing also aims the new element: a slot you just filled is the slot you
    // want to look through, and it saves a second trip to the same cell.
    if (commit(next, index)) {
      setPicked(null);
      setChooser(null);
      setChooserStyle(null);
      chooserFrom.current = null;
      setSelected(element);
    }
  };

  const clear = (index: number) => {
    const next = [...slots];
    next[index] = null;
    if (next.filter(Boolean).length === 0) {
      pushToast({ title: 'KEEP ONE ELEMENT', body: 'At least one slot must stay filled.', color: '#FF5C6C' });
      return;
    }
    setChooser(null);
    setChooserStyle(null);
    commit(next, activeSlot === index ? Math.max(0, next.findIndex(Boolean)) : activeSlot);
  };

  const equipToFirstFree = (element: ElementId) => {
    const free = slots.findIndex((slot) => slot === null);
    const index = free >= 0 ? free : activeSlot;
    place(index, element);
  };

  const autoBest = () => {
    const advice = bestLoadout(unlocked, (id) => data?.mastery[id]?.xp ?? 0, 6);
    if (advice.slots.filter(Boolean).length === 0) {
      pushToast({ title: 'NOTHING TO PICK', body: 'No elements unlocked yet.', color: '#FF5C6C' });
      return;
    }
    if (commit(advice.slots, advice.activeSlot)) {
      setChooser(null);
      setChooserStyle(null);
      setSelected(advice.slots[0]);
      pushToast({
        title: 'AUTO-BEST APPLIED',
        body: advice.picks.map((pick) => `${ELEMENT_REGISTRY[pick.element].symbol} ${pick.why}`).join(' · '),
        color: '#F2C96B',
      });
    }
  };

  // Escape closes the chooser, and focus returns to the slot it was opened from.
  useEffect(() => {
    if (chooser === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setChooser(null);
    };
    const onClickAway = (event: PointerEvent) => {
      if (chooserRef.current?.contains(event.target as Node)) return;
      if ((event.target as HTMLElement | null)?.closest?.('.slot-drop')) return;
      setChooser(null);
    };
    const onMove = () => positionChooser();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onClickAway, true);
    window.addEventListener('resize', onMove, true);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove, true);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onClickAway, true);
    };
  }, [chooser]);

  const selectedElement = selected ?? slots[activeSlot] ?? null;
  const loadoutFull = slots.every((slot) => slot !== null);

  const offence = (
    <div className="stat-grid">
      <StatCell label="Attack" value={stats.attack.toFixed(1)} />
      <StatCell label="Crit chance" value={`${Math.round(stats.critChance * 100)}%`} />
      <StatCell label="Crit damage" value={`${Math.round(stats.critDamage * 100)}%`} />
      <StatCell label="Cooldown" value={`${Math.round((1 - stats.cooldownReduction) * 100)}%`} />
      <StatCell label="Lifesteal" value={`${Math.round(stats.lifesteal * 100)}%`} />
      <StatCell label="Thorns" value={`${Math.round(stats.thorns * 100)}%`} />
    </div>
  );

  const survival = (
    <div className="stat-grid">
      <StatCell label="Max health" value={Math.round(stats.maxHp)} />
      <StatCell label="Max energy" value={Math.round(stats.maxEnergy)} />
      <StatCell label="Armour" value={Math.round(stats.defense)} />
      <StatCell label="Move speed" value={Math.round(stats.speed)} />
      <StatCell label="Regen" value={`${stats.regen.toFixed(1)}/s`} />
      <StatCell label="Evasion" value={`${Math.round(stats.evasion * 100)}%`} />
    </div>
  );

  return (
    <Screen className="loadout-screen">
      <div className="screen-inner scroll-y">
        <header className="ambient-header">
          <div className="row between" style={{ alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h1 className="title-xl">LOADOUT</h1>
              <p className="subtitle">
                Your active element fires where you aim. Every other equipped element casts on its own at the nearest
                target — 50% accuracy at level 1, sharper as its mastery grows.
              </p>
              {inRun ? (
                <p className="tiny live-run-note" role="status">
                  LIVE RUN · the simulation is frozen and every press applies at once. Health is preserved; run buffs
                  ride with their element, not the slot.
                </p>
              ) : null}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <Tag tone={resonances.length ? 'gold' : 'default'}>{resonances.length} RESONANCES</Tag>
              <Tag>{slots.filter(Boolean).length}/6 FILLED</Tag>
            </div>
          </div>
        </header>

        <div className="grid loadout-grid">
          <div className="col loadout-left">
            <Panel
              title="SIX SLOTS"
              action={
                <Button size="small" variant="primary" onClick={autoBest} title="Fill all six slots from what you have unlocked, by mastery, tier and resonance.">
                  AUTO-BEST
                </Button>
              }
            >
              <div className="grid cols-3">
                {slots.map((element, index) => {
                  const def = element ? ELEMENT_REGISTRY[element] : null;
                  const open = chooser === index;
                  return (
                    <div
                      key={`slot-${index}`}
                      className={`slot-drop ${def ? 'filled' : ''} ${activeSlot === index ? 'active' : ''} ${
                        dragOver === index ? 'drag-over' : ''
                      } ${open ? 'choosing' : ''}`}
                      style={def ? { borderLeft: `3px solid ${def.color}` } : undefined}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragOver(index);
                      }}
                      onDragLeave={() => setDragOver((current) => (current === index ? null : current))}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragOver(null);
                        const id = event.dataTransfer.getData('text/sixfold-element') as ElementId;
                        if (id && ELEMENT_REGISTRY[id]) place(index, id);
                      }}
                      onClick={(click) => {
                        if (picked) {
                          place(index, picked);
                          return;
                        }
                        setOnlyFree(!def);
                        toggleChooser(open ? null : index, open ? null : (click.currentTarget as HTMLElement));
                      }}
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      aria-label={`Slot ${index + 1}${def ? `: ${def.name}` : ': empty'}`}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          toggleChooser(open ? null : index, open ? null : (event.currentTarget as HTMLElement));
                        }
                      }}
                    >
                      <div className="row between">
                        <span className="tiny muted">SLOT {index + 1}</span>
                        {activeSlot === index ? (
                          <span className="tiny gold">IN YOUR HANDS</span>
                        ) : def ? (
                          <span className="tiny muted" title="Auto-cast accuracy — it rises with this element's mastery level.">
                            AUTO {Math.round(autoCastAccuracy(masteryDetails(data, def.id).level) * 100)}%
                          </span>
                        ) : (
                          <span className="tiny muted">EMPTY</span>
                        )}
                      </div>
                      {def ? (
                        <>
                          <span style={{ color: def.color, fontWeight: 700 }}>{def.name.toUpperCase()}</span>
                          <span className="tiny muted">
                            LV {masteryDetails(data, def.id).level} · {def.identity}
                          </span>
                          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="btn small"
                              onClick={(event) => {
                                event.stopPropagation();
                                if (pressRefusal(activeSlot === index, 'this slot is already the one you are aiming')) return;
                                commit(slots, index);
                              }}
                              aria-disabled={activeSlot === index || undefined}
                              title={activeSlot === index ? 'This slot is already aiming' : 'Aim this element'}
                              data-reason={activeSlot === index ? 'this slot is already the one you are aiming' : undefined}
                            >
                              SET ACTIVE
                            </button>
                            <button
                              type="button"
                              className="btn small"
                              onClick={(event) => {
                                event.stopPropagation();
                                clear(index);
                              }}
                            >
                              CLEAR
                            </button>
                          </div>
                        </>
                      ) : (
                        <span className="tiny muted">{picked ? 'TAP TO PLACE' : 'TAP TO PICK AN ELEMENT'}</span>
                      )}

                    </div>
                  );
                })}
              </div>

              <div className="separator" />
              <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span className="tiny muted">
                  {slots.filter(Boolean).length}/6 filled · {resonances.length} resonance
                  {resonances.length === 1 ? '' : 's'} · drag on desktop, tap anywhere
                </span>
                {picked ? (
                  <span className="tiny gold">PLACING: {ELEMENT_REGISTRY[picked].name.toUpperCase()}</span>
                ) : null}
              </div>
            </Panel>

            <Panel title="UNLOCKED ELEMENTS" className="flush">
              <div className="element-list">
                {ALL_ELEMENTS.filter((def) => unlocked.includes(def.id)).map((def) => (
                  <div key={def.id} className="element-row" draggable onDragStart={(event) => {
                    event.dataTransfer.setData('text/sixfold-element', def.id);
                    setPicked(def.id);
                  }}
                    onDragEnd={() => setPicked(null)}>
                    <ElementChip
                      element={def.id}
                      equipped={slots.includes(def.id)}
                      masteryText={`Lv ${masteryDetails(data, def.id).level}`}
                      onClick={() => {
                        setPicked(def.id);
                        setSelected(def.id);
                        pushToast({
                          title: `${def.name.toUpperCase()} PICKED`,
                          body: 'Tap a slot to place it.',
                          color: def.color,
                          glyph: def.symbol,
                        });
                      }}
                    />
                    <button
                      type="button"
                      className="btn small equip-btn"
                      onClick={() => {
                        if (
                          pressRefusal(
                            slots.includes(def.id) && slots[activeSlot] === def.id,
                            'this element is already in the slot you are aiming',
                          )
                        )
                          return;
                        equipToFirstFree(def.id);
                      }}
                      aria-disabled={(slots.includes(def.id) && slots[activeSlot] === def.id) || undefined}
                      data-reason={
                        slots.includes(def.id) && slots[activeSlot] === def.id
                          ? 'this element is already in the slot you are aiming'
                          : undefined
                      }
                      title={
                        slots.includes(def.id)
                          ? 'Move this element to the next free slot and aim it'
                          : loadoutFull
                            ? 'Replaces the element you are currently aiming with this one'
                            : 'Put this element in the first free slot'
                      }
                    >
                      {slots.includes(def.id) ? 'AIM' : loadoutFull ? 'REPLACE' : 'EQUIP'}
                    </button>
                  </div>
                ))}
              </div>
              <p className="tiny muted" style={{ marginTop: 8 }}>
                {unlocked.length} of 25 elements unlocked. Locked elements are revealed in the codex as silhouettes so
                you know what is still out there.
              </p>
            </Panel>
          </div>

          <div className="col loadout-right">
            <Panel title="DERIVED STATS">
              <Pager pages={[{ label: 'OFFENCE', node: offence }, { label: 'SURVIVAL', node: survival }]} ariaLabel="Derived stats" />
              <p className="tiny muted" style={{ margin: '8px 0 0' }}>
                Numbers follow the element in the active slot. Slide, or use the arrows and the left and right keys.
              </p>
            </Panel>

            <Panel title="ELEMENT DETAIL">
              {selectedElement ? (
                <ElementDetailCard def={ELEMENT_REGISTRY[selectedElement]} data={data} />
              ) : (
                <p className="small muted" style={{ margin: 0 }}>
                  Select an equipped element to inspect its combat identity, abilities and mastery bonuses.
                </p>
              )}
            </Panel>
          </div>
        </div>

        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          <Button onClick={back}>BACK</Button>
          <Button
            size="small"
            onClick={() => {
              const filled = slots.filter(Boolean) as ElementId[];
              const compacted: (ElementId | null)[] = [...filled];
              while (compacted.length < 6) compacted.push(null);
              commit(compacted.slice(0, 6), 0);
            }}
          >
            AUTO-COMPACT SLOTS
          </Button>
          <span className="tag gold">ACTIVE SLOT {activeSlot + 1}</span>
        </div>
      </div>
      {/* Portalled so the picker is never clipped by a panel and never reflows the grid. */}
      {chooser !== null && chooserStyle
        ? createPortal(
            <div
              className="slot-chooser"
                    ref={chooserRef}
                    style={chooserStyle}
                    role="dialog"
                    aria-label={`Choose an element for slot ${chooser + 1}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="row between chooser-head">
                      <span className="tiny muted">
                        {chooserOptions.length} AVAILABLE
                      </span>
                      <button
                        type="button"
                        className={`chip-toggle ${onlyFree ? 'on' : ''}`}
                        onClick={() => setOnlyFree((value) => !value)}
                        aria-pressed={onlyFree}
                      >
                        {onlyFree ? 'NOT EQUIPPED' : 'ALL'}
                      </button>
                    </div>
                    {nothingFree ? (
                      <p className="tiny muted chooser-note">
                        Every element you have unlocked is already in the rig. Picking one moves it here and
                        vacates its old slot.
                      </p>
                    ) : null}
                    <div className="chooser-list">
                      {chooserOptions.map((def) => (
                        <button
                          key={def.id}
                          type="button"
                          className="chooser-item"
                          style={{ borderLeftColor: def.color }}
                          onClick={() => place(chooser, def.id)}
                        >
                          <span style={{ color: def.color, fontWeight: 700 }}>{def.symbol}</span>
                          <span>{def.name.toUpperCase()}</span>
                          <span className="tiny muted">LV {masteryDetails(data, def.id).level}</span>
                        </button>
                      ))}
                      {chooserOptions.length === 0 ? (
                        <span className="tiny muted">Everything unlocked is already equipped.</span>
                      ) : null}
                    </div>
                    <span className="tiny muted chooser-foot">TAP AN ELEMENT TO PUT IT HERE</span>
            </div>,
            document.body,
          )
        : null}

    </Screen>
  );
}
