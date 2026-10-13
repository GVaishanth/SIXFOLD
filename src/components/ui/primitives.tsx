import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { audioEngine } from '@/game/systems/audio';
import { deny, locked as lockedMotion, modalIn, modalOut, popIn, press, release, success, hoverIn, hoverOut } from '@/utils/motion';
import { usePressable } from '@/hooks/useMotion';
import { useUiStore } from '@/store/uiStore';

/* ------------------------------------------------------------------ */
/* Panels + layout                                                     */
/* ------------------------------------------------------------------ */

/**
 * The one container in the interface. `level` is the elevation contract:
 * 0 = flush to the background, 1 = a surface, 2 = a raised surface the player
 * can act on, 3 = a modal. Nothing else decides how a panel sits in space.
 */
export function Panel({
  title,
  kicker,
  action,
  children,
  className = '',
  flush = false,
  level = 1,
  animate = true,
  accent,
}: {
  title?: string;
  kicker?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
  level?: 0 | 1 | 2 | 3;
  animate?: boolean;
  /** CSS colour applied to the corner ticks + head rule; defaults to the mode accent. */
  accent?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (animate && ref.current) popIn(ref.current);
  }, [animate]);

  return (
    <section
      ref={(node) => {
        ref.current = node;
      }}
      className={`panel pixel-corners level-${level} ${flush ? 'flush' : ''} ${className}`}
      style={accent ? ({ '--panel-accent': accent } as CSSProperties) : undefined}
    >
      {title ? (
        <header className="panel-head">
          <div className="panel-head-text">
            {kicker ? <span className="panel-kicker">{kicker}</span> : null}
            <h2>{title}</h2>
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function KV({ label, value, accent }: { label: string; value: ReactNode; accent?: string }) {
  return (
    <div className="kv">
      <span className="k">{label}</span>
      <span className="v" style={accent ? { color: accent } : undefined}>
        {value}
      </span>
    </div>
  );
}

export function StatCell({ label, value, accent }: { label: string; value: ReactNode; accent?: string }) {
  return (
    <div className="stat-cell">
      <div className="stat-label">{label}</div>
      <div className="stat-value mono-value" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
    </div>
  );
}

export function Tag({
  children,
  tone = 'default',
  glyph,
}: {
  children: ReactNode;
  tone?: 'default' | 'gold' | 'danger' | 'muted' | 'element';
  glyph?: string;
}) {
  return (
    <span className={`tag ${tone === 'default' ? '' : tone}`}>
      {glyph ? <span className="tag-glyph">{glyph}</span> : null}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

/**
 * A refusal is *spoken when it is pressed*, not printed under the label. The control's face says what it
 * does; a sentence of justification parked beneath every locked tile is a wall of text that only makes sense
 * the moment somebody tries to use the tile. So the reason is kept in the markup — `data-reason`, the title,
 * the accessible name, which is what a screen reader and a hovering mouse get — and it surfaces as a pop on
 * the press that needed it. `audit:fit` enforces all three halves of that.
 */
export function refusalNotice(reason?: string, needs?: string[]): { body: string; text: string } | null {
  /*
   * Each line loses any trailing period before the join, or "not over. — clear floor 10" reads like two
   * sentences that collided. The list the screen reader gets (`text`) keeps its punctuation.
   */
  const lines = [reason, ...(needs ?? [])].map((line) => (line ?? '').trim()).filter(Boolean);
  if (!lines.length) return null;
  return { body: lines.map((line) => line.replace(/[.,;:]+$/, '')).join(' — '), text: lines.join(' ') };
}

/** Push the refusal for a control that is not the shared primitive (raw cards, chips, tiles). */
export function pressRefusal(locked: boolean, reason?: string, needs?: string[]): boolean {
  if (!locked) return false;
  audioEngine.play('ui_deny');
  const notice = refusalNotice(reason, needs);
  if (notice) useUiStore.getState().pushToast({ title: 'NOT YET', body: notice.body, color: 'var(--danger)', glyph: '!' });
  return true;
}

/** A refusal that explains itself also has to say so to a screen reader, and to a mouse that can hover. */
function refusalTitle(title: string | undefined, reason?: string): string | undefined {
  if (title) return title;
  return reason ? reason.replace(/\s+/g, ' ').trim() : undefined;
}

export interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'default' | 'small';
  wide?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
  /** Skip the UI click sound (used by rapid-fire gameplay buttons). */
  silent?: boolean;
  /** Reports hover/focus so a screen can let the world behind it react. */
  onHoverChange?: (hovered: boolean) => void;
  /** Shows the progress affordance and refuses input. */
  loading?: boolean;
  /** Read-only refusal, e.g. a locked gate: still focusable, explains itself. */
  locked?: boolean;
  /** Element id used to tint the hover bleed so a button can borrow an identity. */
  accentVar?: string;
  /** Why this control will not act, in the player's terms. Required of anything inert — the audit says so. */
  reason?: string;
  /** The conditions that would lift it, one per line, in the order they can be satisfied. */
  needs?: string[];
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  'aria-label'?: string;
}

/**
 * The interaction contract lives here so every control in the game responds
 * identically: idle → hover (lift + accent bleed) → press (compression) →
 * success (single green sweep) or refusal (lateral knock). No screen re-implements
 * it, and reduced motion collapses all of it to colour changes.
 */
export function Button({
  children,
  onClick,
  disabled,
  variant = 'default',
  size = 'default',
  wide,
  title,
  className = '',
  style,
  silent,
  loading,
  locked,
  accentVar,
  reason,
  needs,
  onKeyDown,
  onHoverChange,
  ...rest
}: ButtonProps) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [state, setState] = useState<'idle' | 'success' | 'denied'>('idle');
  const refusal = refusalNotice(reason, needs);
  const inert = Boolean(disabled) || Boolean(loading) || Boolean(locked);
  // A refusal the player has to be able to reach: `disabled` swallows the press that would explain it, so a
  // reasoned refusal is aria-disabled and still focusable. A *loading* button keeps the real attribute.
  const shownLocked = Boolean(locked) || (Boolean(disabled) && Boolean(refusal));

  if (import.meta.env.DEV && inert && !refusal) {
    // A silent refusal is the bug this whole prop exists to kill. Warn rather than throw: the audit
    // (`npm run audit:fit`) is what fails a build, and a dev should still be able to click around.
    console.warn(`[sixfold] inert control with no reason: ${String(children).slice(0, 40)}`);
  }

  const flash = useCallback((next: 'success' | 'denied') => {
    setState(next);
    const timer = window.setTimeout(() => setState('idle'), next === 'success' ? 420 : 320);
    return () => window.clearTimeout(timer);
  }, []);

  const fire = () => {
    if (inert) {
      if (locked || refusal) {
        audioEngine.play('ui_deny');
        lockedMotion(ref.current);
        // The answer arrives on the press that asked for it, and then leaves.
        useUiStore.getState().pushToast({ title: 'NOT YET', body: refusal?.body, color: 'var(--danger)', glyph: '!' });
      }
      return;
    }
    if (!silent) audioEngine.play('ui_click');
    onClick?.();
    flash('success');
  };

  return (
    <button
      {...rest}
      type="button"
      ref={ref}
      className={`btn ${variant === 'default' ? '' : variant} ${size === 'small' ? 'small' : ''} ${wide ? 'wide' : ''} ${
        loading ? 'loading' : ''
      } ${shownLocked ? 'is-locked' : ''} ${state === 'success' ? 'is-success' : ''} ${state === 'denied' ? 'is-denied' : ''} ${className}`}
      style={accentVar ? ({ '--btn-accent': `var(${accentVar})` } as CSSProperties) : style}
      onClick={fire}
      onPointerEnter={() => {
        if (!inert && ref.current) hoverIn(ref.current);
        onHoverChange?.(!inert);
      }}
      onPointerLeave={() => {
        if (ref.current) hoverOut(ref.current);
        onHoverChange?.(false);
      }}
      onFocus={() => {
        if (!inert && ref.current) hoverIn(ref.current);
        onHoverChange?.(!inert);
      }}
      onBlur={() => {
        if (ref.current) hoverOut(ref.current);
        onHoverChange?.(false);
      }}
      onPointerDown={(event) => {
        if (inert || event.button === 2) return;
        if (ref.current) press(ref.current);
      }}
      onPointerUp={() => {
        if (ref.current) release(ref.current);
      }}
      onPointerCancel={() => {
        if (ref.current) release(ref.current);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === 'Enter' || event.key === ' ') {
          if (ref.current) press(ref.current);
        }
      }}
      onKeyUp={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && ref.current) release(ref.current);
      }}
      disabled={disabled && !refusal}
      aria-disabled={inert || undefined}
      aria-busy={loading || undefined}
      title={refusalTitle(title, reason)}
      data-reason={refusal?.text}
    >
      {loading ? <span className="btn-spinner" aria-hidden="true" /> : null}
      <span className="btn-face">{children}</span>
      <span className="btn-bleed" aria-hidden="true" />
    </button>
  );
}

/**
 * Menu tile — the primary navigation control. Reads its own state (badge,
 * subtitle, locked reason) and never needs a modal to explain itself.
 */
export function MenuButton({
  title,
  subtitle,
  onClick,
  disabled,
  variant = 'default',
  badge,
  locked,
  glyph,
  accentVar,
  hint,
  reason,
  needs,
  onHoverChange,
}: {
  title: string;
  subtitle?: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: ButtonProps['variant'];
  badge?: ReactNode;
  locked?: boolean;
  /** Short element sigil shown in the tile's seal box (no emoji, no icon font). */
  glyph?: string;
  accentVar?: string;
  /** Line revealed on hover/focus — the "what happens if I press this" answer. */
  hint?: string;
  /** Why the tile refuses, and what would unlock it. Shown always, because touch has no hover. */
  reason?: string;
  needs?: string[];
  /** Reports intent upward so the world behind the menu can react to it. */
  onHoverChange?: (hovered: boolean) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const refusal = refusalNotice(reason, needs);
  const inert = Boolean(disabled) || Boolean(locked);
  const shownLocked = Boolean(locked) || (Boolean(disabled) && Boolean(refusal));

  return (
    <button
      ref={ref}
      type="button"
      className={`btn tile wide ${variant === 'default' ? '' : variant} ${shownLocked ? 'is-locked' : ''}`}
      style={accentVar ? ({ '--btn-accent': `var(${accentVar})` } as CSSProperties) : undefined}
      onClick={() => {
        if (inert) {
          if (locked || refusal) {
            audioEngine.play('ui_deny');
            lockedMotion(ref.current);
            useUiStore.getState().pushToast({ title: 'NOT YET', body: refusal?.body, color: 'var(--danger)', glyph: '!' });
          }
          return;
        }
        audioEngine.play('ui_click');
        onClick?.();
        success(ref.current);
      }}
      onPointerEnter={() => {
        if (!inert && ref.current) hoverIn(ref.current);
        onHoverChange?.(!inert);
      }}
      onPointerLeave={() => {
        if (ref.current) hoverOut(ref.current);
        onHoverChange?.(false);
      }}
      onFocus={() => {
        if (!inert && ref.current) hoverIn(ref.current);
        onHoverChange?.(!inert);
      }}
      onBlur={() => {
        if (ref.current) hoverOut(ref.current);
        onHoverChange?.(false);
      }}
      onPointerDown={() => {
        if (!inert && ref.current) press(ref.current);
      }}
      onPointerUp={() => {
        if (ref.current) release(ref.current);
      }}
      disabled={disabled && !refusal}
      aria-disabled={inert || undefined}
      title={refusalTitle(title, reason)}
      data-reason={refusal?.text}
    >
      {glyph ? (
        <span className="tile-seal" aria-hidden="true">
          {glyph}
        </span>
      ) : null}
      <span className="tile-body">
        <span className="row between" style={{ width: '100%' }}>
          <span className="btn-title">{title}</span>
          {badge}
        </span>
        {subtitle ? <span className="btn-sub">{subtitle}</span> : null}
        {hint ? <span className="btn-hint">{hint}</span> : null}
      </span>
      <span className="btn-bleed" aria-hidden="true" />
      <span className="tile-caret" aria-hidden="true" />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

/**
 * A game card, not a web dialog: it settles in with weight and leaves with the
 * same physics, so a confirmation never feels like a DOM swap.
 */
export function ModalCard({
  label,
  children,
  tone = 'default',
  onEscape,
}: {
  label: string;
  children: ReactNode;
  tone?: 'default' | 'danger' | 'gold';
  onEscape?: () => void;
}) {
  const layer = useRef<HTMLDivElement | null>(null);
  const card = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    modalIn(layer.current, card.current);
    if (!onEscape) return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        void modalOut(layer.current, card.current).then(onEscape);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onEscape]);

  return (
    <div
      ref={layer}
      className="overlay-layer"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(event) => {
        if (event.target === event.currentTarget && onEscape) void modalOut(layer.current, card.current).then(onEscape);
      }}
    >
      <div ref={card} className={`overlay-card pixel-corners tone-${tone}`}>
        {children}
      </div>
    </div>
  );
}

/** Refusal feedback for a whole card (wrong slot, missing requirement…). */
export function shakeCard(el: HTMLElement | null): void {
  deny(el);
}

/* ------------------------------------------------------------------ */
/* Bars + controls                                                     */
/* ------------------------------------------------------------------ */

export function Bar({
  value,
  max,
  kind,
  label,
  valueLabel,
  size = 'default',
  segments,
  flash,
}: {
  value: number;
  max: number;
  kind: 'hp' | 'energy' | 'shield' | 'boss' | 'partner';
  label?: string;
  valueLabel?: string;
  size?: 'default' | 'thin' | 'large';
  /** Draw the fill as N hard cells instead of a smooth run. */
  segments?: number;
  /** Direction of the trailing damage ghost (hp bars show what you just lost). */
  flash?: 'damage' | 'heal' | null;
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const fill = useRef<HTMLDivElement | null>(null);
  const previous = useRef(ratio);

  useEffect(() => {
    if (!fill.current) return;
    fill.current.style.width = `${ratio * 100}%`;
    if (ratio < previous.current) {
      fill.current.dataset.lost = '1';
      const timer = window.setTimeout(() => {
        if (fill.current) delete fill.current.dataset.lost;
      }, 320);
      previous.current = ratio;
      return () => window.clearTimeout(timer);
    }
    previous.current = ratio;
    return undefined;
  }, [ratio]);

  return (
    <div className={`bar-wrap ${flash === 'damage' ? 'is-hurt' : ''}`}>
      {label ? (
        <div className="bar-label">
          <span>{label}</span>
          {valueLabel ? <span className="bar-value mono-value">{valueLabel}</span> : null}
        </div>
      ) : null}
      <div
        className={`bar ${size === 'thin' ? 'thin' : size === 'large' ? 'large' : ''} ${segments ? 'segmented' : ''}`}
        role="progressbar"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        style={segments ? ({ '--bar-segments': segments } as CSSProperties) : undefined}
      >
        <div className="bar-ghost" aria-hidden="true" />
        <div ref={fill} className={`bar-fill ${kind}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  return (
    <button
      ref={ref}
      type="button"
      className={`switch ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => {
        audioEngine.play('ui_click');
        onChange(!checked);
        if (ref.current) {
          press(ref.current);
          release(ref.current);
        }
      }}
    >
      <span className="knob" />
    </button>
  );
}

export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.05,
  onChange,
  label,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const ratio = max > min ? (value - min) / (max - min) : 0;
  return (
    <input
      ref={ref}
      type="range"
      className="slider"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      style={{ '--slider-ratio': ratio } as CSSProperties}
      onPointerDown={() => {
        if (ref.current) press(ref.current);
      }}
      onPointerUp={() => {
        if (ref.current) release(ref.current);
      }}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {hint ? <div className="tiny muted">{hint}</div> : null}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/**
 * Empty is a state, not an absence: name the condition, show the seal, and give
 * the player the one action that changes it.
 */
export function EmptyState({
  title,
  body,
  glyph,
  action,
}: {
  title: string;
  body: string;
  glyph?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {glyph ? <div className="empty-seal" aria-hidden="true">{glyph}</div> : null}
      <div className="section-label">{title}</div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        {body}
      </p>
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

/** A carved value plate: label above, big display number below. */
export function Plaque({
  label,
  value,
  sub,
  tone = 'default',
  wide,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'gold' | 'danger' | 'element';
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const last = useRef(String(value));
  useEffect(() => {
    if (String(value) === last.current) return;
    last.current = String(value);
    if (ref.current) popIn(ref.current);
  }, [value]);
  return (
    <div ref={ref} className={`plaque tone-${tone} ${wide ? 'wide' : ''}`}>
      <span className="plaque-label">{label}</span>
      <span className="plaque-value">{value}</span>
      {sub ? <span className="plaque-sub">{sub}</span> : null}
    </div>
  );
}

/** The pressable hook is re-exported so screens do not import two modules. */
export { usePressable };
