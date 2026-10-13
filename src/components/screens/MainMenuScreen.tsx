import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { KV, MenuButton, Panel, Tag } from '@/components/ui/primitives';
import { ACHIEVEMENTS } from '@/data/achievements';
import { ELEMENT_REGISTRY } from '@/data/elements';
import { FLOOR_REGISTRY } from '@/data/floors';
import { useGameFlow } from '@/app/useGameFlow';
import { useAtmosphere, previewElement } from '@/hooks/useAtmosphere';
import { useScreenMotion } from '@/hooks/useMotion';
import { UI_CONFIG } from '@/config/gameConfig';
import { useSaveStore } from '@/store/saveStore';
import { useUiStore } from '@/store/uiStore';
import type { ElementId } from '@/types';
import { formatNumber, formatTime } from '@/utils/math';

interface TileState {
  mood: 'calm' | 'focus' | 'danger';
  element: ElementId | null;
}

const IDLE: TileState = { mood: 'calm', element: null };

/**
 * Main menu.
 *
 * Not a landing page. The title, the tiles and the meta strip share one frame
 * over the ruin backdrop, the accent follows what the player is looking at, and
 * every entry point leads to a real screen. The scene behind this component
 * receives `ui:atmosphere` + `ui:elementPreview`, so hovering CONTINUE warms
 * the world with your current element instead of the page sitting still.
 */
export function MainMenuScreen() {
  const flow = useGameFlow();
  const navigate = useUiStore((s) => s.navigate);
  const setWorkingSlot = useUiStore((s) => s.setWorkingSlot);
  const data = useSaveStore(useShallow((s) => s.data));
  const activeSlot = useSaveStore((s) => s.activeSlot);
  const selectSlot = useSaveStore((s) => s.selectSlot);
  const file = useSaveStore((s) => s.file);
  const screenRef = useScreenMotion<HTMLDivElement>();

  const [tile, setTile] = useState<TileState>(IDLE);
  useAtmosphere(tile.mood, {
    accent: tile.element ? ELEMENT_REGISTRY[tile.element].colorInt : UI_CONFIG.atmosphere.story,
  });

  /* Hovering a tile is an intent, not just a highlight: the world behind the
     menu wears that tile's accent and element until focus leaves it. */
  const hovered = useCallback((state: TileState) => (active: boolean) => {
    const next = active ? state : IDLE;
    setTile(next);
    previewElement(next.element);
  }, []);

  /* The wordmark lights once, then stays lit. No endless pulse. */
  const crestRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = crestRef.current;
    if (!node) return;
    const marks = node.querySelectorAll<HTMLElement>('.crest-mark');
    marks.forEach((mark, index) => {
      mark.animate(
        [
          { opacity: 0, transform: 'translateY(-6px) scale(0.6)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ],
        { duration: 360, delay: 120 + index * 70, easing: 'cubic-bezier(0.2, 0.9, 0.24, 1)', fill: 'both' },
      );
    });
  }, []);

  const occupied = file.slots.filter(Boolean).length;
  const unlockedAchievements = data?.achievements.filter((entry) => entry.unlockedAt).length ?? 0;
  const discovered = data?.unlockedElements.length ?? 0;
  const currentFloor = data ? FLOOR_REGISTRY[data.story.currentFloor] : undefined;
  const activeElement = data?.loadout.slots[data.loadout.activeSlot] ?? data?.profile.starter ?? null;

  return (
    <div className="screen menu-screen" ref={screenRef}>
      <div className="menu-frame">
        <header className="menu-brand">
          <div className="crest" ref={crestRef} aria-hidden="true">
            {(['fire', 'water', 'air', 'earth', 'ice', 'lightning'] as ElementId[]).map((id) => (
              <span
                key={id}
                className="crest-mark"
                title={ELEMENT_REGISTRY[id].name}
                style={{ color: ELEMENT_REGISTRY[id].color }}
              />
            ))}
          </div>
          <h1 className="title-xl menu-title">SIXFOLD</h1>
          <p className="menu-tagline">
            Twenty-five elements. Two hundred waves. One ruin that remembers what you unlocked.
          </p>
        </header>

        <nav className="menu-stack" aria-label="Main menu">
          {data ? (
            <MenuButton
              variant="primary"
              glyph={activeElement ? ELEMENT_REGISTRY[activeElement].symbol : undefined}
              accentVar={activeElement ? `--el-${activeElement}` : '--gold'}
              title="CONTINUE"
              subtitle={`${data.profile.name} · Wave ${data.story.currentWave} · ${currentFloor?.name ?? `Floor ${data.story.currentFloor}`}`}
              hint={
                data.checkpoint
                  ? `Resumes from the ${data.checkpoint.bossName} checkpoint.`
                  : 'Resumes from the start of the current floor.'
              }
              onClick={() => flow.startStory()}
              onHoverChange={hovered({ mood: 'focus', element: activeElement })}
              badge={<Tag tone="gold">SLOT {activeSlot + 1}</Tag>}
            />
          ) : null}

          {data ? (
            <MenuButton
              glyph="◈"
              accentVar={activeElement ? `--el-${activeElement}` : '--gold'}
              title="THE HALL"
              subtitle={`Enter ${data.profile.name}'s hub — altar, pedestals, loadout, codex.`}
              hint="Opens the hub without starting a run. Nothing advances until you step through the gateway."
              onClick={() => {
                // Same slot link the vault performs, minus the run: the hub is a
                // place to be, not a wave to fight.
                selectSlot(activeSlot);
                navigate('hub');
              }}
              onHoverChange={hovered({ mood: 'calm', element: activeElement })}
            />
          ) : null}

          <MenuButton
            title="NEW WARDEN"
            subtitle="Choose a slot, name your warden, pick a starting element."
            hint="Three save slots. Nothing overwrites without asking."
            glyph="✦"
            onClick={() => {
              setWorkingSlot(-1);
              navigate('slotselect');
            }}
            onHoverChange={hovered({ mood: 'focus', element: 'fire' })}
          />

          <MenuButton
            title="LOAD SAVE"
            subtitle={`${occupied} of ${file.slots.length} slots occupied.`}
            hint="Reads the local file in this browser — no account, no server."
            onClick={() => navigate('slotselect')}
            onHoverChange={hovered({ mood: 'calm', element: null })}
          />

          <MenuButton
            title="ELEMENT CODEX"
            subtitle={data ? `${discovered}/25 elements discovered.` : 'Everything you have fused, and its lineage.'}
            hint="The archive of everything you have fused, with lore and lineage."
            glyph="❖"
            onClick={() => navigate('codex')}
            locked={!data}
            reason={!data ? 'The codex is a view of one warden\u2019s journey, and no warden is bound yet.' : undefined}
            needs={!data ? ['raise or link a warden on the vault plinth'] : undefined}
            onHoverChange={hovered({ mood: 'calm', element: null })}
          />

          <MenuButton
            title="FREE MODE"
            /*
             * The tile's own line, whether or not it will open: the prerequisite is what the press answers.
             */
            subtitle={
              data?.freeModeUnlocked
                ? `Endless waves${data.ascension.unlocked ? `, Ascension ${Math.max(1, data.ascension.cycle)}` : ''}.`
                : 'Any cleared floor, any recorded warden, forever.'
            }
            hint="Practice and Ascension cycles. Never touches story progress."
            glyph="∞"
            onClick={() => navigate('freemode')}
            disabled={!data}
            locked={data ? !data.freeModeUnlocked : true}
            reason={
              !data
                ? 'No warden bound to this slot yet.'
                : !data.freeModeUnlocked
                  ? `Free Mode and Ascension open when the first cycle ends \u2014 you are on wave ${data.story.highestWave} of 200, floor ${data.story.currentFloor} of 10.`
                  : undefined
            }
            needs={
              data && !data.freeModeUnlocked
                ? ['clear floor 10\u2019s warden, or reach wave 200']
                : !data
                  ? ['raise or link a warden']
                  : undefined
            }
            onHoverChange={hovered({ mood: 'danger', element: null })}
          />

          <MenuButton
            title="ACHIEVEMENTS"
            subtitle={data ? `${unlockedAchievements}/${ACHIEVEMENTS.length} sealed.` : 'Bragging rights, and nothing else.'}
            onClick={() => navigate('achievements')}
            locked={!data}
            reason={!data ? 'The ledger reads your save, and this slot has none yet.' : undefined}
            needs={!data ? ['raise or link a warden'] : undefined}
            onHoverChange={hovered({ mood: 'calm', element: null })}
          />

          <MenuButton
            title="SETTINGS"
            subtitle="Audio, readability, controls, performance."
            onClick={() => navigate('settings')}
            onHoverChange={hovered({ mood: 'calm', element: null })}
          />
        </nav>
      </div>

      <footer className="menu-meta">
        {data ? (
          <>
            <Panel level={0} animate={false} className="meta-panel">
              <div className="meta-grid">
                <KV label="Warden" value={data.profile.name} />
                <KV label="Starter" value={data.profile.starter.toUpperCase()} />
                <KV label="Highest wave" value={String(data.story.highestWave)} accent="var(--gold)" />
                <KV label="Ascension" value={data.ascension.highestWave ? `W${data.ascension.highestWave}` : '—'} />
                <KV label="Essence" value={formatNumber(data.progression.essence)} />
                <KV label="Playtime" value={formatTime(data.profile.playtime)} />
              </div>
            </Panel>
            <p className="menu-hint">
              Autosaves on wave clears, boss defeats, floor transitions and leaving a run. Nothing is written per frame.
            </p>
          </>
        ) : (
          <p className="menu-hint">
            No save in this browser yet. New Warden starts you with one element — Fire, Water or Air — and the other
            twenty-four have to be earned.
          </p>
        )}
        <p className="menu-controls">
          WASD move · mouse aim · hold click to attack · SPACE dash · E skill · Q ultimate · 1–6 elements · ESC pause
        </p>
      </footer>
    </div>
  );
}
