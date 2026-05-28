// Environment-stratified balance test.
//
// Usage: node bench/environments.js [seedsPerEnv] [years] [colonyScale]
//
// Runs many seeds under each forced environment (predator-heavy, drought-heavy,
// etc.) and reports median gene drift per trait per environment. Answers:
//   - Does each environment select the traits it's designed to?
//   - Can every trait drift BOTH up and down (across environments)?
//   - Is any trait under no selection (a dead end for directed evolution)?
import { Simulation } from '../src/sim/simulation.js';

const seedsPerEnv = Number(process.argv[2]) || 40;
const years = Number(process.argv[3]) || 22;
const colonyScale = Number(process.argv[4]) || 0.5;
const dt = 0.1;
const baseSeed = 5000;

// Each environment forces one event type to dominate (others suppressed) with a
// frozen climate so the bias persists all run.
const LOW = 0.1;
const ENVIRONMENTS = {
  neutral:   null,
  predator:  { predator: 4, drought: LOW, winter: LOW, epidemic: LOW, plentiful: 0.3 },
  drought:   { drought: 4, predator: LOW, winter: LOW, epidemic: LOW, plentiful: 0.3 },
  winter:    { winter: 4, predator: LOW, drought: LOW, epidemic: LOW, plentiful: 0.3 },
  epidemic:  { epidemic: 4, predator: LOW, drought: LOW, winter: LOW, plentiful: 0.3 },
  plentiful: { plentiful: 4, predator: LOW, drought: LOW, winter: LOW, epidemic: LOW },
};

const TRAITS = ['boldness', 'sociability', 'playfulness', 'aggression', 'energy', 'appetite', 'bodyScale'];

console.log(`Environment balance test: ${seedsPerEnv} seeds/env × ${years}yr, colonyScale=${colonyScale}, dt=${dt}\n`);
const t0 = Date.now();
const results = {};

for (const [env, climate] of Object.entries(ENVIRONMENTS)) {
  const drifts = [];        // per surviving seed: {trait: drift}
  let extinct = 0;
  const pops = [];
  for (let i = 0; i < seedsPerEnv; i++) {
    const cfg = { seed: baseSeed + i, colonyScale };
    if (climate) { cfg.climate = climate; cfg.driftWeather = false; }
    const sim = new Simulation(cfg);
    sim.seedFounders();
    sim.runYears(years, { dt });
    const s = sim.snapshot();
    if (s.population <= 1) { extinct++; continue; }
    pops.push(s.population);
    const d = {};
    for (const t of ['boldness', 'sociability', 'playfulness', 'aggression', 'energy', 'appetite']) {
      if (s.geneMean[t] != null) d[t] = s.geneMean[t] - s.founderGenes[t];
    }
    if (s.bodyMean != null) d.bodyScale = s.bodyMean - s.founderGenes.bodyScale;
    drifts.push(d);
  }
  results[env] = { drifts, extinct, survivors: drifts.length, medPop: median(pops) };
}

// ── Report: environment × trait median drift matrix ──
console.log(`Median gene drift (final − founder) by environment, over survivors:`);
console.log(`(positive = trait increased; look for each column having BOTH + and − across rows)\n`);
const head = `${'environment'.padEnd(11)} ${'surv'.padStart(5)} ${'pop'.padStart(5)}  ` +
  TRAITS.map(t => t.slice(0, 5).padStart(7)).join(' ');
console.log(head);
console.log('-'.repeat(head.length));
for (const [env, r] of Object.entries(results)) {
  const cells = TRAITS.map(t => {
    const vals = r.drifts.map(d => d[t]).filter(v => v != null);
    return vals.length ? sfmt(median(vals)).padStart(7) : '   —   ';
  });
  const survStr = `${r.survivors}/${seedsPerEnv}`;
  console.log(`${env.padEnd(11)} ${survStr.padStart(5)} ${String(r.medPop || 0).padStart(5)}  ${cells.join(' ')}`);
}

// ── Per-trait reachability: does each trait reach both directions somewhere? ──
console.log(`\nReachability — strongest median drift each direction across environments:`);
for (const t of TRAITS) {
  let maxUp = -Infinity, maxUpEnv = '', maxDn = Infinity, maxDnEnv = '';
  for (const [env, r] of Object.entries(results)) {
    const vals = r.drifts.map(d => d[t]).filter(v => v != null);
    if (!vals.length) continue;
    const m = median(vals);
    if (m > maxUp) { maxUp = m; maxUpEnv = env; }
    if (m < maxDn) { maxDn = m; maxDnEnv = env; }
  }
  const upOk = maxUp > 0.03, dnOk = maxDn < -0.03;
  const verdict = upOk && dnOk ? 'BOTH ✓' : upOk ? 'only UP' : dnOk ? 'only DOWN' : 'FLAT (no selection?)';
  console.log(`  ${t.padEnd(12)} up ${sfmt(maxUp)} (${maxUpEnv}) | down ${sfmt(maxDn)} (${maxDnEnv})  → ${verdict}`);
}

console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function sfmt(v) { return v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(3); }
