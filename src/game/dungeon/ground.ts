import Phaser from 'phaser';
import { ARENA, DUNGEON } from '@/config/gameConfig';
import { ensurePropTexture, ensureTileTextures } from '@/game/textureFactory';
import { worldFrame } from '@/game/world/worldFrame';
import type { DungeonPlan, FloorDef } from '@/types';

/**
 * The strip's ground: one drawn cell at a time, never the whole map.
 *
 * `Arena` composes a single room for the whole scene, which is right for a wave fight and wrong for a
 * five-thousand-pixel walk — the player would be looking at a wall at their back and an arena-sized
 * texture stretched to nothing. So a cell gets its own floor, wall bands and lip, all keyed by index and
 * built only while it is within a cell of the camera. `setSize` on the TileSprites, never
 * `setDisplaySize`: the former keeps the tile grid at a whole number of source pixels, the latter scales
 * the tiles and smears the pixel art (docs §C).
 *
 * The cells are contiguous, so the wall band between two of them is not drawn — only the strip's own
 * left and right caps are. That is what makes the walk read as one place rather than a corridor of
 * rooms.
 *
 * What is drawn *is* the labyrinth: a spine along the middle of the strip, broken once per cell at that
 * cell's crossing, with a tooth hung off it into the lane the walk enters. Those walls are not paint —
 * each one also gets a static body, because a labyrinth whose walls you can walk through is a floor
 * plan, not a labyrinth. The geometry comes from `map.circuitFor` through `circuitRects` below, so the
 * drawing, the physics and the gate cannot disagree about where the openings are.
 *
 * The art streams with the camera, the bodies do not: eighteen static rectangles cost nothing to keep
 * alive and everything to get wrong, since a body that outlives its picture (or is rebuilt without being
 * removed) is an invisible wall in the player's way. One list, built once, is the only design that
 * cannot drift.
 */
export class DungeonGround {
  private readonly cells = new Map<number, Phaser.GameObjects.GameObject[]>();
  /**
   * The brain plan's floor, sized to the viewport and parked under the camera as it moves.
   *
   * A strip's floor is one cell wide, so its TileSprite is a cell wide and that is that. A brain is the
   * whole organ in a single cell — and a `tileSprite` whose size is the world size is not free: Phaser
   * resizes a canvas-backed source to the sprite it is painted into, so asking for the full 172×148 tile
   * field asked for a 27520×23680 canvas. At 32px per tile that was a 23-megapixel mistake; at 160 it is
   * 651 megapixels, which is not a mistake but an out-of-memory the browser reports as a blank dungeon.
   * So the floor follows the camera instead of the world, with `tilePosition` holding the art still in
   * world space — the same trick the parallax bands use, and the reason the walk looks unchanged.
   */
  private floorField: Phaser.GameObjects.TileSprite | null = null;
  /**
   * The circuit walls' static bodies, built once for the whole strip.
   *
   * A *plain* group, deliberately: an `Arcade.Group` re-applies its `defaults` to every child it
   * adopts, and a `StaticBody` has no `setAllowGravity`, so adding a wall to one throws
   * `body[key] is not a function` on the spot. Arcade walks a plain group's children for collisions all
   * the same, which is the only thing these need.
   */
  readonly walls: Phaser.GameObjects.Group;
  private wallsBuilt = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly plan: DungeonPlan,
    private readonly biomes: Record<number, FloorDef>,
  ) {
    this.walls = scene.add.group();
  }

  /** Physics and camera bounds for the whole strip; the walls are drawn per cell inside it. */
  applyWorldBounds(): void {
    const thickness = ARENA.wall;
    this.scene.physics.world.setBounds(
      thickness,
      thickness,
      this.plan.width - thickness * 2,
      this.plan.height - thickness * 2,
    );
  }

  /**
   * A cell's wall rectangles, in world pixels: the spine either side of the crossing, then the tooth.
   *
   * The last cell's spine stops short of the far wall, and that opening is where the two lanes merge —
   * the centre of the labyrinth, which is where the run ends. Nothing closes it, because a wall there
   * would be a door the player has to look for.
   */
  circuitRects(index: number): { x: number; y: number; w: number; h: number }[] {
    const chunk = this.plan.cells[index];
    if (!chunk) return [];
    const circuit = chunk.circuit;
    const x0 = index * this.plan.cellWidth;
    const width = this.plan.cellWidth;
    const height = this.plan.height;
    const half = DUNGEON.passage / 2;
    const spineTop = circuit.spine.fy0 * height;
    const spineBottom = circuit.spine.fy1 * height;
    const gapX = x0 + circuit.gapFx * width;
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    for (const [from, to] of [
      [x0, gapX - half],
      [gapX + half, x0 + circuit.spineEndFx * width],
    ] as [number, number][]) {
      if (to - from > 0) rects.push({ x: from, y: spineTop, w: to - from, h: spineBottom - spineTop });
    }
    const toothX = x0 + circuit.toothFx * width;
    const toothY = circuit.entersTop ? ARENA.wall : spineBottom;
    const toothH = circuit.entersTop ? spineTop - ARENA.wall : height - ARENA.wall - spineBottom;
    if (toothH > 0) {
      rects.push({ x: toothX - half, y: toothY, w: DUNGEON.passage, h: toothH });
    }
    return rects;
  }


  /** Every wall in the strip, in world pixels: what a straight line has to miss to be walkable. */
  get wallRects(): { x: number; y: number; w: number; h: number }[] {
    // A plan that carries its own walls (the brain: the merged folds, one list for the whole organ) has
    // already answered this question, and it answered it with the derivation's own geometry. Anything else
    // is the strip, whose walls are per-cell circuits.
    return (this.rects ??= this.plan.walls ?? Array.from({ length: this.plan.chunkCount }, (_, index) => this.circuitRects(index)).flat());
  }
  private rects: { x: number; y: number; w: number; h: number }[] | null = null;

  /** The physics half of the labyrinth: one static body per rectangle, for every cell in the strip. */
  buildColliders(): void {
    if (this.wallsBuilt) return;
    this.wallsBuilt = true;
    for (const rect of this.wallRects) {
      const zone = this.scene.add.zone(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w, rect.h);
      this.scene.physics.add.existing(zone, true);
      this.walls.add(zone);
    }
  }

  /** Ensures `index` is drawn and everything outside the window is released. */
  sync(centreX: number): void {
    this.trackFloorField();
    const want = new Set<number>();
    for (let offset = -1; offset <= 1; offset += 1) {
      const index = Math.floor(centreX / this.plan.cellWidth) + offset;
      if (index >= 0 && index < this.plan.chunkCount) want.add(index);
    }
    for (const index of want) {
      if (!this.cells.has(index)) this.build(index);
    }
    for (const [index, objects] of [...this.cells]) {
      if (want.has(index)) continue;
      for (const object of objects) object.destroy();
      this.cells.delete(index);
    }
  }

  /**
   * Keeps the camera-sized floor over the field of view. Called from `sync`, which the scene runs every
   * frame for the brain plan as well, so the field can never be caught off-screen mid-walk.
   */
  private trackFloorField(): void {
    if (!this.plan.walls) return;
    const camera = this.scene.cameras.main;
    if (!this.floorField) {
      const floor = this.biomes[1];
      if (!floor) return;
      ensureTileTextures(this.scene, floor.palette);
      this.floorField = this.scene.add
        .tileSprite(0, 0, 16, 16, `tile_${floor.palette.floor}`)
        .setDepth(-20)
        .setAlpha(0.7)
        .setOrigin(0, 0);
    }
    const width = Math.ceil(Math.max(camera.width, worldFrame.width) + 32);
    const height = Math.ceil(Math.max(camera.height, this.fieldHeight) + 32);
    if (this.floorField.width !== width || this.floorField.height !== height) {
      // `setSize`, as everywhere else in this file: it keeps the tile grid at whole source pixels, where
      // `setDisplaySize` would scale the 16px tile up to a smear. This is the only place the difference
      // could bite, because the size here tracks the viewport rather than a cell — a viewport is a
      // megapixel or two, a world is 651.
      this.floorField.setSize(width, height);
    }
    this.floorField.setPosition(camera.scrollX - 16, camera.scrollY - 16);
    // The pattern is anchored to world coordinates, so the floor reads as a floor and not as a sheet
    // dragged along under the warden's feet.
    this.floorField.setTilePosition(camera.scrollX - 16, camera.scrollY - 16);
  }

  private build(index: number): void {
    const chunk = this.plan.cells[index];
    const floor = this.biomes[chunk.biome] ?? this.biomes[1];
    if (!floor) return;
    ensureTileTextures(this.scene, floor.palette);

    const x0 = index * this.plan.cellWidth;
    const width = this.plan.cellWidth;
    const height = this.plan.height;
    const thickness = ARENA.wall;
    const created: Phaser.GameObjects.GameObject[] = [];

    // A brain plan paints its floor from the field-sized sprite `trackFloorField` keeps under the camera
    // (see the note there); anything sized off `plan.height` here would be a world-sized canvas.
    const organicFloor = Boolean(this.plan.walls);
    if (!organicFloor) {
      const ground = this.scene.add
        .tileSprite(x0 + width / 2, height / 2, width - thickness * 2, height - thickness * 2, `tile_${floor.palette.floor}`)
        .setDepth(-20)
        .setAlpha(0.7);
      ground.setSize(width - thickness * 2, height - thickness * 2);
      created.push(ground);

      // A variant of the same tile at a different scroll offset reads as a change of floor, which is the
      // cheapest way to make three cells of one biome feel like three rooms.
      if (chunk.groundVariant > 0) {
        const sheen = this.scene.add
          .tileSprite(x0 + width / 2, height / 2, width - thickness * 2, height - thickness * 2, `tile_${floor.palette.grout}`)
          .setDepth(-19)
          .setAlpha(0.05 + chunk.groundVariant * 0.03);
        sheen.setSize(width - thickness * 2, height - thickness * 2);
        created.push(sheen);
      }
    }

    // A brain plan paints its edges out of the folds themselves, so the strip's authored frame — border, top
    // and bottom bands, end caps — is skipped for it: a band across the top of a brain is a wall over sky.
    const organic = Boolean(this.plan.walls);
    const accent = Phaser.Display.Color.HexStringToColor(floor.palette.accent).color;
    if (organic) {
      const bg = Phaser.Display.Color.HexStringToColor(floor.palette.bg);
      const cut = this.scene.add.graphics().setDepth(-11);
      cut.fillStyle(Phaser.Display.Color.GetColor(bg.red, bg.green, bg.blue), 1);
      for (const run of this.plan.voidRuns ?? []) cut.fillRect(run.x, run.y, run.w, run.h);
      created.push(cut);
    } else {
      const border = this.scene.add.graphics().setDepth(-18);
      border.lineStyle(1, accent, 0.35);
      border.lineStyle(3, 0x000000, 0.2);
      border.strokeRect(x0 + thickness, thickness, width - thickness * 2, height - thickness * 2);
      created.push(border);
    }

    const wallKey = `wall_${floor.palette.wall}`;
    if (!organic) {
      const top = this.scene.add
        .tileSprite(x0 + width / 2, thickness / 2, width, thickness, wallKey)
        .setDepth(-10);
      top.setSize(width, thickness);
      const bottom = this.scene.add
        .tileSprite(x0 + width / 2, height - thickness / 2, width, thickness, wallKey)
        .setDepth(-10);
      bottom.setSize(width, thickness);
      created.push(top, bottom);

      // End caps only. Between two cells the floor continues, so drawing a wall there would be a lie.
      if (index === 0) {
        const left = this.scene.add
          .tileSprite(thickness / 2, height / 2, thickness, height, wallKey)
          .setDepth(-10);
        left.setSize(thickness, height);
        created.push(left);
      }
      if (index === this.plan.chunkCount - 1) {
        const right = this.scene.add
          .tileSprite(x0 + width - thickness / 2, height / 2, thickness, height, wallKey)
          .setDepth(-10);
        right.setSize(thickness, height);
        created.push(right);
      }
    }

    // Props, from the biome's own family, at the fractions the generator chose.
    const propKey = ensurePropTexture(this.scene, floor.props, accent);
    for (const prop of chunk.props) {
      const sprite = this.scene.add
        .image(x0 + prop.fx * width, prop.fy * height, propKey)
        .setDepth(-9)
        .setAlpha(0.8);
      sprite.setFlipX(prop.variant % 2 === 1);
      created.push(sprite);
    }

    // The walls themselves, painted from the same rectangles the static bodies were built from. For the
    // brain that list is the whole organ and belongs to the one cell drawn, not to each of seven.
    const painted = this.plan.walls ? (index === 0 ? this.plan.walls : []) : this.circuitRects(index);
    for (const rect of painted) {
      const art = this.scene.add
        .tileSprite(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w, rect.h, wallKey)
        .setDepth(-10);
      art.setSize(rect.w, rect.h);
      created.push(art);
    }

    // A lip of accent light along the spine's edges, stopped at the crossing: it is what makes the gap
    // legible as an opening from a camera that sees only one cell at a time.
    const lip = this.scene.add.graphics().setDepth(-9);
    lip.lineStyle(1, accent, 0.5);
    for (const rect of painted) {
      if (Math.round(rect.h) < 40) continue;
      lip.beginPath();
      lip.moveTo(rect.x, rect.y);
      lip.lineTo(rect.x + rect.w, rect.y);
      lip.moveTo(rect.x, rect.y + rect.h);
      lip.lineTo(rect.x + rect.w, rect.y + rect.h);
      lip.strokePath();
    }
    created.push(lip, ...this.ambientMotes(index, x0, width, height, accent));

    this.cells.set(index, created);
  }

  /**
   * Pale motes on the floor, placed by a hash of (cell, index) so a cell that leaves the camera and
   * comes back has the same light rather than a repainted one. Counted from the config per megapixel of
   * field, which is what keeps a phone's short cell from reading denser than a desktop's.
   */
  private ambientMotes(
    index: number,
    x0: number,
    width: number,
    height: number,
    accent: number,
  ): Phaser.GameObjects.Image[] {
    const key = 'fx_square';
    if (!this.scene.textures.exists(key)) return [];
    const megapixels = (width * height) / 1_000_000;
    const count = Math.min(DUNGEON.ambient.max, Math.round(DUNGEON.ambient.perMegaPixel * megapixels));
    const inset = ARENA.wall + 6;
    const created: Phaser.GameObjects.Image[] = [];
    for (let i = 0; i < count; i += 1) {
      const hash = (Math.imul(index * 7919 + i * 104729, 2654435761) >>> 0) / 0xffffffff;
      const hash2 = (Math.imul(index * 6151 + i * 2246822519, 2654435761) >>> 0) / 0xffffffff;
      const x = x0 + inset + hash * (width - inset * 2);
      const y = inset + hash2 * (height - inset * 2);
      const mote = this.scene.add
        .image(x, y, key)
        .setDepth(-17)
        .setTint(accent)
        .setAlpha(0.05 + hash2 * 0.07);
      created.push(mote);
    }
    return created;
  }

  /** The cell height is authored, not derived: a strip that changed shape mid-run would move the map. */
  get fieldHeight(): number {
    return Math.min(worldFrame.height, this.plan.height);
  }

  destroy(): void {
    this.floorField?.destroy();
    this.floorField = null;
    for (const [, objects] of this.cells) {
      for (const object of objects) object.destroy();
    }
    this.rects = null;
    this.cells.clear();
    // The zones are on the scene's display list, so the scene's own teardown removes them and their
    // bodies. Clearing the group from here runs after the display list is gone, and Phaser's
    // `Group.clear` reads the destroyed list — a throw on the way out, which is the worst place to find
    // one, because the run is already over and nothing is left to corrupt.
    this.wallsBuilt = false;
  }
}
