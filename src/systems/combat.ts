import type { Entity, System, World } from "../core/ecs.js";
import { Attack, Behavior, Faction, Health, Named, Transform } from "../components.js";

/**
 * Combat — deterministic core. Melee attacks resolve when an attacker in
 * "attack" mode is in range with a ready weapon. PvE and PvP are the same
 * code path: a player attacking via input and a monster attacking via
 * behavior/Mind both end up here. LLM augmentation happens above (a boss
 * Mind choosing WHO/WHEN to attack, taunting, retreating) — never inside
 * damage resolution.
 */

/** Apply damage directly (projectiles, traps, scripts use this too). */
export function dealDamage(world: World, source: Entity, target: Entity, amount: number): void {
  const h = world.get(target, Health);
  if (!h || h.hp <= 0 || h.iframes > 0) return;
  h.hp = Math.max(0, h.hp - amount);
  h.iframes = 0.1;
  world.events.emit("combat:damaged", { target, source, amount, hpLeft: h.hp });
  if (h.hp <= 0) {
    world.events.emit("combat:death", {
      entity: target,
      name: world.get(target, Named)?.name,
      faction: world.get(target, Faction)?.id,
      killer: source,
      x: world.get(target, Transform)?.x,
      y: world.get(target, Transform)?.y,
    });
    world.destroy(target);
  }
}

export function combatSystem(): System {
  return {
    name: "combat",
    order: 20,
    update({ world, dt }) {
      // cooldowns + iframes tick down
      for (const [, atk] of world.each(Attack)) {
        if (atk.ready > 0) atk.ready -= dt;
      }
      for (const [, h] of world.each(Health)) {
        if (h.iframes > 0) h.iframes -= dt;
      }

      // behavior-driven melee swings
      for (const e of world.query(Behavior, Attack, Transform)) {
        // the dead don't fight (destroy is deferred to end of tick)
        const selfHp = world.get(e, Health);
        if (selfHp && selfHp.hp <= 0) continue;
        const b = world.require(e, Behavior);
        if (b.mode !== "attack") continue;
        if (!world.isAlive(b.target)) {
          b.mode = "idle";
          continue;
        }
        const atk = world.require(e, Attack);
        if (atk.ready > 0) continue;
        const t = world.require(e, Transform);
        const tt = world.get(b.target, Transform);
        if (!tt) continue;
        if (Math.hypot(tt.x - t.x, tt.y - t.y) <= atk.range) {
          atk.ready = atk.cooldown;
          world.events.emit("combat:swing", { entity: e, target: b.target });
          dealDamage(world, e, b.target, atk.damage);
        }
      }
    },
  };
}
