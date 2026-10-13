import type { ReactNode } from 'react';
import { useScreenMotion } from '@/hooks/useMotion';

/**
 * The one shell every full-screen route uses.
 *
 * Wrapping the shell in a component means the entrance direction, the stagger
 * and the reduced-motion collapse live in exactly one place — a screen cannot
 * accidentally ship a hard cut, and backing out of a screen reverses the same
 * motion instead of replaying it.
 */
export function Screen({
  children,
  className = '',
  kicker,
  title,
  subtitle,
  actions,
  tone,
}: {
  children: ReactNode;
  className?: string;
  kicker?: string;
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Sets the single dominant colour of the screen (a CSS var name, no hexes here). */
  tone?: string;
}) {
  const ref = useScreenMotion<HTMLDivElement>();
  const hasHeader = Boolean(title || kicker || subtitle);

  return (
    <div
      ref={ref}
      className={`screen ${className}`}
      style={tone ? ({ '--accent': `var(${tone})` } as React.CSSProperties) : undefined}
    >
      {hasHeader ? (
        <header className="screen-head" data-anim="lead">
          <div className="screen-head-text">
            {kicker ? <span className="panel-kicker">{kicker}</span> : null}
            {title ? <h1 className="title-md">{title}</h1> : null}
            {subtitle ? <p className="screen-sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="screen-head-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </div>
  );
}
