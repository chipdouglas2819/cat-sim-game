import { mulberry32, setRandomSource } from './util.js';

// Owns all simulation state. The live web game and the (future) headless bench
// harness both construct a Simulation and share the same step/snapshot surface,
// so a behavior verified on the bench is the same behavior the player sees.
//
// Phase 1c-i scope: this class only OWNS state. The tick loop and AI/lifecycle
// helpers still live inline in colony.html and read/write `sim.<field>` directly.
// Phase 1c-ii will move those into methods so the bench can step the sim
// without any DOM dependency.
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
    this.founders = [];                    // ids of the starting pair
    this.firsts = {};                      // {phenotypeKey: catName}
    this.activeEvent = null;
    this.activeEventMessage = '';
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

    // ─── INDEXES (formerly module-level Maps) ────────────────
    // These were globals: catById, parentsById, spatialGrid. Living on the
    // Simulation now so a bench harness running multiple sims in one process
    // doesn't cross-contaminate.
    this.catById = new Map();              // O(1) cat lookup by id
    this.parentsById = new Map();          // catId -> [momId, dadId] | null
    this.spatialGrid = new Map();          // "cx,cy" → array of cats
  }
}
