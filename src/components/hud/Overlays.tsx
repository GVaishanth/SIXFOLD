import { useEffect, useState } from 'react';
import { useGameFlow } from '@/app/useGameFlow';
import { ACHIEVEMENTS } from '@/data/achievements';
import { gameBus } from '@/game/systems/eventBus';
import { formatNumber, formatTime } from '@/utils/math';
import { useSaveStore } from '@/store/saveStore';
import { useRunStore } from '@/store/runStore';
import { useUiStore } from '@/store/uiStore';
import { Button, KV } from '@/components/ui/primitives';
import { ElementChip } from '@/components/ui/elementVisuals';
import { PauseSettingsPanel } from '@/components/screens/SettingsScreen';
import { ChapterCard } from '@/components/hud/Events';

/**
 * Gameplay overlays.
 *
 * Each overlay drives the same freeze switch inside the gameplay scene: when an
 * overlay is open, the simulation is paused (enemies, timers, projectiles and
 * player input all stop). That is what keeps the pause menu, the skill tree and
 * the floor transition from becoming an exploitable gap.
 */
export function GameOverlays() {
  const transition = useUiStore((s) => s.transition);
  const deathOpen = useUiStore((s) => s.deathOpen);
  const summary = useUiStore((s) => s.summary);
  const paused = useUiStore((s) => s.paused);
  const screen = useUiStore((s) => s.screen);
  const pauseTab = useUiStore((s) => s.pauseTab);

  return (
    <>
      {transition ? (transition.chapter ? <ChapterCard /> : <TransitionOverlay />) : null}
      {deathOpen ? <DeathOverlay /> : null}
      {summary && !deathOpen ? <RunSummaryOverlay /> : null}
      {/* Pause only exists inside a run: the sub-screens the pause menu opens
          (skill tree, loadout, codex) replace it and freeze the sim themselves. */}
      {paused && !deathOpen && !transition && screen === 'playing' ? <PauseOverlay tab={pauseTab} /> : null}
      {screen === 'skilltree' || screen === 'loadout' || screen === 'codex' ? null : null}
      {paused && screen === 'playing' ? null : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Pause                                                               */
/* ------------------------------------------------------------------ */

function PauseOverlay({ tab }: { tab: 'root' | 'elements' | 'skilltree' | 'settings' }) {
  const flow = useGameFlow();
  const navigate = useUiStore((s) => s.navigate);
  const setPaused = useUiStore((s) => s.setPaused);
  const setPauseTab = useUiStore((s) => s.setPauseTab);
  const data = useSaveStore((s) => s.data);
  // The skill tree / loadout / codex open as full screens, so the pause card
  // falls back to its root tab rather than rendering an empty panel.
  const currentTab = tab === 'skilltree' ? 'root' : tab;
  /*
   * A strip run never reads or writes story progress, so the save's wave would describe a different
   * run than the one being paused. These are primitives on purpose: the pause card must not re-render
   * at the HUD's snapshot rate.
   */
  const runKind = useRunStore((s) => s.runKind);
  const stripCell = useRunStore((s) => s.wave);
  const stripTotal = useRunStore((s) => s.waveTotal);
  const stripFloor = useRunStore((s) => s.floorName);
  const stripCenter = useRunStore((s) => s.stripAtCenter);
  const onStrip = runKind === 'strip';

  const close = () => {
    setPauseTab('root');
    setPaused(false);
    gameBus.emit('command:resume', undefined);
  };

  return (
    <div className="overlay-layer" role="dialog" aria-modal="true" aria-label="Paused">
      <div className="overlay-card">
        <h2 className="overlay-title">PAUSED</h2>
        <p className="overlay-sub">
          {onStrip
            ? `${data?.profile.name ?? 'Warden'} · ${stripFloor.toUpperCase() || 'THE STRIP'} · ${
                stripCenter ? 'CENTER' : `LINE ${stripCell}/${Math.max(1, stripTotal)}`
              } · NOTHING CARRIED OUT`
            : data
              ? `${data.profile.name} · Wave ${data.story.currentWave} · Floor ${data.story.currentFloor}`
              : 'No save loaded'}
        </p>

        {currentTab === 'root' ? (
          <div className="col">
            <Button wide variant="primary" onClick={close}>
              RESUME
            </Button>
            <Button wide onClick={() => setPauseTab('elements')}>
              ELEMENTS
            </Button>
            <Button
              wide
              onClick={() => {
                setPauseTab('skilltree');
                navigate('skilltree');
              }}
            >
              SKILL TREE
            </Button>
            <Button wide onClick={() => setPauseTab('settings')}>
              SETTINGS
            </Button>
            <Button wide onClick={() => navigate('codex')}>
              ELEMENT CODEX
            </Button>
            <Button
              wide
              variant="danger"
              onClick={() => {
                flow.saveAndExit();
              }}
            >
              SAVE &amp; EXIT
            </Button>
            {data?.checkpoint && !onStrip ? (
              <div className="tiny muted" style={{ textAlign: 'center', marginTop: 6 }}>
                Last checkpoint · {data.checkpoint.bossName} — Wave {data.checkpoint.wave}
              </div>
            ) : null}
            {onStrip ? (
              <div className="tiny muted" style={{ textAlign: 'center', marginTop: 6 }}>
                Save &amp; exit leaves the strip unfinished and writes nothing: no wave, no essence, no
                record.
              </div>
            ) : null}
          </div>
        ) : null}

        {currentTab === 'elements' ? (
          <div className="col">
            <div className="section-label">ACTIVE LOADOUT</div>
            <div className="row">
              {data?.loadout.slots.map((element, index) =>
                element ? (
                  <ElementChip
                    key={`pause-slot-${index}`}
                    element={element}
                    equipped={data.loadout.activeSlot === index}
                    onClick={() => gameBus.emit('command:switchElement', { slot: index })}
                  />
                ) : (
                  <span key={`pause-empty-${index}`} className="tag">
                    EMPTY {index + 1}
                  </span>
                ),
              )}
            </div>
            <div className="tiny muted">
              Switching elements is instant but has a short cooldown. Rearranging which elements are equipped is
              allowed mid-run too: the simulation stays frozen while you do it, and your health is not touched.
            </div>
            <Button wide onClick={() => navigate('loadout')}>
              EDIT LOADOUT
            </Button>
            <Button wide onClick={() => setPauseTab('root')}>
              BACK
            </Button>
          </div>
        ) : null}

        {currentTab === 'settings' ? (
          <div className="col">
            <PauseSettingsPanel />
            <Button wide onClick={() => setPauseTab('root')}>
              BACK
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Death                                                               */
/* ------------------------------------------------------------------ */

function DeathOverlay() {
  const flow = useGameFlow();
  const data = useSaveStore((s) => s.data);
  const summary = useUiStore((s) => s.summary);
  // `finishRun()` returns the run snapshot and clears the live tracker, so the
  // card must read the snapshot — the tracker would always be empty here.

  return (
    <div className="overlay-layer" role="dialog" aria-modal="true" aria-label="You have fallen">
      <div className="overlay-card" style={{ borderColor: 'var(--danger)' }}>
        <h2 className="overlay-title danger">YOU HAVE FALLEN</h2>
        <p className="overlay-sub">
          {data?.checkpoint
            ? `Last checkpoint: ${data.checkpoint.bossName} — Wave ${data.checkpoint.wave}`
            : 'No checkpoint reached yet — respawning at wave 1'}
        </p>

        <div className="kv-list">
          <KV label="Waves cleared this run" value={summary?.wavesCleared ?? 0} />
          <KV label="Enemies defeated" value={summary?.enemiesDefeated ?? 0} />
          <KV label="Essence gathered" value={formatNumber(summary?.essenceGained ?? 0)} accent="var(--gold)" />
          <KV label="Highest hit" value={formatNumber(summary?.highestHit ?? 0)} />
          <KV label="Run time" value={formatTime(Math.max(0, (summary?.durationMs ?? 0) / 1000))} />
        </div>

        <div className="modal-actions">
          <Button variant="primary" onClick={flow.respawn}>
            RESPAWN{data?.checkpoint ? ` AT WAVE ${data.checkpoint.respawnWave}` : ''}
          </Button>
          <Button onClick={() => flow.returnToHub('death')}>RETURN TO HUB</Button>
        </div>
        <p className="tiny muted" style={{ marginTop: 10 }}>
          Story bosses you have already defeated are never replayed. Free Mode can revisit any unlocked boss.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Run summary                                                         */
/* ------------------------------------------------------------------ */

function RunSummaryOverlay() {
  const summary = useUiStore((s) => s.summary);
  const setSummary = useUiStore((s) => s.setSummary);
  const flow = useGameFlow();
  const data = useSaveStore((s) => s.data);
  const unlockedAchievements = ACHIEVEMENTS.filter((def) =>
    data?.achievements.some((entry) => entry.id === def.id && entry.unlockedAt),
  );

  if (!summary) return null;

  return (
    <div className="overlay-layer" role="dialog" aria-modal="true" aria-label="Run summary">
      <div className="overlay-card">
        <h2 className="overlay-title">RUN SUMMARY</h2>
        <p className="overlay-sub">
          {summary.mode.toUpperCase()} · WAVE {summary.wave} · FLOOR {summary.floor}
        </p>
        <div className="kv-list">
          <KV label="Waves cleared" value={summary.wavesCleared} />
          <KV label="Enemies defeated" value={summary.enemiesDefeated} />
          <KV label="Bosses defeated" value={summary.bossesDefeated} />
          <KV label="Essence gained" value={formatNumber(summary.essenceGained)} accent="var(--gold)" />
          <KV label="Highest damage" value={formatNumber(summary.highestHit)} />
          <KV label="Run time" value={formatTime(summary.durationMs / 1000)} />
          <KV label="Checkpoint" value={summary.checkpoint ?? 'None'} />
          <KV
            label="New unlocks"
            value={summary.unlocked.length > 0 ? summary.unlocked.join(', ') : '—'}
            accent="var(--success)"
          />
          <KV label="Elements used" value={Object.keys(data?.stats.elementUsage ?? {}).length} />
          {unlockedAchievements.length > 0 ? (
            <KV label="Achievements" value={unlockedAchievements.map((a) => a.name).join(', ')} />
          ) : null}
        </div>
        <div className="modal-actions">
          <Button
            variant="primary"
            onClick={() => {
              setSummary(null);
              flow.returnToHub(summary.cause === 'complete' ? 'exit' : 'death');
            }}
          >
            RETURN TO HUB
          </Button>
          {summary.mode === 'story' ? (
            <Button
              onClick={() => {
                setSummary(null);
                flow.startStory();
              }}
            >
              CONTINUE STORY
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Floor / checkpoint / victory transition                             */
/* ------------------------------------------------------------------ */

function TransitionOverlay() {
  const transition = useUiStore((s) => s.transition);
  const flow = useGameFlow();
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    setProgress(0);
    if (!transition) return;
    const started = performance.now();
    let frame = 0;
    const tick = () => {
      const ratio = Math.min(1, (performance.now() - started) / 900);
      setProgress(ratio);
      if (ratio < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [transition]);

  if (!transition) return null;

  return (
    <div className="overlay-layer" role="dialog" aria-modal="true" aria-label={transition.title}>
      <div className="overlay-card" style={{ borderColor: transition.accent }}>
        <h2 className="overlay-title" style={{ color: transition.accent }}>
          {transition.title}
        </h2>
        {transition.subtitle ? <p className="overlay-sub">{transition.subtitle}</p> : null}
        <div className="bar" aria-hidden>
          <div className="bar-fill" style={{ width: `${progress * 100}%`, backgroundColor: transition.accent }} />
        </div>
        <div className="kv-list" style={{ marginTop: 14 }}>
          {transition.lines.map((line) => (
            <KV key={line.label} label={line.label} value={line.value} />
          ))}
        </div>
        <div className="modal-actions">
          <Button variant="primary" onClick={flow.resumeFromTransition}>
            {transition.action}
          </Button>
          {transition.kind === 'floor' || transition.kind === 'checkpoint' ? (
            <Button onClick={() => flow.returnToHub('exit')}>RETURN TO HUB</Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export function ToastStack() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);
  const screen = useUiStore((s) => s.screen);
  // On a menu the top-centre slot is the header's, and a refusal that covers the sentence it interrupted
  // trades one thing you wanted to read for another. Away from the arena the pop answers from the foot.
  const atFoot = screen !== 'playing';
  return (
    <div className={`toast-stack${atFoot ? ' at-foot' : ''}`} aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className="toast"
          style={{ borderLeftColor: toast.color }}
          onClick={() => dismiss(toast.id)}
        >
          <div className="toast-title" style={{ color: toast.color }}>
            {toast.glyph ? `${toast.glyph} · ` : ''}
            {toast.title}
          </div>
          {toast.body ? <div className="toast-body">{toast.body}</div> : null}
        </button>
      ))}
    </div>
  );
}
