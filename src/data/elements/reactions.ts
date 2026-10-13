import type { ElementFamily } from '@/data/elements/palette';
import type { DamageType, ElementId, StatusApplication, StatusId, VfxStyleId } from '@/types';

/**
 * Elemental reactions.
 *
 * A reaction is a *rule about the world*, not a move in someone's moveset: any
 * damage of the right element landing on a target that already carries the right
 * status sets it off — player attack, projectile, field, hazard, even an enemy's
 * own bolt hitting an ally. Nothing here is hard-coded into the player.
 *
 * The table is data. Adding a reaction means adding an entry; the resolver, the
 * feedback and the codex all read from it.
 */

export interface ReactionFieldSpec {
  radius: number;
  duration: number;
  /** Damage per second, as a multiple of the hit that triggered the reaction. */
  dpsMultiplier: number;
  pull?: number;
  statuses?: StatusApplication[];
}

export interface ReactionChainSpec {
  radius: number;
  jumps: number;
  /** Damage per jump, as a multiple of the triggering hit. */
  damageMultiplier: number;
  status: StatusId;
  duration: number;
}

export interface ReactionDef {
  id: string;
  name: string;
  /** One line for the banner; a second for the codex. */
  short: string;
  detail: string;
  /** Incoming element(s) that can start it… */
  elements: ElementId[];
  /** …landing on a target carrying one of these statuses. */
  consumes: StatusId[];
  /** Statuses the reaction leaves behind (may be empty). */
  applies: StatusApplication[];
  /** Extra burst damage as a multiple of the hit that triggered it. */
  burstMultiplier: number;
  damageType: DamageType;
  field?: ReactionFieldSpec;
  chain?: ReactionChainSpec;
  knockback?: number;
  /** Presentation. */
  vfx: VfxStyleId;
  family: ElementFamily;
  color: string;
  sfx: 'hit' | 'crit' | 'skill' | 'ultimate' | 'element_switch';
  shake: boolean;
}

export const REACTIONS: ReactionDef[] = [
  {
    id: 'steam_burst',
    name: 'Steam Burst',
    short: 'Fire into water-slicked flesh erupts as scalding steam.',
    detail:
      'Fire damage on a target slowed by Water detonates: a burst of scalding steam, blind in a small radius, that lifts the slow off the target.',
    elements: ['fire', 'magma', 'volcano', 'solar'],
    consumes: ['slow'],
    applies: [{ id: 'blind', duration: 2.4, chance: 0.9 }],
    burstMultiplier: 0.8,
    damageType: 'elemental',
    field: { radius: 26, duration: 1.8, dpsMultiplier: 0.35, statuses: [{ id: 'blind', duration: 1.6, chance: 0.5 }] },
    knockback: 120,
    vfx: 'steam',
    family: 'gas',
    color: '#DCE6F5',
    sfx: 'skill',
    shake: true,
  },
  {
    id: 'electrified_water',
    name: 'Electrified Water',
    short: 'Current travelling through wet ground jumps between bodies.',
    detail:
      'Lightning on a wet (slowed) target turns the water conductive: the shock arcs to nearby enemies, each carrying the same charge onward.',
    elements: ['lightning', 'storm', 'tempest', 'plasma', 'sound'],
    consumes: ['slow'],
    applies: [{ id: 'shock', duration: 3, chance: 1 }],
    burstMultiplier: 0.55,
    damageType: 'elemental',
    chain: { radius: 62, jumps: 3, damageMultiplier: 0.4, status: 'shock', duration: 2.2 },
    vfx: 'bolt',
    family: 'current',
    color: '#E7D8FF',
    sfx: 'crit',
    shake: false,
  },
  {
    id: 'burning_vines',
    name: 'Burning Vines',
    short: 'Rooted growth catches and holds the fire.',
    detail:
      'Fire on a rooted target ignites the binding itself: the root burns into a ground fire that keeps feeding, and the target can no longer use the vines to hold still.',
    elements: ['fire', 'magma', 'volcano', 'solar', 'plasma'],
    consumes: ['root'],
    applies: [{ id: 'burn', duration: 5.5, intensity: 2, chance: 1 }],
    burstMultiplier: 0.7,
    damageType: 'elemental',
    field: {
      radius: 30,
      duration: 3.4,
      dpsMultiplier: 0.5,
      statuses: [{ id: 'burn', duration: 2.6, chance: 0.7 }],
    },
    vfx: 'lava',
    family: 'combustion',
    color: '#FF7A2F',
    sfx: 'skill',
    shake: false,
  },
  {
    id: 'frozen_surface',
    name: 'Frozen Surface',
    short: 'Water under ice becomes a floor nobody can run on.',
    detail:
      'Ice on a slowed (wet) target flashes the ground to a sheet of ice: everything crossing it is slowed hard and loses its footing, and the original target stops slipping and starts sliding.',
    elements: ['ice', 'frost', 'blizzard'],
    consumes: ['slow'],
    applies: [{ id: 'freeze', duration: 2.2, chance: 1 }],
    burstMultiplier: 0.4,
    damageType: 'elemental',
    field: {
      radius: 44,
      duration: 5,
      dpsMultiplier: 0.12,
      statuses: [{ id: 'slow', duration: 1.6, chance: 0.9 }],
    },
    vfx: 'frost',
    family: 'crystalline',
    color: '#DDF8FF',
    sfx: 'skill',
    shake: false,
  },
  {
    id: 'firestorm',
    name: 'Firestorm',
    short: 'Wind carries fire further than fire can go alone.',
    detail:
      'Air pressure knocked into a burning target scatters the fire: a ring of embers is thrown outward and every body inside it catches.',
    elements: ['air', 'sound', 'mist'],
    consumes: ['burn'],
    applies: [{ id: 'burn', duration: 3.4, chance: 0.85 }],
    burstMultiplier: 0.5,
    damageType: 'elemental',
    field: {
      radius: 52,
      duration: 2.2,
      dpsMultiplier: 0.4,
      pull: -26,
      statuses: [{ id: 'burn', duration: 2.2, chance: 0.55 }],
    },
    knockback: 150,
    vfx: 'eruption',
    family: 'combustion',
    color: '#FFB12B',
    sfx: 'ultimate',
    shake: true,
  },
  {
    id: 'conductive_crystal',
    name: 'Conductive Crystal',
    short: 'Charge trapped in mineral grows sharp things.',
    detail:
      'Lightning into a stunned, earthen target crystallises the ground: shards erupt where it stands and the charge is stored in them, arcing to anything that comes close.',
    elements: ['lightning', 'storm', 'tempest'],
    consumes: ['stun'],
    applies: [{ id: 'shock', duration: 4, chance: 1 }, { id: 'armorBreak', duration: 4, chance: 0.8 }],
    burstMultiplier: 0.9,
    damageType: 'elemental',
    field: {
      radius: 34,
      duration: 4.2,
      dpsMultiplier: 0.42,
      statuses: [{ id: 'shock', duration: 2, chance: 0.6 }],
    },
    chain: { radius: 54, jumps: 2, damageMultiplier: 0.3, status: 'shock', duration: 1.8 },
    vfx: 'crystal',
    family: 'crystalline',
    color: '#DA8CFF',
    sfx: 'crit',
    shake: true,
  },
];

export const REACTION_BY_ID: Record<string, ReactionDef> = Object.fromEntries(
  REACTIONS.map((reaction) => [reaction.id, reaction]),
);

/**
 * The lookup every damage path uses. Purely a function of the incoming element
 * and the statuses already on the target, so it can be asked before the hit is
 * applied and stays deterministic.
 */
export function findReaction(element: ElementId | null, carried: StatusId[]): ReactionDef | null {
  if (!element || carried.length === 0) return null;
  for (const reaction of REACTIONS) {
    if (!reaction.elements.includes(element)) continue;
    if (reaction.consumes.some((status) => carried.includes(status))) return reaction;
  }
  return null;
}

/** Statuses the reaction table is able to consume, for codex hints. */
export function reactionTriggersFor(element: ElementId): { consumes: StatusId[]; produces: string[] } {
  const consumes = new Set<StatusId>();
  const produces: string[] = [];
  for (const reaction of REACTIONS) {
    if (!reaction.elements.includes(element)) continue;
    reaction.consumes.forEach((status) => consumes.add(status));
    produces.push(reaction.name);
  }
  return { consumes: Array.from(consumes), produces };
}
