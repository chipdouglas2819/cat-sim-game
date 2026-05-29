import { rand, clamp } from './util.js';

// ─── LOG CLASSIFICATION ───────────────────────────────────────
// Event-type priorities for high-pop filtering. 'major' tier passes always.
export const EVENT_PRIORITY = { 'event': 1, 'birth': 2, 'mate': 2, 'death': 2, 'major': 5 };
// Substrings that mark colony-level messages that should always pass even at high pop.
export const MAJOR_KEYWORDS = ['Year ', 'Spring returns', 'Summer arrives', 'Fall sets in', 'Winter falls',
  'predator stalks', 'harsh winter', 'plentiful', 'drought', 'epidemic', 'Illness sweeps',
  'poor harvest', 'abundant fall', 'These cats are becoming'];

export function isMajorEvent(text) {
  for (let i = 0; i < MAJOR_KEYWORDS.length; i++) {
    if (text.indexOf(MAJOR_KEYWORDS[i]) !== -1) return true;
  }
  return false;
}

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
  // Scale event mortality with colony size. Small founding colonies are largely
  // spared (a predator/plague in a 12-cat colony isn't a mass-casualty event),
  // which lets the player's 2-cat start establish (audit B7) without adding
  // extra founders. Large colonies get culled hard. 60 cats ≈ full lethality.
  const popScale = clamp(sim.cats.length / 60, 0.25, 4);

  // ── Winter background: cold favors high energy + larger bodies ──
  if (sim.season === 'winter') {
    const coldVuln = (1 - g.energy);
    cat.hunger = clamp(cat.hunger - 0.012 * coldVuln * dt, 0, 1);
    if (cat.stage === 'senior') cat.hunger = clamp(cat.hunger - 0.008 * dt, 0, 1);
  }

  // ── HARSH WINTER ──  selects FOR large body + high energy, AGAINST small/low-energy.
  // Strong, clear size pressure UP (audit B4: winter must beat the small-cat
  // baseline so size can evolve upward). Lethality raised so winter is a real
  // selector, not 1% of deaths (audit B2/B3).
  if (evt === 'harshWinter') {
    const smallPenalty = clamp(1.05 - cat.bodyScale, 0, 0.6);     // small cats freeze
    const vuln = (1 - g.energy) * 0.6 + (1 - (cat.condition || 1)) * 0.2 + smallPenalty * 0.7;
    const baseRisk = cat.stage === 'senior' ? 0.0065 : 0.0028;
    const risk = baseRisk * dt * vuln * popScale;
    if (rand() < risk) {
      logEvent(`${cat.name} did not survive the winter`, 'death');
      triggerDeath(cat, 'harsh winter');
      return;
    }
    // Large, high-energy survivors toughen up
    if (g.energy > 0.6 && cat.bodyScale > 1.05) {
      cat.condition = clamp(cat.condition + 0.003 * dt, 0.45, 1);
    }
  }

  // ── PREDATOR ──  selects boldness DOWN (reckless cats get caught), AGAINST
  // big bodies slightly (small cats evade). Aggression's predator payoff is
  // REPRODUCTIVE only (defends kittens — see giveBirth +0.9), deliberately NOT
  // a self-survival rescue here: otherwise bold+aggressive cats survived and
  // predators pushed boldness UP (audit follow-up — boldness/aggression were
  // entangled and neither evolved cleanly). Now boldness falls, aggression
  // rises via surviving litters — independently.
  else if (evt === 'predator') {
    const exposureRisk = clamp(g.boldness - 0.25, 0, 0.75);   // recklessness → caught
    const agility = clamp(0.95 - cat.bodyScale, 0, 0.4) * 0.5; // small cats evade
    const netRisk = (exposureRisk - agility) * 0.012 * dt * popScale;
    if (netRisk > 0 && rand() < netRisk) {
      logEvent(`${cat.name} was taken by a predator`, 'death');
      triggerDeath(cat, 'predator');
      return;
    }
  }

  // ── DROUGHT ──  selects FOR small + low-appetite, AGAINST large/high-appetite.
  // The main downward-size pressure (counterbalances winter/predator).
  else if (evt === 'drought') {
    const droughtVuln = (g.appetite - 0.4) * 0.7 + (cat.bodyScale - 0.9) * 0.7 - (g.boldness - 0.5) * 0.3;
    if (droughtVuln > 0) {
      cat.hunger = clamp(cat.hunger - 0.05 * droughtVuln * dt, 0, 1);
      if (droughtVuln > 0.25 && rand() < 0.0025 * dt * droughtVuln * popScale) {
        logEvent(`${cat.name} wasted away in the drought`, 'death');
        triggerDeath(cat, 'drought');
        return;
      }
    }
    // Small efficient cats gain condition relative to others
    if (droughtVuln < -0.1) cat.condition = clamp(cat.condition + 0.0015 * dt, 0.45, 1);
  }

  // ── EPIDEMIC ──  selects AGAINST sociability (crowders catch it), FOR aloofness.
  // Lethality raised + threshold lowered so it overcomes the baseline pro-social
  // litter bonus — previously epidemic drifted sociability UP (backwards, B3).
  else if (evt === 'epidemic') {
    if (g.sociability > 0.45 && !cat.sick && (cat.immunityTimer || 0) <= 0) {
      const risk = (g.sociability - 0.3) * 0.0038 * dt * popScale;
      if (rand() < risk) {
        logEvent(`${cat.name} succumbed to the plague`, 'death');
        triggerDeath(cat, 'plague');
        return;
      }
    }
    // Aloof cats avoid crowds → fare better (reinforces anti-social selection)
    if (g.sociability < 0.4) cat.condition = clamp(cat.condition + 0.001 * dt, 0.45, 1);
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
