import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGameFlow } from '@/app/useGameFlow';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { FLOOR_LIST, WAVES_PER_FLOOR, floorForWave } from '@/data/floors';
import { getBoss } from '@/data/bosses';
import { useSaveStore } from '@/store/saveStore';
import { useUiStore } from '@/store/uiStore';
import { Button, KV, Panel, pressRefusal, Tag } from '@/components/ui/primitives';
import { Screen } from '@/components/ui/Screen';
import { hazardLabel } from '@/game/world/hazards';

type Difficulty = 'normal' | 'veteran' | 'nightmare';

/**
 * Free Mode.
 *
 * Replay any cleared floor, any cleared wave or a recorded warden without
 * touching a single story flag: the run is launched with the `free` mode so
 * completion state, checkpoints and boss one-time rules stay untouched.
 */
export function FreeModeScreen() {
  const flow = useGameFlow();
  const back = useUiStore((s) => s.back);
  const pushToast = useUiStore((s) => s.pushToast);
  const data = useSaveStore(useShallow((s) => s.data));
  const setFreeModeConfig = useSaveStore((s) => s.setFreeModeConfig);

  const clearedWaves = data?.story.clearedWaves ?? [];
  const ownFloor = data?.story.currentFloor ?? 1;
  const replayable = data?.story.replayableBosses ?? [];

  const [floor, setFloor] = useState(data?.freeMode.floor ?? ownFloor);
  const [wave, setWave] = useState(data?.freeMode.startWave ?? 1);
  const [bossId, setBossId] = useState<string | null>(data?.freeMode.bossId ?? null);
  const [difficulty, setDifficulty] = useState<Difficulty>(data?.freeMode.difficulty ?? 'normal');

  const maxWaveInFloor = useMemo(() => {
    const floorStart = (floor - 1) * WAVES_PER_FLOOR;
    const candidates = clearedWaves.filter((w) => w > floorStart && w <= floorStart + WAVES_PER_FLOOR);
    return candidates.length > 0 ? Math.max(...candidates) : floorStart + 1;
  }, [clearedWaves, floor]);

  const floorDef = FLOOR_LIST[floor - 1];

  const launch = () => {
    setFreeModeConfig({ floor, startWave: wave, bossId, difficulty });
    const resolvedWave = bossId
      ? (getBoss(bossId)?.wave ?? wave)
      : wave;
    flow.startFreeMode({ floor, startWave: resolvedWave, bossId, difficulty });
  };

  return (
    <Screen>
      <div className="screen-inner scroll-y">
        <header className="ambient-header">
          <div className="row between" style={{ alignItems: 'flex-end' }}>
            <div>
              <h1 className="title-xl">FREE MODE</h1>
              <p className="subtitle">
                Sandbox replay of everything you have already cleared. Free Mode never writes story progress, never
                re-awards one-time bosses and never unlocks story checkpoints.
              </p>
            </div>
            <Tag tone="gold">STORY SAFE</Tag>
          </div>
        </header>

        <div className="grid cols-2">
          <Panel title="FLOOR">
            <div className="grid cols-2">
              {FLOOR_LIST.map((entry) => {
                const reached = (data?.story.highestWave ?? 0) >= (entry.id - 1) * WAVES_PER_FLOOR;
                const selected = floor === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`starter-card ${selected ? 'selected' : ''}`}
                    style={{ borderLeft: `3px solid ${entry.palette.ui}`, opacity: reached ? 1 : 0.45 }}
                    aria-disabled={!reached || undefined}
                    title={
                      reached
                        ? 'Fight this floor'
                        : `Locked \u2014 ${entry.name} begins at wave ${(entry.id - 1) * WAVES_PER_FLOOR + 1}`
                    }
                    data-reason={
                      reached
                        ? undefined
                        : `Locked — ${entry.name} begins at wave ${(entry.id - 1) * WAVES_PER_FLOOR + 1}. Clear story wave ${(entry.id - 1) * WAVES_PER_FLOOR}; your highest is ${data?.story.highestWave ?? 1}.`
                    }
                    onClick={() => {
                      if (
                        pressRefusal(
                          !reached,
                          `locked — ${entry.name} begins at wave ${(entry.id - 1) * WAVES_PER_FLOOR + 1}`,
                          [`clear story wave ${(entry.id - 1) * WAVES_PER_FLOOR} (highest: ${data?.story.highestWave ?? 1})`],
                        )
                      )
                        return;
                      setFloor(entry.id);
                      setWave((entry.id - 1) * WAVES_PER_FLOOR + 1);
                      setBossId(null);
                    }}
                  >
                    <div className="row between">
                      <strong style={{ color: entry.palette.ui }}>
                        {entry.id}. {entry.name}
                      </strong>
                      {selected ? <span className="tiny gold">SELECTED</span> : null}
                    </div>
                    {/* The floor's own line, whether reached or not: the refusal is a reply to the press, and
                        a card that explains itself in advance is a caption wearing a different name. */}
                    <span className="tiny muted">{entry.subtitle}</span>
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel title="STARTING WAVE">
            <div className="col" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <Button size="small" onClick={() => setWave((value) => Math.max((floor - 1) * WAVES_PER_FLOOR + 1, value - 1))}>
                  −
                </Button>
                <span className="mono-value" style={{ fontSize: 20, minWidth: 64, textAlign: 'center' }}>
                  {wave}
                </span>
                <Button
                  size="small"
                  onClick={() => setWave((value) => Math.min(Math.max(maxWaveInFloor, (floor - 1) * WAVES_PER_FLOOR + 1), value + 1))}
                >
                  +
                </Button>
                <span className="tiny muted">
                  cleared up to wave {maxWaveInFloor} on this floor
                </span>
              </div>

              <div className="kv-list">
                <KV label="Floor" value={`${floorDef.id}. ${floorDef.name}`} />
                <KV label="Hazard" value={hazardLabel(floorDef.hazard.kind)} />
                <KV label="Mini warden" value={getBoss(floorDef.miniBossId)?.name ?? '—'} />
                <KV label="Major warden" value={getBoss(floorDef.majorBossId)?.name ?? '—'} />
              </div>

              <div className="section-label">DIFFICULTY</div>
              <div className="row" style={{ gap: 6 }}>
                {(['normal', 'veteran', 'nightmare'] as Difficulty[]).map((entry) => (
                  <Button
                    key={entry}
                    size="small"
                    variant={difficulty === entry ? 'primary' : 'default'}
                    onClick={() => setDifficulty(entry)}
                  >
                    {entry.toUpperCase()}
                  </Button>
                ))}
              </div>
              <p className="tiny muted" style={{ margin: 0 }}>
                Veteran scales enemy health and damage by 35%. Nightmare by 80%. Neither writes to story progress.
              </p>
            </div>
          </Panel>

          <Panel title="WARDEN REPLAY">
            {replayable.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                No wardens recorded yet. Defeat a boss in story mode and it appears here for replay.
              </p>
            ) : (
              <div className="col" style={{ gap: 6 }}>
                <button
                  type="button"
                  className={`starter-card ${bossId === null ? 'selected' : ''}`}
                  onClick={() => setBossId(null)}
                >
                  NO WARDEN — clear the wave normally
                </button>
                {replayable.map((id) => {
                  const boss = getBoss(id);
                  if (!boss) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`starter-card ${bossId === id ? 'selected' : ''}`}
                      style={{ borderLeft: `3px solid ${boss.color}` }}
                      onClick={() => {
                        setBossId(id);
                        setFloor(boss.floor);
                        setWave(boss.wave);
                      }}
                    >
                      <div className="row between">
                        <strong style={{ color: boss.color }}>{boss.name.toUpperCase()}</strong>
                        <span className="tiny muted">
                          {boss.rank === 'major' ? 'MAJOR' : 'MINI'} · WAVE {boss.wave}
                        </span>
                      </div>
                      <span className="tiny muted">
                        {boss.title} · {ELEMENT_REGISTRY[boss.element].name} aligned
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title="LAUNCH">
            <div className="kv-list">
              <KV label="Mode" value="Free Mode (no story writes)" />
              <KV label="Floor" value={`${floorDef.id}. ${floorDef.name}`} />
              <KV label="Wave" value={bossId ? `Warden encounter · wave ${getBoss(bossId)?.wave}` : `Wave ${wave}`} />
              <KV label="Difficulty" value={difficulty.toUpperCase()} />
              <KV label="Loadout" value={(data?.loadout.slots.filter(Boolean) ?? []).map((id) => ELEMENT_REGISTRY[id as keyof typeof ELEMENT_REGISTRY].name).join(' · ')} />
            </div>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <Button
                variant="primary"
                onClick={() => {
                  const targetFloor = floorForWave(bossId ? (getBoss(bossId)?.wave ?? wave) : wave);
                  if (targetFloor !== floor) {
                    pushToast({
                      title: 'FLOOR ADJUSTED',
                      body: `Wave ${bossId ? getBoss(bossId)?.wave : wave} belongs to floor ${targetFloor}.`,
                      color: '#F2C96B',
                    });
                  }
                  launch();
                }}
              >
                ENTER FREE MODE
              </Button>
              <Button onClick={back}>BACK</Button>
            </div>
          </Panel>
        </div>
      </div>
    
    </Screen>
  );
}
