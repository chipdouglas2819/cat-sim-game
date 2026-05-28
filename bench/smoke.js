// Headless smoke test for the extracted simulation.
// Usage: node bench/smoke.js [seed] [years]
//
// Validates three things the browser build can't:
//   1. The sim modules load + run under Node with no DOM.
//   2. A seeded run is deterministic (same seed → identical outcome).
//   3. step()/snapshot() produce sensible population + drift numbers.
import { Simulation } from '../src/sim/simulation.js';

const seed = Number(process.argv[2]) || 12345;
const years = Number(process.argv[3]) || 20;
// Smaller colony keeps the smoke test fast (it runs the sim twice for the
// determinism check). Lower colonyScale is also the regime we most want to
// study — smaller pops show clearer gene drift.
const colonyScale = Number(process.argv[4]) || 0.4;

const fmt = (v) => (v == null ? '—' : v.toFixed(3));

function runOnce(s, yrs, { log = false } = {}) {
  const sim = new Simulation({ seed: s, colonyScale });
  sim.seedFounders();   // random founders drawn from the seeded RNG
  if (log) console.log(`founders: ${JSON.stringify(mapVals(sim.founderGenes, fmt))}`);
  sim.runYears(yrs, {
    onYear: (sm) => {
      if (log && sm.year % 10 === 0) {
        const snap = sm.snapshot();
        console.log(`  Y${String(sm.year).padStart(2)}: pop=${String(snap.population).padStart(4)} gen=${snap.generation} div=${fmt(snap.diversity)} bold=${fmt(snap.geneMean.boldness)} aggr=${fmt(snap.geneMean.aggression)} size=${fmt(snap.bodyMean)}`);
      }
    },
  });
  return sim;
}

function mapVals(obj, f) {
  const out = {};
  for (const k of Object.keys(obj || {})) out[k] = f(obj[k]);
  return out;
}

function driftReport(founder, final) {
  const out = {};
  for (const k of Object.keys(founder || {})) {
    if (final[k] != null) out[k] = +(final[k] - founder[k]).toFixed(3);
  }
  return out;
}

console.log(`=== Colony headless smoke test (seed=${seed}, years=${years}) ===\n`);

console.log('Run A (verbose):');
const a = runOnce(seed, years, { log: true });
const snapA = a.snapshot();

console.log('\nRun B (same seed, for determinism check): silent');
const b = runOnce(seed, years);
const snapB = b.snapshot();

const drift = driftReport(snapA.founderGenes, snapA.geneMean);
console.log('\nFINAL (run A):');
console.log(`  population:   ${snapA.population}`);
console.log(`  generation:   ${snapA.generation}`);
console.log(`  births/deaths:${snapA.totalBorn}/${snapA.totalDied}  stillborn:${snapA.stillborn}`);
console.log(`  diversity:    ${fmt(snapA.diversity)}`);
console.log(`  mean F:       ${fmt(snapA.meanInbreedingF)}`);
console.log(`  gene drift:   ${JSON.stringify(drift)}`);
console.log(`  body drift:   ${snapA.founderGenes ? fmt(snapA.bodyMean - snapA.founderGenes.bodyScale) : '—'}`);
console.log(`  death causes: ${JSON.stringify(snapA.deathCauses)}`);
console.log(`  final event:  ${snapA.activeEvent || 'none'}`);

// Determinism: A and B used the same seed, so every observable must match.
const keysToCompare = ['population', 'generation', 'totalBorn', 'totalDied', 'stillborn'];
let deterministic = true;
for (const k of keysToCompare) {
  if (snapA[k] !== snapB[k]) { deterministic = false; console.log(`  MISMATCH ${k}: A=${snapA[k]} B=${snapB[k]}`); }
}
// also compare a couple of float gene means
for (const t of ['boldness', 'aggression', 'energy']) {
  if (snapA.geneMean[t] !== snapB.geneMean[t]) {
    deterministic = false;
    console.log(`  MISMATCH geneMean.${t}: A=${snapA.geneMean[t]} B=${snapB.geneMean[t]}`);
  }
}

console.log(`\nDeterminism (same seed → identical run): ${deterministic ? 'PASS ✓' : 'FAIL ✗'}`);
process.exit(deterministic ? 0 : 1);
