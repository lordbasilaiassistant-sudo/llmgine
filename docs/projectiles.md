# Projectiles — verb-gated ranged combat

Source: `src/systems/projectiles.ts`. Deterministic; players, scripts, and
LLM Minds all fire through the same validated `shoot` verb — a Mind can only
shoot if its body has a `Ranged` component.

## Setup

```ts
import { Ranged, Projectile, shootVerb, projectileSystem } from "llmgine";

actions.register(shootVerb);                    // NOT in STANDARD_VERBS — opt in
world.addSystem(projectileSystem(grid));        // order 18: after movement, before melee

const archer = world.create();
world.add(archer, Transform, { x: 0, y: 0 });
world.add(archer, Faction, { id: "guards" });
world.add(archer, Ranged, {
  damage: 8,      // per hit
  speed: 420,     // units/sec
  range: 320,     // max travel (ttl = range / speed)
  cooldown: 0.5,  // seconds between shots
  color: "#ffd166",
});
```

## Firing

```ts
// at an entity (leads nothing — aims at its current position):
actions.execute(world, { actor: archer, verb: "shoot", params: { target: enemyId } });
// or at a position:
actions.execute(world, { actor: archer, verb: "shoot", params: { x: 100, y: -40 } });
```

Validation failures are honest strings: `"you cannot shoot (no Ranged)"`,
`"not ready"` (cooldown), `"no target"`.

Each shot spawns a real entity with `Transform` (rotated toward flight),
`Velocity`, `Projectile`, `Sprite{kind:"projectile"}`, and a non-solid
`Collider`, and emits `combat:shot {entity, projectile, x, y}` for audio/VFX.

## Resolution rules

- Projectiles expire after `ttl` seconds (= range/speed) or on first hit.
- **No friendly fire**: the shooter's `Faction.id` is copied onto the
  projectile; same-faction entities are never hit. The shooter itself is
  always immune.
- A hit requires the victim to have `Health` (hp > 0) and lands when within
  `hitRadius + victim Collider.radius`; damage goes through the same
  `dealDamage` as melee (iframes, `combat:damaged`/`combat:death` events,
  loot drops all behave identically).

## Giving Minds ranged combat

Attach `Ranged` to the entity and (optionally) allowlist the verb:

```ts
world.add(boss, Ranged, { damage: 12, cooldown: 1.2 });
world.add(boss, Mind, { persona: "…", verbs: ["say", "shoot", "move_to"] });
```

The verb schema (params + description) is handed to the model automatically —
`shoot` becomes a tool it can call, and the validator keeps it honest.
