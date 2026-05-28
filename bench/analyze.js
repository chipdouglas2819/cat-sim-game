// Analyze Colony bench results.
//
// Usage:
//   node bench/analyze.js bench/results/cs04_y25_n50.json
//   node bench/analyze.js bench/results/*.json     (sweep comparison)
//
// Per file: extinction rate, per-trait drift distribution (over surviving
// colonies), death-cause breakdown, final pop + diversity. Across files
// (sweep): a colonyScale → median |drift| table to find where evolution
// becomes visible without being pure noise.
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node bench/analyze.js <results.json> [more.json ...]');
  process.exit(1);
}

const TRAITS = ['boldness', 'sociability', 'playfulness', 'aggression', 'energy', 'appetite', 'bodyScale'];
const datasets = files.map(f => ({ file: f, ...JSON.parse(readFileSync(f, 'utf8')) }));

for (const ds of datasets) {
  reportOne(ds);
}

if (datasets.length > 1) {
  reportSweep(datasets);
}

function reportOne(ds) {
  const { rows, meta, file } = ds;
  const n = rows.length;
  const survivors = rows.filter(r => !r.extinct);
  const extinct = rows.filter(r => r.extinct);

  console.log(`\n${'='.repeat(64)}`);
  console.log(`${file}`);
  console.log(`config: ${n} seeds × ${meta.config.years}yr, colonyScale=${meta.config.colonyScale}, dt=${meta.config.dt} (${meta.durationSec}s)`);
  console.log('-'.repeat(64));
  console.log(`Extinctions: ${extinct.length}/${n} (${pct(extinct.length / n)})`);
  if (extinct.length) {
    const yrs = extinct.map(r => r.extinctYear).filter(Boolean).sort((a, b) => a - b);
    console.log(`  extinction years: median ${median(yrs)}, range ${yrs[0]}–${yrs[yrs.length - 1]}`);
  }

  if (survivors.length) {
    console.log(`\nFinal population (survivors): median ${median(survivors.map(r => r.population))}, ` +
      `range ${Math.min(...survivors.map(r => r.population))}–${Math.max(...survivors.map(r => r.population))}`);
    console.log(`Generation reached: median ${median(survivors.map(r => r.generation))}`);
    console.log(`Diversity (final): median ${fmt(median(survivors.map(r => r.diversity)))}`);
    console.log(`Mean inbreeding F:  median ${fmt(median(survivors.map(r => r.meanInbreedingF).filter(v => v != null)))}`);

    console.log(`\nGene drift across ${survivors.length} surviving colonies (final − founder):`);
    console.log(`  ${'trait'.padEnd(12)} ${'median'.padStart(8)} ${'p25'.padStart(8)} ${'p75'.padStart(8)} ${'|med|'.padStart(8)}  direction`);
    for (const t of TRAITS) {
      const vals = survivors.map(r => r.drift?.[t]).filter(v => v != null);
      if (!vals.length) continue;
      const med = median(vals);
      const absMed = median(vals.map(Math.abs));
      const up = vals.filter(v => v > 0).length;
      const dir = `${up}/${vals.length} up`;
      console.log(`  ${t.padEnd(12)} ${sfmt(med).padStart(8)} ${sfmt(percentile(vals, 25)).padStart(8)} ${sfmt(percentile(vals, 75)).padStart(8)} ${fmt(absMed).padStart(8)}  ${dir}`);
    }
  }

  // Death causes aggregated across all rows
  const deaths = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.deathCauses || {})) deaths[k] = (deaths[k] || 0) + v;
  const totalDeaths = Object.values(deaths).reduce((a, b) => a + b, 0) || 1;
  console.log(`\nDeath causes (all seeds):`);
  for (const [k, v] of Object.entries(deaths).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(7)}  ${pct(v / totalDeaths)}`);
  }
}

function reportSweep(datasets) {
  console.log(`\n${'='.repeat(64)}`);
  console.log('SWEEP: median |drift| vs colonyScale');
  console.log('  (looking for the scale where drift is visible ~0.05-0.15 but not noise)');
  console.log('-'.repeat(64));
  const sorted = [...datasets].sort((a, b) => a.meta.config.colonyScale - b.meta.config.colonyScale);
  const header = `${'scale'.padStart(6)} ${'extinct'.padStart(8)} ${'medPop'.padStart(7)} ` +
    TRAITS.map(t => t.slice(0, 5).padStart(6)).join(' ');
  console.log(header);
  for (const ds of sorted) {
    const survivors = ds.rows.filter(r => !r.extinct);
    const ext = ds.rows.filter(r => r.extinct).length;
    const cells = TRAITS.map(t => {
      const vals = survivors.map(r => r.drift?.[t]).filter(v => v != null).map(Math.abs);
      return vals.length ? fmt(median(vals)).padStart(6) : '   —  ';
    });
    const medPop = survivors.length ? median(survivors.map(r => r.population)) : 0;
    console.log(`${String(ds.meta.config.colonyScale).padStart(6)} ${pct(ext / ds.rows.length).padStart(8)} ${String(medPop).padStart(7)} ${cells.join(' ')}`);
  }
}

// ── stats helpers ──
function median(a) { return percentile(a, 50); }
function percentile(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
function fmt(v) { return v == null ? '—' : v.toFixed(3); }
function sfmt(v) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(3); }
function pct(x) { return (100 * x).toFixed(0) + '%'; }
