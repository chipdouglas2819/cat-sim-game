// Per-trait reachability confirmation.
//
// Usage: node bench/reachability.js [seeds] [years] [colonyScale]
//
// For each trait, runs the environment that SHOULD push it up and the one that
// should push it down, with MATCHED seeds (same founders), and checks the trait
// actually ends higher in its favoring environment. This isolates the
// environment's effect from drift noise and answers: does every trait have an
// equal opportunity to evolve in BOTH directions? Plus an extreme-viability
// check: can colonies seeded at trait extremes survive (can extremes THRIVE)?
import { Simulation } from '../src/sim/simulation.js';

const seeds = Number(process.argv[2]) || 30;
const years = Number(process.argv[3]) || 35;
const colonyScale = Number(process.argv[4]) || 0.4;
const dt = 0.1;
const base = 6000;

const LOW = 0.1;
const env = (dominant) => {
  if (dominant === 'neutral') return null;
  const c = { predator: LOW, drought: LOW, winter: LOW, epidemic: LOW, plentiful: 0.3 };
  c[dominant] = 4;
  return c;
};

// trait → { up: env that should raise it, down: env that should lower it }
const EXPECT = {
  boldness:    { up: 'plentiful', down: 'predator' },
  sociability: { up: 'plentiful', down: 'epidemic' },
  playfulness: { up: 'plentiful', down: 'drought' },
  aggression:  { up: 'predator',  down: 'plentiful' },
  energy:      { up: 'winter',    down: 'drought' },
  appetite:    { up: 'plentiful', down: 'drought' },
  bodyScale:   { up: 'winter',    down: 'drought' },
};

// Final mean of a trait over surviving colonies in a given environment, matched seeds.
function runEnv(dominant, trait) {
  const climate = env(dominant);
  const vals = [];
  let survived = 0;
  for (let i = 0; i < seeds; i++) {
    const cfg = { seed: base + i, colonyScale };
    if (climate) { cfg.climate = climate; cfg.driftWeather = false; }
    const sim = new Simulation(cfg);
    sim.seedFounders();
    sim.runYears(years, { dt });
    const s = sim.snapshot();
    if (s.population <= 1) continue;
    survived++;
    const v = trait === 'bodyScale' ? s.bodyMean : s.geneMean[trait];
    if (v != null) vals.push(v);
  }
  return { median: median(vals), survival: survived / seeds, n: vals.length };
}

console.log(`Reachability: ${seeds} matched seeds × ${years}yr, colonyScale=${colonyScale}\n`);
console.log('Per trait: mean value in its UP-env vs DOWN-env (same founders).');
console.log('A positive gap = the environment moves the trait the intended way → both directions reachable.\n');
console.log(`${'trait'.padEnd(12)} ${'UP-env'.padEnd(10)} ${'val'.padStart(6)} ${'DOWN-env'.padEnd(10)} ${'val'.padStart(6)} ${'gap'.padStart(7)}  verdict`);
console.log('-'.repeat(72));
let allOk = true;
for (const [trait, { up, down }] of Object.entries(EXPECT)) {
  const u = runEnv(up, trait);
  const d = runEnv(down, trait);
  const gap = (u.median != null && d.median != null) ? u.median - d.median : null;
  const ok = gap != null && gap > 0.015;
  if (!ok) allOk = false;
  const verdict = gap == null ? 'no survivors' : ok ? 'BOTH WAYS ✓' : (gap > 0 ? 'weak' : 'INVERTED ✗');
  console.log(`${trait.padEnd(12)} ${up.padEnd(10)} ${fmt(u.median).padStart(6)} ${down.padEnd(10)} ${fmt(d.median).padStart(6)} ${sfmt(gap).padStart(7)}  ${verdict}`);
}

console.log(`\nExtreme viability — can colonies seeded at a trait extreme survive ${years}yr?`);
console.log('(if an extreme can\'t sustain a colony, that direction can evolve but not THRIVE)\n');
for (const trait of ['bodyScale', 'appetite', 'energy', 'aggression']) {
  for (const extreme of ['high', 'low']) {
    let surv = 0;
    for (let i = 0; i < seeds; i++) {
      const sim = new Simulation({ seed: base + 500 + i, colonyScale });
      // seed founders, then force the extreme on the whole starting colony
      sim.seedFounders();
      forceExtreme(sim, trait, extreme);
      sim.runYears(years, { dt });
      if (sim.snapshot().population > 1) surv++;
    }
    console.log(`  ${trait} ${extreme.padEnd(5)} → ${Math.round(100 * surv / seeds)}% survive`);
  }
}

function forceExtreme(sim, trait, extreme) {
  const v = extreme === 'high' ? 0.9 : 0.1;
  for (const c of sim.cats) {
    if (trait === 'bodyScale') { c.genes.size = v; c.bodyScale = 0.6 + v * 0.8; }
    else c.genes[trait] = v;
  }
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function fmt(v) { return v == null ? '—' : v.toFixed(3); }
function sfmt(v) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(3); }
