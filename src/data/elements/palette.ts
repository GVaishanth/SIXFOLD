import type { ElementId } from '@/types';

/**
 * The elemental colour system.
 *
 * Two stops per element: `core` is what the element *is* (the hot centre of a
 * flame, the body of a bolt) and `edge` is where it bleeds into the world (the
 * halo of an ember, the tail of a strike). Everything else — UI accents,
 * particle tints, screen washes, the codex plates — derives from this table so
 * a rebalance never means hunting for hex codes across the app.
 *
 * `ELEMENT_REGISTRY` reads this at build time (see `elements.ts`); the React
 * layer consumes it through the `--el-*` custom properties published by
 * `useElementTheme`.
 */
export const ELEMENT_PALETTE: Record<ElementId, { core: string; edge: string }> = {
  fire: { core: '#FF3D3D', edge: '#FF9A3D' },
  water: { core: '#246BFF', edge: '#4EDBFF' },
  air: { core: '#B9C9FF', edge: '#EFFFFF' },
  earth: { core: '#665548', edge: '#B5916D' },
  ice: { core: '#72D8FF', edge: '#DDF8FF' },
  lightning: { core: '#7D5CFF', edge: '#E7D8FF' },
  steam: { core: '#B8C2D8', edge: '#FFFFFF' },
  mist: { core: '#6675C8', edge: '#C4D3FF' },
  smoke: { core: '#343B4D', edge: '#78839A' },
  magma: { core: '#9B1C18', edge: '#FF7A2F' },
  crystal: { core: '#58C8FF', edge: '#DA8CFF' },
  storm: { core: '#485EFF', edge: '#B36BFF' },
  sand: { core: '#B78952', edge: '#E9CF8D' },
  frost: { core: '#54B8FF', edge: '#D5FFFF' },
  ash: { core: '#565B64', edge: '#E17B45' },
  vine: { core: '#247A49', edge: '#9BD95B' },
  metal: { core: '#778494', edge: '#D9E1EA' },
  sound: { core: '#8C5BFF', edge: '#FF74D8' },
  volcano: { core: '#8C1814', edge: '#FFB12B' },
  blizzard: { core: '#4AB5FF', edge: '#FFFFFF' },
  tempest: { core: '#4A73FF', edge: '#B3E8FF' },
  oasis: { core: '#28BFA4', edge: '#FFD477' },
  toxic: { core: '#59D33D', edge: '#C771FF' },
  solar: { core: '#FFB62E', edge: '#FFF1A8' },
  plasma: { core: '#9B45FF', edge: '#FF5EEB' },
};

/**
 * Presentation families. Two elements with the same hue can still need to
 * *read* differently in motion, so the VFX grammar is declared here rather
 * than inferred from the colour or the status effect.
 */
export type ElementFamily =
  | 'combustion' // fire, magma, volcano, solar — embers, heat shimmer, flares
  | 'liquid' // water, steam, oasis — droplets, ripples, arcs
  | 'gas' // air, mist, smoke, sound — streaks, plumes, drift
  | 'solid' // earth, sand, metal, ash — chunks, dust, grit
  | 'crystalline' // ice, frost, crystal — shards, facets, prisms
  | 'current' // lightning, storm, tempest — bolts, flashes, chains
  | 'organic' // vine, toxic — spores, tendrils, blooms
  | 'radiant'; // blizzard, plasma — cores, turbulence, bloom

export const ELEMENT_FAMILY: Record<ElementId, ElementFamily> = {
  fire: 'combustion',
  magma: 'combustion',
  volcano: 'combustion',
  solar: 'combustion',
  water: 'liquid',
  steam: 'liquid',
  oasis: 'liquid',
  air: 'gas',
  mist: 'gas',
  smoke: 'gas',
  sound: 'gas',
  earth: 'solid',
  sand: 'solid',
  metal: 'solid',
  ash: 'solid',
  ice: 'crystalline',
  frost: 'crystalline',
  crystal: 'crystalline',
  lightning: 'current',
  storm: 'current',
  tempest: 'current',
  vine: 'organic',
  toxic: 'organic',
  blizzard: 'radiant',
  plasma: 'radiant',
};
