import { useEffect, useState } from 'react';
import { gameBus } from '@/game/systems/eventBus';
import { useUiStore } from '@/store/uiStore';
import { Button } from '@/components/ui/primitives';
import { Screen } from '@/components/ui/Screen';

/**
 * First screen in the shell.
 *
 * It holds the interface back until Phaser has generated its procedural
 * textures and announced `game:ready`, so the player never sees a half-built
 * world. If the engine fails to start within a few seconds the player gets a
 * real explanation and a retry button instead of a blank page.
 */
export function BootScreen() {
  const navigate = useUiStore((s) => s.navigate);
  const [status, setStatus] = useState('PREPARING THE ARENA');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let done = false;
    const unsubscribe = gameBus.on('game:ready', () => {
      done = true;
      setStatus('READY');
      window.setTimeout(() => navigate('mainmenu'), 260);
    });

    const timers = [
      window.setTimeout(() => !done && setStatus('GENERATING PIXEL ART'), 900),
      window.setTimeout(() => !done && setStatus('TUNING ELEMENTS'), 1900),
      window.setTimeout(() => {
        if (!done) {
          setFailed(true);
          setStatus('THE ENGINE DID NOT START');
        }
      }, 9000),
    ];

    return () => {
      unsubscribe();
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [navigate]);

  return (
    <Screen>
      <div className="screen-inner" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="title-xl" style={{ letterSpacing: '0.42em' }}>
          SIXFOLD
        </div>
        <div className="logo-rule" />
        <div className="subtitle">ELEMENTAL ASCENSION</div>
        <div className="bar" style={{ width: 210, marginTop: 22 }} aria-hidden>
          <div
            className="bar-fill hp"
            style={{ width: failed ? '100%' : '62%', animation: failed ? 'none' : 'pulse 1.4s infinite' }}
          />
        </div>
        <div className={`tiny ${failed ? 'danger' : 'muted'}`} style={{ marginTop: 12 }}>
          {status}
        </div>
        {failed ? (
          <div className="col" style={{ marginTop: 18, alignItems: 'center' }}>
            <p className="small muted" style={{ maxWidth: 420, textAlign: 'center' }}>
              WebGL may be disabled in this browser. SIXFOLD renders with Phaser 3 and needs a WebGL or Canvas
              context to run.
            </p>
            <Button variant="primary" onClick={() => window.location.reload()}>
              RELOAD
            </Button>
          </div>
        ) : null}
      </div>
    </Screen>
  );
}
