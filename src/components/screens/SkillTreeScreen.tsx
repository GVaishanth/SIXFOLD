import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ALL_ELEMENTS, ELEMENT_REGISTRY } from '@/data/elements';
import { MASTERY } from '@/config/gameConfig';
import {
  masteryBonuses,
  masteryLevelFromXp,
  shardUnlockEligible,
  xpForNextLevel,
} from '@/game/systems/elementProgression';
import { formatNumber } from '@/utils/math';
import { useSaveStore } from '@/store/saveStore';
import { useUiStore } from '@/store/uiStore';
import type { ElementId } from '@/types';
import { Button, KV, Panel, StatCell, Tag } from '@/components/ui/primitives';
import { Screen } from '@/components/ui/Screen';
import { layoutSkillTree } from '@/utils/treeLayout';

const NODE_SIZE = 54;

/**
 * Skill tree — the flagship progression screen.
 *
 * All 25 elements are laid out as a real branching graph (parents → children),
 * including the ones still locked, which appear as dim silhouettes with their
 * unlock condition. It fully pauses gameplay: opening it freezes the simulation
 * (enemies, timers, projectiles) exactly like the pause menu does.
 */
export function SkillTreeScreen() {
  const back = useUiStore((s) => s.back);
  const pushToast = useUiStore((s) => s.pushToast);
  const data = useSaveStore(useShallow((s) => s.data));
  const focusUnlock = useSaveStore((s) => s.focusUnlockElement);

  const [selected, setSelected] = useState<ElementId>(() => data?.profile.starter ?? 'fire');
  const [hovered, setHovered] = useState<ElementId | null>(null);

  const unlocked = data?.unlockedElements ?? [];
  const shards = data?.progression.shards ?? 0;

  /*
   * Generations run top to bottom: depth from the parent chain, ordered within a
   * row by the parents' own position. Rings looked like a scatter plot and made
   * every lineage line cross the middle of the diagram, so the structure is laid
   * out by `utils/treeLayout` instead — see that file for the relaxation.
   */
  const tree = useMemo(() => layoutSkillTree({ nodeSize: NODE_SIZE }), []);
  const layout = tree.points;
  const TREE_WIDTH = tree.width;
  const TREE_HEIGHT = tree.height;

  const selectedDef = ELEMENT_REGISTRY[selected];
  const selectedXp = data?.mastery[selected]?.xp ?? 0;
  const level = masteryLevelFromXp(selectedXp);
  const progress = xpForNextLevel(selectedXp);
  const bonuses = masteryBonuses(selected, selectedXp);
  const isUnlocked = unlocked.includes(selected);
  const eligibility = shardUnlockEligible(selected, unlocked, shards);

  const lines = useMemo(
    () =>
      ALL_ELEMENTS.flatMap((def) =>
        def.parents.map((parent) => ({
          key: `${parent}-${def.id}`,
          from: layout[parent],
          to: layout[def.id],
          color: ELEMENT_REGISTRY[parent].color,
          lit: unlocked.includes(parent),
        })),
      ),
    [layout, unlocked],
  );

  /*
   * The structure keeps a minimum pixel width so its labels stay legible, which
   * means a narrow frame cannot show all of it at once. Say so, and only where
   * it is actually true: the fade and the hint both key off this measurement.
   */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [pannable, setPannable] = useState(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const measure = (): void => setPannable(wrap.scrollWidth > wrap.clientWidth + 8);
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(wrap);
    return () => observer?.disconnect();
  }, []);

  return (
    <Screen className="tree-screen">
      <div className="screen-inner scroll-y">
        <header className="ambient-header">
          <div className="row between" style={{ alignItems: 'flex-end' }}>
            <div>
              <h1 className="title-xl">SKILL TREE</h1>
              <p className="subtitle">
                Mastery is earned by fighting with an element. Level it up to raise its damage, status duration,
                cooldown recovery and ultimate efficiency.
              </p>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <Tag tone="gold">{formatNumber(shards)} SHARDS</Tag>
              <Tag>{unlocked.length} / 25 UNLOCKED</Tag>
              {pannable ? <span className="tree-pan-hint">DRAG THE STRUCTURE TO PAN</span> : null}
            </div>
          </div>
        </header>

        <div className="skill-tree-wrap" ref={wrapRef} data-pannable={pannable ? 'x' : undefined}>
          <svg
            className="skill-tree-svg"
            viewBox={`0 0 ${TREE_WIDTH} ${TREE_HEIGHT}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Element skill tree"
          >
            {/* Generation strata: the row rules and their labels are what make the
                diagram read as generations rather than a cloud of glyphs. */}
            <g className="tree-rows" aria-hidden>
              {tree.rows.map((row) => (
                <g key={`row-${row.row}`}>
                  <line
                    className="tree-row-rule"
                    x1={0}
                    y1={row.y + NODE_SIZE / 2 + 34}
                    x2={TREE_WIDTH}
                    y2={row.y + NODE_SIZE / 2 + 34}
                  />
                  <text className="tree-row-label" x={16} y={row.y - NODE_SIZE / 2 - 16}>
                    {row.label}
                  </text>
                </g>
              ))}
            </g>

            {lines.map((line) =>
              line.from && line.to ? (
                <path
                  key={line.key}
                  className={`node-link${line.lit ? ' lit' : ''}`}
                  d={`M ${line.from.x} ${line.from.y + NODE_SIZE / 2 - 4}
                      C ${line.from.x} ${line.from.y + 58}, ${line.to.x} ${line.to.y - 62}, ${line.to.x} ${line.to.y - NODE_SIZE / 2 + 4}`}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={line.lit ? 2 : 1}
                  strokeOpacity={line.lit ? 0.66 : 0.3}
                  strokeDasharray={line.lit ? '5 9' : '3 4'}
                />
              ) : null,
            )}

            {ALL_ELEMENTS.map((def) => {
              const point = layout[def.id];
              if (!point) return null;
              const nodeUnlocked = unlocked.includes(def.id);
              const discovered = data?.discoveredElements.includes(def.id) ?? false;
              const nodeLevel = masteryLevelFromXp(data?.mastery[def.id]?.xp ?? 0);
              const isSelected = selected === def.id;
              const isHovered = hovered === def.id;
              return (
                <g
                  key={def.id}
                  className={`skill-node ${isSelected ? 'selected' : ''} ${isHovered ? 'focused' : ''} ${nodeUnlocked ? 'unlocked' : 'locked'}`}
                  transform={`translate(${point.x}, ${point.y})`}
                  onClick={() => setSelected(def.id)}
                  onMouseEnter={() => setHovered(def.id)}
                  onMouseLeave={() => setHovered((current) => (current === def.id ? null : current))}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') setSelected(def.id);
                  }}
                >
                  <circle
                    className="node-ring"
                    r={NODE_SIZE / 2}
                    fill={nodeUnlocked ? def.gradient[1] : '#0B0F1A'}
                    stroke={nodeUnlocked || discovered ? def.color : '#2A3850'}
                    strokeWidth={isSelected ? 3 : 2}
                    fillOpacity={nodeUnlocked ? 0.92 : 0.55}
                  />
                  <text
                    className="node-core"
                    textAnchor="middle"
                    dy="5"
                    fontSize="15"
                    fill={nodeUnlocked ? def.color : '#54607A'}
                    style={{ fontWeight: 700, letterSpacing: '0.06em' }}
                  >
                    {nodeUnlocked || discovered ? def.symbol : '??'}
                  </text>
                  <text
                    textAnchor="middle"
                    dy={NODE_SIZE / 2 + 15}
                    fontSize="13"
                    fill={nodeUnlocked ? '#E8EDF7' : '#7E899E'}
                    style={{ letterSpacing: '0.08em' }}
                  >
                    {nodeUnlocked ? `${def.name.toUpperCase()} · LV${nodeLevel}` : discovered ? def.name.toUpperCase() : '?????'}
                  </text>
                  {!nodeUnlocked ? (
                    <text
                      className="node-gate"
                      textAnchor="middle"
                      dy={NODE_SIZE / 2 + 27}
                      fontSize="10"
                      fill="#54607A"
                      style={{ letterSpacing: '0.14em' }}
                    >
                      {def.unlock.kind === 'starter'
                        ? 'STARTER'
                        : def.unlock.kind === 'wave'
                          ? `WAVE ${def.unlock.value ?? ''}`
                          : def.unlock.kind === 'boss'
                            ? 'BOSS'
                            : 'FOCUS'}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        </div>

        <div className="grid cols-2">
          <Panel title="SELECTED ELEMENT">
            <div className="row between" style={{ marginBottom: 8 }}>
              <div className="row" style={{ gap: 8 }}>
                <span style={{ color: selectedDef.color, fontSize: 20, fontWeight: 700 }}>{selectedDef.symbol}</span>
                <div className="col" style={{ gap: 2 }}>
                  <strong>{isUnlocked ? selectedDef.name.toUpperCase() : 'UNDISCOVERED'}</strong>
                  <span className="tiny muted">
                    {selectedDef.tier.toUpperCase()} · MASTERY LV {level} / {MASTERY.maxLevel}
                  </span>
                </div>
              </div>
              <Tag tone={isUnlocked ? 'gold' : 'default'}>{isUnlocked ? 'UNLOCKED' : 'LOCKED'}</Tag>
            </div>

            <p className="small" style={{ marginTop: 0 }}>
              {isUnlocked
                ? selectedDef.description
                : `Silhouette only. ${selectedDef.unlock.note}`}
            </p>

            {isUnlocked ? (
              <>
                <div className="bar" style={{ marginBottom: 10 }} aria-label="Mastery progress">
                  <div className="bar-fill energy" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
                </div>
                <div className="stat-grid">
                  <StatCell label="Mastery XP" value={Math.round(selectedXp)} />
                  <StatCell label="To next level" value={Math.max(0, Math.round(progress.next - progress.current))} />
                  <StatCell label="Damage bonus" value={`+${Math.round((bonuses.damageMult - 1) * 100)}%`} accent="var(--gold)" />
                  <StatCell label="Status duration" value={`+${Math.round((bonuses.statusDurationMult - 1) * 100)}%`} />
                  <StatCell label="Cooldown" value={`×${bonuses.cooldownMult.toFixed(2)}`} />
                  <StatCell label="Ultimate cost" value={`×${bonuses.ultimateCostMult.toFixed(2)}`} />
                </div>
                <div className="separator" />
                <div className="kv-list">
                  <KV label={`Attack · ${selectedDef.attack.label}`} value={`×${selectedDef.attack.damageMultiplier.toFixed(2)} · ${selectedDef.attack.cooldown.toFixed(2)}s`} />
                  <KV label={`Skill · ${selectedDef.skill.name}`} value={`${selectedDef.skill.energyCost} energy · ${selectedDef.skill.cooldown}s`} />
                  <KV label={`Ultimate · ${selectedDef.ultimate.name}`} value={`${selectedDef.ultimate.energyCost} energy · ${selectedDef.ultimate.cooldown}s`} />
                  <KV label="Passive" value={selectedDef.passive.description} />
                </div>
              </>
            ) : (
              <>
                <div className="kv-list">
                  <KV label="Parents" value={selectedDef.parents.map((id) => ELEMENT_REGISTRY[id].name).join(' + ') || 'Primordial'} />
                  <KV label="Unlock" value={selectedDef.unlock.note} />
                  <KV
                    label="Focus cost"
                    value={`${eligibility.cost} shards · ${selectedDef.tier} tier`}
                    accent="var(--gold)"
                  />
                </div>
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <Button
                    variant="primary"
                    size="small"
                    disabled={!eligibility.ok}
                    title={eligibility.reason}
                    reason={eligibility.ok ? undefined : eligibility.reason}
                    needs={
                      eligibility.ok
                        ? undefined
                        : [
                            ...selectedDef.parents
                              .filter((id) => !unlocked.includes(id))
                              .map((id) => `unlock ${ELEMENT_REGISTRY[id].name} in the lineage first`),
                            ...(eligibility.cost > shards ? [`spend ${eligibility.cost} shards \u2014 you hold ${shards}`] : []),
                          ]
                    }
                    onClick={() => {
                      const result = focusUnlock(selected);
                      // Success is the unlock moment's job now (it carries the name,
                      // the flavour and the Equip action); a toast on top of it would
                      // just say the same thing twice. Only the refusal needs a line.
                      if (!result.ok) {
                        pushToast({
                          title: 'CANNOT FOCUS YET',
                          body: result.reason,
                          color: '#FF5C6C',
                        });
                      }
                    }}
                  >
                    FOCUS {eligibility.cost} SHARDS
                  </Button>
                  <span className="tiny muted">{eligibility.reason}</span>
                </div>
              </>
            )}
          </Panel>

          <Panel title="MASTERY OVERVIEW">
            <div className="stat-grid">
              {ALL_ELEMENTS.filter((def) => unlocked.includes(def.id)).map((def) => {
                const xp = data?.mastery[def.id]?.xp ?? 0;
                return (
                  <StatCell
                    key={def.id}
                    label={def.name}
                    value={`LV ${masteryLevelFromXp(xp)}`}
                    accent={def.color}
                  />
                );
              })}
            </div>
            <div className="separator" />
            <p className="tiny muted" style={{ margin: 0 }}>
              Mastery grows from normal attacks, skills and ultimates. Element switching grants a trickle of XP so
              flexible play is never punished. Level {MASTERY.maxLevel} is the cap.
            </p>
          </Panel>
        </div>

        <div className="row">
          <Button onClick={back}>BACK</Button>
        </div>
      </div>
    </Screen>
  );
}
