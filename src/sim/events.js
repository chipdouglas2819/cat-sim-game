import { rand, clamp } from './util.js';

// Season helper: 52 weeks/year, 13 weeks/season.
export function deriveSeason(simTime) {
  const week = Math.floor(simTime) % 52;
  if (week < 13) return 'spring';
  if (week < 26) return 'summer';
  if (week < 39) return 'fall';
  return 'winter';
}

export function deriveYear(simTime) {
  return Math.floor(simTime / 52) + 1;
}

// Cats breed in spring & summer only (seasonal estrus).
export function isBreedingSeason(sim) {
  return sim.season === 'spring' || sim.season === 'summer';
}

// Weather is a random walk — biases drift over time. Some eras are unlucky, some lucky.
// No fixed region temperament; ecology is what it happens to be.
export function makeStartingWeather() {
  return {
    winter: 1.0, drought: 1.0, predator: 1.0, epidemic: 1.0, plentiful: 1.0,
  };
}

// Called once per year — each weather bias drifts slightly. Over time, long stretches of
// "lots of droughts" or "few predators" emerge naturally without being chosen.
export function driftWeather(sim) {
  const w = sim.climate;
  if (!w) return;
  const keys = ['winter', 'drought', 'predator', 'epidemic', 'plentiful'];
  for (const k of keys) {
    // Small random walk with reversion to 1.0 (so biases don't drift to infinity)
    const drift = (rand() - 0.5) * 0.25;
    const revert = (1.0 - w[k]) * 0.08;
    w[k] = clamp(w[k] + drift + revert, 0.5, 1.8);
  }
}

// Roll the next seasonal event onto `sim.activeEvent`. `logEvent` is the caller-provided
// sink — web layer's version writes to DOM, bench harness can use a minimal logger.
export function rollSeasonalEvent(sim, season, { logEvent }) {
  // 30% chance the current event persists into this new season (a "long" event)
  // This gives some runs multi-season droughts, prolonged epidemics, etc.
  if (sim.activeEvent && rand() < 0.3) {
    logEvent(`The ${sim.activeEvent === 'harshWinter' ? 'harsh winter' :
                    sim.activeEvent === 'plentiful' ? 'abundance' : sim.activeEvent} continues.`, 'death');
    return;
  }
  sim.activeEvent = null;
  sim.activeEventMessage = '';
  if (sim.year < 2) return;
  const climate = sim.climate || makeStartingWeather();
  const roll = rand();
  // Apply climate multipliers — each region has more or less of each event type
  if (season === 'winter') {
    const t1 = 0.20 * climate.winter;
    if (roll < t1) {
      sim.activeEvent = 'harshWinter';
      sim.activeEventMessage = 'A harsh winter descends. The weak will not survive.';
      logEvent(sim.activeEventMessage, 'death');
    }
  } else if (season === 'spring') {
    const t1 = 0.18 * climate.plentiful;
    const t2 = t1 + 0.15 * climate.predator;
    const t3 = t2 + 0.06 * climate.epidemic;
    if (roll < t1) {
      sim.activeEvent = 'plentiful';
      sim.activeEventMessage = 'A plentiful spring. Prey is abundant.';
      logEvent(sim.activeEventMessage, 'birth');
    } else if (roll < t2) {
      sim.activeEvent = 'predator';
      sim.activeEventMessage = 'A predator stalks the colony.';
      logEvent(sim.activeEventMessage, 'death');
    } else if (roll < t3) {
      sim.activeEvent = 'epidemic';
      sim.activeEventMessage = 'Illness sweeps through the colony.';
      logEvent(sim.activeEventMessage, 'death');
    }
  } else if (season === 'summer') {
    const t1 = 0.14 * climate.drought;
    const t2 = t1 + 0.12 * climate.epidemic;
    const t3 = t2 + 0.10 * climate.predator;
    if (roll < t1) {
      sim.activeEvent = 'drought';
      sim.activeEventMessage = 'A summer drought has set in. Food is scarce.';
      logEvent(sim.activeEventMessage, 'death');
    } else if (roll < t2) {
      sim.activeEvent = 'epidemic';
      sim.activeEventMessage = 'Illness sweeps through the colony.';
      logEvent(sim.activeEventMessage, 'death');
    } else if (roll < t3) {
      sim.activeEvent = 'predator';
      sim.activeEventMessage = 'A predator stalks the colony.';
      logEvent(sim.activeEventMessage, 'death');
    }
  } else if (season === 'fall') {
    const t1 = 0.18 * climate.plentiful;
    const t2 = t1 + 0.08 * climate.drought;
    if (roll < t1) {
      sim.activeEvent = 'plentiful';
      sim.activeEventMessage = 'An abundant fall harvest. Cats fatten for winter.';
      logEvent(sim.activeEventMessage, 'birth');
    } else if (roll < t2) {
      sim.activeEvent = 'drought';
      sim.activeEventMessage = 'A poor harvest. Food is thin going into winter.';
      logEvent(sim.activeEventMessage, 'death');
    }
  }
  // Record event start in the timeline for chart markers
  if (sim.activeEvent) {
    sim.eventTimeline.push({
      simTime: sim.simTime,
      event: sim.activeEvent,
      season: season,
      message: sim.activeEventMessage,
    });
  }
}

// Per-tick environmental effects applied to a cat.
// CRITICAL: each event must select FOR some traits and AGAINST others.
// No trait should be uniformly beneficial — that's how trade-offs make evolution interesting.
export function applyEnvironmentalPressure(sim, cat, dt, { logEvent, triggerDeath }) {
  if (cat.stage === 'kitten' || cat.dying) return;
  const evt = sim.activeEvent;
  const g = cat.genes;
  // Scale mortality with population — at high pop, a "harsh winter" should actually cull noticeably
  const popScale = clamp(sim.cats.length / 200, 1, 4);

  // ── Winter background: cold favors high energy + larger bodies ──
  if (sim.season === 'winter') {
    const coldVuln = (1 - g.energy);
    cat.hunger = clamp(cat.hunger - 0.012 * coldVuln * dt, 0, 1);
    if (cat.stage === 'senior') cat.hunger = clamp(cat.hunger - 0.008 * dt, 0, 1);
  }

  // ── HARSH WINTER ──
  // LOSERS: low-energy, small, low-condition cats die. SHARP mortality.
  // WINNERS: high-energy + larger cats — also gain a slight condition bonus from surviving (toughens up)
  if (evt === 'harshWinter') {
    const vuln = (1 - g.energy) * 0.7 + (1 - (cat.condition || 1)) * 0.3;
    const sizeBenefit = clamp((cat.bodyScale - 0.85), 0, 0.4);
    const baseRisk = cat.stage === 'senior' ? 0.0040 : 0.0014;
    const risk = baseRisk * dt * vuln * (1 - sizeBenefit) * popScale;
    if (rand() < risk) {
      logEvent(`${cat.name} did not survive the winter`, 'death');
      triggerDeath(cat, 'harsh winter');
      return;
    }
    // Survivors with strong cold-tolerance build condition slightly (hardy adaptation)
    if (g.energy > 0.65 && cat.bodyScale > 1) {
      cat.condition = clamp(cat.condition + 0.002 * dt, 0.45, 1);
    }
  }

  // ── PREDATOR ──
  // LOSERS: bold non-aggressive cats wander into danger; LARGE cats are easier to catch (less nimble)
  // WINNERS: aggressive defenders fight back; SMALL cats are nimble and evade. Multiple survival paths.
  else if (evt === 'predator') {
    const exposureRisk = clamp((g.boldness - 0.35), 0, 0.65);
    const defense = clamp(g.aggression - 0.3, 0, 0.7) * cat.bodyScale;
    // Small cats dodge — agility bonus for bodyScale below 1
    const agility = clamp((1 - cat.bodyScale), 0, 0.45);
    const netRisk = (exposureRisk - defense * 0.8 - agility * 0.6) * 0.005 * dt * popScale;
    if (netRisk > 0 && rand() < netRisk) {
      logEvent(`${cat.name} was taken by a predator`, 'death');
      triggerDeath(cat, 'predator');
      return;
    }
  }

  // ── DROUGHT ──
  // LOSERS: high-appetite large cats — fastest to starve
  // WINNERS: small low-appetite cats — survive on little. Bold cats forage further (compensates).
  else if (evt === 'drought') {
    const droughtVuln = (g.appetite - 0.4) * 0.7 + (cat.bodyScale - 0.9) * 0.6 - (g.boldness - 0.5) * 0.3;
    if (droughtVuln > 0) {
      cat.hunger = clamp(cat.hunger - 0.04 * droughtVuln * dt, 0, 1);
      if (droughtVuln > 0.3 && rand() < 0.0012 * dt * droughtVuln * popScale) {
        logEvent(`${cat.name} wasted away in the drought`, 'death');
        triggerDeath(cat, 'drought');
        return;
      }
    }
    // Small efficient cats actually gain a bit of condition relative to others
    if (droughtVuln < -0.1) cat.condition = clamp(cat.condition + 0.001 * dt, 0.45, 1);
  }

  // ── EPIDEMIC ──
  // LOSERS: high-sociability cats spend more time near others, catch faster (disease tick handles)
  // WINNERS: aloof cats avoid crowds (existing wander drift), so disease rolls less often for them
  // We ALSO add direct epidemic mortality scaling with sociability for non-sick cats —
  // even brief contact with sick cats by social cats is more often lethal.
  else if (evt === 'epidemic') {
    if (g.sociability > 0.55 && !cat.sick && (cat.immunityTimer || 0) <= 0) {
      const risk = (g.sociability - 0.4) * 0.0008 * dt * popScale;
      if (rand() < risk) {
        logEvent(`${cat.name} succumbed to the plague`, 'death');
        triggerDeath(cat, 'plague');
        return;
      }
    }
  }

  // ── PLENTIFUL ──
  // No mortality, but big bold appetite-driven cats benefit MORE from abundance:
  // they fatten, build condition, and (via litter-size code) reproduce more.
  else if (evt === 'plentiful') {
    const benefit = (g.appetite - 0.4) * 0.5 + (g.boldness - 0.4) * 0.3;
    if (benefit > 0) {
      cat.condition = clamp(cat.condition + 0.005 * benefit * dt, 0.45, 1);
    }
  }
}
