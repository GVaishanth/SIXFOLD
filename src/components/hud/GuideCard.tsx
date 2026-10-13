import { useEffect, useState } from 'react';
import { gameBus } from '@/game/systems/eventBus';

/**
 * The card the guide stone raises, and the whole of the strip's vocabulary in eight lines.
 *
 * It is deliberately not a screen: `isRunSubscreen` would freeze the sim, and a mode whose danger is the
 * walk itself should not be paused by its own legend. So the run keeps running while it reads — which is
 * why the text is short, why it closes itself, and why tapping anywhere on it is enough. The stone can be
 * read again as often as you like; nothing here is spent.
 */
const GUIDE_ROWS = [
  { color: '#ff7a3c', name: 'GROVE', text: 'Wakes what lives in this biome. Kill it; take what it drops.' },
  { color: '#f2c96b', name: 'CACHE', text: 'Spills loot and essence orbs. Orbs are what your partner carries in.' },
  { color: '#57c7ff', name: 'SPRING', text: 'Heals you and lifts a fallen partner. A few draughts, not forever.' },
  { color: '#ff5c6c', name: 'FIELD', text: 'Seeded with mines. Step into the ring, never land on it.' },
  { color: '#b98cff', name: 'DEN', text: 'One warden, no introduction, no phases. Beat it or walk on.' },
  {
    color: '#dfe9ff',
    name: 'WAYSTONE',
    text: 'Links the network on the first touch. Stand on it to hop to the next link, and the next.',
  },
  { color: '#7fe0c0', name: 'CHART', text: 'Marks the way: the centre, then the stones ahead, then the route.' },
  { color: '#e8edf7', name: 'CENTRE', text: 'Where the last line merges. Standing there ends the walk.' },
];

export function GuideCard() {
  const [open, setOpen] = useState(false);

  useEffect(() => gameBus.on('game:guideOpened', () => setOpen(true)), []);

  useEffect(() => {
    if (!open) return;
    // It walks itself off the screen, because a card that outlives its own reading becomes furniture, and a
    // new run or a death must not leave the last one's legend hanging over new ground — the same reason the
    // wave banner clears on `game:runStarted`.
    const timer = window.setTimeout(() => setOpen(false), 20000);
    const offStart = gameBus.on('game:runStarted', () => setOpen(false));
    const offDeath = gameBus.on('game:playerDied', () => setOpen(false));
    return () => {
      window.clearTimeout(timer);
      offStart();
      offDeath();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="guide-card" role="dialog" aria-label="What each object in the strip does" onClick={() => setOpen(false)}>
      <p className="guide-kicker">THE STRIP, READ</p>
      <ul className="guide-list">
        {GUIDE_ROWS.map((row) => (
          <li key={row.name}>
            <span className="guide-dot" style={{ background: row.color }} aria-hidden="true" />
            <span className="guide-name">{row.name}</span>
            <span className="guide-text">{row.text}</span>
          </li>
        ))}
      </ul>
      <p className="guide-foot">Nothing here leaves the strip. Tap to put it away.</p>
    </div>
  );
}
