import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { pressRefusal } from '@/components/ui/primitives';
import { isReducedMotion } from '@/utils/motion';

export interface PagerPage {
  /** Shown on the dot's accessible name and in the counter. */
  label: string;
  node: ReactNode;
}

/**
 * A horizontal pager for content that is too wide or too tall for one panel.
 *
 * It is deliberately a scroll container with snap points rather than a
 * transform-animated carousel: the swipe gesture, the rubber-banding and the
 * keyboard all come from the platform, so a page that grows past the panel on a
 * small phone is still reachable. The arrows and dots drive the same scroll, so
 * there is only one source of truth for the current page.
 */
export function Pager({
  pages,
  className = '',
  ariaLabel,
}: {
  pages: PagerPage[];
  className?: string;
  ariaLabel: string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);

  const goTo = useCallback((next: number) => {
    const track = trackRef.current;
    if (!track) return;
    const clamped = Math.max(0, Math.min(pages.length - 1, next));
    track.scrollTo({
      left: clamped * track.clientWidth,
      behavior: isReducedMotion() ? 'auto' : 'smooth',
    });
    setIndex(clamped);
  }, [pages.length]);

  const onScroll = useCallback(() => {
    const track = trackRef.current;
    if (!track || track.clientWidth === 0) return;
    const next = Math.max(0, Math.min(pages.length - 1, Math.round(track.scrollLeft / track.clientWidth)));
    setIndex((current) => (current === next ? current : next));
  }, [pages.length]);

  // A resize (or an orientation flip) changes the page width, so the scroll offset
  // has to be re-read or the dots would show the wrong page.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(onScroll);
    observer.observe(track);
    return () => observer.disconnect();
  }, [onScroll]);

  return (
    <div
      className={`pager ${className}`}
      role="group"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          goTo(index + 1);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          goTo(index - 1);
        }
      }}
    >
      <div className="pager-track" ref={trackRef} onScroll={onScroll}>
        {pages.map((page) => (
          <section className="pager-page" key={page.label} aria-label={page.label}>
            {page.node}
          </section>
        ))}
      </div>

      <div className="pager-foot">
        {/*
          At either end the arrow refuses, and the refusal is answered on the press rather than printed in a
          24-pixel square where no sentence fits. `aria-disabled` instead of `disabled` is what keeps the press
          reachable at all; the count line between the arrows still carries the same fact for a glance.
        */}
        <button
          type="button"
          className="btn small pager-arrow"
          onClick={() => {
            if (pressRefusal(index === 0, 'already on the first page')) return;
            goTo(index - 1);
          }}
          aria-disabled={index === 0 || undefined}
          aria-label={index === 0 ? 'Previous page — you are on the first' : 'Previous page'}
          data-reason={index === 0 ? 'already on the first page' : undefined}
        >
          PREV
        </button>
        <div className="pager-dots" role="tablist" aria-label={`${ariaLabel} pages`}>
          {pages.map((page, page1) => (
            <button
              key={page.label}
              type="button"
              role="tab"
              className={`pager-dot ${index === page1 ? 'on' : ''}`}
              aria-selected={index === page1}
              aria-label={page.label}
              title={page.label}
              onClick={() => goTo(page1)}
            />
          ))}
        </div>
        <span className="tiny muted pager-count mono">
          {index + 1} / {pages.length}
        </span>
        <button
          type="button"
          className="btn small pager-arrow"
          onClick={() => {
            if (pressRefusal(index === pages.length - 1, 'already on the last page')) return;
            goTo(index + 1);
          }}
          aria-disabled={index === pages.length - 1 || undefined}
          aria-label={index === pages.length - 1 ? 'Next page — you are on the last' : 'Next page'}
          data-reason={index === pages.length - 1 ? 'already on the last page' : undefined}
        >
          NEXT
        </button>
      </div>
    </div>
  );
}
