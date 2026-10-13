import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGameFlow } from '@/app/useGameFlow';
import { ACHIEVEMENTS } from '@/data/achievements';
import { ALL_ELEMENTS, ELEMENT_REGISTRY, computeResonances } from '@/data/elements';
import { FLOOR_LIST, FLOOR_REGISTRY, STORY_WAVES, floorForWave } from '@/data/floors';
import { getBoss } from '@/data/bosses';
import { formatTime, formatNumber, romanNumeral } from '@/utils/math';
import { useSaveStore } from '@/store/saveStore';
import { useUiStore } from '@/store/uiStore';
import { useAtmosphere, previewElement } from '@/hooks/useAtmosphere';
import { Button, KV, Plaque, Tag } from '@/components/ui/primitives';
import { ElementChip } from '@/components/ui/elementVisuals';
import { Screen } from '@/components/ui/Screen';
import type { ElementId } from '@/types';

type Station = 'portal' | 'altar' | 'codex' | 'forge' | 'gateway' | 'crystal' | 'deep' | null;

/** Floor palettes are authored data, but a bad hex must never crash the hall. */
function accentInt(hex: string, fallback: number): number {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The Hall — the player's room between runs.
 *
 * Not a dashboard of equal panels. The gateway to the story is the largest
 * thing in the room because it is the reason the room exists; everything else
 * is a station placed around it with its own weight. The accent colour of the
 * whole screen comes from the floor you are about to enter, and hovering a
 * station pushes that colour into the world behind the interface.
 */
export function HubScreen() {
  const flow = useGameFlow();
  const navigate = useUiStore((s) => s.navigate);
  const data = useSaveStore(useShallow((s) => s.data));
  const checkpoint = data?.checkpoint ?? null;
  const [station, setStation] = useState<Station>(null);

  const resonances = useMemo(() => computeResonances(data?.loadout.slots ?? []), [data?.loadout.slots]);
  const nextWave = data?.story.currentWave ?? 1;
  const nextFloor = FLOOR_REGISTRY[floorForWave(nextWave)] ?? FLOOR_LIST[0];
  const majorBoss = nextFloor ? getBoss(nextFloor.majorBossId) : null;
  const miniBoss = nextFloor ? getBoss(nextFloor.miniBossId) : null;
  const unlockedCount = data?.unlockedElements.length ?? 0;
  const achievementsUnlocked = data?.achievements.filter((entry) => entry.unlockedAt).length ?? 0;
  const ascensionReady = Boolean(data?.ascension.unlocked);
  const hallBosses = (data?.story.replayableBosses ?? []).map((id) => getBoss(id)).filter(Boolean);

  const lastElement = (data?.unlockedElements[data.unlockedElements.length - 1] ?? data?.profile.starter) as
    | ElementId
    | undefined;

  useAtmosphere(station ? 'focus' : 'calm', {
    accent: accentInt(nextFloor.palette.accent, 0xf2c96b),
    intensity: station ? 1 : 0.72,
  });

  const hover = (id: Station, element: ElementId | null = null) => () => {
    setStation(id);
    previewElement(element);
  };

  const leave = (id: Station) => () => {
    setStation((current) => (current === id ? null : current));
    previewElement(null);
  };

  const floorAccent = nextFloor.palette.ui;

  return (
    <Screen className="hall-screen">
      <div className="hall">
        <header className="hall-head" data-anim="lead">
          <div className="hall-head-id">
            <span className="panel-kicker">{nextFloor.name.toUpperCase()} · FLOOR {nextFloor.id} OF 10</span>
            <h1 className="title-xl">{data?.profile.name ?? 'WARDEN'}</h1>
          </div>
          <div className="hall-head-tally">
            <Plaque label="ESSENCE" value={formatNumber(data?.progression.essence ?? 0)} tone="gold" />
            <Plaque label="SHARDS" value={formatNumber(data?.progression.shards ?? 0)} sub="for the altar" />
            <Plaque
              label="NEXT WAVE"
              value={`${nextWave}`}
              sub={`of ${STORY_WAVES}${data?.story.completed ? ' · story complete' : ''}`}
            />
            {ascensionReady ? <Tag tone="danger">ASCENSION {romanNumeral((data?.ascension.cycle ?? 0) + 1)}</Tag> : null}
          </div>
        </header>

        <div className="hall-floor">
          {/* The gateway: the biggest thing in the room. */}
          <section
            className="station station-portal"
            onMouseEnter={hover('portal')}
            onMouseLeave={leave('portal')}
            onFocus={hover('portal')}
            onBlur={leave('portal')}
          >
            <div className="station-frame" style={{ '--station-accent': floorAccent } as React.CSSProperties}>
              <span className="station-seal" aria-hidden="true">
                ⌘
              </span>
              <div className="station-body">
                <span className="panel-kicker">THE GATEWAY</span>
                <h2 className="station-title">{nextFloor.name}</h2>
                <p className="station-text">
                  {nextFloor.subtitle} The hazard here is{' '}
                  {nextFloor.hazard.kind === 'none' ? 'quiet' : nextFloor.hazard.description.toLowerCase()}
                </p>
                <ul className="gate-risks">
                  <li>
                    <span>WAVE</span>
                    <b>{nextWave}</b>
                  </li>
                  {miniBoss ? (
                    <li>
                      <span>MINI</span>
                      <b style={{ color: miniBoss.color }}>{miniBoss.name}</b>
                    </li>
                  ) : null}
                  {majorBoss ? (
                    <li>
                      <span>WARDEN</span>
                      <b style={{ color: majorBoss.color }}>{majorBoss.name}</b>
                    </li>
                  ) : null}
                </ul>
                <div className="station-actions">
                  <Button
                    variant="primary"
                    onClick={() => flow.startStory()}
                  >
                    {data?.story.completed ? 'REPLAY THE STORY' : 'STEP THROUGH'}
                  </Button>
                  <Button
                    locked={!checkpoint}
                    title={checkpoint ? `Resumes at wave ${checkpoint.respawnWave}` : 'Earned at every warden'}
                    reason={checkpoint ? undefined : 'nothing banked to return to'}
                    needs={checkpoint ? undefined : ['beat a warden to bank one']}
                    onClick={() => flow.startFromCheckpoint()}
                  >
                    {checkpoint ? `CHECKPOINT · W${checkpoint.respawnWave}` : 'NO CHECKPOINT'}
                  </Button>
                </div>
              </div>
              <span className="station-glow" aria-hidden="true" />
            </div>
          </section>

          {/* Loadout forge: what you carry. */}
          <section
            className="station station-forge"
            onMouseEnter={hover('forge', lastElement ?? null)}
            onMouseLeave={leave('forge')}
            onFocus={hover('forge', lastElement ?? null)}
            onBlur={leave('forge')}
          >
            <div className="station-frame">
              <span className="station-seal" aria-hidden="true">
                ⚒
              </span>
              <div className="station-body">
                <span className="panel-kicker">THE FORGE</span>
                <h2 className="station-title">Six slots</h2>
                <div className="element-list">
                  {(data?.loadout.slots ?? []).map((element, index) =>
                    element ? (
                      <ElementChip
                        key={`hub-slot-${index}`}
                        element={element}
                        equipped={data?.loadout.activeSlot === index}
                      />
                    ) : (
                      <span key={`hub-empty-${index}`} className="tag">
                        EMPTY {index + 1}
                      </span>
                    ),
                  )}
                </div>
                {resonances.length > 0 ? (
                  <div className="resonance-list">
                    {resonances.map((entry) => (
                      <span key={entry.def.id} style={{ color: entry.def.color }}>
                        {entry.def.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="tiny muted">
                    Equip related elements together to bind a resonance — Cinder (Fire + Smoke), Pressure (Fire + Water
                    + Steam).
                  </p>
                )}
                <div className="station-actions">
                  <Button size="small" onClick={() => navigate('loadout')}>
                    ARRANGE LOADOUT
                  </Button>
                </div>
              </div>
            </div>
          </section>

          {/* Altar: essence into power. */}
          <section
            className="station station-altar"
            onMouseEnter={hover('altar')}
            onMouseLeave={leave('altar')}
            onFocus={hover('altar')}
            onBlur={leave('altar')}
          >
            <div className="station-frame">
              <span className="station-seal" aria-hidden="true">
                ✧
              </span>
              <div className="station-body">
                <span className="panel-kicker">THE ALTAR</span>
                <h2 className="station-title">Offer essence</h2>
                <div className="kv-list">
                  <KV label="Essence held" value={formatNumber(data?.progression.essence ?? 0)} />
                  <KV
                    label="Slots filled"
                    value={`${(data?.loadout.slots ?? []).filter(Boolean).length} / 6`}
                  />
                  <KV
                    label="Resonances"
                    value={resonances.length === 0 ? 'None bound' : `${resonances.length} active`}
                    accent={resonances.length > 0 ? 'var(--gold)' : undefined}
                  />
                  <KV label="Relic cores" value={formatNumber(data?.progression.relicCores ?? 0)} />
                </div>
                <div className="station-actions">
                  <Button size="small" variant="primary" onClick={() => navigate('skilltree')}>
                    SKILL TREE
                  </Button>
                </div>
              </div>
            </div>
          </section>

          {/* Codex wall: what the ruin remembers. */}
          <section
            className="station station-codex"
            onMouseEnter={hover('codex', lastElement ?? null)}
            onMouseLeave={leave('codex')}
            onFocus={hover('codex', lastElement ?? null)}
            onBlur={leave('codex')}
          >
            <div className="station-frame">
              <span className="station-seal" aria-hidden="true">
                ❖
              </span>
              <div className="station-body">
                <span className="panel-kicker">THE WALL</span>
                <h2 className="station-title">
                  {unlockedCount}
                  <span className="station-title-sub">/ 25 elements carved</span>
                </h2>
                <div className="vault-wall">
                  {ALL_ELEMENTS.map((def) => {
                    const unlocked = data?.unlockedElements.includes(def.id) ?? false;
                    const discovered = data?.discoveredElements.includes(def.id) ?? false;
                    return (
                      <button
                        key={`wall-${def.id}`}
                        type="button"
                        className={`wall-cell ${unlocked ? 'is-lit' : discovered ? 'is-known' : 'is-dark'}`}
                        style={
                          unlocked
                            ? ({ '--cell': def.color, '--cell-core': def.colorCore } as React.CSSProperties)
                            : undefined
                        }
                        title={`${def.name}${unlocked ? ` · mastery ${data?.mastery[def.id]?.level ?? 1}` : discovered ? ' · discovered, not claimed' : ' · unknown'}`}
                        onClick={() => navigate('codex')}
                      >
                        {unlocked || discovered ? def.symbol : '??'}
                      </button>
                    );
                  })}
                </div>
                <div className="station-actions">
                  <Button size="small" onClick={() => navigate('codex')}>
                    OPEN CODEX
                  </Button>
                </div>
              </div>
            </div>
          </section>

          {/* Gateway to the endless rooms. */}
          <section
            className="station station-gate"
            onMouseEnter={hover('gateway')}
            onMouseLeave={leave('gateway')}
            onFocus={hover('gateway')}
            onBlur={leave('gateway')}
          >
            <div className="station-frame">
              <span className="station-seal" aria-hidden="true">
                ∞
              </span>
              <div className="station-body">
                <span className="panel-kicker">THE SIDE DOOR</span>
                <h2 className="station-title">Free mode</h2>
                {/* Both branches describe the door, never the lock: what keeps it shut is the answer to a
                    press on FREE MODE, not a line parked above it. */}
                <p className="station-text">
                  Replay any recorded warden or start on any cleared floor. Story progress is never touched.
                </p>
                <div className="hall-bosses">
                  {hallBosses.length === 0 ? (
                    <span className="tiny muted">No wardens recorded yet.</span>
                  ) : (
                    hallBosses.map((boss) =>
                      boss ? (
                        <span key={boss.id} className="boss-coin" style={{ borderColor: boss.color }}>
                          <i style={{ color: boss.color }}>{ELEMENT_REGISTRY[boss.element]?.symbol ?? '??'}</i>
                          {boss.name}
                        </span>
                      ) : null,
                    )
                  )}
                </div>
                <div className="station-actions">
                  <Button
                    size="small"
                    locked={!data?.freeModeUnlocked}
                    reason={
                      data?.freeModeUnlocked
                        ? undefined
                        : `the first cycle is not over (wave ${data?.story.highestWave ?? 1} of 200)`
                    }
                    needs={data?.freeModeUnlocked ? undefined : ['clear floor 10, or reach wave 200']}
                    onClick={() => navigate('freemode')}
                  >
                    FREE MODE
                  </Button>
                  <Button
                    size="small"
                    locked={!ascensionReady}
                    reason={
                      ascensionReady
                        ? undefined
                        : 'needs the first cycle finished, to run it back harder'
                    }
                    needs={ascensionReady ? undefined : ['clear floor 10, or reach wave 200']}
                    onClick={() => flow.startAscension()}
                  >
                    ASCENSION {romanNumeral((data?.ascension.cycle ?? 0) + 1)}
                  </Button>
                </div>
              </div>
            </div>
          </section>

          {/* Save crystal: the mundane things, in one quiet corner. */}
          <section
            className="station station-crystal"
            onMouseEnter={hover('crystal')}
            onMouseLeave={leave('crystal')}
            onFocus={hover('crystal')}
            onBlur={leave('crystal')}
          >
            <div className="station-frame">
              <span className="station-seal" aria-hidden="true">
                ◈
              </span>
              <div className="station-body">
                <span className="panel-kicker">SAVE CRYSTAL</span>
                <h2 className="station-title">Bound locally</h2>
                <div className="kv-list">
                  <KV label="Starter" value={data?.profile.starter.toUpperCase() ?? '—'} />
                  <KV label="Playtime" value={formatTime(data?.profile.playtime ?? 0)} />
                  <KV label="Deaths" value={formatNumber(data?.stats.deaths ?? 0)} />
                  <KV
                    label="Achievements"
                    value={`${achievementsUnlocked} / ${ACHIEVEMENTS.length}`}
                  />
                </div>
                <p className="tiny muted">
                  Autosaves on wave clears, warden defeats, floor transitions and when you leave a run. Nothing leaves
                  this device.
                </p>
                <div className="station-actions">
                  <Button size="small" onClick={() => navigate('statistics')}>
                    RECORDS
                  </Button>
                  <Button size="small" onClick={() => navigate('achievements')}>
                    SEAL
                  </Button>
                  <Button size="small" onClick={() => navigate('settings')}>
                    SETTINGS
                  </Button>
                  <Button size="small" variant="ghost" onClick={() => flow.returnToMainMenu()}>
                    LEAVE HALL
                  </Button>
                </div>
              </div>
            </div>
          </section>

          {/*
            The strip: a generated dungeon laid end to end, entered from a plinth at the room's foot.
            It is the only station in here that grants nothing — no essence, no shards, no wave moved —
            which is why its copy says so instead of promising a reward.
          */}
          <section
            className="station station-deep"
            onMouseEnter={hover('deep')}
            onMouseLeave={leave('deep')}
            onFocus={hover('deep')}
            onBlur={leave('deep')}
          >
            <div className="station-frame">
              <span className="station-seal" aria-hidden="true">
                ≋
              </span>
              <div className="station-body">
                <span className="panel-kicker">THE STRIP</span>
                <h2 className="station-title">Six cells, walked once</h2>
                <p className="station-text">
                  A generated dungeon, open end to end. Stones hold what the cell woke: walk past one and
                  it stays. Your partner fights beside you and can be put down. Nothing is carried out —
                  the ledger is a score, not a wallet.
                </p>
                <div className="station-actions">
                  <Button size="small" variant="primary" onClick={() => flow.startDungeon()}>
                    WALK THE STRIP
                  </Button>
                </div>
              </div>
              <span className="station-glow" aria-hidden="true" />
            </div>
          </section>
        </div>
      </div>
    </Screen>
  );
}
