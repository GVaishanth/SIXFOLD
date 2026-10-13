import { useShallow } from 'zustand/react/shallow';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { gameBus } from '@/game/systems/eventBus';
import { DEBUG_CONFIG } from '@/config/gameConfig';
import { useRunStore, selectDebug } from '@/store/runStore';
import { useUiStore } from '@/store/uiStore';

/**
 * Development-only debug panel.
 *
 * This module is never imported by production builds: `App` pulls it in through
 * a dynamic import guarded by `import.meta.env.DEV`, so the debug code and the
 * cheat commands it exposes are stripped from the shipped bundle.
 */
/* ------------------------------------------------------------------ */
/* Development debug panel                                             */
/* ------------------------------------------------------------------ */

export function DebugPanel() {
  const open = useUiStore((s) => s.debugOpen);
  const toggle = useUiStore((s) => s.toggleDebug);
  const debug = useRunStore(useShallow(selectDebug));
  const activeName = debug.activeElement ? ELEMENT_REGISTRY[debug.activeElement].name : '—';

  if (!DEBUG_CONFIG.enabled || !open) return null;

  return (
    <div className="debug-panel">
      <div className="row between">
        <strong style={{ color: 'var(--danger)' }}>DEBUG</strong>
        <button type="button" className="btn small" onClick={toggle}>
          CLOSE
        </button>
      </div>
      <div className="separator" />
      <div className="row between">
        <span>Wave</span>
        <span className="mono-value">
          {debug.wave} (local {debug.localWave}, cycle {debug.cycle})
        </span>
      </div>
      <div className="row between">
        <span>Entities</span>
        <span className="mono-value">{debug.enemyCount}</span>
      </div>
      <div className="row between">
        <span>FPS</span>
        <span className="mono-value">{debug.fps}</span>
      </div>
      <div className="row between">
        <span>HP / EN</span>
        <span className="mono-value">
          {debug.hp}/{debug.maxHp} · {debug.energy}/{debug.maxEnergy}
        </span>
      </div>
      <div className="row between">
        <span>Element</span>
        <span className="mono-value">{activeName}</span>
      </div>
      <div className="row between">
        <span>Essence</span>
        <span className="mono-value">
          {debug.essenceRun} / {debug.shardsRun} shards
        </span>
      </div>
      <div className="separator" />
      <div className="row" style={{ gap: 4 }}>
        <button type="button" className="btn small" onClick={() => gameBus.emit('command:grantCheat', { killAll: true })}>
          KILL ALL
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => gameBus.emit('command:grantCheat', { hp: 100, energy: 100 })}
        >
          HEAL
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => gameBus.emit('command:grantCheat', { nextWave: true })}
        >
          NEXT WAVE
        </button>
      </div>
      <div className="tiny muted" style={{ marginTop: 6 }}>
        Development builds only — stripped from production bundles.
      </div>
    </div>
  );
}

