import { useCallback, useEffect, useRef, useState } from 'react';
import { useGameFlow } from '@/app/useGameFlow';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { audioEngine } from '@/game/systems/audio';
import { gameBus } from '@/game/systems/eventBus';
import { useUiStore } from '@/store/uiStore';
import type { ElementId } from '@/types';
import { formatNumber, romanNumeral } from '@/utils/math';
import { countTo, drawLine, fadeOut, popIn, scheduleBeats, staggerIn, wipe } from '@/utils/motion';
import { Button } from '@/components/ui/primitives';

/**
 * Event furniture for the moments that happen *to* a run.
 *
 * Three things live here, each with a beginning and an end:
 *   · the warden's plate — names the boss as it lands (§13)
 *   · the wave strip     — shows what a cleared wave actually paid (§15)
 *   · the chapter card   — the floor change as a set piece (§16)
 *
 * The first two never take control away: they read as the world telling you
 * something. Only the chapter card stops the game, because that is the one beat
 * where the player should be choosing what to do next.
 */

export function EventStage() {
  return (
    <>
      <WardenPlate />
      <WaveStrip />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Warden plate                                                        */
/* ------------------------------------------------------------------ */

interface PlateData {
  name: string;
  title: string;
  brief: string;
  element: ElementId;
  color: string;
  rank: 'major' | 'miniboss';
  wave: number;
  floorName: string;
  hp: number;
  phases: { name: string; banner: string }[];
}

function WardenPlate() {
  const [plate, setPlate] = useState<PlateData | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const name = useRef<HTMLHeadingElement | null>(null);
  const rule = useRef<HTMLDivElement | null>(null);
  const meta = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    const off = gameBus.on('game:bossSpawned', (payload) => {
      if (!alive) return;
      setPlate({
        name: payload.name,
        title: payload.title,
        brief: payload.description,
        element: payload.element,
        color: payload.color,
        rank: payload.rank,
        wave: payload.wave,
        floorName: payload.floorName,
        hp: payload.hp,
        phases: payload.phases,
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (!plate) return undefined;
    const cancel = scheduleBeats(
      (index) => {
        if (index === 0) {
          void wipe(plate.color, 120);
          popIn(name.current);
        }
        if (index === 1) drawLine(rule.current, 520);
        if (index === 2 && meta.current) {
          staggerIn(Array.from(meta.current.querySelectorAll<HTMLElement>('[data-beat]')), 'y', 10);
        }
      },
      [0, 260, 480],
    );
    const hide = window.setTimeout(() => {
      void fadeOut(root.current, 240, 10).then(() => setPlate(null));
    }, 3400);
    return () => {
      cancel();
      window.clearTimeout(hide);
    };
  }, [plate]);

  if (!plate) return null;
  const def = ELEMENT_REGISTRY[plate.element];
  const isMajor = plate.rank === 'major';

  return (
    <div
      ref={root}
      className={`warden-plate ${isMajor ? 'is-major' : 'is-mini'}`}
      style={
        {
          '--plate-accent': plate.color,
          '--plate-core': def.colorCore,
        } as React.CSSProperties
      }
      role="status"
    >
      <div className="warden-plate-kicker">
        {isMajor ? 'WARDEN' : 'HERALD'} · {plate.floorName.toUpperCase()} · WAVE {plate.wave}
      </div>
      <h2 className="warden-plate-name" ref={name}>
        {plate.name}
      </h2>
      <div className="warden-plate-rule" ref={rule} />
      <div className="warden-plate-title">{plate.title}</div>
      <div className="warden-plate-meta" ref={meta}>
        <span data-beat className="warden-plate-element">
          <b style={{ color: def.color }}>{def.symbol}</b> {def.name.toUpperCase()}
        </span>
        <span data-beat>{formatNumber(Math.round(plate.hp))} HP</span>
        <span data-beat>
          {plate.phases.length} PHASE{plate.phases.length === 1 ? '' : 'S'}
        </span>
        <span data-beat className="warden-plate-phases">
          {plate.phases.map((phase) => phase.name).join(' → ')}
        </span>
      </div>
      <p className="warden-plate-brief">{plate.brief}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Wave payout strip                                                   */
/* ------------------------------------------------------------------ */

interface StripData {
  wave: number;
  essence: number;
  shards: number;
  nextWave: number;
}

function WaveStrip() {
  const [strip, setStrip] = useState<StripData | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const essence = useRef<HTMLSpanElement | null>(null);
  const shards = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let alive = true;
    const off = gameBus.on('game:waveCleared', (payload) => {
      // A chapter change owns that beat with the big card; two banners at once
      // is noise, so the strip stands down.
      if (!alive || payload.chapter) return;
      setStrip({
        wave: payload.wave,
        essence: payload.essence,
        shards: payload.shards,
        nextWave: payload.nextWave,
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    if (!strip) return undefined;
    const cancel = scheduleBeats(
      (index) => {
        if (index === 0) popIn(root.current, 0.96);
        if (index === 1) {
          countTo(essence.current, 0, strip.essence, (value) => `+${formatNumber(Math.round(value))} ESSENCE`);
        }
        if (index === 2 && strip.shards > 0) {
          countTo(shards.current, 0, strip.shards, (value) => {
            const rounded = Math.round(value);
            return `+${rounded} ELEMENT SHARD${rounded === 1 ? '' : 'S'}`;
          });
        }
      },
      [0, 160, 260],
    );
    // Short on purpose: the wave-start banner lands about a second later and the
    // two must never share the frame.
    const hide = window.setTimeout(() => {
      void fadeOut(root.current, 160, -8).then(() => setStrip(null));
    }, 1150);
    return () => {
      cancel();
      window.clearTimeout(hide);
    };
  }, [strip]);

  if (!strip) return null;

  return (
    <div className="wave-strip" ref={root} role="status">
      <div className="wave-strip-head">WAVE {strip.wave} CLEARED</div>
      <div className="wave-strip-rewards">
        <span ref={essence}>+{formatNumber(strip.essence)} ESSENCE</span>
        {strip.shards > 0 ? (
          <span ref={shards} className="is-shard">
            +{strip.shards} ELEMENT SHARD{strip.shards === 1 ? '' : 'S'}
          </span>
        ) : null}
      </div>
      <div className="wave-strip-next">NEXT · WAVE {strip.nextWave}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chapter card                                                        */
/* ------------------------------------------------------------------ */

/**
 * The floor change, staged: the old name is left behind, the new one arrives in
 * the display face, and the card tells you what the ground will do to you before
 * it does it. Control returns on Enter or by the button — the same action, so
 * nobody is trapped reading.
 */
export function ChapterCard() {
  const transition = useUiStore((s) => s.transition);
  const chapter = transition?.chapter ?? null;
  const flow = useGameFlow();
  const frame = useRef<HTMLDivElement | null>(null);
  const rule = useRef<HTMLDivElement | null>(null);
  const columns = useRef<HTMLDivElement | null>(null);
  const introPlayed = useRef<number | null>(null);
  const [leaving, setLeaving] = useState(false);

  // `useGameFlow()` returns a fresh object every render, so the flow callbacks are
  // pulled out individually: they are memoised in the hook and stay stable here.
  const resume = flow.resumeFromTransition;
  const returnToHub = flow.returnToHub;

  const begin = useCallback(() => {
    setLeaving(true);
    void fadeOut(frame.current, 220, -12).then(resume);
  }, [resume]);

  useEffect(() => {
    if (!chapter || leaving) return undefined;
    // The entrance plays once per chapter. Without this guard a re-render (the
    // snapshot pushes twelve times a second) would restart the sequence.
    if (introPlayed.current === chapter.floorNumber) return undefined;
    introPlayed.current = chapter.floorNumber;
    audioEngine.play('floor');
    void wipe(transition?.accent ?? '#F2C96B', 150);
    const cancel = scheduleBeats(
      (index) => {
        if (index === 0) drawLine(rule.current, 620);
        if (index === 1 && columns.current) {
          staggerIn(Array.from(columns.current.querySelectorAll<HTMLElement>('[data-beat]')), 'y', 14);
        }
      },
      [300, 520],
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        begin();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancel();
      window.removeEventListener('keydown', onKey);
    };
  }, [chapter, leaving, begin, transition?.accent]);

  if (!transition || !chapter) return null;

  return (
    <div className="chapter-layer" role="dialog" aria-modal="true" aria-label={`Entering ${chapter.name}`}>
      <div
        className="chapter-frame"
        ref={frame}
        style={{ '--chapter-accent': transition.accent } as React.CSSProperties}
      >
        <div className="chapter-numeral" aria-hidden>
          {String(chapter.floorNumber).padStart(2, '0')}
        </div>
        <div className="chapter-kicker">
          {chapter.ascensionCycle > 0 ? `ASCENSION ${romanNumeral(chapter.ascensionCycle)} · ` : ''}FLOOR{' '}
          {chapter.floorNumber} · WAVE {chapter.wave}
        </div>
        <h2 className="chapter-name">{chapter.name}</h2>
        <div className="chapter-rule" ref={rule} />
        <p className="chapter-tag">{chapter.tagline}</p>
        <p className="chapter-left">LEAVING {chapter.previous.toUpperCase()}</p>

        <div className="chapter-columns" ref={columns}>
          <div className="chapter-col" data-beat>
            <span className="section-label">GROUND</span>
            <b>{chapter.hazardLabel}</b>
            <p>{chapter.hazardBrief}</p>
          </div>
          <div className="chapter-col" data-beat>
            <span className="section-label">WARDENS</span>
            {chapter.wardens.map((warden) => (
              <p key={warden}>{warden}</p>
            ))}
          </div>
          <div className="chapter-col" data-beat>
            <span className="section-label">SIGNALS</span>
            <p>{chapter.signals.length ? chapter.signals.join(', ') : 'Nothing new stirs here'}</p>
          </div>
        </div>

        <div className="modal-actions">
          <Button variant="primary" onClick={begin}>
            {transition.action}
          </Button>
          <Button onClick={() => returnToHub('exit')}>RETURN TO HUB</Button>
        </div>
        <p className="chapter-hint">ENTER to continue</p>
      </div>
    </div>
  );
}
