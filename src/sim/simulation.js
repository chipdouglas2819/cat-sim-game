import {
  SIM_DAY_REAL_SEC, FEED_SPOTS_COUNT,
  FOOD_SPAWN_INTERVAL, FOOD_PER_CAT, FOOD_TARGET_MIN, FOOD_BURST_MAX,
  FOOD_RANDOM_CHANCE, FOOD_SPOT_JITTER, FOOD_LIFETIME,
} from './constants.js';
import { mulberry32, setRandomSource, rand, clamp } from './util.js';
import { rollGenes } from './genetics.js';
import {
  deriveSeason, deriveYear, rollSeasonalEvent, driftWeather, makeStartingWeather,
  isMajorEvent, EVENT_PRIORITY,
} from './events.js';
import { rebuildSpatialIndex } from './spatial.js';
import { createCat, recordFirsts, dropFood, triggerDeath } from './lifecycle.js';
import { updateCat } from './ai.js';
import { computeDiversity } from './diversity.js';

const BEHAVIORAL_TRAITS = ['boldness', 'sociability', 'playfulness', 'aggression', 'energy', 'appetite'];

// Owns all simulation state AND the tick loop. The live web game and the headless
// bench harness both construct a Simulation and call step(dt) — same code path —
// so a behavior verified on the bench is the same behavior the player sees.
// step() never touches the DOM; the web layer renders sim.cats after each step.
export class Simulation {
  constructor(config = {}) {
    // ─── CONFIG ──────────────────────────────────────────────
    // seed: integer for reproducible runs. Omit (or null) for Math.random.
    this.seed = config.seed ?? null;
    this.colonyScale = config.colonyScale ?? 1;

    // Wire the RNG. When a seed is given, all subsequent rand/pick/gauss/etc.
    // calls across the codebase pull from mulberry32(seed). Without a seed,
    // the helpers keep using Math.random (unchanged live-game behavior).
    if (this.seed !== null) {
      setRandomSource(mulberry32(this.seed));
    }

    // ─── PHASE / TIME ────────────────────────────────────────
    this.phase = 'setup';                  // setup | running | ended
    this.simTime = 0;                      // sim-days elapsed
    this.speed = 1;
    this.lastTime = 0;
    this.lastAutoFood = 0;
    this.season = 'spring';                // auto-derived from simTime
    this.year = 1;                         // 1-indexed

    // ─── WORLD SIZE ──────────────────────────────────────────
    // Logical drawing area. Web layer updates these from window dims
    // on resize. Headless bench just uses the defaults.
    this.arenaW = config.arenaW ?? 800;
    this.arenaH = config.arenaH ?? 600;

    // ─── CATS / FOOD / WORLD ─────────────────────────────────
    this.cats = [];
    this.food = [];
    this.feedSpots = [];                   // fixed anchor points around which food spawns
    this.nextId = 1;

    // ─── POPULATION COUNTERS ─────────────────────────────────
    this.generation = 1;
    this.totalBorn = 2;
    this.totalDied = 0;
    this.stillborn = 0;
    this.diseaseOutbreaks = 0;

    // ─── EVENT / LOG / HISTORY ───────────────────────────────
    this.events = [];                      // {simTime, text, type}
    this.history = [];                     // population samples for chart
    this.diversityHistory = [];            // genetic diversity samples
    this.geneHistory = {                   // gene-mean over time (behavioral genes)
      boldness: [], sociability: [], playfulness: [],
      aggression: [], energy: [], appetite: [],
      bodyScale: []
    };
    this.notableEvents = [];
    this.deceased = [];                    // snapshots of every cat who died (capped — see triggerDeath)
    this.deathCauses = {};                 // running histogram: reason → count
    this.lifespanSum = 0;                  // Σ age-at-death (sim-weeks) — for mean lifespan
    this.lifespanCount = 0;
    this.eventExposure = {};               // sim-weeks each event type was active (for bench correlation)
    this.founders = [];                    // ids of the starting pair
    this.founderGenes = null;              // captured at start for drift comparison
    this.lastDriftAnnouncement = {};       // last-narrated drift per trait
    this.firsts = {};                      // {phenotypeKey: catName}
    this.activeEvent = null;
    this.activeEventMessage = '';
    // Weather-bias multipliers; drift yearly. config.climate lets the bench force
    // an environment (e.g. {predator: 3, drought: 0.2, ...}) to test conditional
    // selection. config.driftWeather=false freezes it so a forced bias persists.
    this.climate = config.climate ? { ...makeStartingWeather(), ...config.climate } : makeStartingWeather();
    this.driftWeatherEnabled = config.driftWeather !== false;
    this.eventLog = [];                    // history of events for end screen
    this.eventTimeline = [];               // {simTime, event, season, message} for chart markers

    // ─── RECORDS ─────────────────────────────────────────────
    this.longestLife = 0;
    this.longestLifeName = '';
    this.oldestEver = null;
    this.records = {                       // all-time record holders, tracked incrementally
      oldest: null, mostProlific: null, mostFights: null, mostInbred: null, biggest: null,
    };

    // ─── UI / END STATE ──────────────────────────────────────
    this.selectedCatId = null;
    this.starter = { A: null, B: null };   // staged starter cat configs
    this.endCause = '';
    this.endedByUser = false;
    this._endTimer = 0;                    // real-seconds grace before ending (web only)

    // ─── INDEXES (formerly module-level Maps) ────────────────
    // These were globals: catById, parentsById, spatialGrid. Living on the
    // Simulation now so a bench harness running multiple sims in one process
    // doesn't cross-contaminate.
    this.catById = new Map();              // O(1) cat lookup by id
    this.parentsById = new Map();          // catId -> [momId, dadId] | null
    this.spatialGrid = new Map();          // "cx,cy" → array of cats

    // ─── SIDE-EFFECT SINKS ───────────────────────────────────
    // Passed to event/AI/lifecycle helpers so they can log + kill without
    // importing this module (avoids a dependency cycle) and without touching
    // the DOM. Pure: logEvent appends to this.events, triggerDeath updates
    // sim state. The web layer renders this.events on its own cadence.
    this._sinks = {
      logEvent: (text, type) => this.logEvent(text, type),
      triggerDeath: (cat, reason) => triggerDeath(this, cat, reason, this._sinks),
    };
  }

  // Set up the founding pair + feeding spots + initial food. Both the web
  // game (from the setup screen's staged genes) and the bench harness call
  // this, so the colony starts identically. Genes default to fresh random
  // rolls when not supplied. Call once, right after construction.
  // The colony starts from the player's chosen pair (A & B) — exactly two cats.
  // extraFounders stays available for bench experiments but defaults to 0 so the
  // live game starts with just the two. Founder extinction (audit B7) is instead
  // mitigated by a gentle founding period — see step()/early-growth handling.
  seedFounders({ aGenes = null, bGenes = null, aName = null, bName = null, extraFounders = 0 } = {}) {
    // Feeding spots — fixed locations where food regenerates, spread evenly
    for (let i = 0; i < FEED_SPOTS_COUNT; i++) {
      const ang = (i / FEED_SPOTS_COUNT) * Math.PI * 2 + rand() * 0.4 - 0.2;
      const radius = Math.min(this.arenaW, this.arenaH) * 0.28;
      this.feedSpots.push({
        x: this.arenaW / 2 + Math.cos(ang) * radius + (rand() - 0.5) * 30,
        y: this.arenaH / 2 + Math.sin(ang) * radius + (rand() - 0.5) * 30,
      });
    }
    const A = createCat(this, {
      sex: 'M', genes: aGenes || rollGenes('M'), name: aName,
      age: 50, x: this.arenaW * 0.4, y: this.arenaH * 0.5,
    });
    A._gen = 1;
    const B = createCat(this, {
      sex: 'F', genes: bGenes || rollGenes('F'), name: bName,
      age: 50, x: this.arenaW * 0.6, y: this.arenaH * 0.5,
    });
    B._gen = 1;
    const founders = [A, B];
    // Extra founders — alternating sex, random genes, scattered around the arena
    for (let i = 0; i < extraFounders; i++) {
      const sex = i % 2 === 0 ? 'F' : 'M';
      const f = createCat(this, {
        sex, genes: rollGenes(sex),
        age: 40 + Math.floor(rand() * 30),
        x: this.arenaW * (0.25 + rand() * 0.5),
        y: this.arenaH * (0.3 + rand() * 0.4),
      });
      f._gen = 1;
      founders.push(f);
    }
    for (const f of founders) { this.cats.push(f); recordFirsts(this, f); }
    this.founders = founders.map(f => f.id);
    // Snapshot founder gene means (over ALL founders) for drift comparison
    this.founderGenes = {};
    this.lastDriftAnnouncement = {};
    for (const t of BEHAVIORAL_TRAITS) {
      this.founderGenes[t] = founders.reduce((s, f) => s + f.genes[t], 0) / founders.length;
    }
    this.founderGenes.bodyScale = founders.reduce((s, f) => s + f.bodyScale, 0) / founders.length;
    // Bias the named pair toward each other initially
    A.social = 0.3;
    B.social = 0.3;
    this.logEvent(`${A.name} & ${B.name} settle into the colony.`, 'event');
    // Seed initial food at the feeding spots
    for (const spot of this.feedSpots) {
      const ang = rand() * Math.PI * 2;
      dropFood(this, spot.x + Math.cos(ang) * 15, spot.y + Math.sin(ang) * 15);
    }
    return { A, B, founders };
  }

  // Kill a cat through the sim's own sinks. Used by the web layer's end-check
  // (the lone-survivor death) so it doesn't need its own sink plumbing.
  kill(cat, reason) {
    triggerDeath(this, cat, reason, this._sinks);
  }

  // Append an event to the log, with the same pop-based filtering the live
  // game used (so the bench's event list matches what the player would see).
  logEvent(text, type = 'event') {
    const pop = this.cats.length;
    // Above 500 cats: suppress everything except colony-level events
    if (pop > 500 && !isMajorEvent(text)) return;
    // Mid pop (200-500): drop low-priority events probabilistically
    if (pop > 200 && pop <= 500 && (EVENT_PRIORITY[type] || 1) < 2 && rand() < 0.6) return;
    this.events.unshift({ simTime: this.simTime, text, type });
    if (this.events.length > 40) this.events.pop();
  }

  // Advance the simulation by dt sim-weeks. Pure: no DOM, no rendering.
  // Returns { sampledHistory } so the web layer knows when to refresh charts.
  step(dt) {
    const sinks = this._sinks;
    this.simTime += dt;

    // ─── Season + year tracking ──────────────────────────────
    const newSeason = deriveSeason(this.simTime);
    const newYear = deriveYear(this.simTime);
    if (newSeason !== this.season) {
      this.season = newSeason;
      const seasonMsg = newSeason === 'spring' ? 'Spring returns. Breeding season begins.' :
                        newSeason === 'summer' ? 'Summer arrives.' :
                        newSeason === 'fall' ? 'Fall sets in. Breeding season ends.' :
                        'Winter falls over the colony.';
      this.logEvent(seasonMsg, 'event');
      rollSeasonalEvent(this, newSeason, sinks);
    }
    if (newYear !== this.year) {
      this.year = newYear;
      this.logEvent(`Year ${newYear} begins.`, 'event');
      if (this.driftWeatherEnabled) driftWeather(this);
      this._narrateDrift();
      this._maybeMigrant();
    }

    // Tally how long each event type is active (for bench environment correlation)
    if (this.activeEvent) {
      this.eventExposure[this.activeEvent] = (this.eventExposure[this.activeEvent] || 0) + dt;
    }

    // ─── Food spawning ───────────────────────────────────────
    if (this.simTime - this.lastAutoFood > FOOD_SPAWN_INTERVAL) {
      const livingPop = this.cats.filter(c => !c.dying).length;
      // Add additional feeding spots as the colony grows so cats don't all pile up
      const desiredSpots = livingPop >= 35 ? 6 : livingPop >= 22 ? 5 : livingPop >= 12 ? 4 : 3;
      while (this.feedSpots.length < desiredSpots) {
        const ang = rand() * Math.PI * 2;
        const radius = Math.min(this.arenaW, this.arenaH) * (0.18 + rand() * 0.22);
        this.feedSpots.push({
          x: clamp(this.arenaW / 2 + Math.cos(ang) * radius, 60, this.arenaW - 60),
          y: clamp(this.arenaH / 2 + Math.sin(ang) * radius, 130, this.arenaH - 60),
        });
      }
      // Environmental carrying capacity — food production has hard limits.
      // colonyScale shifts the whole equilibrium: smaller = faster evolution.
      // BUGFIX: the floors used to be flat (15/6/4), which clamped every
      // colonyScale <= ~0.6 to the same capacity — the knob did nothing in its
      // useful low range. Floors now scale WITH colonyScale (tiny absolute
      // safety floors only), so low scales produce genuinely small colonies.
      // At scale 1 (the live default) this is essentially unchanged.
      const colonyScale = this.colonyScale || 1;
      const areaCap = Math.max(Math.ceil(4 * colonyScale), Math.floor((this.arenaW * this.arenaH) / 20000 * colonyScale));
      let envMult = 1;
      if (this.season === 'winter') envMult *= 0.5;
      else if (this.season === 'fall') envMult *= 0.8;
      else if (this.season === 'summer') envMult *= 1.1;
      if (this.activeEvent === 'plentiful') envMult *= 1.6;
      else if (this.activeEvent === 'drought') envMult *= 0.35;
      else if (this.activeEvent === 'harshWinter') envMult *= 0.6;
      const envCap = Math.max(2, Math.floor(areaCap * envMult));
      // Target = whichever is LOWER: per-cat demand OR environmental ceiling.
      const demand = Math.ceil(livingPop * FOOD_PER_CAT);
      const targetFood = Math.max(Math.ceil(FOOD_TARGET_MIN * colonyScale), Math.min(demand, envCap));
      const shortfall = targetFood - this.food.length;
      if (shortfall > 0) {
        const dynamicBurst = Math.max(FOOD_BURST_MAX, Math.ceil(livingPop / 25));
        const toSpawn = Math.min(shortfall, dynamicBurst);
        for (let i = 0; i < toSpawn; i++) {
          if (rand() < FOOD_RANDOM_CHANCE) {
            dropFood(this, rand(70, this.arenaW - 70), rand(150, this.arenaH - 70));
          } else {
            const spot = this.feedSpots[Math.floor(rand() * this.feedSpots.length)];
            const ang = rand() * Math.PI * 2;
            const r = 12 + rand() * FOOD_SPOT_JITTER;
            dropFood(
              this,
              clamp(spot.x + Math.cos(ang) * r, 50, this.arenaW - 50),
              clamp(spot.y + Math.sin(ang) * r, 130, this.arenaH - 50)
            );
          }
        }
      }
      this.lastAutoFood = this.simTime;
    }

    // Remove expired food
    this.food = this.food.filter(f => this.simTime - f.bornAt < FOOD_LIFETIME && f.amount > 0.01);

    // Rebuild spatial index once before any neighbor queries this tick
    rebuildSpatialIndex(this);

    // Update cats
    for (const cat of this.cats) updateCat(this, cat, dt, sinks);
    // Remove dead-faded
    this.cats = this.cats.filter(c => !c._remove);

    // Sample history (every 2 sim-weeks)
    let sampledHistory = false;
    if (Math.floor(this.simTime / 2) > this.history.length) {
      sampledHistory = true;
      this.history.push({ day: this.simTime, pop: this.cats.length, born: this.totalBorn, died: this.totalDied });
      this.diversityHistory.push(computeDiversity(this));
      const adults = this.cats.filter(c => !c.dying && c.stage !== 'kitten');
      if (adults.length > 0) {
        for (const t of BEHAVIORAL_TRAITS) {
          const mean = adults.reduce((s, c) => s + c.genes[t], 0) / adults.length;
          this.geneHistory[t].push(mean);
        }
        const sizeMean = adults.reduce((s, c) => s + (c.bodyScale || 1), 0) / adults.length;
        this.geneHistory.bodyScale.push(sizeMean);
      } else {
        // Carry forward last value (or a sensible default)
        for (const t of BEHAVIORAL_TRAITS) {
          const last = this.geneHistory[t];
          last.push(last.length ? last[last.length - 1] : 0.5);
        }
        const last = this.geneHistory.bodyScale;
        last.push(last.length ? last[last.length - 1] : 1);
      }
    }

    return { sampledHistory };
  }

  // Live gene-drift narration — report meaningful shifts from founder genes.
  // Called once per year from step(). Mutates lastDriftAnnouncement, logs.
  _narrateDrift() {
    if (!this.founderGenes || this.year <= 1) return;
    const adults = this.cats.filter(c => !c.dying && c.stage !== 'kitten');
    if (adults.length < 4) return;
    const phrases = {
      boldness:    ['bolder', 'more timid'],
      sociability: ['more social', 'more aloof'],
      playfulness: ['more playful', 'more serious'],
      aggression:  ['more aggressive', 'gentler'],
      energy:      ['more energetic', 'mellower'],
      appetite:    ['hungrier eaters', 'lighter eaters'],
    };
    const shifts = [];
    for (const t of Object.keys(phrases)) {
      const curMean = adults.reduce((s, c) => s + c.genes[t], 0) / adults.length;
      const founderMean = this.founderGenes[t];
      const delta = curMean - founderMean;
      const lastDelta = this.lastDriftAnnouncement[t] || 0;
      if (Math.abs(delta) > 0.12 && Math.abs(delta - lastDelta) > 0.06) {
        shifts.push({ trait: t, delta, phrase: phrases[t][delta > 0 ? 0 : 1] });
        this.lastDriftAnnouncement[t] = delta;
      }
    }
    const curBody = adults.reduce((s, c) => s + (c.bodyScale || 1), 0) / adults.length;
    const bodyDelta = curBody - this.founderGenes.bodyScale;
    const lastBodyDelta = this.lastDriftAnnouncement.bodyScale || 0;
    if (Math.abs(bodyDelta) > 0.08 && Math.abs(bodyDelta - lastBodyDelta) > 0.04) {
      shifts.push({ trait: 'bodyScale', delta: bodyDelta, phrase: bodyDelta > 0 ? 'larger' : 'smaller' });
      this.lastDriftAnnouncement.bodyScale = bodyDelta;
    }
    if (shifts.length) {
      shifts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      this.logEvent(`These cats are becoming ${shifts[0].phrase} than their forebears.`, 'event');
    }
  }

  // Immigration — a stray cat occasionally wanders in with FRESH random genes and
  // its own home range at the arena edge. This is the realistic diversity injector
  // (feral colonies avoid genetic collapse via immigration): it counteracts drift
  // and inbreeding, and starts a new lineage territory. Called once per year.
  _maybeMigrant() {
    const pop = this.livingCount();
    if (pop < 3 || pop > 220) return;        // only into an established, non-crowded colony
    if (rand() > 0.28) return;               // ~once every 3-4 years on average
    const sex = rand() < 0.5 ? 'M' : 'F';
    const edge = Math.floor(rand() * 4);     // enter + settle at a random edge
    let x, y;
    if (edge === 0) { x = 45; y = rand(140, this.arenaH - 45); }
    else if (edge === 1) { x = this.arenaW - 45; y = rand(140, this.arenaH - 45); }
    else if (edge === 2) { x = rand(45, this.arenaW - 45); y = 140; }
    else { x = rand(45, this.arenaW - 45); y = this.arenaH - 45; }
    const m = createCat(this, {
      sex, genes: rollGenes(sex),
      age: 40 + Math.floor(rand() * 60),
      x, y, homeX: x, homeY: y,
    });
    m._gen = this.generation;                // joins at the colony's current generation
    this.cats.push(m);
    recordFirsts(this, m);
    this.logEvent(`A stray ${sex === 'F' ? 'female' : 'male'} joins the colony.`, 'event');
  }

  // Count living (non-dying) cats. A run is biologically over at <= 1
  // (a lone cat can't breed). The web layer adds an animation grace period;
  // the bench can just check this after each step.
  livingCount() {
    let n = 0;
    for (const c of this.cats) if (!c.dying) n++;
    return n;
  }

  // Aggregate metrics for the bench harness / analysis. Computed over living
  // adults (the population that's actually reproducing + being selected).
  snapshot() {
    const adults = this.cats.filter(c => !c.dying && c.stage !== 'kitten');
    const n = adults.length;
    const geneMean = {};
    const geneStd = {};
    for (const t of BEHAVIORAL_TRAITS) {
      if (n === 0) { geneMean[t] = null; geneStd[t] = null; continue; }
      const mean = adults.reduce((s, c) => s + c.genes[t], 0) / n;
      const variance = adults.reduce((s, c) => { const d = c.genes[t] - mean; return s + d * d; }, 0) / n;
      geneMean[t] = mean;
      geneStd[t] = Math.sqrt(variance);
    }
    const bodyMean = n ? adults.reduce((s, c) => s + (c.bodyScale || 1), 0) / n : null;
    const meanF = n ? adults.reduce((s, c) => s + (c.inbreedF || 0), 0) / n : null;

    return {
      simTime: this.simTime,
      year: this.year,
      season: this.season,
      generation: this.generation,
      population: this.livingCount(),
      adults: n,
      totalBorn: this.totalBorn,
      totalDied: this.totalDied,
      stillborn: this.stillborn,
      diseaseOutbreaks: this.diseaseOutbreaks,
      geneMean,
      geneStd,
      bodyMean,
      meanInbreedingF: meanF,
      diversity: computeDiversity(this),
      activeEvent: this.activeEvent,
      climate: this.climate ? { ...this.climate } : null,
      deathCauses: { ...this.deathCauses },
      eventExposure: { ...this.eventExposure },
      meanLifespan: this.lifespanCount ? this.lifespanSum / this.lifespanCount : null,
      totalDeaths: this.lifespanCount,
      founderGenes: this.founderGenes ? { ...this.founderGenes } : null,
    };
  }

  // Run forward N sim-years headlessly with a fixed timestep. For the bench.
  // dt default 0.1 sim-weeks ≈ the live game at ~6× speed — small enough that
  // movement/eating/navigation behave the same (the live game caps dt ~0.13).
  // Larger dt makes cats overshoot food/mates (cat.x += vx*dt*24). Stops early
  // if the colony dies out. Returns the final snapshot.
  runYears(years, { dt = 0.1, onYear = null } = {}) {
    const endTime = this.simTime + years * 52;
    let lastYear = this.year;
    this.phase = 'running';
    while (this.simTime < endTime) {
      this.step(dt);
      if (onYear && this.year !== lastYear) { lastYear = this.year; onYear(this); }
      if (this.livingCount() <= 1) { this.phase = 'ended'; break; }
    }
    return this.snapshot();
  }
}
