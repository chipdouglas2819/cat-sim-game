import {
  SIM_DAY_REAL_SEC, ESTRUS_CYCLE_WEEKS, ESTRUS_DURATION,
} from './constants.js';
import { rand, clamp, dist } from './util.js';
import {
  findNearest, findNearestFood, forCatsNear, localDensity,
} from './spatial.js';
import {
  ageStage, giveBirth, mate, triggerDeath,
} from './lifecycle.js';
import {
  isBreedingSeason, applyEnvironmentalPressure,
} from './events.js';

// Per-tick velocity nudge toward (tx, ty). Used by every move-aware state in
// executeState. `speed` scales the impulse.
export function moveToward(cat, tx, ty, speed) {
  const dx = tx - cat.x, dy = ty - cat.y;
  const d = Math.hypot(dx, dy) || 1;
  cat.vx += (dx / d) * speed * 0.15;
  cat.vy += (dy / d) * speed * 0.15;
}

// Read traits to pick what TYPE of social interaction two cats fall into when
// they meet. Pure (rand + gene reads).
export function decideInteraction(a, b) {
  // Aggression: aggressive bold cats may pick fights
  if (a.genes.aggression > 0.55 && a.genes.boldness > b.genes.boldness + 0.15 && rand() < 0.4) {
    return 'fight';
  }
  // Two playful cats — chase/bat (takes priority over routine grooming)
  if (a.genes.playfulness > 0.55 && b.genes.playfulness > 0.5) {
    return 'play';
  }
  // Friendly social — groom or hang out
  const friendly = (a.genes.sociability + b.genes.sociability) / 2;
  if (friendly > 0.55) return rand() < 0.45 ? 'groom' : 'social';
  return 'social';
}

// Pick the next high-level action (state) for a cat based on needs, gene
// traits, neighborhood, and breeding-season status.
export function chooseAction(sim, cat) {
  if (cat.dying) return;
  if (cat.stage === 'kitten') {
    const mom = cat.parents ? (() => { const _m = sim.catById.get(cat.parents[0]); return _m && !_m.dying && !_m._remove ? _m : null; })() : null;
    // Older kittens (weaning age) can also eat solid food if hungry — saves them when mom is busy
    if (cat.age > 7 && cat.hunger < 0.55) {
      const f = findNearestFood(sim, cat);
      if (f.target && f.d < 240) {
        cat.state = 'seek_food'; cat.targetX = f.target.x; cat.targetY = f.target.y; return;
      }
    }
    // Hungry kittens MUST find mom — overrides sleep
    if (cat.hunger < 0.6 && mom) {
      cat.state = 'follow_mom'; cat.targetCat = mom; return;
    }
    if (cat.energy < 0.3 || (cat.state === 'sleep' && cat.energy < 0.9)) { cat.state = 'sleep'; return; }
    // Stick close to mom even when not hungry
    if (mom && dist(cat, mom) > 90) { cat.state = 'follow_mom'; cat.targetCat = mom; return; }
    if (rand() < 0.02 && cat.genes.playfulness > 0.4) {
      // play near siblings
      const sib = findNearest(sim, cat, c => c.parents && cat.parents && c.parents[0] === cat.parents[0] && c.stage === 'kitten', 80);
      if (sib.target) { cat.state = 'play'; cat.targetCat = sib.target; cat.stateTimer = 2 + rand() * 2; return; }
    }
    cat.state = 'wander';
    return;
  }

  // Pregnant → eat opportunistically, more aggressively than non-pregnant
  if (cat.pregnantWith) {
    if (cat.hunger < 0.65) {
      const f = findNearestFood(sim, cat);
      if (f.target) { cat.state = 'seek_food'; cat.targetX = f.target.x; cat.targetY = f.target.y; return; }
    }
    cat.state = 'wander'; return;
  }

  // Adults: seek food when hungry. High-appetite cats seek at higher threshold (eat more eagerly)
  const seekThreshold = 0.45 + cat.genes.appetite * 0.25;   // range 0.45-0.70
  if (cat.hunger < seekThreshold) {
    const f = findNearestFood(sim, cat);
    if (f.target) { cat.state = 'seek_food'; cat.targetX = f.target.x; cat.targetY = f.target.y; return; }
  }
  // Low energy → sleep. Duration scales inversely with energy gene: low-energy cats sleep longer.
  if (cat.energy < 0.2) {
    const baseSleep = 6 + rand() * 6;             // 6-12 base
    const lengthMult = 1.6 - cat.genes.energy;    // high energy = ~0.6×, low = ~1.6×
    cat.state = 'sleep';
    cat.stateTimer = baseSleep * lengthMult;
    return;
  }
  // Continue sleep
  if (cat.state === 'sleep' && cat.energy < 0.9 && cat.stateTimer > 0) return;

  // Mate opportunity (adult, willing, not on cooldown).
  // Density-dependent fertility: when food per cat is scarce the colony breeds
  // LESS, so it self-limits via fewer births instead of a food wall that culls
  // kittens by starvation (audit B2 — that made it a death-sim). The colony now
  // stabilizes just below carrying capacity; most deaths become old age + events.
  if ((cat.stage === 'adult' || cat.stage === 'senior') &&
      sim.simTime > cat.cooldownUntil &&
      cat.hunger > 0.45 && cat.energy > 0.35) {
    // Suppress breeding while food per cat is still fairly comfortable (below
    // ~0.6) so the colony caps WITH a food surplus instead of breeding until
    // food runs short. This keeps food from being the binding constraint, so
    // food-competition traits stop being selected baseline and the environment
    // events become the differentiator (audit B3/B4 — traits were one-way
    // because constant food competition washed events out).
    const foodPerCat = sim.food.length / Math.max(1, sim.cats.length);
    const scarcity = clamp((0.4 - foodPerCat) / 0.4, 0, 1);  // 0 = plentiful, 1 = none
    const willingThreshold = 0.35 - cat.genes.sociability * 0.2 - cat.genes.playfulness * 0.1 + scarcity * 0.9;
    if (rand() > willingThreshold) {
      const partner = findNearest(sim, cat, c =>
        c.sex !== cat.sex &&
        (c.stage === 'adult' || c.stage === 'senior') &&
        !c.pregnantWith &&
        sim.simTime > c.cooldownUntil &&
        c.hunger > 0.4 && c.energy > 0.35
      , 220);
      if (partner.target) {
        const female = cat.sex === 'F' ? cat : partner.target;
        if (female.inEstrus) {
          // Fitness term uses CONDITION only — not body size. Body size has its own
          // separate trade-offs; including bodyScale here would double-count and
          // bias selection toward large.
          const partnerFitness = (partner.target.condition || 1);
          const myFitness = (cat.condition || 1);
          const p = partner.target.genes;
          const c = cat.genes;
          const traitDist = (Math.abs(c.boldness - p.boldness)
                           + Math.abs(c.sociability - p.sociability)
                           + Math.abs(c.energy - p.energy)) / 3;
          const similarity = 1 - traitDist;
          let compat = 0.45 + similarity * 0.25
                            + (cat.genes.sociability + p.sociability) / 2 * 0.2;
          compat *= clamp(Math.pow((partnerFitness * myFitness), 0.8), 0.4, 1.6);
          if (rand() < compat) {
            cat.state = 'court';
            cat.targetCat = partner.target;
            cat.stateTimer = 0;
            return;
          }
        }
      }
    }
  }

  // Social drive
  if (cat.social < 0.5 && cat.genes.sociability > 0.4) {
    const buddy = findNearest(sim, cat, c => c.stage !== 'kitten' && !c.pregnantWith && c.state !== 'sleep', 200);
    if (buddy.target) {
      const intent = decideInteraction(cat, buddy.target);
      if (intent) { cat.state = intent; cat.targetCat = buddy.target; cat.stateTimer = 0; return; }
    }
  }
  // Default wander
  cat.state = 'wander';
}

// Per-tick update for one cat: aging, environmental pressure, posture displays,
// needs decay, estrus, nursing, disease, pregnancy resolution, death checks,
// state re-decide, executeState, movement integration, opportunistic eating.
export function updateCat(sim, cat, dt, sinks) {
  const { logEvent } = sinks;
  if (cat.dying) {
    cat.dyingT += dt / SIM_DAY_REAL_SEC * sim.speed * 0.6;
    if (cat.dyingT >= 3.5) cat._remove = true;
    return;
  }

  cat.age += dt;
  cat.bornFlash = Math.max(0, cat.bornFlash - dt * 0.5);
  cat.fightGlow = Math.max(0, cat.fightGlow - dt * 0.6);
  cat.postureCooldown = Math.max(0, (cat.postureCooldown || 0) - dt);
  const prevStage = cat.stage;
  cat.stage = ageStage(cat.age);
  if (cat.stage !== prevStage && prevStage) {
    if (cat.stage === 'juvenile')    logEvent(`${cat.name} is no longer a kitten`, 'event');
    else if (cat.stage === 'adult')  logEvent(`${cat.name} is fully grown`, 'event');
    else if (cat.stage === 'senior') logEvent(`${cat.name} is growing old`, 'event');
  }

  // Apply seasonal/event environmental pressure (cold, drought, predators, etc.)
  applyEnvironmentalPressure(sim, cat, dt, sinks);
  if (cat.dying) return;   // env effects may have killed cat

  // Passive aggression posture: aggressive cats show warning when near other adults
  if (cat.stage !== 'kitten' && !cat.dying && cat.postureCooldown <= 0 &&
      cat.genes.aggression > 0.55 && cat.state !== 'fight' && cat.state !== 'flee') {
    let nearbyAdult = null;
    forCatsNear(sim, cat.x, cat.y, 55, (c) => {
      if (c === cat || c.dying || c.stage === 'kitten') return false;
      if (dist(cat, c) < 55) { nearbyAdult = c; return true; }   // short-circuit
      return false;
    });
    if (nearbyAdult) {
      cat.floatTexts.push({ text: '〰', t: 0, life: 1.4 });
      cat.postureCooldown = 5 + rand() * 4;
      if (cat.genes.aggression > 0.7) {
        const dx = nearbyAdult.x - cat.x, dy = nearbyAdult.y - cat.y;
        const d = Math.hypot(dx, dy) || 1;
        nearbyAdult.vx += (dx / d) * 0.6;
        nearbyAdult.vy += (dy / d) * 0.6;
      }
    }
  }
  // Aloof posture: very low-sociability cats show a "leave me alone" indicator
  if (cat.stage !== 'kitten' && !cat.dying && cat.postureCooldown <= 0 &&
      cat.genes.sociability < 0.25 && cat.state === 'wander') {
    let crowded = 0;
    forCatsNear(sim, cat.x, cat.y, 45, (c) => {
      if (c === cat || c.dying) return false;
      if (dist(cat, c) < 45) crowded++;
      return false;
    });
    if (crowded >= 2) {
      cat.floatTexts.push({ text: '·', t: 0, life: 1.2 });
      cat.postureCooldown = 7 + rand() * 5;
    }
  }

  // float texts decay
  for (const ft of cat.floatTexts) ft.t += dt;
  cat.floatTexts = cat.floatTexts.filter(ft => ft.t < ft.life);

  // Needs decay (per sim-week)
  // Hunger drain scales with body size — bigger cats burn more.
  // Base lowered 0.030→0.022 so cats starve less readily (audit B2). The
  // appetite term is softened (0.028→0.012) and body exponent 1.5→1.15: those
  // constant per-tick food penalties used to overwhelm every episodic
  // environment benefit, so appetite/body could ONLY shrink (audit B4). With a
  // light constant cost, the conditional trade-offs (appetite good in plenty /
  // bad in drought; body good in winter / bad in drought) drive direction, so
  // both can now evolve up OR down by environment.
  let hungerDrain = (0.024 + cat.genes.appetite * 0.026) * Math.pow(cat.bodyScale, 1.15);
  if (cat.stage === 'kitten') hungerDrain *= 0.35;
  if (cat.pregnantWith) hungerDrain *= 1.3;
  cat.hunger = clamp(cat.hunger - hungerDrain * dt, 0, 1);
  const energyDrain = (cat.state === 'sleep' ? -0.18 : 0.04 + cat.genes.energy * 0.04);
  cat.energy = clamp(cat.energy - energyDrain * dt, 0, 1);
  cat.social = clamp(cat.social - 0.025 * dt, 0, 1);

  // Body condition tracks chronic nourishment — slow to change
  const conditionGain = sim.activeEvent === 'plentiful' ? 0.05 : 0.03;
  if (cat.hunger < 0.3)        cat.condition = clamp(cat.condition - 0.04 * dt, 0.45, 1);
  else if (cat.hunger > 0.65)  cat.condition = clamp(cat.condition + conditionGain * dt, 0.45, 1);

  // Estrus cycle (adult females only, only fertile during breeding season)
  if (cat.sex === 'F' && cat.stage !== 'kitten' && !cat.pregnantWith) {
    const prevEstrus = cat.inEstrus;
    cat.estrusPhase = (cat.estrusPhase + dt) % ESTRUS_CYCLE_WEEKS;
    cat.inEstrus = isBreedingSeason(sim) && cat.estrusPhase < ESTRUS_DURATION;
    if (cat.inEstrus && !prevEstrus && cat.condition > 0.55) {
      cat.floatTexts.push({ text: '♥', t: 0, life: 1.6 });
    }
  } else {
    cat.inEstrus = false;
  }

  // Nursing — kittens near a living mother gain hunger from her
  if (cat.stage === 'kitten' && cat.parents) {
    const mom = (() => { const _m = sim.catById.get(cat.parents[0]); return _m && !_m.dying ? _m : null; })();
    if (mom && dist(cat, mom) < 35 && mom.hunger > 0.25) {
      const transfer = 0.18 * dt;
      cat.hunger = clamp(cat.hunger + transfer, 0, 1);
      mom.hunger = clamp(mom.hunger - transfer * 0.4, 0, 1);
    }
  }

  // ── Disease ──
  // Tick immunity countdown
  if (cat.immunityTimer && cat.immunityTimer > 0) cat.immunityTimer -= dt;

  if (!cat.sick && !cat.dying && cat.stage !== 'kitten' && (cat.immunityTimer || 0) <= 0) {
    let risk = 0.00018 * dt;
    if (sim.activeEvent === 'epidemic') risk *= 8;
    const density = localDensity(sim, cat);
    if (density >= 4) risk *= (1 + (density - 3) * 0.25);
    if (cat.stage === 'senior') risk *= 2;
    if (cat.condition < 0.55) risk *= 1.6;
    let sickNearby = 0;
    forCatsNear(sim, cat.x, cat.y, 45, (c) => {
      if (c === cat || !c.sick || c.dying) return false;
      if (dist(cat, c) < 45) sickNearby++;
      return false;
    });
    if (sickNearby > 0) risk *= (1 + sickNearby * 0.8);
    if (rand() < risk) {
      cat.sick = true;
      cat.sickTimer = 3 + rand() * 5;
      cat.sickSeverity = cat.stage === 'senior' ? 0.4 + rand() * 0.3 : 0.15 + rand() * 0.25;
      logEvent(`${cat.name} fell ill`, 'death');
      sim.diseaseOutbreaks++;
    }
  }
  if (cat.sick) {
    cat.sickTimer -= dt;
    cat.hunger = clamp(cat.hunger - 0.02 * dt, 0, 1);
    cat.energy = clamp(cat.energy - 0.012 * dt, 0, 1);
    if (cat.sickTimer <= 0) {
      let surviveChance = 0.75 + cat.condition * 0.2 - cat.sickSeverity * 0.35;
      if (cat.stage === 'senior') surviveChance -= 0.15;
      surviveChance = clamp(surviveChance, 0.35, 0.97);
      if (rand() < surviveChance) {
        cat.sick = false;
        cat.sickSeverity = 0;
        cat.immunityTimer = 50 + rand() * 30;   // recovered cats immune ~1 year
        logEvent(`${cat.name} recovered`, 'event');
      } else {
        triggerDeath(sim, cat, 'illness', sinks);
        return;
      }
    }
  }

  // Pregnancy tick
  if (cat.pregnantWith) {
    cat.pregnantWith.daysLeft -= dt;
    if (cat.pregnantWith.daysLeft <= 0) giveBirth(sim, cat, sinks);
  }

  // Death checks
  if (cat.age >= cat.lifespan) {
    triggerDeath(sim, cat, 'old age', sinks);
    return;
  }
  if (cat.hunger <= 0.01) {
    // Kittens with a living mother get a grace period — they should find her, not just die.
    if (cat.stage === 'kitten' && cat.parents) {
      const mom = (() => { const _m = sim.catById.get(cat.parents[0]); return _m && !_m.dying ? _m : null; })();
      if (mom) {
        cat._starveTimer = (cat._starveTimer || 0) + dt;
        if (cat._starveTimer < 4) {
          // floating "!" cry above kitten so player notices, throttled by sim-time
          // (was a real-ms setTimeout — speed-scaled sim made it inconsistent;
          // audit N2).
          if (!cat._cryUntil || sim.simTime > cat._cryUntil) {
            cat.floatTexts.push({ text: '!', t: 0, life: 1.5 });
            cat._cryUntil = sim.simTime + 0.4;   // ~1.5 real-seconds at 1× speed
          }
        } else {
          triggerDeath(sim, cat, 'starvation', sinks);
          return;
        }
      } else {
        triggerDeath(sim, cat, 'orphaned', sinks);
        return;
      }
    } else {
      triggerDeath(sim, cat, 'starvation', sinks);
      return;
    }
  } else if (cat._starveTimer) {
    cat._starveTimer = 0;
  }

  cat.stateTimer -= dt;
  // Re-decide every so often. At high pop, slightly lengthen cadence to ease CPU.
  if (cat.stateTimer <= 0) {
    chooseAction(sim, cat);
    const popFactor = sim.cats.length > 500 ? 1.8 : sim.cats.length > 200 ? 1.3 : 1;
    cat.stateTimer = (1 + rand() * 1.5) * popFactor;
  }

  // Clear sleep-buddy target whenever no longer sleeping
  if (cat.state !== 'sleep' && cat._sleepTargetSet) {
    cat._sleepTargetSet = false;
    cat._sleepTargetX = null;
    cat._sleepTargetY = null;
  }

  executeState(sim, cat, dt, sinks);

  // Movement
  cat.x += cat.vx * dt * SIM_DAY_REAL_SEC * 6;
  cat.y += cat.vy * dt * SIM_DAY_REAL_SEC * 6;
  cat.vx *= 0.88;
  cat.vy *= 0.88;
  // Bounds
  const pad = 30;
  if (cat.x < pad) { cat.x = pad; cat.vx = Math.abs(cat.vx); }
  if (cat.x > sim.arenaW - pad) { cat.x = sim.arenaW - pad; cat.vx = -Math.abs(cat.vx); }
  if (cat.y < pad + 50) { cat.y = pad + 50; cat.vy = Math.abs(cat.vy); }
  if (cat.y > sim.arenaH - pad) { cat.y = sim.arenaH - pad; cat.vy = -Math.abs(cat.vy); }

  // direction faces motion
  if (Math.abs(cat.vx) + Math.abs(cat.vy) > 0.1) {
    cat.dir = Math.atan2(cat.vy, cat.vx);
  }

  // Opportunistic eating — bigger cats are more efficient
  if (cat.stage !== 'kitten' && cat.hunger < 0.85 && !cat.dying) {
    for (let i = sim.food.length - 1; i >= 0; i--) {
      const f = sim.food[i];
      if (Math.hypot(cat.x - f.x, cat.y - f.y) < 16) {
        // Bigger cats eat more per bite. Bold cats also more decisive eaters.
        const biteCap = 0.6 + cat.bodyScale * 0.25 + cat.genes.boldness * 0.1;
        const eaten = Math.min(f.amount, biteCap, 1 - cat.hunger);
        cat.hunger = clamp(cat.hunger + eaten, 0, 1);
        f.amount -= eaten;
        if (f.amount <= 0.01) sim.food.splice(i, 1);
        break;
      }
    }
  }
}

// Execute the current movement/intent state for a cat (wander, sleep, seek_food,
// follow_mom, play, court, social, groom, approach, fight, flee).
export function executeState(sim, cat, dt, sinks) {
  const { logEvent } = sinks;
  // Movement speed: energy provides base, boldness adds pace
  const speed = (0.3 + cat.genes.energy * 0.6 + cat.genes.boldness * 0.25) * 8;
  switch (cat.state) {
    case 'wander': {
      const boldness = cat.genes.boldness;
      const sociability = cat.genes.sociability;
      const reorientChance = 0.02 + (1 - boldness) * 0.08;
      if (rand() < reorientChance) {
        const swing = 0.5 + (1 - boldness) * 1.6;
        cat.dir += (rand() - 0.5) * swing;
        const intensity = (0.3 + cat.genes.energy * 0.5) * (0.5 + boldness * 0.7);
        cat.vx += Math.cos(cat.dir) * intensity;
        cat.vy += Math.sin(cat.dir) * intensity;
      }
      // Timid cats occasionally freeze
      if (boldness < 0.35 && rand() < 0.01) {
        cat.vx *= 0.3; cat.vy *= 0.3;
      }
      // SPATIAL PERSONALITY BIASES — gentle drift based on traits
      if (boldness < 0.4) {
        const edgeForce = (0.4 - boldness) * 0.4;
        const dxEdge = (cat.x < sim.arenaW / 2) ? -1 : 1;
        const dyEdge = (cat.y < sim.arenaH / 2) ? -1 : 1;
        const distToEdge = Math.min(cat.x, cat.y, sim.arenaW - cat.x, sim.arenaH - cat.y);
        if (distToEdge > 80) {
          cat.vx += dxEdge * edgeForce * 0.06;
          cat.vy += dyEdge * edgeForce * 0.06;
        }
      }
      if (boldness > 0.7) {
        const cx = sim.arenaW / 2, cy = sim.arenaH / 2;
        const dx = cx - cat.x, dy = cy - cat.y;
        const d = Math.hypot(dx, dy);
        if (d > 60) {
          cat.vx += (dx / d) * 0.04;
          cat.vy += (dy / d) * 0.04;
        }
      }
      if (sociability > 0.65 && rand() < 0.3) {
        const near = findNearest(sim, cat, c => c.stage !== 'kitten' && c.state !== 'sleep', 220);
        if (near.target && near.d > 40) {
          const dx = near.target.x - cat.x, dy = near.target.y - cat.y;
          const d = Math.hypot(dx, dy) || 1;
          cat.vx += (dx / d) * 0.1 * sociability;
          cat.vy += (dy / d) * 0.1 * sociability;
        }
      }
      if (sociability < 0.3) {
        let crowdX = 0, crowdY = 0, crowdN = 0;
        forCatsNear(sim, cat.x, cat.y, 90, (c) => {
          if (c === cat || c.dying) return false;
          if (dist(cat, c) < 90) { crowdX += c.x; crowdY += c.y; crowdN++; }
          return false;
        });
        if (crowdN > 1) {
          const cx = crowdX / crowdN, cy = crowdY / crowdN;
          const dx = cat.x - cx, dy = cat.y - cy;
          const d = Math.hypot(dx, dy) || 1;
          cat.vx += (dx / d) * 0.18 * (0.3 - sociability + 0.1);
          cat.vy += (dy / d) * 0.18 * (0.3 - sociability + 0.1);
        }
      }
      // ENERGY ZOOMIES
      if (!cat.sick && cat.genes.energy > 0.65 && cat.energy > 0.7 && cat.stage !== 'senior') {
        if ((cat._zoomTimer || 0) <= 0 && rand() < 0.004) {
          cat._zoomTimer = 1.2 + rand() * 1.5;
          cat.floatTexts.push({ text: '⚡', t: 0, life: 0.8 });
        }
        if ((cat._zoomTimer || 0) > 0) {
          cat._zoomTimer -= dt;
          cat.vx += Math.cos(cat.dir) * 0.6;
          cat.vy += Math.sin(cat.dir) * 0.6;
          if (rand() < 0.15) cat.dir += (rand() - 0.5) * 1.5;
        }
      }
      // PLAYFUL POUNCING
      if (!cat.sick && cat.genes.playfulness > 0.6 && cat.stage !== 'kitten' && cat.stage !== 'senior'
          && rand() < 0.005 * cat.genes.playfulness) {
        const pounceAng = cat.dir + (rand() - 0.5) * Math.PI;
        cat.vx += Math.cos(pounceAng) * 2.5;
        cat.vy += Math.sin(pounceAng) * 2.5;
        cat.floatTexts.push({ text: '♪', t: 0, life: 1 });
      }
      break;
    }
    case 'sleep': {
      if (!cat._sleepTargetSet) {
        cat._sleepTargetSet = true;
        let buddyX = null, buddyY = null, buddyD = Infinity;
        forCatsNear(sim, cat.x, cat.y, 140, (c) => {
          if (c === cat || c.dying || c._remove) return false;
          if (c.state !== 'sleep') return false;
          const d = dist(cat, c);
          if (d < 140 && d < buddyD) {
            buddyD = d;
            const ang = Math.atan2(cat.y - c.y, cat.x - c.x);
            buddyX = c.x + Math.cos(ang) * 14;
            buddyY = c.y + Math.sin(ang) * 14;
          }
          return false;
        });
        if (buddyX !== null) {
          cat._sleepTargetX = buddyX;
          cat._sleepTargetY = buddyY;
        }
      }
      if (cat._sleepTargetX != null) {
        const d = Math.hypot(cat.x - cat._sleepTargetX, cat.y - cat._sleepTargetY);
        if (d > 6) {
          moveToward(cat, cat._sleepTargetX, cat._sleepTargetY, 2);
        } else {
          cat.vx *= 0.5; cat.vy *= 0.5;
        }
      } else {
        cat.vx *= 0.5; cat.vy *= 0.5;
      }
      break;
    }
    case 'seek_food': {
      const f = findNearestFood(sim, cat);
      if (!f.target) { cat.state = 'wander'; break; }
      cat.targetX = f.target.x; cat.targetY = f.target.y;
      moveToward(cat, f.target.x, f.target.y, speed);
      if (Math.hypot(cat.x - f.target.x, cat.y - f.target.y) < 14) {
        // eat — bigger cats take bigger bites (consistent with opportunistic eating)
        const biteCap = 0.6 + cat.bodyScale * 0.25 + cat.genes.boldness * 0.1;
        const eaten = Math.min(f.target.amount, biteCap, 1 - cat.hunger);
        cat.hunger = clamp(cat.hunger + eaten, 0, 1);
        f.target.amount -= eaten;
        if (f.target.amount <= 0.01) {
          // idx may be stale if food shifted since findNearestFood; guard it
          if (sim.food[f.idx] === f.target) sim.food.splice(f.idx, 1);
          else sim.food.splice(sim.food.indexOf(f.target), 1);
        }
        cat.state = 'wander';
        cat.stateTimer = 1;
      }
      break;
    }
    case 'follow_mom': {
      if (!cat.targetCat || cat.targetCat.dying || cat.targetCat._remove) { cat.state = 'wander'; break; }
      moveToward(cat, cat.targetCat.x + (rand() - 0.5) * 30, cat.targetCat.y + (rand() - 0.5) * 30, speed * 0.7);
      break;
    }
    case 'play': {
      if (!cat.targetCat || cat.targetCat.dying || cat.targetCat._remove) { cat.state = 'wander'; break; }
      moveToward(cat, cat.targetCat.x, cat.targetCat.y, speed * 1.1);
      if (dist(cat, cat.targetCat) < 22) {
        cat.vx += (rand() - 0.5) * 5;
        cat.vy += (rand() - 0.5) * 5;
        cat.social = clamp(cat.social + 0.03 * dt, 0, 1);
        if (rand() < 0.03) {
          cat.floatTexts.push({ text: '♪', t: 0, life: 1.2 });
        }
      }
      break;
    }
    case 'court': {
      if (!cat.targetCat || cat.targetCat.dying || cat.targetCat._remove || cat.targetCat.pregnantWith) { cat.state = 'wander'; break; }
      moveToward(cat, cat.targetCat.x, cat.targetCat.y, speed * 0.8);
      if (dist(cat, cat.targetCat) < 22) {
        const female = cat.sex === 'F' ? cat : cat.targetCat;
        if (female.inEstrus && rand() < 0.05) {
          mate(sim, cat, cat.targetCat, sinks);
        }
      }
      if (cat.stateTimer < -8) cat.state = 'wander';
      break;
    }
    case 'social':
    case 'groom':
    case 'approach': {
      if (!cat.targetCat || cat.targetCat.dying || cat.targetCat._remove) { cat.state = 'wander'; break; }
      moveToward(cat, cat.targetCat.x, cat.targetCat.y, speed * 0.6);
      if (dist(cat, cat.targetCat) < 22) {
        cat.social = clamp(cat.social + 0.04 * dt, 0, 1);
        const aff = cat.affinity.get(cat.targetCat.id) || 0;
        cat.affinity.set(cat.targetCat.id, clamp(aff + 0.05 * dt, -1, 1));
        if (cat.state === 'groom' && rand() < 0.02) {
          cat.floatTexts.push({ text: '✿', t: 0, life: 1.2 });
        }
      }
      if (cat.stateTimer < -3) cat.state = 'wander';
      break;
    }
    case 'fight': {
      if (!cat.targetCat || cat.targetCat.dying || cat.targetCat._remove) { cat.state = 'wander'; break; }
      moveToward(cat, cat.targetCat.x, cat.targetCat.y, speed * 1.2);
      if (dist(cat, cat.targetCat) < 22) {
        // SELECTION PRESSURE: bigger cat dominates the smaller. Damage is asymmetric.
        const myStrength = cat.bodyScale * (0.6 + cat.genes.aggression * 0.4) * (cat.condition || 1);
        const theirStrength = cat.targetCat.bodyScale * (0.6 + cat.targetCat.genes.aggression * 0.4) * (cat.targetCat.condition || 1);
        const advantage = myStrength / Math.max(0.3, theirStrength);
        cat.energy = clamp(cat.energy - 0.04 * dt / advantage, 0, 1);
        cat.targetCat.energy = clamp(cat.targetCat.energy - 0.04 * dt * advantage, 0, 1);
        cat.targetCat.condition = clamp((cat.targetCat.condition || 1) - 0.04 * dt * advantage, 0.3, 1);
        if (advantage > 1.3) {
          const lethalChance = 0.005 * dt * Math.pow(advantage - 1, 2.5);
          if (rand() < lethalChance) {
            logEvent(`${cat.targetCat.name} died from fight injuries`, 'death');
            triggerDeath(sim, cat.targetCat, 'injury', sinks);
            cat.state = 'wander';
            break;
          }
        }
        const aff = cat.affinity.get(cat.targetCat.id) || 0;
        cat.affinity.set(cat.targetCat.id, clamp(aff - 0.1 * dt, -1, 1));
        cat.fightGlow = 1.2;
        cat.targetCat.fightGlow = 1.2;
        cat.fightCount = (cat.fightCount || 0) + 1;
        cat.targetCat.fightCount = (cat.targetCat.fightCount || 0) + 1;
        cat.targetCat.state = 'flee';
        cat.targetCat.targetCat = cat;
        cat.targetCat.stateTimer = 2;
        if (rand() < 0.05) {
          cat.floatTexts.push({ text: '⚡', t: 0, life: 1 });
          logEvent(`${cat.name} scrapped with ${cat.targetCat.name}`, 'event');
        }
        cat.state = 'wander';
      }
      break;
    }
    case 'flee': {
      if (!cat.targetCat) { cat.state = 'wander'; break; }
      const dx = cat.x - cat.targetCat.x;
      const dy = cat.y - cat.targetCat.y;
      const d = Math.hypot(dx, dy) || 1;
      cat.vx += (dx / d) * 1.5;
      cat.vy += (dy / d) * 1.5;
      if (cat.stateTimer < 0 || d > 200) cat.state = 'wander';
      break;
    }
  }
}
