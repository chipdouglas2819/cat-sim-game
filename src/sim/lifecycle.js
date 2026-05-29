import {
  KITTEN_DAYS, JUVENILE_DAYS, ADULT_END, SENIOR_END,
  PREGNANCY_DAYS, BREED_COOLDOWN,
  ESTRUS_CYCLE_WEEKS, NAME_POOL,
} from './constants.js';
import { rand, pick, gauss, clamp, lightenHex } from './util.js';
import { calculatePhenotype, inheritGenes, deriveEyeColor } from './genetics.js';

// The per-cat floating pop-up comment system was removed (laggy, low value —
// meaningful events go to the top-of-screen log). cat.floatTexts is a shared
// no-op sink so the scattered .push() calls cost nothing and nothing renders.
const FLOAT_SINK = { push() {} };

// The per-cat floating pop-up comment system was removed (laggy, low value —
// meaningful events go to the top-of-screen log instead). cat.floatTexts is a
// shared no-op sink so the scattered .push() calls cost nothing and nothing

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
// homeX/homeY = the cat's territorial home range (matrilineal clustering); defaults
// to its spawn position when not supplied.
export function createCat(sim, { sex, genes, name, parents = null, x, y, age = 0, homeX, homeY }) {
  const ph = calculatePhenotype(genes, sex);
  const spawnX = x ?? rand(80, sim.arenaW - 80);
  const spawnY = y ?? rand(160, sim.arenaH - 160);
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
  // Smaller cats live a bit longer (less metabolic stress). Kept mild (0.18) so
  // it's a gentle nudge, not an unconditional small-cat win — body size should
  // track environment, not always shrink (audit B4).
  const sizeLifeMod = 1 + (1 - bodyScale) * 0.18;   // 0.6× body ~ +7%, 1.5× body ~ -9%
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
  // ── EYES ── every cat gets a realistic base iris color (never black).
  ph.eyeHex = deriveEyeColor(genes, ph);
  ph.eyeHex2 = ph.eyeHex;   // second eye matches unless heterochromia below
  // Heterochromia — one genuinely different eye. Realistically near-exclusive to
  // white / high-white cats (odd-eyed cats are essentially always white/bicolor),
  // so gate the full blue eye to those; colored cats instead get a rare sectoral
  // fleck (so you never see a blue-eyed solid black cat). Inbreeding boosts it.
  if (rand() < 0.015 * (1 + F * 3)) {
    const whiteish = ph.baseColor === 'white' || (ph.whiteAmount != null && ph.whiteAmount > 0.5);
    if (whiteish) {
      rareTraits.push('odd-eyed');
      ph.eyeHex2 = '#bcdcee';   // one ice-blue eye
    } else {
      rareTraits.push('sectoral');
      ph.eyeSectoral = true;    // a flecked iris (rendered as a small accent), both eyes same base
    }
  }
  // ── SUPER-RARE VARIANTS ── striking, low-probability phenotypes for interest
  // and visible diversity. Coat overrides render via ph.baseHex.
  // Albinism/melanism are RECESSIVE in real cats: inbreeding (high F) makes a cat
  // far likelier to inherit the trait from both sides, so inbred lineages surface
  // these striking variants. recBoost scales the odds up to ~3.4× at max F — the
  // visible upside of inbreeding (the downside is shorter life + stillbirths,
  // applied via F above).
  const recBoost = 1 + F * 4;
  if (rand() < 0.006 * recBoost && !ph.smoke) {       // melanistic — solid inky black
    rareTraits.push('melanistic');
    ph.baseColor = 'melanistic';
    ph.baseHex = '#16161c';
    ph.pattern = 'solid';
    ph.melanistic = true;
  } else if (rand() < 0.004 * recBoost) {             // albino — white coat, pink-red eyes
    rareTraits.push('albino');
    ph.baseColor = 'albino';
    ph.baseHex = '#f7f1ea';
    ph.pattern = 'solid';
    ph.whiteAmount = 1;
    ph.albino = true;
    // True albinos have pink-red eyes (both) — not heterochromia. Override both.
    ph.eyeHex = '#d98a96';
    ph.eyeHex2 = '#d98a96';
    ph.eyeSectoral = false;
  } else if (rand() < 0.005 * recBoost) {             // silver/chinchilla shimmer
    rareTraits.push('silver');
    ph.baseHex = lightenHex(ph.baseHex, 0.5);
    ph.silver = true;
  }
  // Methuselah (~0.5%) — exceptional longevity, a rare gift independent of size.
  let methuselah = false;
  if (rand() < 0.005) { methuselah = true; rareTraits.push('methuselah'); }
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
    lifespan: lifespanFinal * (methuselah ? 1.7 : 1),
    inbreedF: F,
    state: 'wander',
    stateTimer: 0,
    x: spawnX,
    y: spawnY,
    homeX: homeX ?? spawnX,   // territorial home range (matrilineal clustering)
    homeY: homeY ?? spawnY,
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
    floatTexts: FLOAT_SINK,      // removed pop-up system — no-op sink
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
  // Smaller base litters (2-4, was 3-5) — the colony was a death-sim: explosive
  // births → overpopulation → mass starvation. Calmer turnover (audit B2/round1).
  const baseLitter = 2 + Math.floor(rand() * 3);  // 2-4 base
  // Maternal condition matters (well-fed moms have more), but NOT body size directly
  const matFitness = clamp(mom.condition, 0.5, 1.2);
  // Trait bonus is now SMALL and conditional
  let traitBonus = 0;

  // SIZE TRADE-OFF: small mothers produce somewhat MORE kittens (r-strategy),
  // large mothers fewer but with survival advantages elsewhere (winter, fights,
  // predator defense). Weakened 0.8→0.35 so it's not an unconditional small-cat
  // win — size should track environment (audit B4).
  traitBonus += (1 - mom.bodyScale) * 0.35;

  // High boldness: better foraging in lean times, but extra predator risk loss
  if (sim.activeEvent === 'plentiful' || sim.activeEvent === 'drought') {
    traitBonus += (mom.genes.boldness - 0.5) * 0.6;
  } else if (sim.activeEvent === 'predator') {
    traitBonus -= (mom.genes.boldness - 0.5) * 0.6;   // bold moms get caught
  }
  // High energy: critical in winter, costs in drought (high metabolism)
  if (sim.season === 'winter' || sim.activeEvent === 'harshWinter') {
    traitBonus += (mom.genes.energy - 0.5) * 0.7;
  } else if (sim.activeEvent === 'drought') {
    traitBonus -= (mom.genes.energy - 0.5) * 0.3;
  }
  // High aggression: defends kittens from predators, but costs in peaceful times
  if (sim.activeEvent === 'predator') {
    traitBonus += (mom.genes.aggression - 0.5) * 0.9;   // strong defender reward
  } else if (sim.activeEvent === 'plentiful' || (!sim.activeEvent && sim.season !== 'winter')) {
    traitBonus -= (mom.genes.aggression - 0.5) * 0.25;
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
  // Playfulness: a real trade-off (audit B5 — was unselected). Playful colonies
  // are socially cohesive → better kitten care when there's energy to spare, but
  // play wastes calories when food is scarce. Selectable in BOTH directions:
  // favored in abundance/peace, costly in drought/winter.
  if (sim.activeEvent === 'plentiful' || (!sim.activeEvent && sim.season !== 'winter')) {
    traitBonus += (mom.genes.playfulness - 0.5) * 0.35;
  } else if (sim.activeEvent === 'drought' || sim.activeEvent === 'harshWinter' || sim.season === 'winter') {
    traitBonus -= (mom.genes.playfulness - 0.5) * 0.4;
  }
  // Father's body size only helps in defense scenarios
  if (sim.activeEvent === 'predator') {
    traitBonus += (father.bodyScale - 1) * 0.3;
  }
  // FOUNDING BOOM: a tiny colony with resources to spare breeds prolifically
  // (r-selection), so the player's 2-cat start reliably establishes before the
  // founders age out (audit B7). Tapers off as the colony reaches viable size.
  const livingNow = sim.cats.filter(c => !c.dying).length;
  if (livingNow < 16) traitBonus += 1.8;
  else if (livingNow < 32) traitBonus += 0.8;

  let litterSize = Math.max(0, Math.round(baseLitter * matFitness + traitBonus));
  litterSize = Math.min(litterSize, 5);   // was 7 — calmer turnover (round 1)
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
    // Kitten's home range = mother's, nudged slightly. Matrilines stay clustered
    // but each generation drifts a little, so distinct family territories spread
    // across the arena over time (territorial clustering of lineages).
    const HOME_DRIFT = 28;
    const kHomeX = clamp((mom.homeX ?? mom.x) + (rand() - 0.5) * 2 * HOME_DRIFT, 40, sim.arenaW - 40);
    const kHomeY = clamp((mom.homeY ?? mom.y) + (rand() - 0.5) * 2 * HOME_DRIFT, 120, sim.arenaH - 40);
    const kitten = createCat(sim, {
      sex, genes: kgenes,
      name: pick(NAME_POOL),
      parents: [mom.id, father.id],
      x: mom.x + (rand() - 0.5) * 16,
      y: mom.y + (rand() - 0.5) * 16,
      homeX: kHomeX, homeY: kHomeY,
    });
    sim.parentsById.set(kitten.id, [mom.id, father.id]);
    kitten.hunger = 0.85;
    // HYBRID VIGOR — a kitten from fresh blood (one parent a migrant or wandering
    // tom) gets a real F1 health edge: longer life + better condition. The mirror
    // of inbreeding depression; makes outcrossing visibly worthwhile.
    if (mom._migrant || father._migrant || mom._wanderer || father._wanderer) {
      kitten.lifespan *= 1.12;
      kitten.condition = Math.min(1, kitten.condition + 0.12);
      kitten.rareTraits.push('hybrid');
      kitten._hybrid = true;
    }
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
  // Running death-cause histogram (deceased array is capped, so we tally here).
  sim.deathCauses[reason] = (sim.deathCauses[reason] || 0) + 1;
  // Attribute the death to the active event if its cause matches, for the event's
  // TRUE toll on the chart (e.g. "the drought of year 12 cost 8 cats").
  if (sim._eventEntry) {
    const ev = sim._eventEntry.event;
    if ((ev === 'harshWinter' && reason === 'harsh winter') ||
        (ev === 'predator' && reason === 'predator') ||
        (ev === 'drought' && (reason === 'drought' || reason === 'starvation')) ||
        (ev === 'epidemic' && (reason === 'plague' || reason === 'illness'))) {
      sim._eventEntry.toll++;
    }
  }
  // Running lifespan tally (age at death, in sim-weeks) for the bench.
  sim.lifespanSum = (sim.lifespanSum || 0) + cat.age;
  sim.lifespanCount = (sim.lifespanCount || 0) + 1;
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
