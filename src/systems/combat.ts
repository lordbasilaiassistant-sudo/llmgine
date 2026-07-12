import type { Entity, System, World } from "../core/ecs.js";
import { Attack, Behavior, DODGE_HEIGHT, Faction, Health, Named, Transform, Velocity } from "../components.js";
import { statOf } from "./status.js";

/**
 * Combat — deterministic core. Melee attacks resolve when an attacker in
 * "attack" mode is in range with a ready weapon. PvE and PvP are the same
 * code path: a player attacking via input and a monster attacking via
 * behavior/Mind both end up here. LLM augmentation happens above (a boss
 * Mind choosing WHO/WHEN to attack, taunting, retreating) — never inside
 * damage resolution.
 */

/** Apply damage directly (projectiles, traps, scripts use this too).
 * Amount must be a positive finite number — NaN would make hp permanently
 * NaN (unkillable), negative would be an unclamped heal. Healing has its own
 * paths.
 *
 * NOTE: the 0.1 s iframe window is GLOBAL per target, not per attacker —
 * incoming hits are capped at 10/sec no matter how many attackers, and the
 * earliest-run system wins the window. Deliberate (readable swarm combat),
 * but tune `iframes` if a game needs true simultaneous hits. */
export function dealDamage(
  world: World,
  source: Entity,
  target: Entity,
  amount: number,
  knockback = 0,
): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const h = world.get(target, Health);
  if (!h || h.hp <= 0 || h.iframes > 0) return;
  h.hp = Math.max(0, h.hp - amount);
  h.iframes = 0.1;
  // hits have weight: shove the victim away from the source through the
  // knockback velocity channel (decays in movementSystem, not speed-clamped)
  if (knockback > 0) {
    const v = world.get(target, Velocity);
    const st = world.get(source, Transform);
    const tt = world.get(target, Transform);
    if (v && st && tt) {
      const dx = tt.x - st.x;
      const dy = tt.y - st.y;
      const d = Math.hypot(dx, dy) || 1;
      v.kx += (dx / d) * knockback;
      v.ky += (dy / d) * knockback;
    }
  }
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

      // behavior-driven melee: windup (telegraph) → impact → cooldown.
      // Enemy damage is REACTABLE: the swing is announced, and it whiffs if
      // the target moves out of reach (or jumps) before it lands.
      for (const e of world.query(Behavior, Attack, Transform)) {
        // the dead don't fight (destroy is deferred to end of tick)
        const selfHp = world.get(e, Health);
        if (selfHp && selfHp.hp <= 0) continue;
        const atk = world.require(e, Attack);
        const t = world.require(e, Transform);

        // resolve an in-flight windup first — it lands or whiffs on its own
        if (atk.winding > 0) {
          atk.winding -= dt;
          if (atk.winding <= 0) {
            atk.winding = 0;
            const tgt = atk.windupTarget;
            atk.windupTarget = 0;
            const tt = world.isAlive(tgt) ? world.get(tgt, Transform) : undefined;
            const inReach = tt && Math.hypot(tt.x - t.x, tt.y - t.y) <= atk.range * 1.15;
            if (tt && inReach && (tt.z ?? 0) <= DODGE_HEIGHT) {
              t.rot = Math.atan2(tt.y - t.y, tt.x - t.x); // face what you hit
              world.events.emit("combat:swing", { entity: e, target: tgt });
              dealDamage(world, e, tgt, atk.damage * statOf(world, e, "damage"), atk.knockback);
            } else {
              world.events.emit("combat:whiff", { entity: e, target: tgt });
            }
          }
          continue;
        }

        const b = world.require(e, Behavior);
        if (b.mode !== "attack") continue;
        if (!world.isAlive(b.target)) {
          b.mode = "idle";
          continue;
        }
        if (atk.ready > 0) continue;
        if ((t.z ?? 0) > DODGE_HEIGHT) continue; // can't swing mid-air (symmetry with dodging)
        const tt = world.get(b.target, Transform);
        if (!tt) continue;
        if (Math.hypot(tt.x - t.x, tt.y - t.y) <= atk.range) {
          // NOTE: an airborne target does NOT stop the windup from starting —
          // the attacker COMMITS and whiffs at impact if the target is still
          // in the air. Waiting-out the jump would make dodging free for the
          // attacker; committing makes a well-timed jump cost them the full
          // windup+cooldown cycle (real dodge economics).
          t.rot = Math.atan2(tt.y - t.y, tt.x - t.x);
          atk.ready = atk.cooldown + atk.windup; // full cycle from windup start
          if (atk.windup > 0) {
            atk.winding = atk.windup;
            atk.windupTarget = b.target;
            world.events.emit("combat:windup", { entity: e, target: b.target, duration: atk.windup });
          } else if ((tt.z ?? 0) <= DODGE_HEIGHT) {
            // windup 0 = instant (player-controlled attackers stay snappy)
            world.events.emit("combat:swing", { entity: e, target: b.target });
            dealDamage(world, e, b.target, atk.damage * statOf(world, e, "damage"), atk.knockback);
          }
        }
      }
    },
  };
}
