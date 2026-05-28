import {
  KITTEN_DAYS, JUVENILE_DAYS, ADULT_END, SENIOR_END,
  ESTRUS_CYCLE_WEEKS, NAME_POOL,
} from './constants.js';
import { rand, pick, gauss, clamp, lightenHex } from './util.js';
import { calculatePhenotype } from './genetics.js';

// Map age (weeks) to life stage.
export function ageStage(age) {
  if (age < KITTEN_DAYS) return 'kitten';
  if (age < JUVENILE_DAYS) return 'juvenile';
  if (age < ADULT_END) return 'adult';
  return 'senior';
}

// Walk the lineage tree up `depth` generations, returning a Map of
// ancestorId → generation distance. Uses sim.parentsById (which tracks both
// living and recently deceased ancestors) so lineage works across deaths.
export function ancestors(sim, catId, depth = 4, map = new Map(), gen = 0) {
  if (depth === 0 || !catId) return map;
  const parents = sim.parentsById.get(catId);
  if (!parents) return map;
  for (const pid of parents) {
    if (pid != null) {
      const prev = map.get(pid) ?? Infinity;
      if (gen + 1 < prev) map.set(pid, gen + 1);
      ancestors(sim, pid, depth - 1, map, gen + 1);
    }
  }
  return map;
}

// Rough inbreeding coefficient via ancestor overlap (Wright's path counting).
// Caps at 0.6 to avoid runaway pile-up.
export function inbreedingCoefficient(sim, momId, dadId) {
  const ma = ancestors(sim, momId);
  const da = ancestors(sim, dadId);
  ma.set(momId, 0);
  da.set(dadId, 0);
  let F = 0;
  for (const [aId, mGen] of ma) {
    if (da.has(aId)) {
      const dGen = da.get(aId);
      F += 0.5 ** (mGen + dGen + 1);
    }
  }
  return Math.min(0.6, F);
}

// First-appearance tracker — for notable cats panel.
export function recordFirsts(sim, cat) {
  const f = sim.firsts;
  const key = cat.phenotype.baseColor;
  if (!f[key]) f[key] = { name: cat.name, id: cat.id, day: Math.floor(sim.simTime) };
  if (cat.phenotype.longHair && !f._longhair) f._longhair = { name: cat.name, id: cat.id, day: Math.floor(sim.simTime) };
  if (cat.phenotype.pattern === 'Cs' && !f._classic) f._classic = { name: cat.name, id: cat.id, day: Math.floor(sim.simTime) };
  if (cat.phenotype.pattern === 'Sp' && !f._spotted) f._spotted = { name: cat.name, id: cat.id, day: Math.floor(sim.simTime) };
  if (cat.inbreedF > 0.2 && !f._inbred) f._inbred = { name: cat.name, id: cat.id, day: Math.floor(sim.simTime) };
}

// Record a kitten's parents into the lineage Map so future inbreeding
// calculations can walk through them.
export function recordParents(sim, catId, parents) {
  if (parents) sim.parentsById.set(catId, parents);
}

// Build a new cat object (founder or kitten). Returns the cat — caller pushes
// onto sim.cats and runs recordFirsts/recordParents.
export function createCat(sim, { sex, genes, name, parents = null, x, y, age = 0 }) {
  const ph = calculatePhenotype(genes, sex);
  // Lifespan modified by inbreeding (computed at birth if has parents)
  const F = parents ? inbreedingCoefficient(sim, parents[0], parents[1]) : 0;
  const lifeMod = 1 - F * 0.4;        // up to 40% shorter life
  // Gaussian lifespan variance — most cluster around SENIOR_END, with long tails both ways
  const baseLifespan = SENIOR_END + gauss() * 55;   // σ ≈ 55 weeks (~1 year)
  const lifespan = Math.max(60, baseLifespan * lifeMod);
  // Permanent body size — driven by the heritable 'size' gene (plus minor appetite/energy influence).
  // This makes size genuinely heritable and lets the colony evolve toward big or small over generations.
  const sizeGene = genes.size !== undefined ? genes.size : 0.5;
  const bodyScale = clamp(
    0.6 + sizeGene * 0.8 + (genes.appetite - 0.5) * 0.10 + (genes.energy - 0.5) * 0.06 + gauss() * 0.04,
    0.45, 1.6
  );
  // Smaller cats live longer (less metabolic stress); larger cats burn out faster.
  // This is a real biological trade-off and a key advantage for small body size.
  const sizeLifeMod = 1 + (1 - bodyScale) * 0.35;   // 0.6× body ~ +14%, 1.5× body ~ -17%
  const lifespanFinal = lifespan * sizeLifeMod;
  const rareTraits = [];
  // Dwarf — emerges naturally at the low tail of the size gene (heritable!)
  if (bodyScale < 0.62) {
    rareTraits.push('dwarf');
  }
  // Giant — emerges at the high tail (heritable!)
  else if (bodyScale > 1.42) {
    rareTraits.push('giant');
  }
  // Smoke (~2%) — coat has silvery wash. Modifies phenotype.
  if (rand() < 0.02 && ph.baseColor !== 'white') {
    rareTraits.push('smoke');
    ph.smoke = true;
    ph.baseHex = lightenHex(ph.baseHex, 0.32);
    ph.smokeUndertint = true;
  }
  // Heterochromia — different eye colors (~1.5%)
  if (rand() < 0.015) rareTraits.push('odd-eyed');
  return {
    id: sim.nextId++,
    name: name || pick(NAME_POOL),
    sex,
    genes,
    phenotype: ph,
    rareTraits,
    age,
    stage: ageStage(age),
    hunger: 0.7,
    energy: 0.85,
    social: 0.5,
    condition: 0.85,
    bodyScale,
    bornAt: sim.simTime - age,
    lifespan: lifespanFinal,
    inbreedF: F,
    state: 'wander',
    stateTimer: 0,
    x: x ?? rand(80, sim.arenaW - 80),
    y: y ?? rand(160, sim.arenaH - 160),
    vx: 0, vy: 0,
    dir: rand(0, Math.PI * 2),
    targetX: null, targetY: null,
    targetCat: null,
    partner: null,
    pregnantWith: null,
    cooldownUntil: 0,
    parents: parents,            // [momId, dadId]
    children: [],
    affinity: new Map(),
    dying: false,
    dyingT: 0,
    dyingReason: '',
    floatTexts: [],              // {text, t, life, dy}
    bornFlash: 0.6,              // sparkle effect on birth
    fightGlow: 0,                // flares red when fighting
    fightCount: 0,               // total fights initiated/joined (for end screen)
    postureCooldown: 0,          // sim-day countdown for aggression posture displays
    // Estrus (females only): cycles continuously, only fertile during ESTRUS_DURATION window
    estrusPhase: sex === 'F' ? rand() * ESTRUS_CYCLE_WEEKS : 0,
    inEstrus: false,
    // Disease
    sick: false,
    sickTimer: 0,            // weeks remaining until resolution
    sickSeverity: 0,         // 0-1, affects death chance
    immunityTimer: 0,        // weeks of post-recovery immunity
  };
}

// Spawn a food morsel at (x, y). Pushes onto sim.food.
export function dropFood(sim, x, y) {
  sim.food.push({
    x, y,
    amount: 0.65 + rand() * 0.3,
    bornAt: sim.simTime,
  });
}
