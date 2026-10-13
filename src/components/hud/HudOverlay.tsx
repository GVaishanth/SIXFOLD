import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { STATUS_REGISTRY } from '@/data/elements';
import { gameBus } from '@/game/systems/eventBus';
import { GuideCard } from '@/components/hud/GuideCard';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import {
  selectBoss,
  selectCooldowns,
  selectLoadout,
  selectStatuses,
  selectStrip,
  selectVitals,
  selectWaveInfo,
  useRunStore,
} from '@/store/runStore';
import { Bar } from '@/components/ui/primitives';
import { valueBump, hurt } from '@/utils/motion';
import { formatTime, romanNumeral } from '@/utils/math';
import { EventStage } from '@/components/hud/Events';

/**
 * The plan's grid. One row per circuit cell, with the cell's two lanes folded inside the row and every
 * second row drawn backwards, so the rows join at their ends the way the walk actually turns from one
 * circuit into the next. Everything is in the SVG's own units; the CSS only decides how big it draws.
 */
const PLAN = { left: 3, width: 56, top: 3, pitch: 3.6, span: 2, height: 26 };

type PlanCell = { route: number[]; you: { fx: number; fy: number } | null };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A cell's own corridor, folded into its row of the plan, plus the walker's dot on that row. */
function planRow(cell: PlanCell, index: number) {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < cell.route.length; i += 2) pts.push({ x: cell.route[i], y: cell.route[i + 1] });
  if (pts.length < 2) return null;
  const ys = pts.map((p) => p.y);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const mirror = index % 2 === 1;
  const px = (fx: number) => PLAN.left + (mirror ? 1 - clamp01(fx) : clamp01(fx)) * PLAN.width;
  const py = (fy: number) =>
    PLAN.top + index * PLAN.pitch + (hi > lo ? ((clamp01(fy) - lo) / (hi - lo)) * PLAN.span : PLAN.span / 2);
  const d = pts.map((pt, at) => `${at === 0 ? 'M' : 'L'}${px(pt.x).toFixed(1)},${py(pt.y).toFixed(1)}`).join(' ');
  const first = pts[0];
  const last = pts[pts.length - 1];
  return {
    d,
    start: { x: px(first.x), y: py(first.y) },
    end: { x: px(last.x), y: py(last.y) },
    you: cell.you ? { x: px(cell.you.fx), y: py((clamp01(cell.you.fy) - lo) / (hi - lo || 1)) } : null,
  };
}

/**
 * Combat HUD.
 *
 * Four registers, placed by what they answer:
 *   top-left     "am I okay?"      — vitals, shield, active statuses
 *   top-centre   "where am I?"     — floor, wave, chapter, boss plate
 *   top-right    "what now?"      — objective, timer, currency
 *   bottom       "what can I do?"  — element rail left of centre, abilities right
 *
 * Each quadrant subscribes to its own slice of the run snapshot, so a boss HP
 * change never re-renders the vitals block, and nothing here updates per frame.
 */
export function HudOverlay() {
  const vitals = useRunStore(useShallow(selectVitals));
  const wave = useRunStore(useShallow(selectWaveInfo));
  const boss = useRunStore(useShallow(selectBoss));
  const cooldowns = useRunStore(useShallow(selectCooldowns));
  const loadout = useRunStore(useShallow(selectLoadout));
  const ledger = useRunStore(useShallow(selectStatuses));
  /*
   * Dungeon mode's registers, from the same 12 Hz publish as everything else. `on` is false for a wave
   * run, and then the plates below keep their story wording — the mode changes the words, not the layout.
   */
  const stripInfo = useRunStore(useShallow(selectStrip));
  const strip = {
    on: stripInfo.kind === 'strip',
    depth: stripInfo.depth,
    partner: stripInfo.partner,
    cells: stripInfo.cells ?? [],
    atCenter: stripInfo.atCenter,
    left: stripInfo.sitesLeft
      ? stripInfo.sitesLeft.grove +
        stripInfo.sitesLeft.cache +
        stripInfo.sitesLeft.spring +
        stripInfo.sitesLeft.field +
        stripInfo.sitesLeft.den
      : 0,
  };
  const showFps = useSettingsStore((s) => s.showFps);
  /*
   * A phone has no Escape key, so the pause card — the only way into the loadout, the
   * skill tree, the settings and save & exit mid-run — needs a control of its own. It is
   * hidden while a full-screen card already owns the frame, because then there is nothing
   * left to open.
   */
  const overlayOpen = useUiStore(
    useShallow((s) => s.paused || s.deathOpen || s.transition !== null || s.summary !== null),
  );
  const fps = useRunStore((s) => s.fps);
  const entities = useRunStore((s) => s.enemyCount);

  const vitalsRef = useRef<HTMLDivElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const previousHp = useRef(vitals.hp);
  const previousWave = useRef(wave.wave);

  /* Damage is felt before it is read: the block flinches, the bar keeps a ghost. */
  useEffect(() => {
    if (vitals.hp < previousHp.current - 0.5) hurt(vitalsRef.current);
    previousHp.current = vitals.hp;
  }, [vitals.hp]);

  useEffect(() => {
    if (wave.wave !== previousWave.current) {
      previousWave.current = wave.wave;
      valueBump(waveRef.current);
    }
  }, [wave.wave]);

  const activeDef = loadout.activeElement ? ELEMENT_REGISTRY[loadout.activeElement] : null;
  const hpRatio = vitals.maxHp > 0 ? vitals.hp / vitals.maxHp : 0;
  const low = hpRatio <= 0.25 && vitals.playerAlive;
  const countdown = wave.isCountdown && wave.countdown > 0 ? Math.ceil(wave.countdown) : null;
  const counting = countdown !== null;
  // The wave announcement and the countdown share the middle of the frame, so they are one stack here
  // rather than two absolutely-positioned guesses at it: the announcement reads above the count, at any
  // window shape, because a `padding-top: 12vh` on a centred grid moves it *into* the other plate.
  const banner = useWaveBanner();
  const objective = strip.on
    ? strip.left > 0
      ? `LEAVE NOTHING — ${strip.left} SITE${strip.left === 1 ? '' : 'S'} UNTOUCHED`
      : 'ENDS EAST — WALK'
    : boss.bossId
      ? `STRIKE ${boss.bossName.toUpperCase()}`
      : wave.enemiesRemaining > 0
        ? `CLEAR ${wave.enemiesRemaining} HOSTILE${wave.enemiesRemaining === 1 ? '' : 'S'}`
        : 'HOLD — NEXT WAVE INBOUND';

  return (
    <div className={`hud ${low ? 'is-low' : ''}`} aria-live="polite">
      <div className="hud-quadrant hud-tl" ref={vitalsRef}>
        <div className="vitals">
          <div className="vitals-head">
            <span className="vitals-name">{activeDef ? activeDef.name.toUpperCase() : 'WARDEN'}</span>
            <span className="vitals-hp">
              {Math.round(vitals.hp)}
              <span className="vitals-max">/{Math.round(vitals.maxHp)}</span>
            </span>
          </div>
          <Bar kind="hp" value={vitals.hp} max={vitals.maxHp} segments={20} />
          <div className="vitals-secondary">
            <Bar kind="energy" value={vitals.energy} max={vitals.maxEnergy} size="thin" label="ESSENCE" />
            {vitals.shield > 0 ? (
              <Bar kind="shield" value={vitals.shield} max={vitals.maxHp * 0.6} size="thin" label="WARD" />
            ) : null}
          </div>
          {strip.partner ? (
            <div className={`partner-line ${strip.partner.state === 'downed' ? 'is-downed' : ''}`}>
              <Bar
                kind="partner"
                value={strip.partner.hp}
                max={strip.partner.maxHp}
                size="thin"
                label="PARTNER"
              />
              <span className="partner-state">{strip.partner.state.toUpperCase()}</span>
            </div>
          ) : null}
          {ledger.statuses.length > 0 ? (
            <div className="status-row" aria-label="Active statuses">
              {ledger.statuses.map((status) => {
                const def = STATUS_REGISTRY[status.id as keyof typeof STATUS_REGISTRY];
                return (
                  <span
                    key={status.id}
                    className="status-chip"
                    style={{ '--status-color': status.color } as React.CSSProperties}
                    title={`${def?.name ?? status.id}${status.stacks > 1 ? ` ×${status.stacks}` : ''}`}
                  >
                    <i className="status-ring" style={{ '--ratio': status.ratio } as React.CSSProperties} />
                    {status.id.slice(0, 2).toUpperCase()}
                    {status.stacks > 1 ? <b>{status.stacks}</b> : null}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      <div className="hud-quadrant hud-tc">
        <div className={`floor-plate${counting ? ' is-counting' : ''}`}>
          <span className="floor-name">{wave.floorName.toUpperCase()}</span>
          <div className="wave-line" ref={waveRef}>
            {wave.mode === 'ascension' ? (
              <span className="wave-cycle">ASCENSION {romanNumeral(wave.cycle + 1)}</span>
            ) : null}
            <span className={`wave-number ${!strip.on && wave.isBossWave ? 'is-boss' : ''}`}>
              {strip.on
                ? strip.atCenter
                  ? 'CENTER'
                  : `LINE ${wave.wave}`
                : wave.isBossWave
                  ? 'WARDEN'
                  : `WAVE ${wave.wave}`}
            </span>
            <span className="wave-of">
              {strip.on
                ? `/ ${Math.max(1, wave.waveTotal)}`
                : wave.mode === 'ascension'
                  ? `LOCAL ${wave.localWave}`
                  : wave.isBossWave
                    ? ''
                    : '/ 200'}
            </span>
          </div>
          <div className="wave-progress" aria-hidden="true">
            {Array.from({ length: strip.on ? Math.max(1, strip.cells.length) : 10 }, (_, index) => {
              // On a strip the line is walked, not cleared: one pip per cell, filled by distance.
              const filled = strip.on
                ? index < Math.round(strip.depth * Math.max(1, strip.cells.length))
                : wave.waveTotal > 0
                  ? index < Math.round(((wave.waveTotal - wave.enemiesRemaining) / Math.max(1, wave.waveTotal)) * 10)
                  : false;
              return <i key={`p-${index}`} className={filled ? 'is-filled' : ''} />;
            })}
          </div>
          {strip.on ? (
            <div className="strip-tally">
              <span className="strip-depth">DEPTH {Math.round(strip.depth * 100)}%</span>
              <span className="strip-sites">{strip.left} LEFT</span>
              {/*
                The labyrinth, drawn from the same route the walls were built from: one folded line per
                circuit, lit on the line you are standing on, dimmed once its sites are spent, and ended
                by the centre. `crispEdges` because a scaled SVG stroke at this size is a smear.
              */}
              <svg
                className="strip-map"
                viewBox={`0 0 ${PLAN.left * 2 + PLAN.width} ${PLAN.height}`}
                width={(PLAN.left * 2 + PLAN.width) * 1.25}
                height={PLAN.height * 1.25}
                shapeRendering="crispEdges"
                role="img"
                aria-label={
                  strip.atCenter
                    ? 'Center of the labyrinth'
                    : `Line ${wave.wave} of ${Math.max(1, strip.cells.length + 1)}${
                        strip.left > 0 ? `, ${strip.left} sites untouched` : ', strip cleared'
                      }`
                }
              >
                {(() => {
                  const rows = strip.cells
                    .map((cell, index) => ({ cell, index, row: planRow(cell, index) }))
                    .filter((entry): entry is { cell: (typeof strip.cells)[number]; index: number; row: NonNullable<ReturnType<typeof planRow>> } =>
                      Boolean(entry.row),
                    );
                  const drawn = rows.map((entry) => entry.row);
                  const last = drawn.length ? drawn[drawn.length - 1] : null;
                  // The centre is where the walk *ends*: one step past the last line's exit, on its own
                  // row, so the plan finishes the way the strip does instead of trailing off into nothing.
                  const centre = last ? { x: last.end.x + 3, y: last.end.y + 1.4 } : null;
                  return (
                    <>
                      {drawn.slice(0, -1).map((row, index) => (
                        <path key={`strip-joint-${index}`} className="strip-joint" d={`M${row.end.x.toFixed(1)},${row.end.y.toFixed(1)}L${drawn[index + 1].start.x.toFixed(1)},${drawn[index + 1].start.y.toFixed(1)}`} />
                      ))}
                      {rows.map(({ cell, index, row }) => (
                        <path
                          key={`strip-cell-${index}`}
                          className={`strip-cell${cell.here ? ' is-here' : ''}${
                            cell.goal ? ' is-goal' : ''
                          }${cell.sites > 0 && cell.cleared >= cell.sites ? ' is-done' : ''}`}
                          d={row.d}
                          stroke={cell.accent}
                        />
                      ))}
                      {centre ? (
                        <>
                          <path className="strip-joint" d={`M${last!.end.x.toFixed(1)},${last!.end.y.toFixed(1)}L${centre.x.toFixed(1)},${centre.y.toFixed(1)}`} />
                          <rect
                            className={`strip-centre${strip.atCenter ? ' is-live' : ''}`}
                            x={(centre.x - 1).toFixed(1)}
                            y={(centre.y - 1).toFixed(1)}
                            width="2"
                            height="2"
                          />
                        </>
                      ) : null}
                      {rows.map(({ cell, index, row }) =>
                        row.you && cell.here ? (
                          <rect
                            key={`strip-you-${index}`}
                            className="strip-you"
                            x={(row.you.x - 0.9).toFixed(1)}
                            y={(row.you.y - 0.9).toFixed(1)}
                            width="1.8"
                            height="1.8"
                          />
                        ) : null,
                      )}
                    </>
                  );
                })()}
              </svg>
            </div>
          ) : null}
        </div>

        {boss.bossId && boss.bossMaxHp > 0 ? (
          <div className="boss-plate">
            <div className="boss-plate-head">
              <span className="boss-name">{boss.bossName.toUpperCase()}</span>
              <span className="boss-title">{boss.bossTitle.toUpperCase()}</span>
              <span className="boss-phase">{boss.bossPhase ? `PHASE · ${boss.bossPhase.toUpperCase()}` : ''}</span>
            </div>
            <Bar kind="boss" value={boss.bossHp} max={boss.bossMaxHp} size="large" segments={10} />
          </div>
        ) : null}
      </div>

      <div className="hud-quadrant hud-tr">
        <div className="tr-tools">
          {overlayOpen ? null : (
            <button
              type="button"
              className="hud-menu-btn"
              onClick={() => useUiStore.getState().setPaused(true)}
              aria-label="Pause and open the run menu"
              title="Pause (Esc)"
            >
              <span aria-hidden="true" />
              MENU
            </button>
          )}
        </div>
        <div className="objective">
          <span className="objective-label">OBJECTIVE</span>
          <span className="objective-text">{objective}</span>
        </div>
        <div className="tr-row">
          <span
            className="currency"
            title={strip.on ? 'What this strip is worth — a score, not a wallet' : 'Essence gained this run'}
          >
            ◈ {ledger.essenceRun}
          </span>
          <span className="currency" title="Element shards gained this run">
            ❖ {ledger.shardsRun}
          </span>
          <span className="run-timer" title="Elapsed run time">
            {formatTime(ledger.elapsedMs / 1000)}
          </span>
        </div>
        {showFps ? (
          <span className="hud-diag">
            {fps} FPS · {entities} UNITS
          </span>
        ) : null}
      </div>

      <div className="hud-quadrant hud-bottom">
        <div className="element-rail" role="group" aria-label="Element loadout">
          {loadout.slots.map((element, index) => {
            const def = element ? ELEMENT_REGISTRY[element] : null;
            const active = loadout.activeSlot === index;
            // Equipped but not in hand means it is firing on its own: the slot says
            // so, and shows the cycle the player is not steering.
            const auto = element && !active ? loadout.auto.find((entry) => entry.slot === index) : undefined;
            return (
              <button
                key={`slot-${index}`}
                type="button"
                className={`rail-slot ${active ? 'is-active' : ''} ${auto ? 'is-auto' : ''} ${def ? '' : 'is-empty'}`}
                style={
                  def
                    ? ({
                        '--slot': def.color,
                        '--slot-core': def.colorCore,
                        '--auto': auto ? Number(auto.charge.toFixed(3)) : 0,
                      } as React.CSSProperties)
                    : undefined
                }
                onClick={() => gameBus.emit('command:switchElement', { slot: index })}
                title={
                  def
                    ? auto
                      ? `${def.name} — auto-casting at ${Math.round(auto.accuracy * 100)}% accuracy (LV ${auto.level}). Switch to it for full control.`
                      : active
                        ? `${def.name} — ${def.identity}. In your hands: aim, timing, skills.`
                        : `${def.name} — ${def.identity}`
                    : 'Empty slot'
                }
                aria-label={
                  def
                    ? auto
                      ? `${def.name}, auto-casting at ${Math.round(auto.accuracy * 100)} percent accuracy`
                      : `Switch to ${def.name}`
                    : `Empty slot ${index + 1}`
                }
                aria-pressed={active}
              >
                <span className="rail-key">{index + 1}</span>
                <span className="rail-glyph">{def ? def.symbol : '·'}</span>
                <span className="rail-name">{active && def ? def.name.toUpperCase() : ''}</span>
                <span className="rail-lamp" aria-hidden="true" />
                {auto ? <span className="rail-auto" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>

        <div className="ability-cluster" role="group" aria-label="Abilities">
          <AbilityButton
            label="DASH"
            hint="SPACE"
            ratio={cooldowns.dashReady}
            accent="var(--text)"
            onPress={() => gameBus.emit('command:dash', undefined)}
          />
          <AbilityButton
            label="SKILL"
            hint="E"
            name={activeDef?.skill.name}
            ratio={cooldowns.skillReady}
            accent={activeDef?.color ?? 'var(--accent)'}
            onPress={() => gameBus.emit('command:useSkill', undefined)}
          />
          <AbilityButton
            label="ULTIMATE"
            hint="Q"
            name={activeDef?.ultimate.name}
            ratio={cooldowns.ultimateReady}
            accent="var(--gold)"
            charged={cooldowns.ultimateReady >= 1}
            onPress={() => gameBus.emit('command:useUltimate', undefined)}
          />
        </div>
      </div>

      {countdown !== null || banner !== null ? (
        <div className="hud-centre">
          <div className="centre-stack">
            {banner !== null ? (
              <div className="banner" key={banner.title}>
                <span className="banner-title">{banner.title}</span>
                <span className="banner-sub">{banner.sub}</span>
              </div>
            ) : null}
            {countdown !== null ? (
              <div className="countdown-plate" key={countdown}>
                {/*
                 * The wave this countdown is counting into, stated here rather than left in the
                 * top plate where it sat behind the incoming card: one plate, one reading order,
                 * and the top plate's own wave line stands down while this is up.
                 */}
                <span className={`countdown-wave ${wave.isBossWave ? 'is-boss' : ''}`}>
                  {wave.mode === 'ascension' ? `ASCENSION ${romanNumeral(wave.cycle + 1)} · ` : ''}
                  {wave.isBossWave ? 'WARDEN' : `WAVE ${wave.wave}`}
                  {wave.mode === 'ascension' ? ` · LOCAL ${wave.localWave}` : wave.isBossWave ? '' : ' / 200'}
                </span>
                <span className="countdown-number">{countdown}</span>
                <span className="countdown-label">{wave.waveLabel.toUpperCase() || 'WAVE INBOUND'}</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <EventStage />
      <GuideCard />
    </div>
  );
}

function AbilityButton({
  label,
  hint,
  name,
  ratio,
  accent,
  charged = false,
  onPress,
}: {
  label: string;
  hint: string;
  name?: string;
  ratio: number;
  accent: string;
  charged?: boolean;
  onPress: () => void;
}) {
  const ready = ratio >= 1;
  return (
    <button
      type="button"
      className={`ability ${ready ? 'is-ready' : 'is-cooling'} ${charged ? 'is-charged' : ''}`}
      style={{ '--ability-accent': accent, '--cd': 1 - Math.min(1, Math.max(0, ratio)) } as React.CSSProperties}
      onClick={onPress}
      title={name ? `${label} — ${name} (${hint})` : `${label} (${hint})`}
    >
      <span className="ability-veil" aria-hidden="true" />
      <span className="ability-name">{name ? name.toUpperCase() : label}</span>
      <span className="ability-meta">
        <span className="ability-key">{hint}</span>
        {!ready ? <span className="ability-charge">{Math.round(ratio * 100)}%</span> : null}
      </span>
    </button>
  );
}

/**
 * The wave announcement, as a piece of state the centre stack can place. Announces once, then leaves —
 * it never loiters — and it never renders itself: the stack above owns where it goes.
 */
type Banner = { title: string; sub: string };

function useWaveBanner(): Banner | null {
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    let timer = 0;
    const clear = () => {
      window.clearTimeout(timer);
      setBanner(null);
    };
    const offWave = gameBus.on('game:waveStarted', (payload) => {
      // A warden is announced once, by the plate above (name, element, HP,
      // phases). A second centred banner would compete with it for the same
      // half-second of attention, so the banner steps aside instead.
      if (payload.isBoss) {
        clear();
        return;
      }
      setBanner({ title: `WAVE ${payload.wave}`, sub: payload.label.toUpperCase() });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setBanner(null), 1500);
    });
    // A restart must not leave the previous run's banner hanging over new ground.
    const offRun = gameBus.on('game:runStarted', clear);
    return () => {
      clear();
      offWave();
      offRun();
    };
  }, []);

  return banner;
}
