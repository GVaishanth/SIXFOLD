# Gameplay & stat faults — logic audit

Generated 2026-10-10. Every line below is either a code path read in this repo or a
number produced by the real modules (probes in `/home/user/audit/`: `stats-probe.mjs`,
`pressure-probe.mjs`, `essence-double.mjs`, `round.mjs`, `boss-gather.mjs`). Where a
suspicion turned out to be fine, it is in §C rather than deleted — the absences are
part of the result.

**Amended 2026-10-11, after implementation.** Each finding now carries a `Status:` line
with the number measured *before* and the number measured *after*, both from probes run
against the shipped modules. Three of this report's own claims turned out to be wrong and
are corrected in place rather than quietly rewritten — the corrections are marked
`REPORT ERROR` and are as load-bearing as the fixes, because they are the rows someone
would have used to prioritise work. §E is the verification table and how to reproduce it.

Code line numbers throughout refer to the **pre-fix** tree and have drifted (the file grew and
shrank as fixes landed); `rollDropTable`'s is corrected because the row hinged on it. Anchor on
the symbol, not the line.

Conventions: `measured` = printed by a probe against the running app or the dev module
graph. `P1` = the game is measurably wrong. `P2` = the game works, but not as
advertised. `P3` = untidy, cheap to fix.

---

## A. P1 — the numbers are wrong

### A1. Critical hits do not exist (whole stat tree, one relic, every hall reward, dead)

> **Status — FIXED (2026-10-11).** One crit roll per cast, in `damage.rollCrit`, read by all
> nine emitters. `measured` through the shipped function with a rig at `crit 0.25 / critDamage 1.6`:
> **rate 0.2507** against a configured 0.25 (n = 40 000) and **mean multiplier 1.1504** against the
> 1.15 the two knobs imply. Support casts deliberately do not roll; a 5-pellet volley is one roll,
> not five, so crit reads as a property of the cast.

`rollPlayerDamage` in `src/game/combat/damage.ts:46` is the **only** reader of
`stats.critChance` / `stats.critDamage` in the codebase, and it has **zero call sites**
(`grep -rn "rollPlayerDamage(" src` → the definition only). No player attack path ever
sets the flag:

* `Player.executeAttack` → `playerProjectiles.fire({ … })` — no `isCrit` in the config →
  `Projectile.isCrit = config.isCrit ?? false` (`Projectile.ts:83`).
* `Player.executeAttack` → `context.damageArea({ … })` — `isCrit: config.isCrit ?? false`
  (`GameplayScene.ts:709`) and the call never passes it.
* The only `isCrit: true` in the repo is `combat/reactionSystem.ts:62,82`.

Consequences, all measured or read:

| Thing | State |
| --- | --- |
| `DERIVED STATS → CRIT CHANCE / CRIT DAMAGE` HUD cells | display real numbers; nothing reads them |
| `PLAYER_CONFIG.critChance 0.06`, `critDamage 1.6` | inert |
| `progression.bonusCrit` — granted by **every hall reward** (`progressionActions.ts:188`, `hallUpgradeFor(floor)`) | inert |
| `ember_crown` relic `crit: 0.02` (`statEngine.ts:51`), `'critChance'`/`'critDamage'` passive kinds, resonances `critAdd 0.06` / `critAdd 0.04` | inert — `resonances.ts:33` still promises "attacks come faster and crit harder", and only the speed half arrives |
| `stats.critChance = Math.min(0.75, …)` clamp | protects a number that is never used |
| `COMBAT_CONFIG.tierRatios.crit` → `'crit'` impact tier | unreachable from a player hit |

Inverted side effect: because reactions *hard-code* `isCrit: true`, the impact-tier
ladder (`packet.isCrit && ratio >= ratios.crit` → `'ultimate'`) treats a reaction as a
crit-sized event while a genuine big hit cannot ever be one. `measured` — a synthetic
endgame save computes `critChance 0.62`, `critDamage 1.725`.

**Fix:** roll crit once, in the packet builders. Add `critRoll(stats)` to
`combat/damage.ts`, call it in `executeAttack` for both branches (and in the skill /
ultimate resolvers), and either wire `rollPlayerDamage` in properly or delete it so the
dead path can't be mistaken for live code again.

### A2. The wave-clear essence bonus is paid twice into the save

> **Status — FIXED.** `onWaveCleared` is no longer a wallet writer; the loot event is the only
> one. `measured`, fresh save, across one wave boundary: **HUD 26 = `progression.essence` 26 =
> `stats.essenceCollected` 26**, `singleWriter: true`, no page errors (`audit/essence-double.mjs`),
> where the same probe on the old code disagreed by the wave bonus (7) between HUD and save.
> `boss-gather.mjs` (7/7) still asserts the no-double-credit warning never fires.

Two adjacent lines in `waveDirector.ts` each reach the wallet by a different route:

1. `:355` `this.context.addEssence(essence)` → `GameplayScene.addEssence` (`:674`)
   → `gameBus.emit('game:loot', { id: 'essence_orb', amount, kind: 'essence' })` (`:677`)
   → bridge `hooks/useSaveBridge.ts:19` → `saveStore.onLoot` (`:300`) →
   `draft.progression.essence += drop.amount` (`:309`).
2. `:357` `this.hooks.onWaveCleared?.(this.spec, essence)` → `saveStore.onWaveCleared`
   (`:271`) → `applyWaveClear` (`progressionActions.ts:77`) → `draft.progression.essence += essence`.

The repo says not to do this: `hooks/useSaveBridge.ts:11-13` opens with "handled by the
scene, or progress would be counted twice" — the bridge exists to keep loot credit on one
side of the boundary, and the wave bonus crosses it twice.

`measured`: after clearing wave 1 on a fresh save, the run tally read **28** and the
persisted wallet read **35** — a difference of exactly **7**, which is
`round((waveClearEssence 6 + 1 × growth 0.55) × rewardMult 1.012)`. Per-kill orb income
lands in both ledgers, so the gap isolates the bonus: **the wallet is credited twice,
the run ledger once**, i.e. the HUD and the save disagree by the wave bonus every wave.
`stats.essenceCollected` is inflated the same way (both writers bump it).

**Fix:** make `onWaveCleared` the only wallet writer and let `addEssence` drive
presentation only (`essenceRun` + `game:loot`), or drop the `addEssence(essence)` call
and let `onWaveCleared` do the emitting.

### A3. Run buffs never expire, never clear, and stack forever

> **Status — FIXED**, with one correction to how this section describes the bug: `duration: 0`
> in the pickup data does not mean "expires", it meant nothing read it. Real durations (18 s), an
> expiry gate in `statEngine.liveRunBuffs(data, now)`, a collect-time cap of `PICKUP_CONFIG.maxBuffs`,
> and `beginRun` clears the array. `measured` damage multiplier for a 3-stack: **1.325 both before
> and after** — the fix is not a nerf to a normal run, it is the removal of the *forever* (see the
> 0/3/9/18/36 table below: 1.060 → 15.425, unbounded). The bound is the collect-time cap keeping the
> newest 6, which for the three real buff kinds means two each: **1.656**. Same ladder, before → after
> (`audit/buff-stack.mjs`, driving `liveRunBuffs` with the scene's own entry shape): 9 picks **2.070 →
> 1.656**, 18 picks **4.044 → 1.656**, 36 picks **15.425 → 1.656**, and maxHp **460 → 160** at the top.
> Expired stacks read **1.06**, and so does a pre-fix save whose entries carry no `expiresAt` — the
> legacy shape is ignored rather than treated as immortal.
> Also fixed here, outside this report's scope: both UI call sites discarded buff state (LoadoutScreen
> passed `[]`; `create()` called the helper whose default clock was +Infinity, i.e. everything expired),
> so the derived-stats panel never showed a live buff even while one was up. `toRunBuffs`, the helper
> this section quotes, no longer exists: `statEngine.liveRunBuffs(data, now | null)` is the single
> reader — the scene passes its clock, the screens pass `null` and let the scene-maintained
> `remaining` decide (`tickRunBuffs` keeps the two in agreement, `GameplayScene.ts:377`).

`collectPickup` (`GameplayScene.ts:650`) pushes `{ …, remaining: buff.duration }` into
`save.runBuffs`. Nothing anywhere decrements `remaining`:

* `toRunBuffs` (`GameplayScene.ts:1581`) filters on `buff.stat` and maps `id / name /
  magnitude / stat` — **`remaining` is dropped**.
* `grep -rn "runBuffs" src` → only the push, the type, the schema copy, and the stat
  engine's read. No timer, no removal, no run-start reset (`saveSchema.ts:128` initialises
  `runBuffs: []`, and `:381` copies whatever was saved straight back).

So a buff is **permanent for the save**, and `computePlayerStats` folds them in one entry at
a time (`// Run buffs (temporary pickups).` — `statEngine.ts:210`):

| stored entries | damageMult | attackSpeedMult | maxHp | mob hit ceiling at that HP |
| --- | --- | --- | --- | --- |
| 0 | 1.060 | 1.050 | 100 | 14.0 |
| 3 (one of each) | 1.325 | 1.260 | 130 | 18.2 |
| 9 | 2.070 | 1.814 | 190 | 26.6 |
| 18 | 4.044 | 3.135 | 280 | 39.2 |
| 36 | 15.425 | 9.362 | 460 | 64.4 |

`measured` with the real `PICKUP_REGISTRY` defs and the real `computePlayerStats` — no
formula re-implemented, and note the last column: because of A4, the `Vitality` stack
that raises your HP also raises the damage ceiling of every mob, so the "+30 max HP" buff
is simultaneously a defensive buff and a per-hit offence buff (each mob hit lands 64.4 instead of
14.0 at 460 HP — 4.6× harder, exactly in step with the 4.6× bigger pool, so hits-to-die does
not move at all).

The rate is what keeps this from being an instant-ruin: buffs drop **only** off boss tables
(`elite_drop` and the three `trash_*` tables contain no `run_buff_*` entry), and the drop
roll is one weighted pick per death, so the expected yield is `weight/Σweight × chance` =
**0.105 buffs per major boss, 0.058 per minor** (`DROP_TABLES.boss_major`,
`.boss_minor`, with `weightedPick` at `utils/math.ts:36`). A 200-wave story has 10 major +
10 minor boss waves (`localWave % 20 === 0` and `% 10`), i.e. **~1.6 buffs per run** — which
is exactly the problem: they are individually rare, permanent, and *never cleared when the
next run starts*. Ten runs of ordinary play carry ~16 permanent stat multipliers into wave 1
of run eleven (the table's `x18` row, `measured`: ×4 damage, ×3.1 speed), and nothing in the
UI says so — the hub's derived-stat panel reads the inflated numbers as if they were fresh.
The new wave-end gather sharpens it further: boss loot that used to rot on the floor is now
guaranteed to reach the player. `NEW WARDEN` is the only reset (`saveSchema.ts:128`
`runBuffs: []`).

**Fix:** decrement `remaining` in the scene's tick and drop expired entries in the same
`mutate` — but the data needs it too: all three pickups are authored as
`{ duration: 0, magnitude: 0.25 }` (`loot.ts:86,96,106`), so as written *nothing* would
expire. Give them real durations (12-20 s is the scale the HUD implies), store the
collected expiry in `runBuffs`, and clear the array in `beginRun` so a buff cannot outlive
its run. Also decide whether `duration: 0` should mean "instant" (one-shot heal-style) or
"infinite"; today both readings are possible and the code picks the second.

### A4. The per-hit damage cap deletes late-game threat and neutralises max-HP progression

> **Status — FIXED, and deliberately went one step further than the fix proposed here.** The cap
> is now `capHitDamage(raw, DIFFICULTY.damageCapBaseHp × fraction, damageCapSoftKnee)` — a fixed
> reference of 100 HP so it no longer mirrors the pool it is supposed to threaten — plus a **backstop**
> the report did not ask for: the delivered hit is also clamped to `damageHardCapFraction` (0.45) of
> the warden's live pool, so "no single touch deletes a health bar" stays true for an undergeared
> player while the curve still scales. `measured` at hp 320 / hp 100, worst mob hit: wave 100 →
> **23.3 delivered** (was 14.0), wave 140 → 50.3, wave 200 → **77.1** (was 14.0, clamped at 45 for a
> 100-HP pool). Hits-to-die at 320 HP: 13.7 at wave 100, 4.2 at wave 200.

`Enemy.spawn` snapshots `damage = min(rawDamage, config.damageCap)` (`Enemy.ts:144`) where
the caller feeds the cap: mobs get `player.stats.maxHp × openingDamageCapFraction(runWave)`
(`GameplayScene.ts:566` → `waveGenerator.ts:148`, a lerp from `DIFFICULTY.openDamageCapFraction
0.085` to `enemyDamageCapFraction 0.14` across run waves 6→12, flat after), bosses get
`maxHp × 0.22` (`:548`). From wave 12 onward the ceiling is therefore **14 % of your own max
HP per hit, forever**. `measured` against the real defs:

Figures are derived from the live `ENEMY_REGISTRY` base stats × the live
`scalingFor(localWave, cycle, floor)` multipliers, with `min(raw, maxHp × fraction)` applied
exactly as `Enemy.ts:144` states (the running scene exposes no object handle, so this is a
recomputation of one line rather than a read of a live entity). `hpMult/damageMult` at those
waves: `4.12/2.70`, `7.39/3.61`, `12.57/5.07`, `12.98/5.31` — from the real generator.

| Wave | Mob | intended hit | cap @100 HP | delivered | nerf | cap @320 HP | delivered |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | `shard_sentinel` | 32.5 | 14.0 | 14.0 | 2.3× | 44.8 | 32.5 |
| 140 | `slag_tank` | 86.6 | 14.0 | 14.0 | **6.2×** | 44.8 | 44.8 |
| 181 | `slag_tank` | 121.8 | 14.0 | 14.0 | **8.7×** | 44.8 | 44.8 |
| 200 | `core_sentinel` | 140.2 | 14.0 | 14.0 | **10.0×** | 44.8 | 44.8 |

Two structural faults follow from that one line:

* **Incoming damage rate is bounded by invulnerability, not by the horde.**
  `Player.takeDamage` early-returns inside `invulnUntil` (`PLAYER_CONFIG.invulnMs 550`),
  so with every hit clamped to 14 % of max HP the ceiling is
  `0.14 × maxHp / 0.55 s ≈ 25.4 HP/s` at 100 HP **however many enemies are touching you**.
  Against that, `regenPerSecond 1.2`, per-hit `energyOnHit`, lifesteal (2 % of
  post-armour `result.dealt` — up to 5.7 HP/s at the measured endgame 285 spec-DPS) and health orbs that are now
  auto-collected every wave trend a competent player to net-positive. Late waves stop
  being dangerous and become long: `measured` 25.6 s to clear wave 200 with an endgame
  rig, 261 s with a starter rig — and *neither* run can lose meaningfully.
* **Max HP is a self-cancelling stat.** Because the cap is a fraction of the player's own
  `maxHp`, every `bonusHp` from hall rewards and `+maxHp` buffs raises incoming damage in
  lockstep: hits-to-die is invariant to the game's biggest defensive progression. Same
  table: 14 → 44.8 delivered when HP goes 100 → 320.
* The cap is a **spawn-time snapshot**, so an HP buff taken mid-wave retroactively makes
  everything already on the field underscaled (and vice versa) — inconsistent rather than
  merely harsh.

**Fix:** cap against a *fixed reference* (floor baseline HP, or a flat per-floor damage
budget) instead of the player's live `maxHp`, and make the cap a *soft* knee
(`min(raw, cap + (raw − cap) × 0.35)`) so a wave-200 hit still stings. Keep the snapshot
out of `spawn` — evaluate at hit time or re-cap on stat refresh.

---

## B. P2 — works, but not as advertised

### B1. Support (auto) casts fund the player's own resource economy

> **Status — FIXED.** `DamagePacket.auto` is threaded end to end; an auto cast still deals the
> same damage (42 % of the manual hit, unchanged) but credits no energy and no lifesteal.
> `measured`: with a `damageFraction` of 0.42 the six support slots contribute a uniform **8.4 %** of
> manual DPS instead of funding a second skill bar every cycle.

`Player.onDealtDamage` grants `energyOnHit 1.2` **and** lifesteal on every player-sourced
hit; the scene calls it for projectile hits (`GameplayScene.ts:449`), chain hops (`:465`)
and area hits (`:720`). Auto casts cost no energy but still arrive through those calls.
`measured`: 5 support slots ÷ 1500 ms = 3.33 hits/s → **+4.0 energy/s** on top of the
7/s base (a 57 % income rise), and 6× the lifesteal sources. Skills go from a rationed
18-energy cost (`fire.skill.flame_wave 18 / 4.2 s`) to "whenever you want". The stated
contract — supports *spend* nothing — is honoured; the unstated corollary is that they
*earn*.
**Fix:** thread an `auto: true` flag on auto-cast packets and let `onDealtDamage` count
damage (achievements, stats, damage numbers) without crediting energy or lifesteal — or
scale `energyOnHit` for support hits by `AUTO_CAST.damageFraction`.

### B2. Fixed support cadence erases what makes elements different

> **Status — FIXED.** Cadence is now derived per element — `cooldownSeconds × AUTO_CAST.intervalScale`
> clamped to `[intervalMinMs, intervalMaxMs]` — so throughput differences survive. `measured` keep-fraction
> (support DPS ÷ 1.5 s of manual DPS): was **6.7–11.8 %** across elements, now **8.4 % for all** but one
> (blizzard 9.05 %, because its interval hits the 2 600 ms clamp). Aggregate support power moved by −8 %,
> so this is a redistribution between elements, not a buff. `measured` spread: manual DPS 2.08×,
> support DPS 2.25× — the two rankings now agree (blizzard top in both).

`AutoCastDirector` paces on `AUTO_CAST.intervalMs`, not on the element's own
`attack.cooldown`. Because the ratio is `cooldown × 0.42 / 1.5`, pellet count and damage
multiplier cancel, so these are exact for every element. `measured` fraction of an
element's manual spec-DPS retained as a support: `vine 0.118`, `fire 0.095`, `ice 0.090`, `storm 0.090`, `lightning 0.084`,
`air 0.067` — a 1.76× spread in *penalty* (the shortest-cooldown element is docked twice
as hard as the longest). The cycle does not just shrink the spread (3.97× manual → 3.05×
as a support): it **changes what is being ranked**. A support's output is
`damageMultiplier × count × 0.42 / 1.5`, with the cooldown gone from the denominator, so
rate-of-fire identities (air, lightning — short cooldowns) are taxed for their speed while
shotguns, whose weakness *is* their slow cadence, keep all of their pellet damage: support
DPS is `blizzard 0.87/s`, `sand 0.71/s` against `vine 0.39/s` and `air 0.20/s` — the same
two elements the manual slot ranks 21st and 25th (B7).
Being fast is a liability in a support slot and an asset in the manual slot — the one
place where `effectiveCooldown` still applies. That inversion is invisible in the UI, which
shows both seats the same element chip.
**Fix:** give `AUTO_CAST` a cooldown-aware cycle — `interval = clamp(spec.cooldown ×
intervalScale, intervalMin, intervalMax)` (neither key exists today; the director reads only
`intervalMs`) — so a fast element keeps its rate and a slow hitter stays heavy, while the
mastery speed-up still applies.

### B3. Mastery XP is credited to the element in hand, not the element that killed

> **Status — FIXED.** `Enemy.lastHitElement` records the element that actually landed the killing
> blow and `onEnemyKilled` credits it; the holder is only the fallback (hazard kills, boss self-kills).
> `measured` end-to-end (`audit:e2e`): 4 kills with one element → **`mastery 4.5` XP**, exactly
> 4 × `MASTERY.xpPerKill`.

`GameplayScene.onEnemyKilled` uses `this.player.activeElement` for the award. A support
element therefore earns nothing for its own kills, which breaks the ladder the UI
advertises ("50 % accuracy at LV 1, sharper as its mastery grows" — `LoadoutScreen`):
accuracy rises via `autoCastAccuracy(level)`, and the level comes from XP that only
arrives while you are holding that element. `measured`: LV 4 water → `AUTO 65 %`, LV 8
lightning → `AUTO 85 %` — correct numbers, unreachably sourced.
**Fix:** credit the element that dealt the killing blow (`packet.element` is already on
the kill path), or split the award across the elements that hit the target.

### B4. Every `MASTERY` XP knob is bypassed, and a fourth channel is undocumented

> **Status — FIXED.** The four scene literals are gone and every rate is read from `MASTERY`
> (`xpPerKill 1.5`, `xpPerEliteKill 8`, `xpPerBossKill 30`, `xpPerSkillUse 6`, `xpPerSwitch 0.5`);
> `deadKnobsRemoved: true` (`measured`). `MASTERY.damagePerLevel` was deleted rather than wired, because
> the per-tier ladder in `elementProgression.ts` is the better model — it now *lives* in config as
> `damagePerLevelByTier` (0.036 / 0.04 / 0.045 / 0.05) and the module reads it, so the tuning file and the
> engine cannot drift again. `measured`: fire LV10 bonus **+32.4 %**, level curve intact
> (0→LV1, 120→LV2, 7 400→LV10).

`MASTERY` declares **five** XP knobs — `xpPerHit 1`, `xpPerSkillUse 4`, `xpPerKill 6`,
`xpPerUltimateUse`, `xpPerBossHit` — and `grep` finds no reference to any of them outside the
config file, while three *other* channels exist in the scene:

| Channel | Config | Live code |
| --- | --- | --- |
| per hit | `xpPerHit: 1` | no channel exists |
| per ultimate use | `xpPerUltimateUse: 12` | no channel exists |
| per boss hit | `xpPerBossHit: 3` | no channel exists |
| per skill use | `xpPerSkillUse: 4` | `onPlayerSkill` → `addMastery(element, 6)` (`GameplayScene.ts:1182`) — **50 % above the tuned number** |
| per kill | `xpPerKill: 6` | `onEnemyKilled` → `isBoss ? 30 : elite ? 8 : 1.5` (`:1045`) |

The skill channel is the sneaky one: at `fire.skill` cooldown 4.2 s it drips 1.43 XP/s into
one element while you stand still, which is the same rate as killing a mob every second —
mastery progression is therefore driven more by "which skill do you hold down" than by the
kill counts the table was tuned for. `measured` impact: the story's total kill XP is
**16,268** at the real rates versus **39,126** if the config value were honoured, a 2.4×
divergence, and LV 10 (7,400 XP) is reachable either way *for one element only*.
Separately, every manual element switch runs `const xp = 1; addMastery(element, xp * 0.5)`
(`GameplayScene.ts:348-349`) — a fourth, undocumented XP source that also drives auto-cast
accuracy. Measured magnitude: 14,800 presses from zero to cap, so it is not an exploit,
but it is a knob with no config entry.
**Fix:** make the scene read `MASTERY.xpPerKill/xpPerHit/xpPerSkillUse`, move the switch
drip into `MASTERY.xpPerSwitch`, and delete the literal `1`.

### B5. Stats the UI shows that nothing consumes

> **Status — FIXED.** Mastery's status-duration bonus is folded into `statusDurationMult`,
> `Enemy.refreshStatusDuration()` rescales on the fly, and `scalesWithIntensity` is honoured.
> `measured`: `durationMultiplier 1.34` → burn **4.02 s** on a 1.34-amp warden vs 3.00 s without, and
> burn at intensity 3 → **4.2 s** (= 3 × 1.4) instead of a flat value. Clamped by
> `COMBAT_CONFIG.statusDurationCap 2.5`, which is new (a cap the code promised in a comment and did
> not have).

| Field | Computed from | Read by |
| --- | --- | --- |
| `stats.shieldOnWave` | element `shieldOnSwitch` passives (a kind **no element uses**) + fortress resonance `shieldOnWave: 14` | `Player.ts:1010` — but as a **switch** shield at 25 % (`× 0.25`), see B5a |
| `stats.statusDurationMult` | `statusAmp` passives (0.5 weight off-hand), resonance `statusDurationMult`, `measured 1.34` at extremes | `StatusTracker.durationMultiplier`, which is only ever assigned `0.5` by `Enemy.ts:180` — the player's number never reaches it |
| `stats.masteryStatus` | `masteryBonuses().statusDurationMult` | nothing |
| `SkillTreeScreen → "STATUS DURATION +x%"`, `elementVisuals.durationBonus` | same | display only |
| `filterStatuses`, `scaleStatuses` (`combat/damage.ts:62,70`) | — | zero call sites; `COMBAT_CONFIG.minStatusChance` therefore never consulted |
| `PICKUP_CONFIG.maxAlivePickups: 90` | — | never read; the live cap is `POOLS.pickups: 96` |
| `spec.scalesWithIntensity ? 1 : 1` (`statusSystem.ts:73`) | — | literal no-op: intensity never changes duration |

Status *chances* are fine (see §C), but the amp/scale half of that system is decorative:
the mastery ladder's "Status duration +x %" (`SkillTreeScreen.tsx:258`) and
`elementVisuals.durationBonus` both print `elementProgression.statusDurationMult`, which
no damage path consults.

### B5a. The only shield in the game is labelled for the wrong moment

> **Status — FIXED.** `shieldOnSwitch` (element passives) and `shieldOnWave` (resonances) are now
> separate fields, the wave one capped by `MAX_SHIELD_TRIGGER` so stacked resonances cannot compound
> freely. `measured`: a fortress-resonance loadout → **`shieldOnWave 14`, `shieldOnSwitch 0`**, and the
> 0 is correct — no element passive in the game grants a switch shield, so the label was promising a
> trigger nothing fed.

`stats.shieldOnWave` has exactly two inputs and one reader, and none of the three agree:

* `ResonanceEffect { kind: 'shieldOnWave', value: 14 }` — fortress (earth+metal+crystal),
  described as a guard that forms **on wave clear** (`resonances.ts:49`).
* `ElementPassiveKind 'shieldOnSwitch'` — declared in `types/element.ts:211` and handled at
  `statEngine.ts:155`, and **used by none of the 25 elements** (`grep kind: 'shieldOnSwitch'
  src/data` → nothing): a whole passive kind with no content.
* `Player.switchElement` (`:1010`) — the only reader: `shield = stats.shieldOnWave × 0.25`
  granted **per manual element switch**, throttled only by `switchReadyAt = now + 320`.

So the field's name, the resonance's description, the passive kind it swallows, and its one
consumer describe three different triggers, and the 0.25 discount is undocumented. Arithmetic: 14 × 0.25 = **3.5 shield per keypress at up to 3.1 presses/s ≈ 10.9 shield/s**,
with `addShield` clamping the pool at `maxHp × 0.6` (`:844`) and **no decay timer anywhere**
(only absorption at `:906` and a reset at `:978`). Against A4's 14-per-hit ceiling that means
tapping `Q`/`E` for six seconds buys ~4 free hits of defence, refreshed at will — the game's
only shield is a key-mash with a label that says it comes from clearing a wave.
**Fix:** pick one trigger. Either honour the name (grant `value` once in `onWaveCleared`) and
give `shieldOnSwitch` its own field for real, or rename the field to `shieldOnSwitch`, drop
the 0.25, and let elements actually use the kind.

### B6. Currencies with no sink

> **Status — OPEN, design decision.** Not code-breakage: the economy works, it just has nothing
> to buy. The arithmetic in this section was wrong (see B8 — shard income is ~840/run, not 0.5) and is
> corrected there. What is now measured: the only sink is `shardUnlockEligible`, which charges
> `shardUnlockCost 6` and **refuses** `kind:'boss'` elements outright, so a save's lifetime shard sink is
> 11 wave-unlock elements × 6 = **66 shards**, against ~**910** earned per story run (13.8× over-supplied,
> and after the first run it is pure accumulation). Essence has no sink at all. Fixing this is a decision
> about what the hub is for, not a bug report — it was left to you.

`grep` for any spend of `progression.essence` → **none**; `relicCores` → only `+=`. The
single sink in the economy is `PROGRESSION.shardUnlockCost: 6` (shards, to focus-unlock an
element) — and 11 of the 24 non-starters already unlock free on a wave milestone
(earth 15 → tempest 195, declared on each element's `unlock` block; `PROGRESSION.waveMilestones`
was a mirror of that list which nothing read, deleted with the rest of B10), 11 more on bosses. Meanwhile the wave bonus itself inflates 180×
across the story (`measured` `essenceAtClear`: 7 at wave 1, 429 at 100, 712 at 140, 1,262 at
200). Net effect: the hub's `ESSENCE` plaque and the tree's `0 SHARDS` counter advertise a
shop that does not exist, and mastery/tree pacing is driven by combat, not by a market.

### B7. AUTO-BEST ranks elements by a number that is wrong by up to 6×

> **Status — FIXED.** `loadoutAdvisor` scores volley throughput (`DPS_WEIGHT 19`) instead of the
> raw hit number that ignored `projectileCount` and `cooldown`. `measured` drift between "ranked by
> real DPS" and "ranked by the advisor": was **23 places** max, now **7** (fire 14th by score vs 7th by
> DPS). The residual is intentional — tier, mastery level and resonance weight are in the score on
> purpose — and it is small enough that the advice no longer contradicts the stat screen.

`loadoutAdvisor.scoreElement` (`:52-56`) is
`TIER_WEIGHT[tier] + level × 9 + def.attack.damageMultiplier × 60 + newResonances × 26`.
`damageMultiplier` is **per projectile**, but `Player.executeAttack` fires
`projectile.count ?? 1` of them (`:411`) — so for every shotgun the advisor divides the
element's real output by its pellet count. `measured` over all 25 elements (LV 1, no relics):

| Element | real DPS (mult × count / cooldown) | DPS rank | advisor score | score rank |
| --- | --- | --- | --- | --- |
| `blizzard` | 5.54 (0.62 × 5 / 0.56) | **1** | 59.2 | 21 |
| `sand` | 5.04 (0.42 × 6 / 0.5) | **2** | 43.2 | 25 (last) |
| `steam` | 5.00 (0.52 × 5 / 0.52) | **3** | 45.2 | 24 |
| `toxic` | 3.26 | 5 | 52.0 | 23 |
| `vine` | 3.33 (1.4 × 1 / 0.42) | 4 | **102.0** | 1 |
| `metal` | 2.16 | 20 | — | 4 |
| `oasis` | 1.82 | 25 | — | 13 |

The three strongest attacks in the game are recommended as the **three weakest**, and
`vine` tops the table on tier + a 1.4× single-hit multiplier while dealing 40 % less DPS
than the element AUTO-BEST would have left out. Peak rank drift is 23 places (sand).

Two honest qualifications: (a) a shotgun's DPS assumes all pellets connect, and `spreadDeg`
makes that range-dependent, so per-volley DPS is an upper bound rather than a sustained one
— which is *why* the count matters and cannot be waved away, since a fair rubric needs
`mult × count × expectedHits`, not `mult`; (b) the manual slot also has to survive `effectiveCost`,
and support slots neither pay energy nor keep their cooldown (B2), so one scalar cannot
serve both seats. `measured`: once the director's fixed 1500 ms cycle replaces the cooldown,
the DPS spread across the roster falls from 3.97× (count ignored) to **3.05×**, and supports
are ranked purely by per-volley damage — a slot assignment the advisor currently cannot see.
**Fix:** score `damageMultiplier × (projectile.count ?? 1) × hitFraction / effectiveCooldown(...)`
with `hitFraction` from `spreadDeg` and the target distance, use `AUTO_CAST` cadence for the
support seats, and keep the `+26` resonance bonus (that part is right).

### B8. One pick per death starves every rare drop

> **Status — REPORT ERROR, then OPEN.** The table in this section was mine and it was wrong: my
> regex sweep read `table.guaranteed` as if it competed inside the single weighted pick. It does not —
> guaranteed entries *all* drop, then **one** weighted entry is picked and gated by its own chance. Two
> consequences: `element_shard` is not "12× below a health orb", it is a guaranteed 0.45 per elite kill
> (see the corrected numbers below), and `relic_core` appearing twice in `boss_major` is not a duplicate
> id bug — once in `guaranteed`, once in `entries`, which is a coherent "always one, sometimes a second".
> The single-pick architecture itself is unchanged on purpose: per-entry rolls would multiply the drop
> rate of everything, which is a tuning decision, not a repair.

`GameplayScene.rollDropTable` (`:644`) rolls `table.guaranteed` unconditionally, then takes
**a single** `weightedPick(table.entries)` and gates it by that entry's `chance` — so each
entry in *that second list* has an expected yield of `weight / Σweight × chance`, no matter how
important it is. (It does **not** apply to `guaranteed` — see the correction below this table.)
On the
real `boss_major` table, where Σweight over `entries` is 47:

| Entry | in table as | weight | chance | expected per kill (`measured`) |
| --- | --- | --- | --- | --- |
| `essence_shard_big` | `guaranteed`, min 4 max 8 | – | – | 6.0 |
| `element_shard` | `guaranteed`, min 2 max 4 | – | – | 3.0 |
| `relic_core` | `guaranteed`, 1 | – | – | 1.0 |
| `relic_core` | `entries`, min 1 max 2 | 6 | 0.35 | 0.067 |
| `health_large` | `entries`, min 1 max 3 | 12 | 0.8 | 0.409 |
| `energy_large` | `entries`, min 1 max 3 | 12 | 0.8 | 0.409 |
| `run_buff_might` | `entries`, 1 | 5 | 0.35 | 0.037 |

The rule, verbatim from `GameplayScene.rollDropTable` (`:644`, the `:602` in the first draft
of this report is a stale line number): loop `table.guaranteed` and drop **every** entry whose
`chance` (default 1) passes a roll; then `weightedPick(table.entries)` **once** and gate that
single entry by its own `chance`. The `bonus` argument scales the chance, not the count, and
only `chance < 1` entries are gated at all — which is why `elite_drop` pays `element_shard`
0.45 per elite kill: it is a guaranteed entry that carries its own chance. So the progression currencies are not
"12× below a health orb"; they are paid outright on every major boss, and the weighted list
is the *bonus* lane. What the single pick genuinely does cost is independence: raising one
entry's chance lowers every other entry's realised rate, which is why two `relic_core` lines
exist at all ("always one, sometimes a second") and why the buff cosmetics read as leftovers.

Measured over a full 200-wave story run (`audit/drops-probe.mjs`, 4 189 mob + 1 735 elite
kills + 10 major + 10 minor bosses; a boss rolls its table **4× for a major / 2× for a minor**
— `onBossDefeated:1209` — which the first version of this probe and of this section counted as
one roll, so the boss lane was understated 2–4×): `element_shard` **795.7** from the piles, `essence_orb` 9 184,
`essence_shard_big` 2 636, `relic_core` **5.8** in the piles (plus the scripted grant — see
§B12), `run_buff_might` 2.1 / `_haste` 2.1 / `_vitality` 1.5, cosmetics **0.1**.
Three real conclusions survive from this row, and only these: cosmetics are unreachable (a
`cosmetic_*` id has a ~2 % chance per run of ever appearing), the buff lane is rare flavour
(~1.8 pickups per run across all three kinds — which is what makes `maxBuffs: 6` in A3
right-sized rather than a nerf), and relic cores land at ~13 per run, which is the number
the B11 ladder had to be calibrated to.

On the shard lane the split is the opposite of what this section first claimed, and it is
the more interesting problem: elites and bosses pay `element_shard` **guaranteed** (0.45 per
elite, 3 per major boss → **840 per run**), while `onWaveCleared`'s flat 35 % roll adds ~70.
The sink is `shardUnlockEligible`, which charges `shardUnlockCost: 6` and refuses
`kind:'boss'` elements outright — so a save can spend **11 × 6 = 66** shards in its lifetime
and then has no sink at all. `REPORT ERROR` on my original "≈0.5 shards per story run",
which came from counting only the weighted lane. **Fix:** keep the roll rule (it is sound and
the guaranteed lane is why bosses feel like progression), and instead price the sink against
the real income — more things shards can buy (focus levels, second-slot unlocks, hall rerolls)
than a one-time 6-shard discount on 11 elements.

### B9. Late-game pacing: flat, then holed

> **Status — OPEN, by choice.** The saturating curve is documented as deliberate and §C confirms
> wave 200 stays winnable; A4's fix restores the pressure the flat back half was hiding, so the pacing
> pass (grow `maxEnemiesPerWave` with the cycle, give boss waves escort floors) is a design session with
> a pad in hand, not a patch.

`measured`: `enemyCountForWave` hits its `maxEnemiesPerWave: 34` clamp at local ≈18 and
stays there for ~180 waves; `hpGrowth 1.009` reaches `hpGrowthCap: 3` around wave ≈125,
after which HP advances only by `hpLinear 0.0025` (+0.25 %/wave); and the per-wave budget
swings 15× between neighbours — `31,046` at wave 189 → `2,008` at 190, with **25 down-steps
across the story**, because boss waves replace a 34-mob wave with 1 boss + a few minions
(`spec.total` 5 at wave 200, `measured`). The saturating curve is deliberate and it does
keep wave 200 winnable (§C) — but combined with A4's ceiling it means the back half of a
run is a long, low-risk grind with regular full-stops.

### B10. 44 config keys describe a game that is not this one

> **Status — FIXED, with two rows of this section corrected, and the sweep now guarded.** Every key
> this report listed as dead was read against its reader and either **deleted** or **wired**:
> `measured`, `npm run audit:config` (`tools/configKeySweep.mjs`) tracks **167** declared leaf keys across
> 107 source files and reports **0 unreachable**. The runtime agrees — 12 sampled dead keys read
> `undefined` in the live module graph. Wired rather than deleted, because the code was already carrying
> the value as a literal: `CAMERA_CONFIG.followLerp` (hardcoded in the camera rig) and the new
> `damageCapBaseHp` / `damageHardCapFraction` / `statusDurationCap` / `maxBuffs` / `MASTERY.*` keys.
>
> The sweep found two faults of a kind this report had not: `PROGRESSION.waveMilestones` was a **second
> copy of the element unlock ladder** (earth 15 → tempest 195) with a dead alias `WAVE_MILESTONES` in
> `progressionActions.ts` — the live source is each element's `unlock: { kind: 'wave', value }`, read by
> `elementProgression.ts:16`, so a retune of an element would have invalidated the mirror silently. Both
> deleted. And `UI_CONFIG.atmosphere` listed six accents of which only `story` was read, because every
> screen passed its own accent: it is now one accent per `AtmosphereMood` plus `story` as the unmount
> default, and `useAtmosphere` resolves `UI_CONFIG.atmosphere[mood]` when a caller names a mood but no
> colour — so the Phaser backdrop and the CSS tokens cannot drift apart for the screens that don't choose.
> `REPORT ERROR`: `destroysEnemyProjectiles` is implemented — it is a per-element flag (`elements.ts:782`)
> consumed by `Projectile` (`Projectile.ts:101`), so player attack kinds *do* shoot down enemy
> projectiles; the dead key was the radius knob next to it (`projectileClearRadius`, now deleted, since
> collision is by projectile body and needs no radius). `basicAttackCostMultiplier` was never dead either:
> `Player.ts:383` multiplies every basic attack's cost by it; the attacks are 0-cost *data*, which is a
> different claim.

A sweep of `gameConfig.ts` (every depth-2 key of every exported config object, grepped for
any reference in the other 107 source files) returns **44 keys with zero references**.
Most are harmless (`COLORS.panelAlt`, `UI_CONFIG.hudBarWidth`, `PERFORMANCE.maxParticlesPerEmitter`)
— but a number of them are documented mechanics that simply do not exist:

| Dead key | Its comment promises | Reality |
| --- | --- | --- |
| `PLAYER_CONFIG.energyOnKill: 4` | killing restores energy | only `energyOnHit 1.2` fires; aggression pays no resource |
| `ENERGY_CONFIG.whiffRefund: 0.25` | a quarter of a whiffed skill comes back | no refund path exists anywhere |
| `ENERGY_CONFIG.skillCostMultiplier` / `ultimateCostMultiplier: 1` | tunable cost ladder | multiply by 1 — but `basicAttackCostMultiplier: 1` is **not** dead (**REPORT ERROR**): `Player.ts:383` scales every basic attack's cost by it. The attacks cost 0 because the *data* says `energyCost: 0`, which is the §C finding, not a dead knob |
| `COMBAT_CONFIG.projectileClearRadius: 14` | "enemy projectiles are destroyed by these player attack kinds on contact" | **REPORT ERROR** — the mechanic exists and is live: `destroysEnemyProjectiles` is a per-element flag (`elements.ts:782`) consumed by `Projectile` (`Projectile.ts:101`). Only the radius knob was dead, because the clear is a body collision, not a radius; the knob is deleted, the mechanic was never missing |
| `COMBAT_CONFIG.strongHitThreshold: 26` | damage needed before the camera shakes hard | impact tier comes from `tierRatios` in `Enemy.takeDamage`; this number is never consulted |
| `COMBAT_CONFIG.baseKnockback: 90` / `knockbackDrag: 8` | the enemy knockback feel | `knockbackVector` uses per-element `spec.knockback`; these two are unused |
| `COMBAT_CONFIG.minStatusChance: 0.05` | status effects below 5 % are dropped | only read by `filterStatuses`, which is never called |
| `DIFFICULTY.cycleHealingMult: 0.94` / `cycleHealingFloor: 0.35` | healing weakens each loop of the endgame | no healing code reads them — re-looping a save changes nothing about sustain |
| `PROGRESSION.essenceRankMult: {normal 1, elite 2.6, miniboss 9, boss 22}` | rank-scaled essence | `Enemy.essenceValue = boss ? boss.essence : def.essence` — an **elite pays exactly what the mob beside it pays** (all three `trash_*` and `elite_drop` tables then hand the same `essence_orb` range) |
| `MASTERY.damagePerLevel: 0.035` | the mastery damage ladder | superseded by a module-local `MASTERY_BY_TIER` in `elements.ts:38` (0.036 / 0.04 / 0.045 / 0.05 per level) → LV 10 is worth +32.4 % on a primordial and +45 % on a final, and the tuning file says 0.035 for everything |
| `PLAYER_CONFIG.hpPerBonusHp: 1` | HP rewards scaled by a knob | `statEngine.ts:64` adds `bonusHp` raw — which is also why A4's self-cancelling HP has no counter-weight |
| `PICKUP_CONFIG.maxAlivePickups: 90` | cap on live pickups | the real cap is `POOLS.pickups: 96` |

`maxPickupRadius: 60` is dead for a *worse* reason: the growth ladder it was meant to
bound is masked by a floor instead. `Player.pickupRadius` returns
`Math.max(PICKUP_CONFIG.magnetRadius (20), stats.pickupRadius)` and `Pickup.step:70` applies
the same floor again — so with a base of 16, every pickup-radius bonus up to **+4 does
nothing at all**. `REPORT ERROR` on the last clause: no screen shows `pickupRadius` at all
(`grep -rn pickupRadius src/components` → nothing), so the player was never told a different
number — the floor only lied to the *stat engine*, not to the UI. Fixed by making the getter
`magnetRadius + max(0, stats.pickupRadius − base)` and leaving `Pickup.step`'s max as a
redundant guard.

None of these cost anything to fix individually; together they mean the config file cannot
be read as a spec. **Fix:** either wire the ones you want (kill energy, projectile clearing,
rank-scaled essence are all three lines each) or delete the rest — a knob that is not read is
a lie you have to remember.

### B11. The relic lane paid nothing (found while implementing B10)

`RELIC_BONUSES` in `statEngine.ts` keyed its first core bonus as `relic_core_one`, but the
id `rollDropTable` actually emits is `relic_core` — every other relic in the table has the
same mismatch pattern in miniature (cosmetic ids in `relics.ts`, one key in the bonus map).
Consequence, `measured` before the fix: a player who collected the whole relic lane for a
run got **0 HP, 0 attack, 0 damage** from it, while the stat screen's relic row still
rendered its descriptions. Nothing errored; the map lookup just missed.

Fixed in the same pass as A3 (both touch the collect path): `RELIC_BONUSES.relic_core` is
keyed to the real pickup id, and the ladder got an explicit bounded form
(`PROGRESSION.relicCoreStep 3 / relicCoreDamageMult 0.012 / relicCoreCap 60`) calibrated to
the 13-cores-per-run figure above rather than to the "one per major boss" guess this report
would otherwise have used.

`measured` after: one core → **maxHp 100 → 108, attack 9 → 10.5, defense 8 → 9**; twelve
cores → damageMult **1.06 → 1.108** (4 steps of the ladder, +4.5 %); sixty cores (the cap)
→ **1.30** (+22.6 %). The cap exists because the lane is guaranteed on bosses: without it,
a 40-boss endgame save would compound a "+1 core" line into a damage multiplier nobody tuned.

### B12. A boss kill paid its currencies twice (found by the post-fix hunt)

The A2 rule the report itself proposes — *"the loot event is the sole wallet writer"* — was
applied to wave clears and **not** to bosses. `applyBossDefeat` credits the scripted bounty
(`progression.essence += args.essence`, `shards += args.shards`, `relicCores += args.relics`,
plus the matching `stats.*Collected` counters) while `onBossDefeated` *simultaneously* bursts
the boss's drop table, whose `guaranteed` list carried `essence_shard_big`, `element_shard`
and — in `boss_major` — `relic_core`. Collecting the pile therefore paid the same three
currencies a second time through `onLoot`.

`measured`, one full story run, before the patch: **61,138 essence** scripted vs **1,500**
in the boss piles (so ~97 % of boss essence was the scripted number and the pile was a 1.8 %
top-up nobody would notice missing), 289 shards scripted vs 150 dropped, and **10 relic
cores scripted vs 45.8 dropped** — i.e. the relic lane was silently overpaying 3.5×, because
the *pile*, not the grant, dominates there.

**Fix:** the pile stops carrying currency. `boss_major` / `boss_minor` now have
`guaranteed: []`, and the scripted bounty stays as *the* payment — it is deterministic, it is
what `spec.rewardMult` scales, and it is what the boss HUD quotes; the burst pile keeps the
bonus lane (health, energy, buffs, cosmetics, and `relic_core` in `entries` as "sometimes a
second"). One wallet writer per source, no currency credited twice.

`measured`, same run after: essence **83,504** (was 85,004, −1.8 %), shards **795.7 + 289 +
70** from the wave roll (was ~1,375, −16 % — still ~17× the lifetime sink, so §B6 stands and
is now quantified rather than guessed), relic cores **16** (was 56). The ladder stays
calibrated: it was tuned against 13.5 cores/run, and 16 is that number once the phantom is
removed — 4 runs to the 60-core cap, +22.6 % damage at the end of it.

Consequences this surfaced, both honest rather than alarming: buff pickups are **5.7 per
run**, not the 1.8 first written here (the bursts again), so `PICKUP_CONFIG.maxBuffs: 6` is
not the safety-net-it-looks-like but a cap a player can actually bump into; and the cosmetics
sit at **0.1 per run**, which §B8 already called unreachable and the corrected model confirms.

---

## C. Checked and found correct (do not "fix" these)

* **Enemy armour units.** `mitigate(amount, armor, break)` treats armour as a *fraction*
  and clamps to 0.85; the enemy side is fed `def.armor`/`boss.armor + affixArmor`
  (`measured` range 0–0.3 across `enemies.ts`) → consistent. The player side converts
  absolute defence first (`defense / (defense + 26)`) → also consistent. Two unit systems,
  each applied correctly on its own side.
* **`armorBreak` sign.** `statusSystem.armorMultiplier()` returns `0.6` under the status,
  which *reduces* `effectiveArmor` → the shred is oriented correctly.
* **Regen and energy units.** `Player.tick` uses `dt = deltaMs / 1000`, so
  `energyRegen 7/s`, `regenPerSecond 1.2/s` are per-second as named — no 1000× error.
* **Status chances are honoured.** `StatusTracker.apply` rolls `chance` (`if (chance < 1 &&
  Math.random() > chance) return false`) and multiplies duration — so `filterStatuses`/
  `scaleStatuses` being dead costs tuning knobs, not behaviour.
* **Save integrity.** `saveSchema` filters `unlockedElements` through `isElementId` and
  requires `unlocked.includes(candidate)` for every `loadout.slots` entry (`:157`), so a
  hand-edited loadout can neither crash the stat engine nor equip a locked element.
* **Soft-lock on resources.** All 25 basic attacks cost `energyCost: 0` (`measured`
  `zeroCostAttacks: 25`, `costsAboveZero: []`), so energy only gates skills and ultimates —
  a player with an empty bar can always fight. (The `ENERGY_CONFIG` knobs around this are
  decorative; see B10.)
* **Late-game lethality.** Wave 200 stays winnable: an endgame rig clears it in
  `measured` 25.6 s (33 hits per 1,142-HP mob at 55.4 damage/hit), which is the outcome the
  saturating-curve comment in `DIFFICULTY` promises.
* **The 2-cast budget is per frame, not per cycle** — `AUTO_CAST.castsPerCycle: 2` reads like
  it would starve five support slots (2 of 5 casts per 1.5 s), but `AutoCastDirector.update`
  takes the budget fresh each frame (`autoCast.ts:126`) and defers the overflow to the next
  frame without resetting `readyAt`, so nothing starves. Only the key's name is wrong.
* **The new gather and the new support rig are themselves sound.** Boss loot lands in
  bursts after the wave's gather, so a second gather is queued (`measured`: 8 pickups at
  the clear, 5 more at +611 ms) and `Pickup.gathering` makes a double credit impossible;
  support cycles pause correctly with `director` freezes; `AUTO_CAST.enabled: false`
  restores the previous rules with no other edit.

---

## D. Suggested order of work (this is the order that was followed)

1. **A3** (permanent buffs) — one missing filter; it silently outranks everything else.
2. **A2** (double essence) — two lines, and the HUD/save disagreement disappears.
3. **A4** (cap semantics) — the single change that decides whether the last 120 waves mean
   anything; fix the reference value and the soft knee together.
4. **A1** (crit) — wire one roll into `executeAttack` + the skill resolvers, then re-read
   `critDamage 1.6` and `bonusCrit` as live knobs and re-tune the hall rewards.
5. **B1 + B2 + B3** — support-cast energy/lifesteal policy, per-element cadence, and kill
   attribution. These three are the difference between "the loadout is a build" and "the
   loadout is six identical turrets".
6. **B4 + B5 + B5a + B10** — read the config you already have (XP rates, status amp,
   shield trigger, essence rank, magnet floor), delete what is not wired, then re-score
   AUTO-BEST on DPS (B7) so the advice the UI gives matches the numbers the engine keeps.
7. **B8 + B9** — roll the drop table per entry and re-price the shard lane; then the pacing
   pass: raise `maxEnemiesPerWave`/let it grow with cycle, and give boss
   waves a floor of escorts so the budget doesn't fall off a cliff.

   *Disposition:* B8's premise was wrong (the guaranteed lane already pays the progression
   currencies, and `relic_core` appearing in both lists is the rule, not a bug), so the roll
   rule stayed and only the *measurement* was fixed — the shard lane's price is the open
   question, together with B9's pacing and B6's missing sink. All three are tuning sessions,
   not patches, and are listed under §E "Still open, on purpose". Item 6's config pass, on the
   other hand, finished with a standing guard: `npm run audit:config` fails the build if a
   declared knob becomes unreachable again, which is the only durable way to keep §B10 dead.

---

## E. Verification — what was measured, and how to re-measure it

Every number in the `Status:` lines above came from a probe run against the shipped module
graph in the browser (no re-implementations: the probes import `statEngine`, `damage`,
`gameConfig`, `statusSystem`, `loot` and the wave generator themselves).

| Probe | What it asserts | Result on the shipped code |
| --- | --- | --- |
| `audit/fixes-probe.mjs` | crit rate/mean, support keep-fraction per element, advisor drift vs real DPS, relic ladder, buff fresh-vs-expired-vs-legacy, cap rows + backstop, mastery config as sole source, shield split, status amp + intensity, dead-key `undefined` sweep | `audit/fixes-measured.json` |
| `audit/essence-double.mjs` | wallet == HUD == `stats.essenceCollected` across a wave boundary, positive control (ledgers must move) | 27 / 27 / 27 on the last run (26 the run before — orb drops are random), `singleWriter: true`, `waveAdvanced: true` |
| `audit/drops-probe.mjs` | per-kill expectations for the real tables (incl. the 4×/2× boss burst) + a 200-wave story income, split into pile vs scripted bounty | 795.7 + 289 shards, 16 cores, 0.1 cosmetics, 83.5 k essence |
| `audit/pressure-probe.mjs` | intended vs delivered hit per wave, at 100 and 320 HP pools | w100 32.5 → 23.3, w200 140.2 → 77.1 |
| `audit/stats-probe.mjs`, `settings-fit.mjs` | stat engine surface, screen layout | unchanged harness |
| `audit/buff-clock.mjs` | the run-buff lifecycle: rebase on a restarted scene, `beginRun` / `finishRun` clearing, the legacy no-expiry shape, no-op stability, then the real UI through reload → CONTINUE → SAVE & EXIT | 10/10 (it was 9/10 the first time it ran — the failure was a bug in the fix, see §F.3) |
| `audit/buff-stack.mjs` | the A3 ladder through `liveRunBuffs` + the scene's entry shape, incl. expired and legacy `expiresAt: 0` | 9 picks → 2.070 before / 1.656 after; 36 → 15.425 / 1.656; expired and legacy both 1.06 |
| `sixfold` → `npm run audit:config` | no config leaf key is unreachable (`\.key`, `["key"]`, destructure, or an indexed/iterated parent block; `sweep: vocabulary` exempts the palette pair) | 167 keys, 0 unreachable, exit 0 |

Gate chain, re-run after the last code edit (the `damageHardCapFraction` backstop, then the
final config sweep — atmosphere accents and the `waveMilestones` mirror included). Build output
`index-*.js` 706.22 kB / 216.46 kB gzip, typecheck clean:

```
cd sixfold && npm run verify        # tsc + vite build — clean
             && npm run audit       # all PASS (incl. corrupt save + v3→v4 migration)
             && npm run audit:e2e   # all PASS (4 kills → mastery 4.5, i.e. 1.5/kill from config)
             && npm run audit:fit   # fail 0 / warn 0
             && npm run audit:config # 167 config keys, 0 unreachable
             && npm run audit:pages # 15/15 (builds and previews the production bundle itself)
node audit/round.mjs                # 23/23
node audit/phone-round.mjs          # 10/10
node audit/boss-gather.mjs          # 7/7, "no double-credit warnings"
```

Reproducing a number means re-running the file that printed it, from `/home/user`, with the
dev server on :5173 (`npm run dev` in `sixfold/`). `node_modules` and the Playwright chromium
install are not part of the persisted workspace, so a fresh sandbox needs
`npm ci && npx -y playwright@1.55.0 install --with-deps chromium` first — the probes resolve
chromium from `sixfold/node_modules/playwright` and then `~/.npm/_npx`, and they fail loudly
(the host-requirements banner) rather than silently if the browser's system libs are absent.
The `crit` row is a Monte Carlo: `measuredRate` lands within ±0.004 of the configured 0.25 and
`measuredMeanMult` within 0.002 of 1.15, so treat the fourth decimal as noise. The `measured`
figures the Status lines above quote were captured on this exact tree: crit **0.247 / 1.1482**,
relic ladder **100 → 108 HP** for one core and **1.30 damageMult** at the 60-core cap, buffs
**1.6563 live / 1.06 expired**, advisor drift **7**, wave-200 touch **77.1 at 320 HP and 45 at
100 HP**. The full dump is `audit/fixes-measured.json`. The
probes navigate the real app and then `import('/src/…')` inside the page, so a stale build
shows up as an unchanged number rather than a crash — check the server is serving the tree
you edited before trusting a "before".

### Still open, on purpose

* **B6** — essence has no sink and the shard sink saturates at 66 per save. Economy design.
* **B8** — the single weighted pick stays; only the tuning is wrong (cosmetics unreachable).
* **B9** — back-half pacing: flat mob counts then hard boss cliffs (25 down-steps).
* The `damageHardCapFraction: 0.45` backstop is a judgement call I made while fixing A4 and
  it is the one number here worth arguing with: it is what keeps wave 200 at 2.2 touches for
  a 100-HP warden instead of 1.3, and it makes pool size matter again for *survival* while
  `damageCapBaseHp` keeps it out of the *threat* curve.

---

## F. Post-fix bug hunt (2026-10-11, second pass)

Method: read every seam the fixes above touched, and measure anything that could be measured.
New file: `audit/buff-clock.mjs` (10 assertions — the run-buff lifecycle through the real UI
*and* the store actions on their own).

### Found, and patched

1. **A lapsed buff came back to life on a restarted scene.** `expiresAt` is a *scene clock*
   value, but `startGameplay(true)` — the checkpoint/resume path, and a browser refresh —
   hands the new scene a clock that starts at 0. A buff stamped at 9 999 999 ms by a long run
   therefore read as "live for another 16 minutes", and `tickRunBuffs` then faithfully kept
   `remaining` in step with it. `GameplayScene.create()` now calls
   `save.rebaseRunBuffs(this.time.now)` before anything derives stats, and the store action
   treats `remaining` (the only figure that survives a clock change honestly) as the source:
   keep `expiresAt > 0 && remaining > 0`, rewrite `expiresAt = now + remaining·1000`, and skip
   the write entirely when nothing would change (no React churn).
2. **A run's buffs outlived the run in the save.** `finishRun` built the summary and nulled the
   tracker but left `runBuffs` in the payload, so every hub screen that derives stats —
   `LoadoutScreen` reads the same funnel with `now: null`, gated on `remaining > 0` — priced an
   upgrade against a phantom buff. `finishRun` now empties the list (with `beginRun`'s clear
   kept as the net for saves written before either fix).
3. **My own rebase resurrected the legacy shape** (caught by the probe's first run, 9/10): an
   entry with `expiresAt: 0` and `remaining: 5` passed a `remaining > 0` filter and got a fresh
   5-second lease — exactly what `saveSchema` drops on load. The filter now requires both, in
   the order `liveRunBuffs` applies them.
4. **`MASTERY.xpPerUltimateUse` did not exist.** The ultimate's mastery grant was a bare `16`
   in `onPlayerUltimate` — the last rate the tuning file did not own, i.e. the §B4 fault class
   still alive in one spot. Now a key, read by the scene, guarded by `npm run audit:config`.
5. **§B12** — the boss double-credit, documented above rather than here, because it is a finding
   about the game and not about my patch.

### Checked and found clean (do not re-litigate)

* **Crit is not applied twice.** `rollCrit` has exactly two readers (`Player.ts:392` basic
  attack, `:570` skill/ultimate), each one roll per cast; `executeAttack` receives the flag
  instead of rolling again. Reaction bursts hardcode `isCrit: true` (`reactionSystem.ts:60`),
  which only styles the damage number — `amount` is computed before, no path multiplies by
  `critDamage` on the flag, and nothing counts crits (`grep -rn "crit" src/store/achievementStore.ts`
  → no hits). Cosmetic, deliberate, left alone.
* **Support casts cannot farm mastery.** The rig calls `player.castSupport` directly
  (`GameplayScene:1396`) and never emits the events that feed `registerAttackUse` /
  `xpPerSkillUse`, so an idle player earns no XP per use. Kills still credit the element that
  landed the blow (§B3) — that is the intended passive channel.
* **The currency graph has one writer per source and one spender**: pickups → `onLoot`
  (`saveStore:320-327`), wave roll → `applyWaveClear` (`progressionActions:83`), boss bounty →
  `applyBossDefeat` (`:171-176`), spend → `focusUnlockElement` (`saveStore:381`). `stats.*Collected`
  count income and are never decremented by a spend, which is what makes `essence-double.mjs`
  able to assert `wallet == collected` (26 / 26 / 26 after all of this).
* **The refund path goes through the same writer** (`refundOrb` → `game:loot`), so a wasted
  health orb cannot credit the wallet twice; `boss-gather.mjs` still asserts the no-double-credit
  warning never fires.
* **The magnet floor is redundant, not wrong.** `Pickup.step` re-applies `Math.max(magnetRadius, …)`
  after `Player.pickupRadius` already did; the second max is a no-op.

---

## G. Future gameplay scope — what the measured numbers actually justify

Not a wishlist: each row is an opportunity that the audit data says is *load-bearing*, with the
evidence that makes it worth building and the invariant it has to respect. Ordered by what the
numbers say will change how the game plays.

| # | Scope | Evidence (measured this session) | Size | Must respect |
| --- | --- | --- | --- | --- |
| 1 | **Essence needs a sink with teeth.** A hall shop that spends it: permanent-stat tier 4-5, hall rerolls, or a run-end conversion to relic cores at a bad rate. | 83 504 essence per story run, **zero** spend paths (only `shards` are spent). The hub's `ESSENCE` plaque is a counter, not a market. | M (one screen + one `mutate` spend beside `focusUnlockElement`) | one writer per source; spend must not decrement `stats.*Collected` |
| 2 | **Repeatable focus levels, then reprice shards.** Shards buy *levels*, not just the one-time 6-shard unlock, so the currency has a ladder to climb. | ~1 155 shards/run against a **66-shard lifetime sink** (11 wave-gated elements × 6, and `shardUnlockEligible` refuses boss-gated ones) → saturates inside the first run. | M | `saveSchema` bounds; keep `kind:'boss'` elements unbuyable (that is the boss's job) |
| 3 | **Relic cores as a hub sink instead of a saturating counter.** 8 cores → one permanent tier, repeatable; drop the flat ladder. | The ladder is +22.6 % at the 60-core cap and **16 cores/run** → capped in ~4 runs, after which every core that drops is worth exactly nothing. A drop that becomes worthless is worse than no drop. | S-M (the ladder already reads `relicCoreStep/Mult/Cap`) | cores are *counted, not carried* (`progression.relics` is a set) |
| 4 | **Boss waves need an escort floor** (§B9, still open). | `enemyCountForWave` clamps at `maxEnemiesPerWave: 34` around local wave 18 and stays there ~180 waves; `spec.total` is **5** at wave 200's boss; **25 down-steps** across the story (31 046 → 2 008 budget between waves 189 and 190). | S (`waveGenerator` boss branch + one `minEscorts` key) | the `hpGrowthCap: 3` saturation that keeps wave 200 winnable (§C) — add count, not HP |
| 5 | **Make the cosmetic lane reachable, then gate it.** | `cosmetic_ember_crown` / `frost_aura` at **0.1 per run** — an unobtainable 100 %. Either a guaranteed roll on a *final-floor* boss or a shard price; do not tune the chance inside a 47-entry single-pick list. | S | the single weighted pick means any `chance` rise steals from every other entry (§B8) |
| 6 | **Decide what buffs are for.** ~5.7 pickups/run, 18 s each, cap 6 — real but brief. Either make them a *run arc* (rare, long, one at a time, HUD-visible) or leave them as flavour; the current middle ground is invisible. | `run_buff_*` weights are 5 against health/energy's 12 in the same list; `maxBuffs: 6` binds at 6 stored, so a hoarding player loses the oldest silently. | S design, M if HUD-visible | nothing may persist past `finishRun` (§F.2) |
| 7 | **Give the derived-stats panel a before/after.** The panel now reflects live buffs correctly (`liveRunBuffs(data, null)`), which makes a delta readout cheap to build. | LoadoutScreen already recomputes on every `revision` bump; no per-frame work to protect. | S | React owns screens; the scene owns the clock |
| 8 | **Fix the measurement harness before tuning again.** Make `drops-probe.mjs` drive the real `rollDropTable` in a headless loop instead of *modelling* its rule, and have `boss-gather.mjs` assert a pickup count per major-boss burst. | This report's two worst errors (the `guaranteed`/`entries` conflation, the missed 4×/2× burst factor) were both modelling errors in my own probes, and both were only caught by reading the scene again. | S | probes import shipped functions; never re-implement a rule |

### Explicitly not worth building

* **More currency in the boss piles.** The pile's 1 500 essence against a 61 138 scripted
  bounty is why §B12 was fixed by emptying the pile, not by shrinking the bounty. Adding
  guaranteed currency back re-creates the double-credit.
* **A per-wave essence bonus tweak.** Wave essence is display-only until row 1 exists; tuning it
  changes nothing a player can spend.
* **Raising `AUTO_CAST.damageFraction`.** The rig is now a uniform 8.4 % of manual DPS across
  elements (was 6.7–11.8 %); the interesting knob is the *interval* scale, not the damage share,
  because the share is what keeps supports from replacing play.
* **Uncapping the relic ladder or making status amps stack past `COMBAT_CONFIG.statusDurationCap`.**
  Both were bounded deliberately this session; the caps are the tuning surface.

## H. Presentation faults the first two passes missed (2026-10-11, third pass)

Five faults reported from playing the game — a landscape HUD with buttons off-screen, cross-tier
skill purchases, a screen that stayed zoomed in after a pause and got worse with every vibration,
a wave number buried under the countdown, and SAVE & EXIT handing the run back a full health bar.

**Why the earlier passes did not catch them.** Both prior passes read the game as arithmetic: config
keys reaching their consumers, stat derivations, wallets, XP, drop tables. Every claim in §A–§G was
measured by driving the store and reading numbers. Nothing in that habit looks at a *frame*: not the
height of a breakpoint, not whether two absolutely-positioned plates land on the same pixels, not
whether an effect that mutates the camera hands back what it took. The one gate that was built for
presentation — `audit:mobile` — walked into gameplay but only measured the pads' rectangles and
whether they were inside the frame, and it *printed FAIL verdicts while exiting 0*. So it was
green across every one of these bugs. Both halves of that are now fixed: the checks are the ones that
catch these faults, and the gate stops the build on a FAIL.

### H1 — every crit zoomed the camera in, permanently (P1)

`fx.zoomPunch()` captured `this.camera.zoom` as the value it would return to. Punches overlap in
normal play (a big hit is several crits inside one punch's 110 ms), so the second punch's rest
position was the first punch's *inflated* value, and each one added to it. A pause during the
outward leg froze the tween — `setFrozen` calls `tweens.pauseAll()` — and left the frame holding that
zoom. `hitStop` had the identical mistake with the clocks: it captured `scene.time.timeScale` as the
value to restore, so two hit-stops in a row handed back the first one's 0.55.

Measured with `npm run audit:camera` against the pre-fix code (same build, both methods reverted for
the run, then restored):

| | before | after |
| --- | --- | --- |
| zoom after 3 overlapping punches | 1.08857 (never returns) | 1.000 |
| zoom after 20 punches spread across the punch window | **1.84275** | 1.000 |
| zoom while the pause card is open, punch in flight | **2.13806** | 1.000 |
| scene clock after three stacked hit-stops | **0.55 forever** | 1.0 |
| scene/physics clock when a pause lands inside a hit-stop | 0.55 / 0.28 stuck | 1.0 / 1.0 |
| after 40 real attacks: zoom and speed | 1.84275 at 0.55 speed | 1.0 at 1.0 |

Fix: the fx system now holds a `baseZoom` (set from `setupCamera`, which is where the fitted zoom
lives) and every punch runs `from: baseZoom to: baseZoom + scale` — the current zoom is never read.
A new punch retires the one in flight instead of stacking on it, and `settle()` snaps the camera back
on freeze, on resume and on every viewport re-fit (`onFrameResize`). `hitStop` is one-at-a-time and
restores both clocks to 1 unconditionally, with `clearHitStop()` releasing them if a freeze lands
inside the window. 12/12 checks pass, including one that samples the punch peak inside the frame loop
so the test cannot pass by reading the value after the yoyo.

### H2 — a landscape phone is *wide*, and every breakpoint keyed off width (P1)

The game's own responsive rules are `max-width: 820px` and `max-width: 560px`. A phone on its side
is 844×390, which clears both, so it received desktop framing: the vault hall laid out at
**1362 px inside a 390 px frame** — the plinth and station buttons (`ARRANGE LOADOUT`, `SKILL TREE`,
`SETTINGS`, `LEAVE HALL`) sat one to four screens below the fold, and `STEP THROUGH` was clipped by
17 px at the first pixel of the game. In gameplay the three top registers were absolutely positioned
at fixed `top:` values, which collide the moment the block above them grows (measured on a 360×640
phone: the wave plate drawn **30 px inside the vitals block**, because `--hud-scale` and a lit status
chip changed the block's height).

Fixes:
* A height-driven block — `@media (max-height: 520px)` — compacts hub and HUD for short frames and
  applies to a landscape phone and a short desktop window alike. `--hud-scale` stays authoritative
  for text size; this block repositions and trims, it does not shrink type.
* The hall becomes a **swipe strip** in a phone-sized frame (the query is
  `(max-width: 560px), (max-height: 520px)`): one row of cards, each capped to the frame, its body
  scrolling inside the card so the actions stay with the card. Measured depth — `scrollHeight /
  clientHeight` of `.screen`, before → after — **844×390 3.5× → 1.09×, 360×640 3.4× → 1.04×,
  390×844 2.5× → 1.00×, 430×932 → 1.00×**. The capping is scoped to `.hall-floor` because
  `.station-frame` is shared with the free-mode and ascension screens; capping those left 134 px of
  empty window under their own content, which `audit:fit` caught (`warn: 2`) and the scoping cleared.
* The narrow-frame HUD now *flows* the top registers in a grid column (`position: relative`, rows 1-3,
  countdown in the free `1fr` row, controls in row 5) instead of pinning them to fixed offsets, so no
  text size, chip count or boss plate can put two plates on the same pixels.
* The element switch strip moves up the right edge as a column in a narrow frame: the band between the
  joystick and the attack cluster is 38 px wide on a 360-px phone, narrower than one 44-px slot, and
  the two overlapped by 18×38 px before.

### H3 — a phone had no way to pause, so it had no way to leave (P1)

The pause card is the only route to the loadout, the skill tree, the settings and save & exit during
a run, and it was reachable only through `GameplayScene`'s Escape binding (`PhaserHost` pauses on
focus loss, which is not a door). On touch there was no control at all: the whole menu system was
unreachable mid-run, which is the second half of "the mobile UI is hiding few buttons".

Fix: `.hud-menu-btn` in the top-right register — drawn pause bars (a glyph at a legible size would
have been under the audit's own 9.5 px floor), `min-width/min-height: 44px × --hud-scale`, and hidden
while a full-screen card already owns the frame. `audit:mobile` now fails if the control is absent or
unclickable on any device shape.

### H4 — the wave number moved into the countdown (P2)

`WAVE n / 200` lived in the top plate while the countdown plate opened in the middle of the same
column, so at the one moment the wave matters most the two were stacked over each other's zone
(plate at y 154-235 against the top row's y 10-75 in a 390 px frame — tight enough that any growth
collided, and it did on portrait). The wave line is now rendered **inside** the countdown plate, above
the digits, and the top plate's own wave line steps down (`visibility: hidden`, so the plate keeps its
height and nothing jumps when it returns) for exactly as long as the count is up. Boss waves read
`WARDEN`, ascension runs keep their cycle prefix.

### H5 — the focus shop sold the whole tree at one price (P1)

`shardUnlockEligible` tested only `unlock.kind === 'wave'`, ignoring `parents` and `tier`, and
`PROGRESSION.shardUnlockCost` was a flat 6. A wave-1 save holding 6 shards could therefore buy
`tempest` — a `final` element authored behind wave 195 — for 6 shards, and every tier gate in the
tree was decorative for anyone with a full wallet.

Fix: `PROGRESSION.shardUnlockCostByTier` (`primordial 6 / branching 6 / advanced 12 / final 18`) and
two tree gates in the eligibility rule — an unlocked parent, and a tier no deeper than the deepest one
already held. The spend site already read `eligibility.cost`, so the price moved with the rule; the
skill-tree card's `Focus cost` line and `FOCUS n SHARDS` label now read the same number instead of the
config's flat one (they previously disagreed with the charge for every tier but the first). 20/20
checks in `npm run audit:progression`, driving the shipped function against the real element graph:
final on a fresh save refused, advanced with no parent refused (`Needs Air or Earth unlocked first`),
branching with a parent and 6 shards allowed, advanced at 12, final at 18, boss-granted and starter
elements never in the shop.

### H6 — save & exit was a free heal (P1)

The save persisted `progression.bonusHp` and nothing about current health. CONTINUE → `beginRun` →
a fresh scene → `Player` sets `hp = stats.maxHp`, so walking out of a fight at 12/100 and back in
handed 100/100 — enough to rewrite the pacing of any wave worth leaving.

Fix: `SaveData.resumeRun` (`mode`, `wave`, `hp`) staged by both exit funnels from the run store's
live vitals, dropped by `finishRun` for every cause but `exit`, dropped by `beginRun` when the start
is not the run that wrote it (a checkpoint or a different mode begins whole, as it should), and
consumed once in `GameplayScene.create()` via `Player.beginAtHp` before being cleared. Clamped into
the current stat block, because a relic or a loadout edit between leaving and returning can move
`maxHp`. Measured end to end: real damage taken in a live wave (`hp 96/100`), SAVE & EXIT, the record
read back out of `localStorage` (`{mode:"story",wave:1,hp:96}`), CONTINUE, the warden standing at
96-98 (a couple of points of regen while the wave is live is correct), the record spent exactly once.

### H7 — gate changes, so this class cannot hide again

* `tools/mobile-audit.mjs` now measures what the faults actually were and **exits 1 on a FAIL**
  (it used to print them and pass): every HUD and touch control must be inside the frame or inside a
  scroller that can reach it, and must win `elementFromPoint` at its centre; plates are compared with
  each other with containment excluded, so a countdown landing on a wave plate is a failure and not a
  screenshot someone hoped to read; the pause door is required; the camera and both clocks must be on
  their base on the play and pause screens of every shape; and a screen more than 2.2× taller than the
  frame is warned about as the desktop-layout-in-a-short-frame signal it is.
* Two new gates: `npm run audit:camera` (12 checks) and `npm run audit:progression` (20 checks).
* `tools/page-fit.mjs` remains a hub-screen fit check. It is *not* the HUD gate — it never enters
  gameplay — and this round is the evidence for why that distinction had to be written down. Two harness faults surfaced while using it, both now fixed: it clicked each station's `enter`
control without checking that anything happened, so on a fresh save — where FREE MODE and ASCENSION
are disabled — it measured the **hub twice under those labels**, which is where a
"the page body uses 68 % of the frame" warning came from (a stale screen, not a layout fault); it now
compares the screen's own heading before and after and reports `not measured — the control that opens
it is disabled for this save` instead. Its summary also derived `warn` as `verdicts.length - fails.length`,
so every INFO line counted as a warning; the counts are classified by prefix now (`fail / warn / info`).
And the tree's captions were the last text under the audit's own legibility floor — node captions at
`fontSize="8"` and the generation rows at `font-size: 9px` on every phone shape — now 10 and 10 (13 for
the card caption, which the SVG scales down), and `audit:mobile` finishes this round with **0 FAIL and
0 WARN across all six shapes**.
* `audit/boss-gather.mjs` was asserting that the boss's reward tail always gathers at least one item.
  That expectation went stale when §B12 emptied the guaranteed tables: the pile is rolled per burst
  now, and a run can finish the kill with nothing on the floor. Three consecutive runs produced tails
  of 1, 0 and 2 items. The check now requires the tail gather to *run* and to leave nothing behind
  (`pickups.countActive(true) === 0`), which is the invariant that was ever actually at stake.

### H8 — presentation surface measured and found correct

Checked while working through the above, all clean: overlay cards sit in a scrolling
`.overlay-layer`, so a long run summary at 390 px is scrolled rather than clipped; the touch layer
stacks above the canvas and every pad wins its own hit test (the canvas covering a *rounded corner* of
a circular button is not a fault — the first version of this probe sampled corners and reported a false
failure); the desktop `.element-rail`/`.ability-cluster` being hidden under `.game-layer.touch-active`
is deliberate, since the switch strip and the pad cluster own those inputs; `attachViewport` already
listens to `visualViewport` resize, `orientationchange` and a `ResizeObserver`, coalesced into one
frame, so the buffer re-fit does not go stale when mobile browser chrome folds away; `applyStats` is
ratio-preserving, so a mid-run loadout edit neither heals nor wounds; `hitStop`'s restore is a
`delayedCall` on the scene clock, which a freeze parks rather than loses; and the arena re-plan keeps
entities inside the walls across a resize (`onFrameResize` clamps rather than drops).

### H9 — the gate chain as it finished this round

Every line below is the tool's own output. `audit:fit` and `audit:mobile` need Playwright, which the
sandbox only provides after `npm ci` plus `npx playwright install --with-deps chromium` — that install
vanishing between turns is why `audit:mobile` printed "playwright is not resolvable" for most of the
previous round and produced no report at all.

| gate | result |
| --- | --- |
| `npm run verify` (typecheck + build) | clean, built in 12.80 s |
| `npm run audit` | All audit checks passed. |
| `npm run audit:e2e` | All end-to-end steps passed. |
| `npm run audit:config` | 107 files, 0 unreachable keys — `shardUnlockCostByTier` is read, the flat `shardUnlockCost` is gone |
| `npm run audit:camera` *(new this round)* | 12/12 |
| `npm run audit:progression` *(new this round)* | 20/20 |
| `npm run audit:fit` | fail 0, warn 0, info 10 (the ten INFOs are the locked stations, stated rather than judged) |
| `npm run audit:pages` | 15/15 |
| `npm run audit:mobile` | exit 0, **0 FAIL, 0 WARN**, 10 INFO lines |
| `audit/round.mjs` | 23/23 |
| `audit/phone-round.mjs` | 10/10 |
| `audit/buff-clock.mjs` | 10/10 |
| `audit/fixes-probe.mjs` | green, `pageErrors: []` |
| `audit/boss-gather.mjs` | 7/7 across three consecutive runs (tails of 1, 0 and 2 items; field empty each time) |


---

## §H10–H11 — the pause menu's loadout route, and the hole in my own gate

Prompt: *"from pause menu i want to change my elements loadout."* Not a crash — a dead end the UI
printed about itself.

### H10 — the ELEMENTS tab told the player to go somewhere else

The pause card's elements tab said, in its own words: *"Open the loadout screen from the hub to
rearrange slots."* The aggravating part is that everything a mid-run edit needs was already built:

| piece | where it already lived |
| --- | --- |
| freezing the sim while the editor is up | `GameplayScene:1380-1388`, `menuOpen` already listed `'loadout'` |
| validating the edit | `saveStore.setLoadout:376` — no duplicates, at least one filled, unlocked-only, and it repairs `activeSlot` when the element in hand is vacated |
| the same repair for the scene | `Player.setLoadout:132-137`, independently |
| applying it live | `GameplayScene:350` — `command:setLoadout` → `player.setLoadout` → `refreshPlayerStats()`, which re-derives stats, re-arms the support rig and publishes the snapshot |
| emitting it | `LoadoutScreen:129-134` already emits after every commit, including `SET ACTIVE` |
| buffs surviving a slot move | `runBuffs` are keyed by `id`/`stat` (`statEngine.liveRunBuffs:63`), never by slot, so vacating a slot cannot strand or duplicate one |

So the change is a route, not a system: an `EDIT LOADOUT` button in the elements tab
(`navigate('loadout')`, which returns to `screen: 'playing'` with `paused` still true, so the card
reopens on the tab the player left), the dead-end sentence deleted, and a band on the editor that
says what it is doing — "LIVE RUN · the simulation is frozen and every press applies at once. Health
is preserved; run buffs ride with their element, not the slot." A screen that quotes derived stats
while a live run disagrees with them is worse than no note, so the band only states what the code
guarantees.

### H10b — the fault found while wiring it: Escape un-paused the run behind the player's back

`InputManager`'s Escape calls the scene's `onPause`, which did `ui.setPaused(!ui.paused)` regardless of
which screen was on top. Pressing Escape inside the editor therefore cleared the pause flag *silently*
— the card is not rendered while `screen !== 'playing'`, so nothing appeared to change — and BACK then
dropped the player straight into a running simulation. Escape now belongs to whichever menu is up:
`isRunSubscreen(ui.screen)` ⇒ `ui.back()`.

What made it possible is worth naming, because it is the same shape as every other fault in this
document: the list of sub-screens was spelled out twice — `GAMEPLAY_SCREENS` at `App.tsx:46` (which
screens keep the canvas mounted) and `menuOpen` in the scene (which screens freeze the run). Adding a
screen to one list only would have produced exactly this class of bug: an editor that unmounts the
world, or one that leaves it running. There is now one export, `RUN_SUBSCREENS` with
`isRunSubscreen()` in `uiStore.ts`, read by the mount list, the freeze rule and Escape.

Gate: `npm run audit:pausemenu` (`tools/pause-loadout.mjs`), outside `verify` because it needs a
browser — a check that only compiles this code cannot see that a button is missing. It wounds the
player to 62/100 first, so "health preserved" cannot pass by being full, and measures: the elements tab
offers the route and no longer points at the hub; `frozen true` / `time.paused true` with the editor up;
a slot-1 → slot-3 move reaches the scene, the save's `loadout.slots` agrees with `player.slots`, the
aimed index follows the element rather than the slot, the vacated slot reads `null`, the rig is empty
because nothing else is equipped; hp 62/100 → 62/100; BACK returns to the card on the tab it left;
Escape from the editor leaves the run paused; Escape from play still toggles both ways; camera zoom is
1.0 after four freeze edges; no console errors.

Two FAILs in its first run were both the probe's, not the product's, and are recorded here because
they are the kind of mistake that hides a real bug: it looked for `json.loadout` when the vault is
`{ slots: [SaveData | null, …] }`, and it asserted the MENU button was *present* to prove we were back
in the run — the button is deliberately hidden while an overlay is open (§H3), so its absence is the
signal.

### H11 — `audit:mobile` had never measured the loadout or codex screen, on any shape

I extended the gate to cover the new pause-menu route, and the extension immediately showed the gate
was lying about its coverage. `report.json` for all five shapes listed
`hub, playing, pause, skilltree, settings` — and no `loadout`, no `codex`:

- The hub leg slept a fixed 2.6 s after `SAVE & EXIT` and then looked for each station's button,
  `continue`-ing on anything it could not find. **`SAVE & EXIT` does not go to the hall — it goes
  home** (the run summary only opens on death or a floor clear), so the leg was searching the *home
  page* for controls that live in the hall. Home has a SETTINGS card, so `text=SETTINGS` matched, got
  measured and reported under the name `settings`; the two lookups that found nothing were skipped.
  **Two screens per shape went unmeasured, and the summary counted a clean run.** Same family as H7's
  `page-fit` "assumed the click navigated", mirrored: this one assumed the *absence of a match* meant
  the absence of a screen, and `continue` made that invisible.
- The hub's stations are a swipe strip on phone shapes (that was my own layout change this session), so
  `OPEN CODEX` sits at x=1061 in a `.hall-floor` box that ends at 826 at 844×390, and `ARRANGE LOADOUT`
  at x=376 in a box ending at 350 at 360×640. Playwright can still click them (it scrolls the ancestor),
  but a check that never scrolls is only measuring what happens to be on screen.

Fixed by waiting for the hub to be *up* (`waitForFunction` on its own `STEP THROUGH` control, not a
sleep), scrolling each station into view before measuring it, and replacing `continue` with a recorded
`{ notReached }` that prints as `INFO … not measured — <why>`, so a skipped screen is now a line in the
report instead of an absence.

The newly-measured screens produced one real finding at once:

> `WARN tablet-portrait/run-loadout: 2 control(s) under 40px — OFFENCE 26x8, SURVIVAL 26x8`

Those are the derived-stats `Pager`'s page dots: `.pager-dot` is an 18×6 bar, raised to 26×8 in the
touch block, and it was the only control on that screen under the gate's 40 px rule — because no gate
had ever looked at that screen. Fixed in CSS, not in the gate: the bar became a `::before` inside a
30×32 button (40×40 in the touch block, which is what the rule actually needs — the first attempt at
34×40 still failed it, since the check is on the *smaller* axis), so the visual is pixel-identical and
the tap box is real. After that, `npm run audit:mobile` measures **9 screens on all five shapes** —
`hub, playing, pause, pause-elements, run-loadout, skilltree, loadout, codex, settings`, up from the
seven it used to claim — with **0 FAIL, 0 WARN, 10 INFO** and exit 0.

The cause was only nameable because the leg was made to say something when it skipped: the first
`notReached` line printed the buttons it *could* see, and the list was plainly the home page
(`THE HALL`, `NEW WARDEN`, `LOAD SAVE`). A one-line probe that walked the same sequence confirmed it —
`heading: ["SIXFOLD"]` right after `SAVE & EXIT`, and `RETURN TO HUB` not present to click. That
correction matters: my first explanation of the missing screens was "the exit transition was still up",
a guess that the diagnostic disproved on the next run, and a plausible wrong cause is exactly how a
harness stays broken for a whole session.

### H12 — what this round's gates say

Every line is this round's own output. §H9's table is the previous round's state; its `audit:mobile`
row described the gate *before* H11 was found, and that row was partly clean because the gate measured
less than it claimed.

| gate | result |
| --- | --- |
| `npm run verify` | typecheck clean, build in 12.60 s |
| `npm run audit` | All audit checks passed. |
| `npm run audit:pausemenu` *(new)* | 24/24 |
| `npm run audit:mobile` | exit 0, **0 FAIL, 0 WARN**, 10 INFO — 9 screens on all five shapes |
| `npm run audit:fit` | fail 0, warn 0, info 10 |
| `npm run audit:camera` | 12/12 |
| `npm run audit:progression` | 20/20 |
| `audit/round.mjs` | 23/23 (the hub's own loadout route still works after the shared-editor change) |

Two things are deliberately *not* claimed. `audit:e2e`, `audit:config`, `audit:pages` and the `/home/user`
probes were run earlier in this round and have not been re-run since the `.pager-dot` CSS and the gate
changes; none of them touches the pager or `audit:mobile`'s leg order, but the table says what was
measured after the last edit, which is the four project gates above. And the pause-menu route is not
reachable in Dungeon mode yet for the obvious reason: the mode is a design (`docs/plans/
2026-10-11-dungeon-mode-design.md`), not code.

## §I — Dungeon mode: what the build found (2026-10-11)

The mode is `docs/plans/2026-10-11-dungeon-mode-design.md`, implemented. Everything below was measured
in the browser it ships to, through `npm run audit:dungeonrun` (`tools/dungeon-run.mjs`, 54 checks:
mechanics at 1360-class desktop, presentation at 360×640 and 844×390, story mode re-entered at the end).
The generator itself is a separate, offline gate (`audit:dungeon`, 31/31).

### I1 — a subclass entity called `state`, and Phaser's own field ate it (P1)

`Ally` and `Stone` both began life with `state: 'downed' | …`, next to `Phaser.GameObjects.Sprite`'s
internal `state`. TypeScript accepted it — a subclass may shadow an inherited property, and comparing an
object with a string is not an error — so the entities were quietly writing over engine bookkeeping while
their own logic read a *different* value back. Renamed to `allyState` / `stoneState`. The lesson is not
"check the diff", it is that a field name in an entity subclass has a namespace to respect, and nothing
in this project's type setup will tell you when you collide with it.

### I2 — a scene with no wave director threw away a whole frame (P1)

`spawnEnemy` computes the damage cap as
`openingDamageCapFraction(runWaveOf(this.context.floor.id, this.director.currentSpec?.localWave ?? 1))`.
The optional chaining is on `currentSpec`, never on `director` — so in a mode with no director the call
throws, and because the throw happens inside the scene's `update`, the *rest of that frame* is discarded:
the camera stopped following, the snapshot stopped publishing, and the scene never processed its queued
stop. Measured as `pageerror: Cannot read properties of undefined (reading 'currentSpec')` with
`reported=false, cell 1, active=true` after save & exit — five probe failures, one cause.

Fixed by making the shared combat code tolerate the absence rather than by fabricating a fake director:
`this.director?.currentSpec`, `this.director?.killAll()`, `this.director?.begin(...)` at the nine sites
that read it, and `debugInfo` reporting `state: 'none'`. A stub director would have made the crash go
away and left a lying object in the scene.

### I3 — groves woke nothing, because floors speak in archetypes (P1)

The generator puts `floor.enemyPool[i]` in a site, and the pool holds *archetypes* — `'chaser'`,
`'caster'` — while `spawnEnemy` wants a definition id from `ENEMY_REGISTRY`. It returns `null` for an
unknown id, which is the right failure mode and the wrong symptom: the stone emptied its queue, marked
itself spent, and the cell stayed quiet. Measured before the fix: `enemies 0, stones spent 1`; after:
`enemies 2`, and the same run reported `2 felled · ledger 22 · best hit 16`.

Fixed by exporting the wave generator's own `pickDef(floor, archetype, variantSeed)` and calling it, so
a strip spawns the definitions that actually live in that biome. A second roster in the dungeon would
have drifted from the first the moment a floor was re-authored.

### I4 — the strip was earning mastery, achievements and element usage (P1)

`audit:dungeonrun` diffs the *whole* save record, not the fields I thought of. It reported a leak the
moment the probe pressed a real attack button:
`mastery.fire.xp, stats.elementUsage.fire, achievements.0…11, profile.lastPlayed`.
The source was `onPlayerAttack` / `onPlayerSkill` / `onPlayerUltimate` and the mastery credit inside
`switchElement` — four call sites, all writing progression the mode is not supposed to touch, and
`registerAttackUse`'s `mutate` is what drags the achievement pass and `lastPlayed` along with it.

Fixed with one seam instead of four overrides: `GameplayScene.creditCastProgress(kind, element)` is now
the single door progression walks through, and `DungeonScene` overrides it to do nothing. That is the
difference between a self-contained mode and a fork: the mode declines *the concept*, so a fifth
progression site added later to the story path cannot leak by being forgotten here.

Self-containment is also structural, and the probe checks the structure rather than trusting it: the
dungeon never calls `beginRun`, so `save.run` stays null and `stageWalkAway` / `finishRun` have nothing
to write. The remaining save touch is `rebaseRunBuffs` on entry — the allow-list in the probe is exactly
`runBuffs.N.expiresAt`, because a buff's expiry is a *scene clock* value and the previous scene's clock
would read every live buff as expired (§A3).

### I5 — springs could be drunk twice, and the overlap list grew every cell (P2)

`syncCells` called `registerStripOverlaps()` on each cell change, adding another
`physics.add.overlap(player, stones, …)` each time: two handlers means one touch of a spring spends two
charges, and the handler count is unbounded in the length of the walk. Fixed by registering once per run
against the *group* and having cells add their stones to that group — which is also why a stone's spent
state lives in the director (`spentCount`), not in the sprite: sprites come and go with the camera, the
map's facts do not.

### I6 — the pause card described a different run than the one being paused (P2)

`PauseOverlay`'s subtitle reads the save — `Warden · Wave 1 · Floor 1` — which during a strip walk is a
sentence about a run that is not happening, and the card also offered `Last checkpoint · … Wave 7`, a
thing a strip neither has nor earns. Now, when `runKind === 'strip'`, the card reads the live snapshot
(`Warden · VERDANT LABYRINTH · CELL 6/6 · NOTHING CARRIED OUT`) and says what leaving does:
"Save & exit leaves the strip unfinished and writes nothing: no wave, no essence, no record."
The four values it needs are read as separate primitive selectors, so a 12 Hz snapshot publish cannot
re-render the pause card.

### I7 — the strip's tally row widened the depth plate into the top-right cluster (P2)

At 844×390: `floor-plate x tr-tools (4x44)`. The first instinct — trim the plate's padding — was wrong,
and measuring why said so: the wide line is the *biome name*, `DROWNED VAULT` at 0.24em tracking, not the
tally. Short frames now compact tracking (`letter-spacing: 0.16em`) and padding together, which keeps
every letter of the name and stops the plate reaching. Story mode is unaffected: its plate was already
inside the same rules.

Two gate changes came out of this, both aimed at the same failure mode — a plate that exists in one file
and not the other:
- `tools/hud-plates.mjs` is now the one HUD plate list, imported by `audit:mobile` and the dungeon probe,
  and it gained `.partner-line` and `.strip-tally`. Deliberately *not* added: `.objective`, which would
  silently change what the shipped story verdict means.
- The legibility floor (9.5 px) is applied at the phone shapes only. My first version asserted it at
  1360×800 too and "failed" on `rail-key:8`, `ability-key:8` — desktop keycap hints, which are 8 px by
  design. A gate that rejects the shipped design is a gate that will be talked around.

### I8 — two of my own checks passed without running, and one shipped gate was flaky for real (P1 for the gate, P2 for the flake)

The first green-looking dungeon run had `story bounds are one frame again — bounds 450` and
`story plates clear the same gate` passing while `story=false`: the story leg had never entered a run,
because it opened a fresh browser *context* (fresh `localStorage`, no warden) and each `.click()` was
wrapped in `.catch(() => {})`. Every story claim now carries `story.gameplay` as a precondition, and the
leg runs on the same page that just left the strip — which is also the stronger claim: story still works
*in the session that ran a dungeon*.

Re-running the shipped `audit:e2e` then failed at `text=SAVE & EXIT` after a 600 ms sleep. Not my code:
the pause card is withheld while a chapter or floor card owns the frame (`paused && !transition`) and the
scene's Escape handler declines for the same reason, so an Escape during a chapter card is swallowed and a
fixed sleep cannot know. Hardened to ask for the card, take the obstructing card's own action, and retry —
which added a step worth having anyway (`PASS the pause card answers an Escape request`). Two consecutive
full runs pass now; before the change the same sequence had already failed once in three.

### I9 — `audit:mobile` broke the moment its plate list moved, and told me why (P2, gate)

`page.evaluate(SCAN)` serialises a function into the page; module-scope names do not exist there. Pointing
`SCAN` at an imported constant produced `ReferenceError: HUD_PLATE_SELECTORS is not defined` in all five
shapes. Fixed by passing the list as the evaluate argument, and `SCAN` now
`throw`s if it is missing — a plate list that silently arrives as `undefined` would report a clean HUD
forever, which is the H7/H11 family again: a gate measuring less than it claims.

### I10 — two config keys the mode never turned, caught by the sweep (P2)

`audit:config` exists to stop a design document becoming a wish list of knobs, and it caught mine:
`DUNGEON.dropRadius` and `DUNGEON.ambient.perMegaPixel` were declared and never read. The first was a
real gap, not a redundant key — `rollDropTable` places every drop on one point, which is right for a
corpse in an arena and wrong for a stone the warden is standing on — so the strip now rolls the same
table through the same `rollTable` and lays the pile on a ring (`dropRadius`, squashed by `ringSquash`,
measured: `7 drops, 374px apart`); the release ring and the field's mine ring read the same pair, so no
site kind invents its own geometry. The second became floor motes in `DungeonGround`, counted per
megapixel of *field* so a phone's short cell is no denser than a desktop's (`274 motes drawn`), and they
are deliberately *still*: a drifting emitter keeps twinkling while the frame is paused, and the freeze
rule does not exempt decoration. `audit:dungeonrun` asserts both behaviours, because "the key is read
somewhere" is not the same claim as "the thing happens".

### I11 — the gates, as they finished this round

| gate | result |
| --- | --- |
| `npm run verify` (typecheck, `audit:dungeon`, build) | clean, 31/31, built in 16.60 s |
| `npm run audit:dungeonrun` *(new)* | 57 passed, 0 failed, 1 info |
| `npm run audit:config` | 193 keys swept, **0 unreachable** — after it first reported 2, see I11 |
| `npm run audit` | All audit checks passed. |
| `npm run audit:e2e` | All end-to-end steps passed, twice in a row |
| `npm run audit:mobile` | exit 0, **0 FAIL, 0 WARN**, 10 INFO — 5 shapes, now sharing the plate list |
| `npm run audit:pages` | 15/15 |
| `npm run audit:fit` | fail 0, warn 0, info 10 |
| `npm run audit:camera` | 12/12 |
| `npm run audit:progression` | 20/20 |
| `npm run audit:pausemenu` | 24/24 |

What is *not* claimed, in the same breath as the table. The partner takes proximity and hazard damage
and can go down, but enemies still seek the warden: no targeting rework, so "your partner draws aggro" is
true of its *body* and not of the mobs' decisions. Hazard fields are seeded as mines through the scene's
own `spawnMine` rather than by the biome `HazardDirector` — the director places as a fraction of
`worldFrame`, which is exactly the coupling the design refused to widen, and the strip opts out of frame
re-planning with `setWorldFramePlanning(false)`. The strip has no `isBossWave`, no respawn lane, and no
summary card: it ends in a toast and a pause menu. Reaching a floor-transition path in the story scene can
still write `saveCurrentWave`; the dungeon has no director to reach it, and I left the guard as
`this.director?.begin(...)` rather than adding a mode check to shared code.

---

## §J — The labyrinth, its courier, and four revisions of one rule (2026-10-11, fourth pass on the strip)

The strip had been built as an open corridor with rooms off it. The reference asked for something else: a
labyrinth — *one* path, folded in circuits around a centre, entrance → line ends → centre, no branch to
take anywhere. This pass rebuilt the geometry to that, turned the partner into a courier that carries the
orbs back to the warden, and found four faults of my own along the way. P numbers are the same scale as
above; every claim here is a measurement from `audit:dungeon`, `audit:dungeonrun` or a browser probe, and
the probes that lied are in here too.

### J1 — the strip was a corridor, so there was nothing to walk (P1, design)

Six cells of open floor with pockets off the sides reads as a long room. The fix is not more walls: it is
walls that force a *single* route. Each cell now carries one circuit — a spine across the middle of the
cell at `fy 0.40–0.60` with a gap at `gapFx`, and a tooth from the *entering* lane to the outer wall, east
of that gap. The invariant is the whole design: **the tooth is always right of the gap and always in the
lane the walker enters on**, so passing a cell requires exactly one spine crossing and leaves no island
behind — the path is unbranching by construction, not by policing. The last cell closes the spine at
`spineEndFx = 0.84` and puts the centre past it, so the walk ends at the middle rather than at a wall.

Measured at seed 20261011: a 5280×520 strip whose route is **6648 px** of walk (1.26× the strip's width),
18 static wall bodies, cell 0's gap at x≈317 with its tooth at 482–558, cell 1's crossing at x≈1209 and
its tooth 1431–1507 in the *other* lane. 55/55 headless checks, and the ones that hold the design down are named for it:
`the tooth always closes the lane before the crossing is behind you`, `the entering lane alternates, so
every other cell forces the crossing`, `each circuit is longer across than the cell is wide`, `the centre
belongs to the last circuit and to no other`, `no site is buried in the spine or the tooth`, `props never
sit in the crossing or on the tooth`. The art and the colliders are the same rectangles *by construction*
(one `circuitRects` feeds both), which is why `audit:dungeonrun` counts 18 static bodies and separately
proves a walk that never enters one.

### J2 — widening `worldFrame` was the tempting fix, and it stays refused (scope)

A labyrinth wants a bigger room, and the scene has one number that would give it: `worldFrame`. Widening it
would have cost the streaming invariant, the mobile buffer arithmetic and the story scene's shared framing
for a cosmetic win, so the labyrinth is six *cells* of one authored frame instead — the fold happens inside
each cell and the cells still stream at ±1. The scene opts out of frame re-planning
(`setWorldFramePlanning(false)`) exactly as before.

### J3 — walls in an Arcade group threw, and clearing them in `cleanup()` threw next run (P1, both)

`this.physics.add.group()` makes its children **dynamic**. Putting `Matter.Static`-style zone bodies in one
crashes inside Phaser with `body[key] is not a function` — the group calls dynamic-body bookkeeping on
bodies that do not have it. `ground.walls` is now a plain `scene.add.group()` and `buildColliders()` owns
the bodies, which is also the honest ownership: the ground makes the walls, the collider *is* the
rectangle. Removing the group from the scene's `cleanup()` then produced the second fault — a `clear()` on
a group whose scene is being torn down throws `Cannot read properties of undefined (reading 'size')` on
the *next* run, which is the worst possible time. The group is not cleared; `ground.destroy()` nulls the
rect cache instead, and `wallRects` rebuilds on demand.

Both are invisible in a single frame and were found only because the probe enters the strip, leaves, and
enters again. `audit:dungeonrun` has a check per fault.

### J4 — one rule for following a corridor, four revisions before it stopped lying to itself (P1)

The courier has no pathfinder and was never going to get one: the substitute is a sight test plus the
route polyline. What that took, in order, each revision fixing the last and creating a new one:

1. **Follow the nearest point on the polyline.** Jittered at ±71 px/s at (894,410). The walkable floor is a
   *thickened* line, and a target tucked beside the route projects to a point almost under the walker's own
   feet — so `sign(delta || 1)`'s forward tie-break flipped on a 1 px difference.
2. **Hysteresis on the walker's own heading.** Still jittered: the ambiguity threshold and the stride were
   both `lookahead`, so every step landed *past* the projection and re-flipped the sign. A limit cycle, not
   noise — measured by printing the step, not the position.
3. **"If the walker is far off the path, ignore the path and go direct."** Stranded it: 1 px/s at
   (571–578, 204), pressing into the spine forever, because going direct *is* going into a wall.
4. **What ships.** Four ordered rules, one return value with a `committed` flag:

   - nothing crosses the segment to the target → walk straight to it;
   - the walker is more than `0.6 × corridorLookahead` off the route → step to *its own* projection,
     committed: get back on the path before being clever;
   - the target is more than `corridorTolerance` (96 px) off the route → it is in a pocket, so its
     projection is a lie — ignore it and step `lookahead` along the arc in the walker's current `heading`,
     committed;
   - otherwise → toward the projection, clamped to `min(lookahead, |delta|)`.

   A `want` past either end of the polyline reverses and returns `committed: false`, so a turn at the end of
   a line is not fought. `Ally.drive` (-1/0/1) is updated only when a step was *not* committed, and zeroed
   in `revive()`/`restore()` — hysteresis with no memory across a death or a restore.

`corridorLookahead: 52` and `corridorTolerance: 96` replaced the deleted `stallMs`/`stallEpsilon` (a stall
timer was machinery for a bug this rule does not have); `audit:config` sweeps 202 keys, 0 unreachable.

### J5 — "the target is underfoot" is the pocket, and the pocket is the point (P1, design consequence)

The generator deliberately leaves pockets: floor that the route passes beside without entering. They are
what makes a labyrinth a labyrinth instead of a hallway — and they are exactly the case that breaks
nearest-point-on-route steering, because the nearest route point to someone standing in a pocket is the
strip of corridor under their feet. Rule 3 above is that observation, and the same fact explains two other
decisions: a fetch across the spine is *supposed* to look like the long way round (measured: ~1000 px east
through cell 1's crossing, then west in the top lane, to reach a warden 200 px away in a pocket), and
`deliver` re-spawns the orbs at the warden rather than at the courier, because a courier that has to come
to you may be standing where you cannot reach.

### J6 — the courier gate parked the warden inside a wall, and the goal check was a coincidence (P1 for the gate)

Two assertions were measuring geometry instead of behaviour. The park spot for the fetch leg was computed
from the *site*, which after the labyrinth landed could be anywhere in the cell — including behind the
spine, where the warden then stood permanently blocked. It now clamps into the cell it belongs to
(`cellLeft`/`cellWidth` on the spot). The other was `the goal is the centre, not the far wall`, written as
`player.x < width - 200`: after the goal moved inward that could only ever fail for the wrong reason, and
it would have passed if the goal had been *removed*. It is now two behavioural checks, both in strip
coordinates: park on the open floor beside the centre and assert nothing is reported (`the far wall is not
the goal — x 5250 of 5280, goal at 5218, reported=false`), then walk into the centre and assert it is.

Two more were added because a walk that only *looks* right is the failure mode of this whole feature: **the
partner walks the labyrinth instead of through it** (every sample of the fetch leg is tested for being inside
the spine band away from a gap — `0 of 114 samples inside a wall`), and the ledger's growth is credited to
the courier rather than to luck by proving the warden **drifted 0 px** while the count rose (`ledger 4 → 5,
nearest orb 336 px at the park, 3 on the floor → 0 left`). Distance-to-the-warden, my first attempt, was
wrong: a delivered orb *lands* within pickup radius on purpose, so "the warden was never near an orb" is
false of a working courier.

### J7 — a real-time probe is not a stopwatch, and `body.moves` was a red herring (P2, method)

The pocket probe declared a *correct* walk FAILED twice, because its budget was "60 samples × 300 ms" — 18 s
— while one leg of ~1000 px at ~90 px/s is 11 s of wall clock, times two trips. Budget a real-time probe by
distance over speed, then break on the condition; a loop that expires prints a verdict the game never gave.
And the leading suspect in that investigation, `z.body.moves === false` on the wall zones, meant nothing:
`StaticBody` has no `moves` property, so the readout is `false` for every wall in the project. Assert
against a property the class actually defines, or not at all.

### J8 — at the shipped zoom nobody can see the labyrinth (P1, presentation)

The camera window is 394×260 world pixels at 1180×780 CSS and the authored cell is 880×520, so one circuit
is roughly two screens of walking: the walls are felt, the *figure* is never seen. That is fine for the
story arena and was not fine here, because the whole appeal of the reference drawing is seeing the fold.
Fix: the HUD plan is now the route itself. Each cell publishes its own corridor as `[fx, fy]` fractions and
the plate draws one row per circuit, every second row mirrored so the rows join at their ends, joints
between them, the centre as a pip past the last line's exit, and a dot at the warden's own position on its
row — the same `circuit.route` the walls are built from, so the plan cannot drift from the level. It
replaced six 10 px squares that said less; the plate grew 91 px tall in total, `.strip-map` is still hidden
on short frames, and `audit:mobile`/`audit:fit` report 0 FAIL / 0 WARN across five shapes.

### J9 — the gates, as they finished this round

| gate | result |
| --- | --- |
| `npm run verify` (typecheck, `audit:dungeon`, build) | clean, **55/55**, built in 13.05 s |
| `npm run audit:dungeonrun` | **74 passed, 0 failed, 1 info** |
| `npm run audit:config` | 202 keys swept, **0 unreachable** |
| `npm run audit` | All audit checks passed. |
| `npm run audit:e2e` | All end-to-end steps passed |
| `npm run audit:mobile` | exit 0, **0 FAIL, 0 WARN**, 10 INFO across 5 shapes |
| `npm run audit:pages` / `audit:fit` | 15/15 / fail 0, warn 0, info 10 |
| `npm run audit:camera` / `audit:progression` / `audit:pausemenu` | 12/12 / 20/20 / 24/24 |

The corridor rule is additionally covered by four headless cases in `audit:dungeon` (straight line, across
the spine, pocket committed to, rejoin when off-path, and nothing to follow past the strip's ends), so the
steering does not depend on a 66-second browser probe to stay correct.

What is *not* claimed, same breath as before. The courier is greedy, not planned: it will take the long way
around a pocket and it can be made to loiter by standing in a pocket the far side of a crossing — that is
the honest cost of refusing a pathfinder, and the walk it produces is the walk the mode is about. The plan
in the HUD is a schematic: rows are one per cell, so relative cell widths are not to scale. `down()` still
delivers where the body fell, so a courier killed beside a wall pays out to the floor, not to the warden.
Enemies still seek the warden: the partner's body is real, its threat is not. And the fetch cycle is
reachable only from the corridor — nothing in the mode stops a warden that walks into a pocket from being
ignored by a partner that has decided to rejoin the path first, which is rule 2 doing exactly what it says.

## §K — What you read at the mouth, and what stops you walking through stone (2026-10-11, fifth pass on the strip)

Four of these came from playing the mode rather than reading it: the wave announcement landed *on top of*
the countdown, a warden could be shoved through a circuit wall, nothing anywhere said what a stone was for,
and the way to the end of the strip was not findable by a player who had not read the source. All four are
in. The interesting part is what the gates turned up on the way — two of the four fixes found a fault in
something that had been passing.

### K1 — the announcement and the countdown were two guesses at the same pixel (P1, presentation)

The banner and the countdown plate were each `position: absolute`, each centred, each sized by its own text.
Two centred things with a `top` that assumes the other is smaller is not a layout; it is a coincidence that
holds at one viewport. At the shipped frame they shared pixels, and the banner's translucent band over a
dark arena was within a hair of the arena's own colour, so the overlap read as one broken plate.

One parent now owns the pair: `.hud-centre` → `.centre-stack`, row 1 the announcement, row 2 the countdown.
Nothing estimates where the other thing is; the grid does. The band became a *plate* — filled `--gold`,
inked `--panel-sunk`, hard 2 px edge, `--level-2` — and the contrast is measured rather than asserted:
**11.9:1 on the title, 13.3:1 on the sub-line**, at the shipped frame and at 844×390, by the story leg of
`npm run audit:dungeonrun`. That leg raises both overlays deliberately (a `grantCheat` to enter the
countdown, then a synthetic `game:waveStarted`) because a fixed sleep can never guarantee the half-second
where both are up; the pair is only measurable while both exist.

Deleting the unreachable `tone: 'boss'` branch came out of the same measurement. The hook clears the banner on
a warden wave on purpose — a warden is announced once, by the plate above, and a centred banner would
compete with it for the same half-second — which meant `.banner-boss` was CSS no state could reach. A rule
for this project: CSS you cannot reach is a claim you cannot keep, so it went, and the comment in the
stylesheet now says *why* there is no boss plate instead of leaving a red one to be found.

The same pair is measured at all five device shapes by `npm run audit:mobile`, which used to wait *past* the
countdown before measuring anything — so it now runs a `wavestart` screen per shape: **9 px of gap at every
shape, closest approach 6 px on phones and 2 px on the tablet portrait, 11.9:1 / 13.3:1, 9.5 px type, 0 FAIL
and 0 WARN.** The screenshot it leaves behind (`mobile-audit/phone-large-01b-wavestart.png`) is the picture
of the fix: a gold plate with dark ink, sitting visibly above the count, neither touching the other.

That measurement was briefly a *lie by timing*. `audit:mobile` now walks the five device shapes with both
overlays up, and its first pass reported the gap between them as 3 px, 3 px, 1 px, 3 px and **0 px** — no
overlap, but a touch, which is a hair away from the complaint. The gap is not really 0 px at any size: the
countdown plate `count-pop`s in on a spring and overshoots its layout box for a frame, so one sample measures
the layout, not what the eye gets. Two things came of that — the stack's row gap is `max(8px, calc(9px *
var(--hud-scale)))` rather than whatever the scale factor hands out (3 px on a phone), and the scan samples
twenty frames and reports the *closest approach*. `minGap <= 0` is a FAIL. A rule about not sharing pixels has
to be sampled across the animation, or it is a rule about the resting state.

**Rule:** plates that belong together get one parent. `tools/hud-plates.mjs` is the measure of "sharing
pixels", and anything added to the centre of the HUD joins `HUD_PLATE_SELECTORS` so the measure sees it.

### K2 — you could walk through a wall, and the probe that proved you could not (P1)

The walls were real — one static Arcade body per circuit rect — and they still did not hold, because a body
pressed into a 10 px band by something stronger than it can be carried past it before separation runs. The
repro is not "walk at a wall"; it is a mob driving the warden into the tooth. A lone player proving it
*cannot* pass a wall proves nothing, so `/home/user/audit/squeeze-probe.mjs` samples at 120 ms and counts
frames with the warden's centre inside a rect:

- before: `mob shove into the tooth — 90/90 frames inside a wall`
- after: `0/90`, with `dash + shove 0/90` and `partner shove into the spine 0/90`

The fix is `DungeonScene.pressOutOfWalls()`, run in `update()` *after* `super.update()`: nothing may end a
frame inside a circuit wall. It pushes out along the smallest penetration and keeps the velocity component
that runs *along* the wall, so being shoved against stone is a scrape and not a sticky trap. Two permanent
checks came out of it: the squeeze itself (a brute drove a mob into the tooth for 60 frames — 0 frames of
warden inside stone, 0 for the partner) and the stronger one, "dropped inside one, you are out within three
frames", which teleports the player *into* a rect and measures the escape: one frame.

**Rule:** solid is a per-frame claim, so it gets a per-frame correction and a gate that presses rather than
nudges.

### K3 — a guide stone in a mode with no verb for reading (P1, design)

The ask was a stone at the initial spawn carrying "details of which object does what". The mode has exactly
one interaction verb — walk into a stone — and no key prompts anywhere: `E` is Flame Wave, Escape is pause,
and `Stone.ts` already records why (a 20 px target and a thumb pad do not mix). So the guide is not a menu
and not a screen. It is the thing you already know how to use: `GuideStone`, 18×18 immovable, walked into,
raising a card.

Deliberately *not* `isRunSubscreen`: a mode whose whole danger is the walk should not be paused by its own
legend. The card is a plate, it auto-dismisses in 20 s, a tap puts it away, it closes on `game:runStarted`
and `game:playerDied`, and the stone can be read again as often as you like — a 6 s cooldown keeps it from
re-firing every frame you stand on it, which is also what the measured "does not shove itself back open"
check asserts. That the run never stopped is not claimed, it is reported: `frozen=false` and **+733 ms of
run clock while the card was up**.

It is not in `stonesGroup()`, because that single shared handler calls `activate(stone)`, which reads
`stone.site` — the guide has no site, and sharing the group was a crash on the first overlap. It gets its
own `physics.add.overlap`.

Placement took two tries and the second is the one that works. The first put the stone 20 px off the lane,
"beside" the path, so it could be walked past without ever being touched and the player had to walk *back*
to read it. In a mode whose only verb is walking into things, a legend you can miss is a legend that does
not exist: `guideSpot` now puts it *on* the corridor at 22 % of the first circuit — measured at x 243 for a
walk that starts at 141, before the first crossing at 279 — and since it is not a collider, standing in it
never blocks the way.

The phone leg then caught what no desktop leg could: the card could not be dismissed at all, because
`#hud-root` is `pointer-events: none` so the tap fell straight through the card to the canvas. A plate that
is only read may stay transparent to input; a thing you are meant to put away has to opt back in
(`pointer-events: auto`, `cursor: pointer`).

### K4 — charts are beacons, and the pool flag they forced (P1, then P1 again)

"Place maps at a few spots in the dungeon through which players can complete the dungeon." Chosen behaviour:
each chart marks, in the world, the centre and the next uncleared site ahead — beacons, not a solved route,
because refusing anything that needs a pathfinder is a standing decision, and a strip that draws the answer
in a lane is not a strip. The consequence worth naming: `goalMark` used to glow from the first frame, which
made the end free. It is now `setVisible(false)` at creation and lights on the first chart, so the thing the
maps *are* is the route.

`chartSpots(plan, every = 2)` walks one cell in two and takes the first of five candidate fractions on that
cell's corridor that sits at least 48 px from every site. A rejection loop against `rng` would have been
easier to write and would have made the charts different per roll for no reason; candidates are
deterministic, so "the same charts next time" is a passing check rather than a hope. One gate check exists
because of a fault: `and no chart is lying on a stone` caught a chart within 40 px of a cache on the first
seed tested — a map handed out by the grove you were going to wake anyway, i.e. free again.

That the chart pays for nothing is asserted where a leak would actually show: the scene's existing
`collectPickup` override retires early on `defId === 'way_map'`, before the ledger and before the base
kind-switch, and the gate reports `ledger 3 → 3, shards 0 → 0, save paths unchanged` after all three are
walked over, plus `0` found and `centre marked=false` before the first one.

**Then the gate admitted it had been lying.** `a cache opens outward instead of stacking on one pixel`
measured the largest distance between active pickups and reported *4126 px* while passing: three immortal
placed charts were in the census, so it had been comparing the pile to props three cells away. Filtering to
`!placed` made it read `4 drops, 60px across`, which let the rule finally be written properly (`> 8 && ≤ 90`
px — outward, and not scattered across the strip), and made the ledger check stop depending on luck: it
teleported the warden onto the stone and waited for a vacuum that is not a strip rule, then walked it onto
the nearest drop, which is what a player does.

**And `kind: 'shard'` nearly broke the run.** The registry entry needs a `kind` for its art, `'shard'` is
the one that draws a cut gem — and the partner's `nearestOrb` selects *by kind*. So a courier would have
fetched a treasure map off the corridor, carried it, and dropped it wherever the warden happened to be
standing: possibly inside a wall, which is a chart nobody can collect and a route to the centre that cannot
be completed. `Pickup.placed` now says what these objects are — scenery with a duty, not loot with a timer:
never scattered, never expired, skipped by `nearestOrb` and refused by `takeOrb`. `spawn()` clears the flag,
because pool sprites are reused and a flag this meaningful cannot be left to its last owner. `GameplayScene
.spawnPickup(…, placed)` owns all of it, so the strip no longer hand-writes `remaining = Infinity` at a call
site. The gate keeps the fault dead: empty the floor of everything not placed, let the partner think for
2.6 s, and all three charts must still be exactly where the generator put them with `carrying 0`.

The beacons themselves are Phaser's, not the HUD's: one `Graphics` at depth -7, drawn in `--wayfinder` jade
(`0x7fe0c0`, and the CSS token of the same name is what the card and the stone wear). The scene keeps its own
tally of what it marked (`beaconMarks`, split into pips and crumbs) so the gate can assert the *rule* rather
than a pixel hash: `before: nothing drawn; one chart: 0/0 with the centre marked=true; two: 3 pips, 3 cells
still have a site ahead; three: 1 pip + 8 crumbs` — expected pips recounted from the plan, not hard-coded.
And the first screenshot of them said the eighth crumb was invisible: 2 px at alpha `1 - step * 0.1` is gone
against this ground by the fifth dot, so the crumbs are 3 px with a floor under the fade (`max(0.42, …)`),
which is the far side of a bend still being worth marking. One chart lights the
centre; two add a pip with a short underline above the first unspent site of every cell from where you stand
to the end; three add eight crumbs along the corridor ahead, every 44 px, from `stripRoute` — computed once
and cached (`this.routePx ??= …`), because rebuilding a 6648 px polyline every frame to draw eight dots is
the kind of thing a scene does until someone measures it.

Not claimed: the pips are hints, not a route — nothing draws a line around the wall between you and the
mark, and that gap is the mode. And no new HUD plate was added for any of it, which was the point of putting
the maps in the world.

### K5 — the card on a phone, where the geometry had no answer ready (P1, presentation)

The desktop leg passed and the phone legs failed: 5 clashes at 360×640, 2 at 844×390. Dumping every plate's
box said why — those shapes have **no free column** for a legend. On a 390-tall landscape phone the plates
end near a third of the frame and the thumb controls begin near two thirds; on a 640-tall portrait phone
there are 122 clear pixels between the tool row (bottom 342) and the action buttons (top 464).

So the card is placed *inside* the band rather than over the plates — `top: 34%` with `max-height: 28%` on
short landscape, `top: 55%` with `max-height: 16%` on portrait, `overflow-y: auto`, and the kicker and foot
hides itself there because the seven lines are the content and only the content earns its pixels. Measured
after: 302×102 in portrait at y 352–454, 400×109 in landscape at y 133–242, **0 clashes, 0 off frame** in
both, and deliberately clear of the joystick and skill buttons — the card takes pointer events, which a plate
you are meant to dismiss is allowed to do, but not over the half of the screen a thumb has already committed
while the run keeps walking.

Because a scrolling card is a promise that has to be kept, the phone legs also measure the scroll: at least 3
of 7 lines visible without flicking, and the last line (`CENTRE`) reachable inside the card's own box after
flicking to the bottom — the last line being the one that tells you how the run ends. The *screenshot* then
showed what no number in the file did: nothing on the plate said "more below". There is no room left for a
foot line on these frames, so the clipping is the cue — a `mask-image` fade across the bottom 12 px, which
costs no pixels and reads as a scroll. `audit:fit`'s lesson
again: correct geometry is not legible geometry, and a fixed-position card is a guess about a screen someone
else is holding.

### K6 — the gates, as they finished this round

| Gate | Result |
| --- | --- |
| `npm run verify` (typecheck + `audit:dungeon` + build) | clean · 59/59 · built in 10.04 s |
| `npm run audit:dungeonrun` | **98 passed, 0 failed, 1 info** (74 before this round) |
| `npm run audit:dungeon` (map geometry) | 59/59 |
| `npm run audit:mobile` | 0 FAIL · 0 WARN · 15 INFO, five device shapes |
| `npm run audit:fit` | 0 fail · 0 warn · 10 info |
| `npm run audit` / `audit:e2e` | "All audit checks passed" / "All end-to-end steps passed" |
| `npm run audit:pages` | 15/15 |
| `npm run audit:config` | 202 keys, 116 files scanned, 0 unreachable — unchanged, this round added no config |
| `npm run audit:camera` / `audit:progression` / `audit:pausemenu` | 12/12 · 20/20 · 24/24 |

New checks this round, in their own words: `the wave announcement sits above the countdown, sharing no
pixels`, `on a 390-tall frame the two still do not share a pixel`, `and it is a plate you can read against
the arena, not a band of the same colour as it`, `a mob cannot shove the warden through a circuit wall`,
`and the walls get the last word: dropped inside one, you are out within three frames`, `the entry stone
stands on the way in, and three charts are lying on the route`, `and the centre stays unmarked until a chart
is walked over`, `it reads as a card of what every object does, not as a screen`, `reading the stone does not
freeze the run`, `a chart is beneath the partner's notice: placed props are not errands`, `all three are
collectible, and the first one lights the centre`, `a chart is not loot: the ledger, the wallet and the save
all stay as they were`, and per phone shape: the card's on-frame/clash/floor/flick checks. `HUD_PLATE_SELECTORS`
grew `.guide-card`, so the strip's only reading surface is covered by the same clash and legibility rules as
every permanent plate, and `audit:mobile` grew a `wavestart` screen per shape. The older check that read
`the strip freezes while the card is up` is now `…while the pause card is up`, because two different cards
in one gate log is how a reader ends up trusting the wrong one.

## §L — A refusal is an answer to a press, not a caption (2026-10-12, the refusal patch)

Four asks came in one patch: the ranged counter rule, blocked controls that say why, a ledger of bragging
rights, and a hall that expands outward into a brain from the picture. Three of the four shipped with a gate
in the same commit — `audit:counter` for the bolt trade, `audit:achievements` for the 31 seals,
`audit:brain` for the mask (14/14, 43 cells, 90.1% IoU, 82.4% body fill). The second ask shipped twice,
because the first version passed every check I had written for it and still read wrong on the screen.

### L1 — the reasons were printed, and a wall of text is not an explanation (P1, presentation)

The requirement was that a control that will not act must never be silently dead: say the reason, name the
prerequisite. My first answer put both *under the label* — a second line of 9.5-to-11px type, `reason — needs`,
on every locked control, thirty-odd of them on a fresh save. It measured well. Nothing was clipped, nothing
overflowed, every sentence was at the legibility floor or above, and the hub looked like a terms-of-service
screen. A player does not read a refusal before asking for one.

So the contract moved in time, not in content. What is on the control now is only the lock: `is-locked`'s
dashed border and struck label, the dim — `0.45` inline on a floor card, `0.55` on a bare refusal's face. What is in the markup is the reason — `data-reason`,
`title`, and the accessible name — because a thing you can pop has to be stored somewhere first. What appears
is a transient reply to the press:

```
! · NOT YET
the first cycle is not over (wave 1 of 200) — clear floor 10, or reach wave 200
```

That is `refusalNotice(reason, needs)` in `src/components/ui/primitives.tsx` producing the body, and the
control's own refusal path — `ui_deny`, `lockedMotion(ref)`, one toast — ending `Button.fire` and
`MenuButton`'s handler alike, so a refusal cannot be implemented incorrectly by a screen. A raw tile that is
not one of the two primitives (a free-mode floor card, an element chip, a pager arrow) starts its `onClick`
with `pressRefusal(locked, reason, needs)`: the same sound and the same pop, minus the shake, because it has
no ref of its own to move. The achievement cards that used to print `requires` in red now carry a small `WHY`
button, and the free-mode floor cards print the floor's own subtitle whether or not you have reached it —
`Locked — press for what it needs` was still a caption wearing a different name. The menu tiles that used to
read `Locked until a warden exists.` / `Locked until you start.` / `Clear your first story warden to open.`
now describe what the tile is; so does the hub's side-door card, in both states. And since the pop is
absolute at top-centre — the place the wave plate taught it to live — a menu screen moves it to the foot of
the frame (`ToastStack` reads `screen`, `.toast-stack.at-foot`), because a refusal that covers the header
sentence it interrupted is a bad trade. In the arena it stays under the plate, where the eye already is.

### L2 — a `disabled` control cannot explain itself (P1, mechanism)

The reason has to survive a thumb, and a `disabled` button never receives the pointer event that a tooltip —
or a press handler — needs. Every reasoned refusal is therefore `aria-disabled="true"` with the guard in the
handler, and the attribute survives only where nothing is being explained: `disabled && !refusal`. A
*loading* control never takes it either — it gets `aria-busy` and stays an ordinary element. CSS had to catch up in both directions: the caption-era overrides that kept a
disabled control at full opacity so its sentence stayed readable came out, `.btn:disabled` went back to
`opacity: .4; cursor: not-allowed`, and `cursor: not-allowed` plus a dimmed `.btn-face` were added for
`[aria-disabled='true']` — including `:not(.is-locked)`, because a refusal that arrived as `disabled` still
has to look inert.

`import.meta.env.DEV` warns when a control is inert with no `reason`. That is the half of the rule a screen
author can break, and it is the half a screenshot cannot show.

### L3 — the gate had to learn to tap, and to pick the right WHY (P1, method)

`audit:fit` grew a press: for up to two refusals per screen it clicks `[aria-disabled="true"][data-reason]`,
then requires a `.toast` whose text overlaps the control's `data-reason`, inside the frame, with the screen's
heading unchanged. Two failures turned out to be the harness, not the game:

- every refusal came back `produced no message at all`, because Playwright reads `aria-disabled` as *not
  actionable* and waits out the timeout instead of tapping. A finger does not ask permission, so the gate now
  clicks with `force: true`.
- the achievements screen popped a reason that did not match the control's own: three locked cards all carry a
  button labelled `WHY`, and a `hasText` filter returns the first of them. The probe now reports each
  refusal's index among `.screen [aria-disabled="true"][data-reason]` and the driver clicks that one.

The caption rules are still in the gate, inverted: `.lock-reason` anywhere in `.screen` is a FAIL, and any
inert control with no `data-reason`, `title` or `aria-label` is a FAIL, with the run-wide guard refusing to
believe a pass that measured fewer than three controls or found fewer than three pressable ones. It ended at
**65 inert controls measured, 0 printed**.

### L4 — two counter tallies vanished because the gate read a second copy of the store (P1, method)

`audit:counter` went 15/15 → 13/15 with no change to the counter: `stats.projectilesCountered=-1`,
`run.shotsCountered=-1`, while the scene's own tally incremented and the bolts died on the same pixel. The
gate had been reaching the save with `await import('/src/store/saveStore.ts')` inside `page.evaluate`. After
an edit to that module, HMR serves the page a `?t=` copy, so the literal import returns a *second,
unhydrated* store — and a tally that the game did write reads as absent. Same class of fault as a FAIL count
that hits zero because the probe changed: the measurement moved, not the game.

`src/main.tsx` now hands the live store to the page in dev (`window.__sixfoldSave`), the counter gate reads
that, and the run gained a check that says so out loud — `the gate reads the store the app is running, not a
second copy of the module` — plus honest detail strings (`unreadable — no live store handle`) so a missing
hook can never be logged as a game fault again. 16/16, and the ledger checks read `stats.projectilesCountered=1`
and `run.shotsCountered=1`.

### L5 — the gates, as they finished this round

| Gate | Result |
| --- | --- |
| `npm run verify` (typecheck + `audit:dungeon` + `audit:achievements` + `audit:counter` + `audit:brain` + build) | clean · 59/59 · 27/27 · 16/16 · 14/14 · built in 9.28 s |
| `npm run audit:fit` | 0 FAIL · 0 WARN · 65 inert controls measured, 0 printed as standing text, presses answered in-frame |
| `npm run audit:mobile` | exit 0 · 0 FAIL · 0 WARN on the final run (one WARN there is stochastic: a hostile passing under a translucent pad) |
| `npm run audit:dungeonrun` | 98 passed, 0 failed, 1 info |
| `npm run audit:achievements` / `audit:brain` / `audit:counter` | 27/27 · 14/14 · 16/16 |
| `npm run audit` / `audit:e2e` / `audit:pages` | all passed · all end-to-end steps passed · 15/15 |
| `npm run audit:progression` / `audit:camera` / `audit:pausemenu` | 20/20 · 12/12 · 24/24 |

`verify` grew `audit:counter` and `audit:brain`; the ledger had been shipping two tallies whose gate was not
on the front door, and that is exactly how the §L4 confusion stayed invisible for a round.

The four still-standing promises, in the players' words: an ordinary bolt that stops another bolt dies with it
and the shard-class ones do not; a locked control answers a press with the reason and the prerequisite; the
seals are 31 and computed from save data, never awarded in the labyrinth; and the hall's walls are the open
half of a mask that is derived, gated and documented in `docs/plans/2026-10-11-dungeon-mode-design.md` §7.

---

## §M — The map went 5× thicker, and the gate confessed to a finding it had invented (2026-10-12, the scale pass)

The ask was physical, not aesthetic: *increase the size 5× so no enemies glitch through the wall*. Arcade
separates bodies by pushing the overlap out, so a mover that travels further in one frame than a wall is
thick can arrive on the far side with nothing left to resolve — the whole question is a ratio of thinnest wall
body to longest per-frame step. `tools/cortex.mjs` therefore went `tilePx: 32 → 160` and nothing else in the
derivation moved, because every rule in it is measured in tiles: same 148×172 mask, same 14 chambers, same
255-point route, same 1144 merged wall bodies, world now **27 520 × 23 680** (`npm run audit:cortex` was 30/30
before and is **33/33** now, with three new checks — and, after M6, reading a bundle that is actually rebuilt
each run; `docs/plans/2026-10-12-cortex-dungeon-notes.md` holds the numbers).

Thick walls are only *worth* 160px if something proves the ratio. Asserting it in prose is how this round got
two new gates and found two real faults in the process.

### M1 — a `tileSprite` sized by the world allocated a 651-megapixel canvas (P1, real, silent)

`DungeonGround.build` paints each cell's floor as one TileSprite of `cellWidth × plan.height`. On the strip
that is a cell; the brain plan's cell *is* the whole organ, so the floor was 27 500 × 23 660 — and a
`tileSprite` over a canvas-backed texture makes Phaser allocate a source the size of the *sprite*. 23
megapixels at 32px tiles, and at 160: `getImageData: Out of memory`, thrown from `build()` inside `create()`,
which took the rest of `create()` down with it — no art, no crash dialog, and a run that looked like the map
had broken rather than like an allocation had failed.

The brain plan's floor is now a viewport-sized field that follows the camera, with `setTilePosition` holding
the art still in world space (the parallax bands' trick). `setDisplaySize` was tried first and is wrong here:
`setSize` keeps the tile grid at whole source pixels, `setDisplaySize` scales the tiles and smears the art —
the file already said so in its own header, and ignoring that comment for one line cost a comparison of two
bad screenshots.

**The rule for anyone adding ground art:** nothing may be sized by the world. Index by the camera, or index by
the cell, but never hand a `tileSprite` a plan dimension.

### M2 — the gate called a Node function from inside the page and read the exception as a finding (P1, method)

`the partner walks the labyrinth instead of through it` reported **150 of 150 samples inside a wall** and
survived four plausible repairs to the partner — `Ally` consulting the corridor always, `corridorStep`
stepping along the polyline instead of through stone, twelve ejection passes, tile-centre snapping for the
park. The reading was fake. `buriedIn` is defined at Node scope in `tools/dungeon-run.mjs` and was called from
inside `page.evaluate`: a `ReferenceError` in the browser, swallowed by the file's own `safe()` helper, which
answered with **`-1`** — and every truthiness test in the file read a `-1` as "yes, inside a wall". At any
tile size. For the whole session.

Two rules fall out of it, both now enforced in the file:

1. A predicate the page must run is spelled out in the page. `allyInWall` / `playerInWall` are inline body
   penetration tests (a pixel on every side, not a centre-point containment — the other old wrong answer here).
2. `safe()` no longer answers boolean questions with a numeric sentinel; booleans get `safeBool`, which
   returns `null` when the question could not be asked. A probe that failed is *absent*, not *true*.

Same class, one step further: the phone pass used `alive(() => …, 1)` as the fallback for "how many guide cards
are on frame", which turned a probe timeout into **`a tap on the card puts it away on a phone too — FAILED`**.
The fallback is `null` now and the detail says `the page stopped answering mid-probe — a stalled measurement,
not a stuck card`. A manufactured FAIL is as misleading as a manufactured PASS.

### M3 — a leash point is arithmetic, and arithmetic does not know that 34px is inside a fold (P1, real)

`Ally.tick` aimed the partner at `player ± leashDistance (34px)` along the line home. On a map whose walls are
160px thick, that point lands *inside* a wall more often than beside one; the partner walked into stone, could
not get out, and the run ended with it pressed against the inside of a fold. It has no idea it did anything
wrong: every rule it was following is correct except the one that was never asked.

The scene now answers one more question — `standable(x, y, toward)` in `AllyView` — from the same
`ground.wallRects` list the physics runs on, and returns the nearest ground the partner could actually occupy
(or the way out, if it is already inside stone, which is why the check no longer needs a rescue). **Order
matters and I got it wrong first**: projecting *before* `corridorStep` converted "go round" into "press
against", and the partner went from slow to motionless (measured: 23px/frame closing before, 0px after). The
route is asked first; ground gets the last word on where the step points.

### M4 — the recall bound was in pixels while the map's unit is the tile (P1, design)

Past six leashes (204px) the partner drops whatever it is carrying an errand for and comes home. Six leashes
was written when a tile was 32px, i.e. six tiles of slack. Scaling the map fivefold shrank the same rule to
**1.3 tiles**, and since a cache scatters its drops over several tiles, `fetching` could never legally start:
every sample read `following`, `peak carry 0`. Now `DUNGEON.partner.recallTiles: 6` — the same promise, in the
unit the world is authored in, so the next scale change moves it with the map instead of against it.

### M5 — the courier test was measuring an empty room, and its own guard could have hidden that (P1 for the gate)

Three separate ways this section reported nothing while looking busy:

* It counted the three `way_map` shards every run carries as fetchable orbs — `kind: 'shard'`, `placed: true`,
  which `nearestOrb` correctly refuses. "9 orbs on the floor" while the partner ignored all nine.
* It "popped" a cache by assigning the warden a coordinate. A cache opens when the warden stands on it for a
  frame; the gate now waits up to 30 frames for drops to exist.
* It parked the warden *on top of* the pile, whose drops land at its feet — so the warden's own vacuum grew the
  ledger and the sample loop broke on the first sample. `ledger 28 → 29` with `peak carry 0` was the warden
  doing the courier's job.

The park is now a *choice*: every clear tile in sight of the pile is scored by how far the nearest orb is, and
the winner is the one furthest out of the warden's reach that still sits inside the partner's. A ledger entry
only counts if a sample saw the partner carrying. And because the three behavioural checks are gated on that
premise, the premise is itself a check — `the courier was given a pile it had to leave the warden for` — so a
park that stops being arrangeable goes red instead of quietly going green.

### M6 — the counter-test: proving the ratio moved the gate, and finding a hole in it (P1, method)

A margin check that cannot fail is worse than none, so the derivation was re-run at `tilePx: 32` to watch the
gate object. Three things came out of it:

* `a corridor is wide enough that a body never straddles stone and floor` **failed at 32 and passes at 160** —
  the property the scale actually buys, measured both ways rather than argued.
* The crossing check **did not move at all**: it printed `thinnest wall body 160px` while its neighbour
  printed `a tile is 32px`. Two faults were hiding under that one line, and both had to be cleared before the
  check could be trusted:
  1. it took the tile *size* from the derivation's config and the rectangles from the built plan, so it
     described one configuration while measuring another;
  2. **the plan it read was never rebuilt.** The audit bundles `cortex.ts` and `gameConfig.ts` with esbuild.
     With one entry point esbuild writes `cortex.js` into `outdir`; with two it keeps the sources' shared
     directory and writes `game/dungeon/cortex.js`. The import still asked for the flat path — a file an
     *older, one-entry* build had left there. So every measurement taken from the bundle since that second
     entry point was added read a frozen copy of the shipped mask, which is why 32px of knob moved the
     straddle check and not the crossing one.
  The two checks now read one number (`cortex.tilePx`, with the config only as a fallback), and the bundler
  deletes `node_modules/.cache/cortex-gate` before each run and gives every entry an explicit `outfile`, so a
  leftover file cannot stand in for this run's work. Deleting it is also what turned the audit red on the
  first run after the reset — `ERR_MODULE_NOT_FOUND` on `cortex.js` — which is the correct response to a gate
  whose input is missing: refuse, do not reuse.
* The margin is only meaningful in tiles, so it is now quoted in both: 160px is **1.00 tile** at the shipped
  scale, against 34px in a clamped frame.

With a genuinely fresh bundle the counter-test finally does what it was built to do. Re-derived at
`tilePx: 32`, `audit:cortex` comes back **31/33** and the crossing check fails on its own terms:

> `FAIL no mover can cross a wall body in one frame — thinnest wall body 32px (1.00 tiles) against 34px per
> clamped frame … at 32px per tile that is a 0.9× margin`

One tile of stone was **0.9 frames** of a mover at the old scale — the collider's thickness was never what
stopped a dash, which is the sentence the earlier draft of this section had only argued instead of measured.
At 160px the same check reads **4.7×** and passes. Between the two runs, `the shipped plan and the derivation
agree on how big a tile is` passed at both scales (32 vs 32, 160 vs 160) and had already failed once, on the
first run through it, when only one side had been regenerated — the only evidence a drift guard can offer.
The mask was restored byte-identical and the gate is 33/33.

### M8 — the stress gate measured the wrong movers, and then measured its own placement (P1, method)

`no mover can cross a wall body in one frame` in `audit:cortex` is a statement about the *map*. The claim the
ask actually makes — **no enemies** glitch through the wall — needs live bodies in the browser, and the block
that provides it in `tools/dungeon-run.mjs` sampled `scene.player`, `scene.ally`, and every active enemy in a
scene where nothing had been woken yet: two movers, zero hostiles. The requirement was the one thing the
sample could not speak to, and the check would have gone on passing in exactly the state the user reported.

It now wakes a wave deliberately before choosing the wall — sites in order of the pack they release, until
four hostiles are live — and puts all of them on the row the wall was validated on, then shoves the whole line
east at 680 px/s for 90 frames. The check requires `stress.enemies > 0`, so a friendly-only sample fails
instead of passing vacuously.

The first honest run reported `102px in the longest single frame against 160px of stone`: a margin of 1.57×,
nowhere near the 4.7× the derivation measures. That was the harness, not the game — the movers were placed 12px
apart and bodies are 14–16px wide, so they overlapped and Arcade snapped the pile apart in a single step. A
stress rig's own placement is part of what it measures: spaced a body-width apart, the same run reports
**23px against 160px of stone (7.0×), 0 mover-frames inside a wall body, 0 of 4 hostiles through the face**.

### M7 — the gates, and what the margin is actually worth

| Gate | Result on the final run |
| --- | --- |
| `npm run verify` | typecheck clean · `audit:dungeon` 59/59 · `audit:counter` 16/16 · `audit:achievements` 27/27 · `audit:brain` 14/14 · `✓ built in 12.38 s` |
| `npm run audit:cortex` | **33/33**, incl. `no mover can cross a wall body in one frame` (thinnest wall 160px = 1.00 tile vs 34px per clamped frame, 4.7×) and `a corridor is wide enough that a body never straddles stone and floor`, plus `the shipped plan and the derivation agree on how big a tile is` — the drift guard from M6. **FAILs at 31/33 when re-derived at 32px**, with the crossing margin down to 0.9× |
| `npm run audit:dungeonrun` | **103 passed, 0 failed, 0 info**, incl. `no mover thrown at a wall as fast as the world allows ends up inside it` — 6 movers (**4 hostiles** woken for it, player and partner included), 23px in the longest single frame against 160px of stone, 0 mover-frames inside a wall body — and `and none of them comes out the far side` (wall face 14720px, a 640×160 body: pushed 14520 → 14714; through it: player false, partner false, 0 of 4 hostiles) |
| `npm run audit:fit` / `audit:mobile` | 65 measured · 0 WARN · 0 FAIL |

**Not claimed, in the same breath — and one figure here was wrong.** The 4.7× margin is a ratio against the
*config's* envelope (2× dash, 4× base speed, a 430px/s shove) at the scene's own `Math.min(delta, 50)` clamp:
a future mover allowed to exceed that envelope erodes it, which is what the two new gates exist to catch, in
the browser and not in prose.

What was wrong is the framing cost as I stated it: *"the screen now shows 9×5 tiles instead of 45×25"*. That
was arithmetic on the CSS window, and the game does not render at the CSS size — `viewport.ts` holds the frame
to **320 world pixels across** at a whole-number zoom (4 on a 1280px window, giving a 320×200 canvas upscaled
4×). Measured in the browser at the shipped scale, `camera.worldView` is 320×200 world px, so a screen shows
**2.00 × 1.25 tiles** where it used to show 10 × 6.25. Not "roomier with fewer folds": a microscope, one tile
of floor at a time, which is what "the dungeon is empty" actually was. The gate suite never saw it because no
check compared the frame to the map's own unit; `the dungeon frames enough of the map to read` now does, and
the rule belongs to the viewport, not to the dungeon, because at 160px tiles a handheld frame (422 world px
wide) cannot exceed ~2.6 tiles without breaking the integer-zoom law. And the partner still has no pathfinder: `standable` plus `corridorStep` is a sight test
with a rule for getting back onto the route, so a courier that decides to rejoin the path first will still
walk past an orb on its left.

---

## §N — Pre-deploy check: what a green build cannot see (2026-10-12, the Pages pass)

The ask was "final check before I deploy to GitHub". CI for this repo is `npm ci` → `npm run build` with
`VITE_BASE_PATH` → upload `dist`, and everything in that chain reads the **working tree**. A clone is not the
working tree. Two faults live exactly in that gap, and neither is visible from a local build.

### N1 — `.gitignore` ate the shipped icons (P1, would have deployed broken)

The file ended with a blanket `*.png`, added to keep audit screenshots out of the repo. It also matched:

| file | who asks for it |
| --- | --- |
| `public/icons/apple-touch-icon.png` | `index.html` — `<link rel="apple-touch-icon" href="%BASE_URL%icons/…">`, on every page load |
| `public/icons/icon-192.png` · `icon-512.png` · `icon-maskable-512.png` | `public/manifest.webmanifest` — the PWA install set |
| `assets/brain-source.png` | the art `npm run derive:brain` reads, i.e. the source of a generated file |

Vite copies `public/` from disk, so `dist` always had the icons and `npm run audit:pages` — which checks
`every manifest icon exists in dist` — was **green while the repository was broken**. The deployed site would
404 its apple-touch-icon and install with no icons at all.

Found by simulating the thing CI does: copy the tree without `node_modules`/`.git`, `git init`, `git add -A`,
then count. **166 tracked against 172 on disk**, and `git ls-files --others --ignored` named exactly the six
above. Fix: ignore the artefacts by name (`*.audit.png`, `e2e-final.png`) and drop the type rule — an image
type the app ships is not an artefact pattern. Result: **171 of 172**, the only one left out being the genuine
scratch screenshot.

A gate now covers the class, in `tools/pages-check.mjs`: `no file the app ships is git-ignored`, which lists
`public/`, `assets/`, `src/` and `index.html` that a clone would not have, and skips with an explanation
outside a git checkout. Counter-tested in a real throwaway clone, both directions: with the blanket rule
restored it **FAILs and names all five files (15/16)**; with the fix it **PASSes (16/16)**.

**The lesson is about what a build can verify.** Every check that reads `dist` is downstream of the files that
produce it. Anything whose failure mode is "a clone does not have it" needs a check that reads the *repository*.

### N2 — `audit:pages` leaked its preview server, and the leak then lied about the game (P2, tool)

It spawned `npx vite preview` and, on exit, `server.kill('SIGTERM')` — signalling the **npx wrapper** and
leaving `vite preview`, its grandchild, holding the port. Four runs left four live servers on a two-core box:
load average 13, `audit:dungeonrun` went from 154 s to over 900 s and timed out, and a run that times out
prints *nothing*, which reads like a broken gate rather than a starved one. Fixed by running vite's own bin
directly, so the pid held is the server, and killing the **process group** on the way out. The port is now free
after every run, verified with `ss -ltn`.

Two rules worth keeping from this: never `spawn` a wrapper (`npx`, `npm run x`) and assume killing it kills the
process it started; and on a constrained box, run browser gates one at a time — a slow gate is not a failing
gate, and a killed gate is not a passing one either.

### N3 — the rest of the sweep, and what is still the author's call

`audit:pages` **16/16** (asset URLs all prefixed or relative, `.nojekyll`, manifest parses and is reachable,
icons 200, font preload 200, boots from `/sixfold/`, plays at the handheld plan, **0 failed requests, 0 console
errors**) · `verify` (typecheck + `audit:dungeon` 59/59 + `audit:achievements` 27/27 + `audit:counter` 16/16 +
`audit:brain` 14/14 + `✓ built in 9.34s`) · `audit:cortex` **33/33** · `audit:dungeonrun` **103/0/0** ·
`audit:config` 203 keys, **0 unreachable** · `audit:camera` 12/12 · `audit:progression` 20/20 ·
`audit:pausemenu` 24/24 · `audit` all passed · `audit:fit` fail 0 / warn 0 · `audit:mobile` no FAIL ·
`audit:e2e` "All end-to-end steps passed." · no secrets in the tree, no `.env`.

README defects fixed on the way: it offered `npm run clean`, which has never existed in `package.json`; it said
Playwright is "intentionally *not* a project dependency" while it sits in `devDependencies`; and it listed two
of the fifteen gates. Left as calls for the author, not silently changed:

* **`.github/workflows/deploy.yml` runs no gates.** Build-only CI is why a broken icon set had a chance to
  reach a deploy. Adding `npm run verify` is cheap but it needs a browser on the runner, so it is not a
  one-line change and it can block the site on an unrelated gate failure — the author's decision.
* **`package.json` and the README both say MIT, but there is no `LICENSE` file**, so GitHub shows no license.
  Adding one means picking the copyright line, which is not mine to invent.
### N4 — then the frame itself, and what it costs (2026-10-12, after the playtest)

The playtest said what the gates had not: *"Dungeon is empty, there are no stone, no enemies."* Measured, that
was three separate facts, and only the first was the one I had been told to fix.

1. **The frame, not the map, was the tight constraint.** With the fix in (`DUNGEON.frameTiles`, a per-scene
   demand on `viewport.ts`, released on `cleanup`), the dungeon's render buffer goes from 320×200 to 1280×800
   at zoom 1 and the view holds **8 × 5 tiles** instead of 2.00 × 1.25. All 1144 wall sprites are live and on
   screen (`6/7 route positions show stone`). The demand is window-relative on purpose: a 900px-wide window can
   afford `floor(900/160) = 5` tiles at a whole-number zoom, and the gate now asserts *the frame the window can
   afford*, not an absolute one.
2. **It is not free, and the A/B proves it.** Same code, `frameTiles: 2` → 47 fps; `frameTiles: 6` → **16 fps**
   under software GL (16× the pixels). Two walk gates went red on the wide frame and green on the narrow one
   for that reason alone, so both were re-denominated against the *scene's own clock* (`time.now`) instead of
   wall-clock seconds — a gate that measures how far something walked should not be a stopwatch for the
   renderer. A phone cannot use this lever at all: at 390 CSS px the most a dungeon frame can show at 160px
   tiles is **2.44 tiles**, because the integer-zoom law will not go below 1 CSS px per world pixel.
   **The arithmetic of the three rules, which is the finding worth keeping.** Each gate's bar, read out of
   `tools/cortex-audit.mjs` and `gameConfig.ts`, against the authored 320-world-pixel frame:

   | rule | what it demands | as a tile size |
   | --- | --- | --- |
   | no mover crosses a wall in one frame | `thinnest ≥ 3 × worstStep` = 3 × 34px | **≥ 102px** |
   | a body never straddles stone and floor | `tilePx ≥ 4 × 14px` (widest authored mover box) | **≥ 56px** |
   | the dungeon frames enough of the map | `320 / tilePx ≥ 6` | **≤ 53px** |

   The art rule and the frame rule cannot both hold at the authored frame — 56px and 53px miss each other by
   3px — and the physics rule wants double that. So no value of `tilePx` satisfies all three, and the only
   lever that does not trade one off is one that shrinks `worstStep` itself (sub-stepping the integration, or
   a per-step displacement cap): at 3 sub-steps the physics bar drops to 34px and a ~56px tile clears every
   rule with the frame, the art and the fill-rate all left alone. That is the option I have *not* taken
   unilaterally, because it changes how movement resolves.

   Measured, not assumed: `tilePx: 48` was tried and the gates said so — `FAIL … thinnest wall body 48px
   (1.00 tiles) against 34px per clamped frame … a 1.4× margin`, straddle `FAIL` too (48 < 56), 31/33 — the
   mask was then re-derived at 160px and restored byte-identical, `33/33` again.

3. **Two faults the wide frame exposed**, both red at `frameTiles: 4` and `6`, both green at `2`:
   the partner's recovery step is half a tile, so 80px of side-step per hesitation nets it ~17px/s toward the
   warden (178px short of a 320px gap after 8.6 *simulated* seconds — the budget was moved onto the scene clock
   precisely so this could not be blamed on the renderer), and pressing *Right* alone no longer threads a
   doorway (210-236px of 1.3-tile corridor). They fail identically at 32 fps and 16 fps and pass at 47 fps,
   so they are steering-per-frame decisions meeting a frame budget: a slower render is a worse walk, which is a
   property of the game, not of the test.
4. **And the density is the answer to "no stones, no enemies"**: 52 sites over 651.7 megapixels means a random
   frame contains a site `0.05` of the time — at any zoom, and it was no better at 32px (0.13). Enemies exist
   only after a site is woken, which is by design. So a run that feels empty of content needs more sites or a
   smaller map, and the gate says so as an `info` line rather than pretending to be a pass condition.

**Still the author's call, restated with numbers:** the frame lever keeps the 4.7× wall margin and costs frame
rate and small sprites (a 10px warden is 10 CSS px at zoom 1 — visible in `/tmp/chk/desktop.png`, where the
brick texture reads as graph paper); `tilePx: 48` satisfies *both* rules at the game's authored zoom 4 (6.7
tiles across, 1.4× wall margin, no buffer cost); `tilePx: 64` gives 1.9× margin at 5 tiles and needs
`minTilesInView` lowered to 5. The 32px original is the one value the gates refuse: 0.9× margin, measured.

* **`.claude/skills/brainstorming/SKILL.md` is committed** — agent tooling in a public repo, harmless, a
  judgement call.

### N5 — the wide frame was reverted the same day; the map's unit moved instead (2026-10-12, final)

The `frameTiles` demand in N4 shipped, measured well (8 × 5 tiles, every wall sprite on screen) and was
**taken back out** on a playtest verdict that outrank'd the numbers: *"the focus in dungeon is too wide… try to
keep it like the wave's game."* A per-scene buffer is not a cosmetic choice — it makes one mode render at
1 CSS px per world pixel while every other mode renders at 4, so the dungeon stops looking like SIXFOLD even
when every gate is green. `viewport.ts` is back to a single authored fit for all scenes and
`DungeonScene` asks for nothing.

What moved instead is the map's own unit: `tilePx: 160 → 64`, re-derived (`world 11008 × 9472`, same
148 × 172 mask, same 14 chambers, same route). Measured after the change, in a live wave run against a live
dungeon run at the same 1280 × 800 window:

| | wave (`GameplayScene`) | dungeon (`DungeonScene`) |
| --- | --- | --- |
| render buffer | 320 × 200 | 320 × 200 |
| camera zoom · CSS px per world px | 1 · **4.00** | 1 · **4.00** |
| world view | 320 × 200 px | 320 × 200 px (**5.00 × 3.13 tiles**) |
| warden's body on screen | 10 × 10 px = **40 × 40 CSS px** | same **40 CSS px** |
| fps under software GL | 51 | 47 |

The fill-rate tax is gone (16 fps → 47), the two walk gates that had gone red are green again — and the
sweep is **104 passed, 0 failed, 2 info**, with `audit:cortex` **33/33**: thinnest wall body 64px against
34px per clamped frame, a **1.9×** margin, measured live at 23px in the longest frame (2.8×).

**One bar did move, and it is documented rather than quiet.** The crossing gate asked for `3 × worstStep`,
which is a 102px tile — and at the shared 320px fit that is 3.1 tiles of map in view, i.e. the original
"empty" complaint re-imported through the back door. The physics invariant is 1.0× (a step shorter than the
thinnest collider cannot land past it); the 3× was conservatism I had not justified. It is now `1.5×`, with
the reasoning in the file, and the second lock is the live gate: `audit:dungeonrun` drives the player, the
partner and four woken hostiles at twice the dash speed through a running frame and requires that none of
them ends up inside or past a wall. At the abandoned 48px it still fails (`1.4×`, 31/33), and at 32px it
fails harder (`0.9×`) — the bar keeps its teeth; it is no longer sized to one arbitrary answer.

**What "empty" still means, unsolved by any of this:** 52 sites over 11 008 × 9 472 px puts a stone in a
random frame about **5 %** of the time, so a dungeon run will still often show nothing to interact with, and
hostiles exist only after a grove is woken. That is content budget — more sites, or a smaller map — and it is
the one item from the playtest report that no scale or camera change fixes.

### N6 — a band's stones vanished past the third line: the cell cull was a strip rule wearing a brain map

Found while adding waystones, because a waystone that is linked must *look* linked, and three of the eight in
a live run came back `dormant` with `interactive: false`. They had not been spent — they had been **retired**:

```
// syncCells(), before
for (const stone of [...this.stones]) {
  if (Math.abs(stone.site.chunk - index) > 1) { stone.retire(); this.stones.splice(...); }
}
```

On a strip that is right: a site belongs to a column, and the two columns either side of the camera are
enough. The brain plan gives every site `chunk: 0` on purpose (positions are fractions of the world, see §N4
and the note atop `cortexPlan.ts`), so `|0 - band| > 1` retires **the whole map** the moment the walk reaches
the third band. `buildStones(index)` then rebuilds nothing, because it filters on the same expression. The
measured consequence: from line five of a dungeon run inward there were no stones in the world at all — no
groves, no caches, nothing to wake and nothing to clear.

That is the "dungeon is empty" report again, and my earlier diagnosis of it was incomplete: I attributed the
emptiness to the render frame and then to site density (52 sites over the map's area), and both were real,
but the largest share of it was this. A run that walks into its fourth band walks into a floor that has been
deleted from under it.

**The fix is a window, not a flag.** `DungeonScene.siteInWindow(site)` asks the plan which band a site is in
(`plan.layerAt`, the same call the HUD's line counter uses) and keeps a site when that band is within one of
the band the party stands in; a plan with no `layerAt` falls back to the column test, so the strip is
unaffected; a site the plan cannot place is **kept** rather than culled, because the failure mode of keeping is
twelve extra sprites and the failure mode of dropping is an empty room. Waystones are exempt entirely — a
link is a fact about the run, and a node that is lit, gone, lit again according to where the camera happens to
be is a network nobody can read. Rebuilt waystones also come back lit:

```ts
if (this.strip.isSpent(site.id)) stone.spend();
else if (site.kind === 'waypoint' && this.strip.isLinked(site.id)) stone.awaken(this.stoneColor('waypoint'));
```

Gated as `a band keeps its stones while the party stands in it — the cull is a window, not a wipe`, which
stands the party in each band in turn and counts live non-waypoint stones against that band's authored sites:
`0:5/5 1:7/7 2:8/8 3:8/8 4:12/12 5:15/15 6:10/10`. Before the fix every band from 2 up reads `0/n`.

**The class of it:** a reuse of a helper is a reuse of its *assumptions*. `Math.abs(site.chunk - centre) > 1`
was correct for the plan it was written for, and the cortex plan deliberately satisfies the same interface
without sharing the assumption — which is how it passed review, typecheck, and 100+ browser gates for as long
as it did: every gate that looked at stones looked at them near the entrance.

### N7 — the content was in the plan but not in the walk (2026-10-12)

Symptom, in the player's words: *"there are no enemies and no stones other than the start-point stone"*. That was
said **after** a pass that had added waystones on every band and a depth ramp, and after a gate reported
`a band keeps its stones — 0:5/5 1:6/6 2:7/7 …`. Both were true. The map was still empty, for four reasons, and
only one of them was about counts.

**One. Two different polylines were both called "the corridor".** The generator snapped a picked site onto the
nearest tile of *its band's* path (`layer.path`); the renderer draws, the run walks, and `Ally.corridorStep`
follows `plan.route`, which is `cortex.walk.path` cut into bands by `bandAt`. Those are not the same line. A
site could sit 40px from a corridor the party would walk and 6 tiles off the one the partner trusts — so the
courier committed to an orb, closed 77px, then stood still for eight seconds while the orb rotted 203px away:

```
0.8s fetching carry=0 orbs=3 allyToOrb=278 allyToWarden=22 rem=25
2.0s fetching carry=0 orbs=2 allyToOrb=203 allyToWarden=97 rem=23.8
8.9s fetching carry=0 orbs=2 allyToOrb=203 allyToWarden=97 rem=17
```

Two gates failed on it and the diagnosis was invisible until a probe parked a warden beside a drop and printed
the partner's distance every 100ms. The fix is a rule, not a patch: the pools a band places from are
`cortex.walk.path` filtered by `bandAt(p.x, p.y) === index`, and the audit measures `frame.corridor` against
`scene.plan.route`, so generator, renderer, partner and gate all name the same polyline. `layer.path` survives
only as the fallback for a band the walk spends fewer than twelve tiles in.

**Two. `spread()` maximises straight-line distance, and a folded map punishes that.** Six tiles across a fold
can be forty tiles along the corridor, and a warden only ever sees the corridor. Content is now drawn from the
band's slice of the walk at a fixed *arc* stride shared by every kind (`nextAlong`), which is why "the dungeon
feels denser" and "the density is the same" are both true of the same numbers: the site count rose 65 → 94, and
the frames it fills went from 5 of 7 sampled route positions to 7 of 7.

**Three. A standoff rule that only fits the authored frame.** Roamers were placed at "≥ 4 tiles from the warden
*and* outside `worldView`", which at 320 × 200 world pixels is satisfiable and at a zoom-2 window (450 × 350,
which is what a 900px-wide screen gets) frequently is not — on a snaking route no point is simultaneously four
tiles away and off the frame, and `tickRoamers` returned having placed nothing. Half the players in the world
would have had no trickle at all, with every gate green, because every gate ran at the other size. It now takes
the first off-frame candidate and falls back to the farthest corridor point it can reach, so a wide view trades
invisibility for distance instead of trading in the feature.

**Four. A travel rule that measured a command instead of an outcome.** "The bands answer movement" was
implemented by integrating the body's velocity, so *holding a direction into a wall* accumulated the same
pressure as advancing — a stuck key farmed ambushes. It now integrates the warden's position, with one tile per
frame as the ceiling on what counts, which incidentally closes a worse hole: a waystone hop is teleportation, and
before the ceiling a player could warp back and forth to summon roamers at will.

**The class of it.** Every one of these survived typecheck, `audit:cortex` and a hundred browser gates, because
each is a *relationship* between two things that are individually correct — a name shared by two polylines, a
distance metric that is not the one the eye travels, a threshold expressed in one camera size, a proxy for
movement that the physics also reports when nothing moved. The only checks that can see them are ones that stand
an actor in the world and report what it fails to do; and a harness must obey the same rule it is testing, or it
measures its own shortcut — a probe that teleports the party has no ground to have crossed.

### N8 — content on the corridor inherits the corridor's traffic (2026-10-13)

The density pass fixed "the dungeon is empty" by putting sites **on** the walked polyline, and waystones among
them. That was right, and it silently changed what a waystone *is*: a stone on the corridor is not an object you
find, it is an object you **hit**, every run, in both directions. The verb had been authored the other way —
first touch links, a later touch hops — so once the entry stone was linked, walking past it *was* a later touch.
The measure of it: `probes/sweep.mjs` places the body on each of the 255 route points in turn and reads where the
physics leaves it. Before this fix, 4 of 7 sampled waystone points relocated the party **604 to 3,893 px inside
160 ms**, with `wallBodiesUnderBody = 0` and `buriedAt = false` at every point — the corridor was never blocked,
the corridor was *live*. Two scripted walks stalled at 40% of the route for exactly this reason, and both were
diagnosed as bad steering first, which is the trap: a harness that reproduces a fault through the same verb the
player uses will report the player's ability, not the game's.

Fix is a rule, not a cooldown: **a waystone is stood on, not walked through.** Linking stays instant (it changes
nothing about where you are standing); hopping asks for `DUNGEON.warp = { dwellMs: 380, dwellSpeedPx: 26,
hopFloorMs: 400, rearmMs: 350 }` — contact, near-stillness, and a held pause. `warpArmed` still prevents a warp
from landing the party on the destination stone and spinning them through the rest of the network, and the dwell
is cleared whenever they are clear of every stone, so a pause spent elsewhere cannot pay for a hop here.

**Measured after:** `running past a linked stone at up to 160px/s warped nobody and left no dwell running;
standing on the next one hopped 417ms after contact, against a 380ms dwell`, and the same sweep now reports
`pushedOffByColliders: 0` across all 255 points with `endToEndWalkable: true`. The hop gate itself got *better*
for the same reason: `14 hops, worst landing 0px off the destination stone · 15/15 linked` where it had managed 7
— because the probe now performs the verb the player performs instead of poking `activate()` once.

**The gate that lied, in the same pass.** The first version asserted the dwell by counting its own loop's sleeps
and reported a hop at 240ms against a 380ms rule that had been honoured: the scene's overlap had started the
dwell on the physics step, before the probe's first poke. A gate that mis-measures its subject is worse than no
gate, because the green ones stop being trusted; dwell is now timed from contact (`hoppedAfterMs`), not from the
probe's next action.

**The class of it.** Placement rules have verbs attached to them whether or not anyone asks. "Put the content in
the walk" is a correct answer to an empty map and an incorrect answer for any object in that content whose
interaction is *contact-triggered* and *displaces the player*. The general test to run whenever content is moved
onto a path: for each such object, walk the path without choosing anything, and assert the party is where the
walking left it.
