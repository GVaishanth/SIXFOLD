import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_COUNT,
  ACHIEVEMENT_THEMES,
  achievementReadout,
} from '@/data/achievements';
import { useSaveStore } from '@/store/saveStore';
import { useUiStore } from '@/store/uiStore';
import { Button, Tag } from '@/components/ui/primitives';
import { Screen } from '@/components/ui/Screen';

/**
 * The ledger of secrets.
 *
 * Thirty entries is a wall unless it is grouped, so the screen is organised by the same four themes the
 * data file uses, with a filter over the whole list. Every bar and every "6 of 25" on this screen is the
 * store's copy of `achievementProgress` — the one number that is also what unlocks the entry — so the
 * meter can never read further along than the truth.
 *
 * An entry whose system is switched off prints why it is waiting, in the same words the locked controls
 * use elsewhere. Nothing here punishes the player for a setting they never touched; it just says so.
 */
type Filter = 'all' | 'earned' | 'progress';

export function AchievementsScreen() {
  const back = useUiStore((s) => s.back);
  const data = useSaveStore(useShallow((s) => s.data));
  const [filter, setFilter] = useState<Filter>('all');

  const entries = ACHIEVEMENTS.map((def) => {
    const state = data?.achievements.find((entry) => entry.id === def.id);
    const progress = state?.progress ?? 0;
    const sealedAt = state?.unlockedAt ?? null;
    return {
      def,
      sealedAt,
      progress: sealedAt ? 1 : progress,
      readout: data ? achievementReadout(def, data) : `0 of ${def.target}`,
      blocked: data ? (def.requires?.(data) ?? null) : null,
    };
  });
  const sealedCount = entries.filter((entry) => entry.sealedAt).length;

  const shown = entries.filter((entry) =>
    filter === 'all' ? true : filter === 'earned' ? Boolean(entry.sealedAt) : !entry.sealedAt,
  );

  return (
    <Screen>
      <div className="screen-inner scroll-y">
        <header className="ambient-header">
          <div className="row between" style={{ alignItems: 'flex-end' }}>
            <div>
              <h1 className="title-xl">ACHIEVEMENTS</h1>
              <p className="subtitle">
                {sealedCount} of {ACHIEVEMENT_COUNT} sealed. The ledger reads your save file, so it survives a
                reload and cannot be missed by a crash.
              </p>
            </div>
            <Tag tone={sealedCount === ACHIEVEMENT_COUNT ? 'gold' : 'default'}>
              {sealedCount}/{ACHIEVEMENT_COUNT}
            </Tag>
          </div>
          <div className="bar thin" aria-label="ledger sealed" style={{ marginTop: 8 }}>
            <div
              className="bar-fill hp"
              style={{ width: `${Math.round((sealedCount / ACHIEVEMENT_COUNT) * 100)}%` }}
            />
          </div>
          <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {(
              [
                ['all', `ALL ${ACHIEVEMENT_COUNT}`],
                ['earned', `SEALED ${sealedCount}`],
                ['progress', `OPEN ${ACHIEVEMENT_COUNT - sealedCount}`],
              ] as const
            ).map(([id, label]) => (
              <Button
                key={id}
                size="small"
                variant={filter === id ? 'primary' : 'default'}
                onClick={() => setFilter(id)}
              >
                {label}
              </Button>
            ))}
          </div>
        </header>

        {ACHIEVEMENT_THEMES.map((theme) => {
          const rows = shown.filter((entry) => entry.def.theme === theme.id);
          if (!rows.length) return null;
          const inTheme = entries.filter((entry) => entry.def.theme === theme.id);
          const sealed = inTheme.filter((entry) => entry.sealedAt).length;
          return (
            <section className={`ach-group ach-${theme.id}`} key={theme.id}>
              <div className="row between ach-group-head">
                <span className="panel-kicker">{theme.label}</span>
                <span className="tiny muted">
                  {sealed} / {inTheme.length}
                </span>
              </div>
              <div className="ach-grid">
                {rows.map(({ def, sealedAt, progress, readout, blocked }) => (
                  <article key={def.id} className={`ach-card${sealedAt ? ' is-sealed' : ''}`}>
                    <span className="ach-seal" aria-hidden="true">
                      {def.glyph}
                    </span>
                    <div className="ach-body">
                      <div className="row between" style={{ gap: 8, alignItems: 'baseline' }}>
                        <strong className="ach-name">{def.name}</strong>
                        <Tag tone={sealedAt ? 'gold' : 'default'}>{sealedAt ? 'SEALED' : readout}</Tag>
                      </div>
                      <p className="tiny muted ach-desc">{def.description}</p>
                      <div className="bar thin" aria-label={`${def.name} progress`}>
                        <div className="bar-fill hp" style={{ width: `${Math.round(progress * 100)}%` }} />
                      </div>
                      <div className="row between" style={{ gap: 8, alignItems: 'center' }}>
                        <span className="tiny muted ach-foot">
                          {sealedAt
                            ? `sealed ${new Date(sealedAt).toLocaleDateString()}`
                            : progress > 0
                              ? `${Math.round(progress * 100)}% of the way`
                              : 'not yet begun'}
                        </span>
                        {/*
                          Why a card is standing still is a question, so it is answered when it is asked. Every
                          entry that can be waiting for a system at all carries this press — the red sentence it
                          would print used to sit under thirty cards at once.
                        */}
                        {blocked ? (
                          <Button
                            size="small"
                            locked
                            reason={blocked}
                            onClick={() => undefined}
                            title={blocked}
                          >
                            WHY
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}

        <div className="row between" style={{ marginTop: 12 }}>
          <Button onClick={back}>BACK</Button>
          <span className="tiny muted">
            {filter === 'progress' && !shown.length
              ? 'every seal is yours — the ledger has nothing left open.'
              : `${shown.length} of ${ACHIEVEMENT_COUNT} cards in this view.`}
          </span>
        </div>
      </div>
    </Screen>
  );
}
