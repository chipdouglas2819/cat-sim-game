import {
  KITTEN_DAYS, JUVENILE_DAYS, ADULT_END, SENIOR_END,
  PREGNANCY_DAYS, BREED_COOLDOWN,
  ESTRUS_CYCLE_WEEKS, NAME_POOL,
} from './constants.js';
import { rand, pick, gauss, clamp, lightenHex } from './util.js';
import { calculatePhenotype, inheritGenes } from './genetics.js';

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

// Pair two cats — sets up pregnancy and cooldowns.
export function mate(sim, a, b, { logEvent }) {
  const female = a.sex === 'F' ? a : b;
  const male = a.sex === 'M' ? a : b;
  if (female.pregnantWith) return;
  female.pregnantWith = { fatherId: male.id, daysLeft: PREGNANCY_DAYS };
  female.cooldownUntil = sim.simTime + PREGNANCY_DAYS + BREED_COOLDOWN;
  male.cooldownUntil = sim.simTime + 6;
  a.state = 'wander';
  b.state = 'wander';
  female.floatTexts.push({ text: '♥', t: 0, life: 1.5 });
  male.floatTexts.push({ text: '♥', t: 0, life: 1.5 });
  logEvent(`${female.name} and ${male.name} paired`, 'mate');
}

// Resolve a pregnancy into a litter of kittens. Modifies sim.cats, sim.totalBorn,
// sim.stillborn, sim.generation, sim.parentsById. May trigger maternal death.
export function giveBirth(sim, mom, sinks) {
  const { logEvent } = sinks;
  const father = sim.catById.get(mom.pregnantWith.fatherId);
  if (!father) { mom.pregnantWith = null; return; }
  const F = inbreedingCoefficient(sim, mom.id, father.id);

  // ── LITTER SIZE: trait advantages are CONDITIONAL on environment ──
  // No trait gives unconditional reproductive advantage. Selection direction
  // depends on context.
  const baseLitter = 3 + Math.floor(rand() * 3);  // 3-5 base
  // Maternal condition matters (well-fed moms have more), but NOT body size directly
  const matFitness = clamp(mom.condition, 0.5, 1.2);
  // Trait bonus is now SMALL and conditional
  let traitBonus = 0;

  // SIZE TRADE-OFF: small mothers produce MORE kittens (r-strategy: many cheap
  // offspring), large mothers produce fewer but invest more per kitten
  // (K-strategy: see survival advantages).
  traitBonus += (1 - mom.bodyScale) * 0.8;   // 0.6× body → +0.3 kittens, 1.5× body → -0.4 kittens

  // High boldness: better foraging in lean times, but extra predator risk loss
  if (sim.activeEvent === 'plentiful' || sim.activeEvent === 'drought') {
    traitBonus += (mom.genes.boldness - 0.5) * 0.4;
  } else if (sim.activeEvent === 'predator') {
    traitBonus -= (mom.genes.boldness - 0.5) * 0.3;   // bold moms get caught
  }
  // High energy: critical in winter, costs in drought (high metabolism)
  if (sim.season === 'winter' || sim.activeEvent === 'harshWinter') {
    traitBonus += (mom.genes.energy - 0.5) * 0.7;
  } else if (sim.activeEvent === 'drought') {
    traitBonus -= (mom.genes.energy - 0.5) * 0.3;
  }
  // High aggression: defends kittens from predators, but costs in peaceful times
  if (sim.activeEvent === 'predator') {
    traitBonus += (mom.genes.aggression - 0.5) * 0.5;
  } else if (sim.activeEvent === 'plentiful' || (!sim.activeEvent && sim.season !== 'winter')) {
    traitBonus -= (mom.genes.aggression - 0.5) * 0.15;
  }
  // High appetite: only beneficial when food is plentiful
  if (sim.activeEvent === 'plentiful') {
    traitBonus += (mom.genes.appetite - 0.5) * 0.4;
  } else if (sim.activeEvent === 'drought' || sim.season === 'winter') {
    traitBonus -= (mom.genes.appetite - 0.5) * 0.5;
  }
  // Sociability: helps in normal times (alloparenting), hurts in epidemics
  if (sim.activeEvent === 'epidemic') {
    traitBonus -= (mom.genes.sociability - 0.5) * 0.4;
  } else {
    traitBonus += (mom.genes.sociability - 0.5) * 0.2;
  }
  // Father's body size only helps in defense scenarios
  if (sim.activeEvent === 'predator') {
    traitBonus += (father.bodyScale - 1) * 0.3;
  }

  let litterSize = Math.max(0, Math.round(baseLitter * matFitness + traitBonus));
  litterSize = Math.min(litterSize, 7);
  // Postpartum mortality risk
  const motherRisk = (litterSize - 2) * 0.02 + (1 - mom.condition) * 0.08 + F * 0.05;
  const momWillDie = rand() < motherRisk;
  if (litterSize <= 0) { mom.pregnantWith = null; return; }
  const littermates = [];
  for (let i = 0; i < litterSize; i++) {
    // Inbreeding may cause stillbirth. Also: extreme low-fitness moms have weaker kittens.
    const stillbornChance = F * 0.5 + (1 - matFitness) * 0.05;
    const sex = rand() < 0.5 ? 'M' : 'F';
    const kgenes = inheritGenes(mom, father, sex);
    if (rand() < stillbornChance) {
      sim.stillborn++;
      logEvent(`A kitten of ${mom.name} did not survive`, 'death');
      continue;
    }
    const kitten = createCat(sim, {
      sex, genes: kgenes,
      name: pick(NAME_POOL),
      parents: [mom.id, father.id],
      x: mom.x + (rand() - 0.5) * 16,
      y: mom.y + (rand() - 0.5) * 16,
    });
    sim.parentsById.set(kitten.id, [mom.id, father.id]);
    kitten.hunger = 0.85;
    sim.cats.push(kitten);
    sim.totalBorn++;
    mom.children.push(kitten.id);
    father.children.push(kitten.id);
    // Track generation
    const gen = Math.max(mom._gen || 1, father._gen || 1) + 1;
    kitten._gen = gen;
    if (gen > sim.generation) sim.generation = gen;
    recordFirsts(sim, kitten);
    // Initial affinity: positive toward mom and dad
    kitten.affinity.set(mom.id, 0.5);
    kitten.affinity.set(father.id, 0.3);
    mom.affinity.set(kitten.id, 0.6);
    father.affinity.set(kitten.id, 0.2);
    littermates.push(kitten);
  }
  // Wire littermate mutual affinity — they grow up bonded
  for (const a of littermates) {
    for (const b of littermates) {
      if (a !== b) a.affinity.set(b.id, 0.4);
    }
  }
  logEvent(`${mom.name} bore ${litterSize} kitten${litterSize > 1 ? 's' : ''}${F > 0.15 ? ' (inbred)' : ''}`, 'birth');
  mom.pregnantWith = null;
  if (momWillDie) {
    // Mother dies in childbirth (formerly setTimeout(..., 0) — now synchronous
    // so headless runs match the live game).
    triggerDeath(sim, mom, 'childbirth', sinks);
  }
}

// Mark a cat as dying. Updates records, deceased snapshot list, longest-life
// stats, and triggers maternal grief on kitten death.
export function triggerDeath(sim, cat, reason, { logEvent }) {
  if (cat.dying) return;
  cat.dying = true;
  cat.dyingT = 0;
  cat.dyingReason = reason;
  cat.vx = cat.vy = 0;
  sim.totalDied++;
  if (cat.age > sim.longestLife) {
    sim.longestLife = cat.age;
    sim.longestLifeName = cat.name;
  }
  // Snapshot for pedigree + end-screen. Keep a compact record.
  const snapshot = {
    id: cat.id,
    name: cat.name,
    sex: cat.sex,
    age: cat.age,
    bornAt: cat.bornAt,
    diedAt: sim.simTime,
    diedOf: reason,
    children: cat.children.length,
    childrenIds: [...cat.children],
    parents: cat.parents ? [...cat.parents] : null,
    fightCount: cat.fightCount || 0,
    inbreedF: cat.inbreedF || 0,
    bodyScale: cat.bodyScale || 1,
    phenotype: cat.phenotype,
    genes: cat.genes,
    gen: cat._gen || 1,
    wasFounder: sim.founders.includes(cat.id),
  };
  // Track all-time records incrementally (so we don't scan a huge array at end)
  const r = sim.records;
  if (!r.oldest       || snapshot.age        > r.oldest.age)            r.oldest = snapshot;
  if (!r.mostProlific || snapshot.children   > r.mostProlific.children) r.mostProlific = snapshot;
  if (!r.mostFights   || snapshot.fightCount > r.mostFights.fightCount) r.mostFights = snapshot;
  if (!r.mostInbred   || snapshot.inbreedF   > r.mostInbred.inbreedF)   r.mostInbred = snapshot;
  if (!r.biggest      || snapshot.bodyScale  > r.biggest.bodyScale)     r.biggest = snapshot;
  // Push to deceased but cap the array — only recent dead are kept for pedigree lookups.
  sim.deceased.push(snapshot);
  if (sim.deceased.length > 400) sim.deceased.shift();
  logEvent(`${cat.name} died (${reason}, week ${cat.age.toFixed(0)})`, 'death');
  // Maternal grief: if a kitten dies, mom withdraws socially for a while
  if (cat.stage === 'kitten' && cat.parents) {
    const mom = (() => { const _m = sim.catById.get(cat.parents[0]); return _m && !_m.dying ? _m : null; })();
    if (mom) {
      mom.social = Math.min(mom.social, 0.15);   // social drive blunted
      if (sim.cats.length < 500) mom.floatTexts.push({ text: '…', t: 0, life: 2 });
    }
  }
}
