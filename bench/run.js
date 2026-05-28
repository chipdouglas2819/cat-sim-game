// Headless batch runner for the Colony simulation.
//
// Usage:
//   node bench/run.js --seeds=50 --years=25 --colonyScale=0.4 --out=bench/results/cs04.json
//   node bench/run.js --seeds=100 --years=30 --colonyScale=1 --dt=0.1
//
// Runs `seeds` colonies (seed = base + i) at one config, capturing per-seed
// founder genes, a yearly trajectory, the final snapshot, and extinction info.
// One config per invocation — sweep colonyScale by calling it several times.
//
// Important: runs are sequential. The RNG is a process-global swapped by the
// Simulation constructor (setRandomSource), so a run must finish before the
// next seed is constructed. This loop does that.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Simulation } from '../src/sim/simulation.js';

const args = parseArgs(process.argv.slice(2));
const seeds = num(args.seeds, 50);
const years = num(args.years, 25);
const colonyScale = num(args.colonyScale, 0.4);
const dt = num(args.dt, 0.1);                 // see project_dt_sensitivity: keep fixed
const baseSeed = num(args.baseSeed, 1000);
const out = args.out || `bench/results/cs${String(colonyScale).replace('.', '')}_y${years}_n${seeds}.json`;

const TRAITS = ['boldness', 'sociability', 'playfulness', 'aggression', 'energy', 'appetite'];

console.log(`Colony bench: ${seeds} seeds × ${years}yr, colonyScale=${colonyScale}, dt=${dt}`);
const t0 = Date.now();
const rows = [];

for (let i = 0; i < seeds; i++) {
  const seed = baseSeed + i;
  const sim = new Simulation({ seed, colonyScale });
  sim.seedFounders();   // founders rolled from the seeded RNG

  const trajectory = [];
  sim.runYears(years, {
    dt,
    onYear: (s) => {
      const snap = s.snapshot();
      trajectory.push({
        year: snap.year,
        pop: snap.population,
        diversity: round(snap.diversity),
        geneMean: roundObj(snap.geneMean),
        bodyMean: round(snap.bodyMean),
      });
    },
  });

  const final = sim.snapshot();
  const extinct = final.population <= 1;
  rows.push({
    seed,
    extinct,
    extinctYear: extinct ? final.year : null,
    founderGenes: roundObj(final.founderGenes),
    finalGeneMean: roundObj(final.geneMean),
    finalGeneStd: roundObj(final.geneStd),
    finalBodyMean: round(final.bodyMean),
    drift: driftOf(final.founderGenes, final.geneMean, final.bodyMean),
    population: final.population,
    generation: final.generation,
    totalBorn: final.totalBorn,
    totalDied: final.totalDied,
    stillborn: final.stillborn,
    meanInbreedingF: round(final.meanInbreedingF),
    diversity: round(final.diversity),
    deathCauses: final.deathCauses,
    trajectory,
  });

  if ((i + 1) % 10 === 0 || i === seeds - 1) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`  ${i + 1}/${seeds} done (${elapsed}s)\r`);
  }
}

const meta = {
  config: { seeds, years, colonyScale, dt, baseSeed },
  generatedAt: new Date().toISOString(),
  durationSec: +((Date.now() - t0) / 1000).toFixed(1),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ meta, rows }, null, 2));
console.log(`\nWrote ${rows.length} rows to ${out} in ${meta.durationSec}s`);
const extinctions = rows.filter(r => r.extinct).length;
console.log(`Extinctions: ${extinctions}/${seeds} (${(100 * extinctions / seeds).toFixed(0)}%)`);

// ── helpers ──
function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}
function num(v, d) { return v === undefined ? d : Number(v); }
function round(v) { return v == null ? null : +v.toFixed(4); }
function roundObj(obj) {
  if (!obj) return null;
  const o = {};
  for (const k of Object.keys(obj)) o[k] = round(obj[k]);
  return o;
}
function driftOf(founder, finalMean, finalBody) {
  if (!founder) return null;
  const d = {};
  for (const t of TRAITS) if (finalMean[t] != null) d[t] = round(finalMean[t] - founder[t]);
  if (finalBody != null && founder.bodyScale != null) d.bodyScale = round(finalBody - founder.bodyScale);
  return d;
}
