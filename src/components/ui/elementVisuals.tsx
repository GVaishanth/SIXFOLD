import { pressRefusal } from '@/components/ui/primitives';
import { ELEMENT_REGISTRY } from '@/data/elements';
import type { ElementDef, ElementId } from '@/types';
import { masteryBonuses, masteryLevelFromXp } from '@/game/systems/elementProgression';
import { MASTERY } from '@/config/gameConfig';
import { withAlpha } from '@/utils/color';
import type { SaveData } from '@/types';

/** Shared element presentation helpers so colours never drift between screens. */

export function ElementGlyph({
  element,
  size = 16,
  dim = false,
}: {
  element: ElementId;
  size?: number;
  dim?: boolean;
}) {
  const def = ELEMENT_REGISTRY[element];
  return (
    <span
      className="codex-symbol"
      style={{
        color: dim ? withAlpha(def.color, 0.4) : def.color,
        fontSize: size,
        letterSpacing: '0.08em',
      }}
      aria-hidden
    >
      {def.symbol}
    </span>
  );
}

export function ElementChip({
  element,
  onClick,
  equipped,
  locked,
  masteryText,
  reason,
}: {
  element: ElementId;
  onClick?: () => void;
  equipped?: boolean;
  locked?: boolean;
  masteryText?: string;
  /** What a locked chip is waiting on. Defaults to the element's own unlock note. */
  reason?: string;
}) {
  const def = ELEMENT_REGISTRY[element];
  return (
    <button
      type="button"
      className={`element-chip ${equipped ? 'equipped' : ''} ${locked ? 'locked' : ''}`}
      onClick={() => {
        if (pressRefusal(Boolean(locked), reason ?? `locked — ${def.unlock.note.toLowerCase()}`)) return;
        onClick?.();
      }}
      aria-disabled={locked || undefined}
      title={locked ? (reason ?? `Locked — ${def.unlock.note}`) : undefined}
      data-reason={locked ? (reason ?? `Locked — ${def.unlock.note}`) : undefined}
      style={{ borderLeft: `3px solid ${def.color}` }}
    >
      <span className="row" style={{ gap: 6 }}>
        <span style={{ color: def.color, fontWeight: 700 }}>{def.symbol}</span>
        <span>{locked ? '???' : def.name}</span>
      </span>
      {masteryText ? <span className="tiny muted">{masteryText}</span> : null}
    </button>
  );
}

export function masteryLabel(data: SaveData | null, element: ElementId): string {
  if (!data) return 'Lv 1';
  const xp = data.mastery[element]?.xp ?? 0;
  return `Lv ${masteryLevelFromXp(xp)}`;
}

export function masteryDetails(data: SaveData | null, element: ElementId) {
  const xp = data?.mastery[element]?.xp ?? 0;
  const level = masteryLevelFromXp(xp);
  const bonuses = masteryBonuses(element, xp);
  const nextThreshold = MASTERY.levelXp[Math.min(level, MASTERY.maxLevel - 1)];
  return {
    level,
    xp,
    nextThreshold,
    damageBonus: bonuses.damageMult,
    durationBonus: bonuses.statusDurationMult,
    cooldownMult: bonuses.cooldownMult,
  };
}

export function ElementDetailCard({ def, data }: { def: ElementDef; data: SaveData | null }) {
  const unlocked = data ? data.unlockedElements.includes(def.id) : false;
  const mastery = masteryDetails(data, def.id);
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row between">
        <div className="row" style={{ gap: 10 }}>
          <ElementGlyph element={def.id} size={24} />
          <div>
            <div className="title-md" style={{ fontSize: 16 }}>
              {unlocked ? def.name.toUpperCase() : '???'}
            </div>
            <div className="tiny muted">
              {def.tier.toUpperCase()} · {def.damageType.toUpperCase()}
            </div>
          </div>
        </div>
        <span className="tag" style={{ borderColor: def.color, color: def.color }}>
          {unlocked ? def.symbol : 'LOCKED'}
        </span>
      </div>

      <p className="small" style={{ margin: 0 }}>
        {unlocked ? def.description : 'This element has not been discovered yet. Clear waves and defeat wardens to reveal it.'}
      </p>

      <div className="kv">
        <span className="k">Combat identity</span>
        <span className="v">{unlocked ? def.identity : '—'}</span>
      </div>
      <div className="kv">
        <span className="k">Parents</span>
        <span className="v">
          {def.parents.length === 0
            ? 'None (primordial)'
            : def.parents.map((id) => ELEMENT_REGISTRY[id].name).join(' + ')}
        </span>
      </div>
      <div className="kv">
        <span className="k">Child elements</span>
        <span className="v">
          {def.children.length === 0
            ? 'None'
            : def.children.map((id) => ELEMENT_REGISTRY[id].name).join(', ')}
        </span>
      </div>
      <div className="kv">
        <span className="k">Unlock</span>
        <span className="v">{def.unlock.note}</span>
      </div>

      {unlocked ? (
        <>
          <div className="separator" />
          <div className="kv">
            <span className="k">Primary attack</span>
            <span className="v">
              {def.attack.label} · ×{def.attack.damageMultiplier.toFixed(2)} · {def.attack.cooldown.toFixed(2)}s
            </span>
          </div>
          <div className="kv">
            <span className="k">Skill · E</span>
            <span className="v">
              {def.skill.name} · {def.skill.energyCost} energy · {def.skill.cooldown}s
            </span>
          </div>
          <div className="kv">
            <span className="k">Ultimate · Q</span>
            <span className="v">
              {def.ultimate.name} · {def.ultimate.energyCost} energy · {def.ultimate.cooldown}s
            </span>
          </div>
          <div className="kv">
            <span className="k">Passive</span>
            <span className="v">{def.passive.description}</span>
          </div>
          <div className="kv">
            <span className="k">Mastery</span>
            <span className="v">
              Lv {mastery.level} · +{Math.round((mastery.damageBonus - 1) * 100)}% damage · ×
              {mastery.cooldownMult.toFixed(2)} cooldowns
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}
