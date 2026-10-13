import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ALL_ELEMENTS, ELEMENT_REGISTRY, RESONANCES } from '@/data/elements';
import { STATUS_REGISTRY } from '@/data/elements/statuses';
import { getBoss, BOSS_LIST } from '@/data/bosses';
import { FLOOR_LIST } from '@/data/floors';
import { ENEMY_REGISTRY, ENEMY_AFFIXES } from '@/data/enemies';
import { intToHex } from '@/utils/color';
import type { ElementId } from '@/types';
import { useSaveStore } from '@/store/saveStore';
import { useUiStore } from '@/store/uiStore';
import { Button, EmptyState, Panel, Tag } from '@/components/ui/primitives';
import { ElementDetailCard, ElementGlyph } from '@/components/ui/elementVisuals';
import { Screen } from '@/components/ui/Screen';
import { hazardLabel } from '@/game/world/hazards';
import { REACTIONS, type ReactionDef } from '@/data/elements/reactions';

type Tab = 'elements' | 'resonances' | 'enemies' | 'bosses' | 'floors' | 'statuses' | 'reactions';

/**
 * The codex.
 *
 * Locked elements are deliberately shown as silhouettes rather than hidden
 * entirely: the player should know how many elements exist and what they are
 * chasing. Everything else (enemies, wardens, floors, statuses, resonances) is
 * read straight from the data registries.
 */
export function CodexScreen() {
  const navigate = useUiStore((s) => s.navigate);
  const back = useUiStore((s) => s.back);
  const data = useSaveStore(useShallow((s) => s.data));
  const [tab, setTab] = useState<Tab>('elements');

  const unlocked = data?.unlockedElements ?? [];
  const discovered = data?.discoveredElements ?? [];
  const killedBosses = data?.story.replayableBosses ?? [];

  const [detail, setDetail] = useState<ElementId | null>(null);
  const enemyCount = Object.keys(ENEMY_REGISTRY).length;

  return (
    <Screen>
      <div className="screen-inner scroll-y">
        <header className="ambient-header">
          <div className="row between" style={{ alignItems: 'flex-end' }}>
            <div>
              <h1 className="title-xl">ELEMENT CODEX</h1>
              <p className="subtitle">
                {unlocked.length} of 25 elements unlocked · {discovered.length} discovered · 25 entries total.
              </p>
            </div>
            <Tag tone="gold">{killedBosses.length} WARDENS RECORDED</Tag>
          </div>
        </header>

        <div className="row" style={{ gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {(['elements', 'resonances', 'enemies', 'bosses', 'floors', 'statuses', 'reactions'] as Tab[]).map((entry) => (
            <Button key={entry} size="small" variant={tab === entry ? 'primary' : 'default'} onClick={() => setTab(entry)}>
              {entry.toUpperCase()}
            </Button>
          ))}
        </div>

        {tab === 'elements' ? (
          <div className="grid cols-2">
            <Panel title="REGISTRY">
              <div className="codex-grid">
                {ALL_ELEMENTS.map((def) => {
                  const isUnlocked = unlocked.includes(def.id);
                  const isDiscovered = discovered.includes(def.id);
                  return (
                    <button
                      key={def.id}
                      type="button"
                      className={`codex-card ${isUnlocked ? '' : 'locked'}`}
                      style={{
                        borderLeft: `3px solid ${isUnlocked || isDiscovered ? def.color : '#2A3850'}`,
                      }}
                      onClick={() => setDetail(def.id)}
                    >
                      <div className="row between">
                        <span className="codex-symbol" style={{ color: isUnlocked ? def.color : '#54607A' }}>
                          {isUnlocked || isDiscovered ? def.symbol : '??'}
                        </span>
                        <span className="tiny muted">{String(def.index).padStart(2, '0')}</span>
                      </div>
                      <div className="codex-meta">
                        <strong>{isUnlocked ? def.name : isDiscovered ? def.name : 'Locked'}</strong>
                        <span className="tiny muted">{def.tier}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </Panel>
            <Panel title="ENTRY">
              {detail ? (
                <ElementDetailCard def={ELEMENT_REGISTRY[detail]} data={data} />
              ) : (
                <EmptyState title="NO ENTRY SELECTED" body="Pick an element from the registry to read its combat identity, abilities and unlock condition." />
              )}
              {detail ? (
                <div className="row" style={{ marginTop: 10 }}>
                  <Button size="small" onClick={() => navigate('skilltree')}>
                    OPEN IN SKILL TREE
                  </Button>
                </div>
              ) : null}
            </Panel>
          </div>
        ) : null}

        {tab === 'resonances' ? (
          <Panel title="RESONANCES">
            <div className="grid cols-2">
              {RESONANCES.map((resonance) => {
                const active = resonance.requires.every((id) => (data?.loadout.slots ?? []).includes(id));
                return (
                  <div key={resonance.id} className={`relic-row ${active ? 'active' : ''}`} style={{ borderLeft: `3px solid ${resonance.color}` }}>
                    <div className="col" style={{ gap: 3 }}>
                      <div className="row between">
                        <strong style={{ color: resonance.color }}>{resonance.name}</strong>
                        <span className="tiny muted">{active ? 'ACTIVE' : 'INACTIVE'}</span>
                      </div>
                      <span className="tiny muted">{resonance.description}</span>
                      <span className="tiny">
                        Requires {resonance.requires.map((id) => ELEMENT_REGISTRY[id].name).join(' + ')}
                      </span>
                      <span className="tiny gold">
                        {resonance.effects
                          .map((effect) => `${effect.kind} ${typeof effect.value === 'number' ? effect.value : ''}`)
                          .join(' · ')}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        ) : null}

        {tab === 'enemies' ? (
          <div className="grid cols-2">
            <Panel title="ARCHETYPES">
              <div className="grid cols-2">
                {Object.values(ENEMY_REGISTRY).map((def) => (
                  <div key={def.id} className="relic-row">
                    <span className="legend-dot" style={{ background: intToHex(def.colorInt) }} />
                    <div className="col" style={{ gap: 2 }}>
                      <span>{def.name}</span>
                      <span className="tiny muted">
                        {def.archetype} · HP {def.hp} · DMG {def.damage}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="tiny muted" style={{ marginTop: 8 }}>
                {enemyCount} enemy definitions are live in the current build. Behaviour is driven by eight shared
                archetypes, so no enemy overrides the combat rules of another.
              </p>
            </Panel>
            <Panel title="MUTATIONS">
              <div className="col" style={{ gap: 6 }}>
                {Object.values(ENEMY_AFFIXES).map((affix) => (
                  <div key={affix.id} className="relic-row" style={{ borderLeft: `3px solid ${affix.color}` }}>
                    <div className="col" style={{ gap: 2 }}>
                      <strong style={{ color: affix.color }}>{affix.name}</strong>
                      <span className="tiny muted">{affix.description}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        ) : null}

        {tab === 'bosses' ? (
          <Panel title="WARDENS">
            <div className="grid cols-2">
              {BOSS_LIST.map((boss) => {
                const defeated = killedBosses.includes(boss.id);
                return (
                  <div key={boss.id} className="relic-row" style={{ borderLeft: `3px solid ${boss.color}` }}>
                    <ElementGlyph element={boss.element} dim={!defeated} />
                    <div className="col" style={{ gap: 2 }}>
                      <div className="row between">
                        <span>{boss.name}</span>
                        <span className="tiny muted">
                          {boss.rank === 'major' ? 'MAJOR' : 'MINI'} · W{boss.wave}
                        </span>
                      </div>
                      <span className="tiny muted">
                        {defeated ? boss.description.slice(0, 96) : `Undefeated. Encountered on floor ${boss.floor}, wave ${boss.wave}.`}
                      </span>
                      {defeated && boss.rewardElement ? (
                        <span className="tiny gold">Reward: {ELEMENT_REGISTRY[boss.rewardElement].name}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        ) : null}

        {tab === 'floors' ? (
          <Panel title="THE TEN FLOORS">
            <div className="grid cols-2">
              {FLOOR_LIST.map((floor) => {
                const reached = (data?.story.highestWave ?? 0) >= (floor.id - 1) * 20;
                return (
                  <div key={floor.id} className="relic-row" style={{ borderLeft: `3px solid ${floor.palette.ui}` }}>
                    <div className="col" style={{ gap: 2 }}>
                      <div className="row between">
                        <strong style={{ color: floor.palette.ui }}>
                          {floor.id}. {floor.name}
                        </strong>
                        <span className="tiny muted">{reached ? 'REACHED' : 'UNDISCOVERED'}</span>
                      </div>
                      <span className="tiny muted">{reached ? floor.subtitle : 'Clear the previous floor to reveal this one.'}</span>
                      {reached ? (
                        <span className="tiny">
                          Hazard: {hazardLabel(floor.hazard.kind)} · Warden: {getBoss(floor.majorBossId)?.name}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        ) : null}

        {tab === 'statuses' ? (
          <Panel title="STATUS EFFECTS">
            <div className="grid cols-2">
              {Object.values(STATUS_REGISTRY).map((status) => (
                <div key={status.id} className="relic-row" style={{ borderLeft: `3px solid ${intToHex(status.color)}` }}>
                  <div className="col" style={{ gap: 2 }}>
                    <strong style={{ color: intToHex(status.color) }}>{status.name}</strong>
                    <span className="tiny muted">{status.description}</span>
                    <span className="tiny">
                      {status.stackMode} · max {status.maxStacks} · {status.duration}s
                      {status.dotPerSecond ? ` · ${status.dotPerSecond}/s` : ''}
                      {status.moveMultiplier !== undefined ? ` · move ×${status.moveMultiplier}` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        ) : null}

        {tab === 'reactions' ? (
          <Panel title="ELEMENTAL REACTIONS">
            <p className="tiny muted" style={{ marginTop: 0 }}>
              Reactions are rules about the world, not moves: any source of the right element landing on a
              target carrying the right status sets one off — your attacks, a projectile, a field, even the
              floor itself.
            </p>
            <div className="grid cols-2">
              {REACTIONS.map((reaction) => {
                const state = reactionState(reaction, unlocked, discovered);
                return (
                  <div
                    key={reaction.id}
                    className="relic-row"
                    style={{ borderLeft: `3px solid ${state === 'locked' ? '#293850' : reaction.color}` }}
                  >
                    <div className="col" style={{ gap: 3 }}>
                      <strong style={{ color: state === 'locked' ? 'var(--text-dim)' : reaction.color }}>
                        {state === 'locked' ? '?????' : reaction.name}
                      </strong>
                      <span className="tiny muted">
                        {state === 'locked'
                          ? `Requires an element you have not found${reaction.elements.length > 2 ? ` (or one of ${reaction.elements.length - 1} others)` : ''}.`
                          : reaction.short}
                      </span>
                      {state === 'locked' ? (
                        <span className="tiny">ORIGIN: UNKNOWN · {REACTIONS.length} PATTERNS THEORISED</span>
                      ) : (
                        <>
                          <span className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
                            {reaction.elements.map((element) => (
                              <ElementGlyph key={element} element={element} size={11} dim={!unlocked.includes(element)} />
                            ))}
                            <span className="tiny">+ {reaction.consumes.join(' / ')} status</span>
                          </span>
                          <span className="tiny muted">
                            ×{reaction.burstMultiplier} burst
                            {reaction.field ? ` · ${reaction.field.radius} field, ${reaction.field.duration}s` : ''}
                            {reaction.chain ? ` · chains ${reaction.chain.jumps} × ${reaction.chain.radius}` : ''}
                            {reaction.applies.length ? ` · leaves ${reaction.applies.map((a) => a.id).join(', ')}` : ''}
                            {reaction.knockback ? ` · ${reaction.knockback} knockback` : ''}
                          </span>
                          {state === 'teased' ? (
                            <span className="tiny">CONFIRMED ONLY BY USE — carry the status, land the element.</span>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        ) : null}

        <div className="row" style={{ marginTop: 12 }}>
          <Button onClick={back}>BACK</Button>
        </div>
      </div>
    
    </Screen>
  );
}

/**
 * What the codex is allowed to say about a reaction. Nothing is spelled out
 * until the player owns an element that could start it: a discovered-but-not-
 * unlocked element gets the tease, an unknown one gets the shape of the hole.
 */
function reactionState(
  reaction: ReactionDef,
  unlocked: readonly ElementId[],
  discovered: readonly ElementId[],
): 'confirmed' | 'teased' | 'locked' {
  if (reaction.elements.some((element) => unlocked.includes(element))) return 'confirmed';
  if (reaction.elements.some((element) => discovered.includes(element))) return 'teased';
  return 'locked';
}
