import { useShallow } from 'zustand/react/shallow';
import { ELEMENT_REGISTRY, ALL_ELEMENTS } from '@/data/elements';
import { TOTAL_FLOORS, STORY_WAVES } from '@/data/floors';
import { totalMasteryLevels } from '@/game/systems/elementProgression';
import { formatNumber, formatTime } from '@/utils/math';
import { useSaveStore } from '@/store/saveStore';
import { useUiStore } from '@/store/uiStore';
import { Button, KV, Panel, StatCell } from '@/components/ui/primitives';
import { Screen } from '@/components/ui/Screen';

/** Long-form progress readout: the numbers behind the warden. */
export function StatisticsScreen() {
  const navigate = useUiStore((s) => s.navigate);
  const data = useSaveStore(useShallow((s) => s.data));
  const back = useUiStore((s) => s.back);

  if (!data) {
    return (
      <Screen>
        <div className="screen-inner narrow">
          <Panel title="NO ACTIVE SAVE">
            <p className="small muted">Load or create a save slot to see statistics.</p>
            <Button onClick={() => navigate('slotselect')}>OPEN SAVE SLOTS</Button>
          </Panel>
        </div>
      
    </Screen>
    );
  }

  const stats = data.stats;
  const masteryLevels = totalMasteryLevels(data.mastery);
  const usage = Object.entries(stats.elementUsage).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const highestUsage = usage[0]?.[1] ?? 1;

  return (
    <div className="screen">
      <div className="screen-inner scroll-y">
        <header className="ambient-header">
          <h1 className="title-xl">STATISTICS</h1>
          <p className="subtitle">
            {data.profile.name} · created {new Date(data.profile.createdAt).toLocaleDateString()} · last played{' '}
            {new Date(data.profile.lastPlayed).toLocaleString()}
          </p>
        </header>

        <div className="grid cols-2">
          <Panel title="CAREER">
            <div className="stat-grid">
              <StatCell label="Story waves cleared" value={`${stats.wavesCompleted} / ${STORY_WAVES}`} />
              <StatCell label="Highest story wave" value={stats.highestStoryWave} accent="var(--gold)" />
              <StatCell label="Highest Ascension wave" value={stats.highestAscensionWave || '—'} accent="var(--gold)" />
              <StatCell label="Enemies defeated" value={formatNumber(stats.enemiesDefeated)} />
              <StatCell label="Bosses defeated" value={formatNumber(stats.bossesDefeated)} />
              <StatCell label="Total damage" value={formatNumber(stats.totalDamage)} />
              <StatCell label="Highest hit" value={formatNumber(stats.highestHit)} />
              <StatCell label="Deaths" value={formatNumber(stats.deaths)} />
              <StatCell label="Runs started" value={formatNumber(stats.runsStarted)} />
              <StatCell label="Essence collected" value={formatNumber(stats.essenceCollected)} />
              <StatCell label="Shards collected" value={formatNumber(stats.shardsCollected)} />
              <StatCell label="Relics collected" value={formatNumber(stats.relicsCollected)} />
              <StatCell label="Playtime" value={formatTime(stats.playtimeMs / 1000)} />
              <StatCell label="Mastery levels" value={masteryLevels} />
            </div>
          </Panel>

          <Panel title="PROGRESS">
            <div className="kv-list">
              <KV label="Story" value={data.story.completed ? 'COMPLETE — 200 waves cleared' : `${data.story.highestWave} of ${STORY_WAVES}`} />
              <KV label="Floor" value={`${data.story.currentFloor} of ${TOTAL_FLOORS}`} />
              <KV label="Waves cleared (unique)" value={data.story.clearedWaves.length} />
              <KV label="Elements unlocked" value={`${data.unlockedElements.length} / 25`} />
              <KV label="Elements discovered" value={`${data.discoveredElements.length} / 25`} />
              <KV label="Essence banked" value={formatNumber(data.progression.essence)} accent="var(--gold)" />
              <KV label="Shards banked" value={formatNumber(data.progression.shards)} />
              <KV label="Relic cores" value={formatNumber(data.progression.relicCores)} />
              <KV label="Boss hall level" value={data.progression.hallLevel} />
              <KV
                label="Ascension"
                value={data.ascension.unlocked ? `Cycle ${data.ascension.cycle + 1} · wave ${data.ascension.highestWave}` : 'Locked'}
              />
              <KV label="Checkpoint" value={data.checkpoint ? `${data.checkpoint.bossName} · wave ${data.checkpoint.wave}` : 'None'} />
            </div>
          </Panel>

          <Panel title="ELEMENT USAGE">
            {usage.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                No attacks logged yet.
              </p>
            ) : (
              <div className="col" style={{ gap: 8 }}>
                {usage.map(([id, count]) => {
                  const def = ELEMENT_REGISTRY[id as keyof typeof ELEMENT_REGISTRY];
                  if (!def) return null;
                  return (
                    <div key={id} className="col" style={{ gap: 3 }}>
                      <div className="row between">
                        <span style={{ color: def.color }}>{def.name}</span>
                        <span className="tiny muted">{formatNumber(count ?? 0)} casts</span>
                      </div>
                      <div className="bar thin">
                        <div
                          className="bar-fill energy"
                          style={{ width: `${Math.round(((count ?? 0) / highestUsage) * 100)}%`, backgroundColor: def.color }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title="MASTERY">
            <div className="stat-grid">
              {ALL_ELEMENTS.filter((def) => data.unlockedElements.includes(def.id)).map((def) => (
                <StatCell
                  key={def.id}
                  label={def.name}
                  value={`LV ${data.mastery[def.id]?.level ?? 1} · ${Math.round(data.mastery[def.id]?.xp ?? 0)} xp`}
                  accent={def.color}
                />
              ))}
            </div>
          </Panel>

          <Panel title="RUN HISTORY">
            {stats.runEndings.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                Your completed runs will be listed here.
              </p>
            ) : (
              <div className="col" style={{ gap: 6 }}>
                {stats.runEndings
                  .slice()
                  .reverse()
                  .slice(0, 12)
                  .map((run, index) => (
                    <div key={`${run.endedAt}-${index}`} className="relic-row">
                      <div className="col" style={{ gap: 2 }}>
                        <div className="row between">
                          <strong>{run.mode.toUpperCase()}</strong>
                          <span className={`tiny ${run.cause === 'death' ? 'danger' : 'gold'}`}>
                            {run.cause.toUpperCase()}
                          </span>
                        </div>
                        <span className="tiny muted">
                          wave {run.wave} · {run.wavesCleared} cleared · {formatNumber(run.enemiesDefeated)} kills ·{' '}
                          {formatTime(run.durationMs / 1000)}
                        </span>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <Button onClick={back}>BACK</Button>
        </div>
      </div>
    </div>
  );
}
