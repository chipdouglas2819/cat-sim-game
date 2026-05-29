// Comprehensive analysis of a big run.js sweep.
// Usage: node bench/fullreport.js bench/results/big.json
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node bench/fullreport.js <results.json>'); process.exit(1); }
const { meta, rows } = JSON.parse(readFileSync(file, 'utf8'));
const TRAITS = ['boldness', 'sociability', 'playfulness', 'aggression', 'energy', 'appetite', 'bodyScale'];
const N = rows.length;
const surv = rows.filter(r => !r.extinct);
const ext = rows.filter(r => r.extinct);

const line = (n = 70) => '─'.repeat(n);
const med = a => pctile(a, 50);
function pctile(a, p) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = (p / 100) * (s.length - 1); const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); }
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const f = (v, d = 2) => v == null ? '—' : v.toFixed(d);
const sf = (v, d = 3) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d);
const pct = x => (100 * x).toFixed(0) + '%';

console.log('\n' + '═'.repeat(70));
console.log(`COLONY FULL ANALYSIS — ${N} seeds × ${meta.config.years}yr, colonyScale=${meta.config.colonyScale}, dt=${meta.config.dt}`);
console.log(`(${meta.durationSec}s of simulation)`);
console.log('═'.repeat(70));

// ── 1. SURVIVAL ──
console.log('\n■ SURVIVAL');
console.log(line());
console.log(`  Colonies surviving to year ${meta.config.years}: ${surv.length}/${N}  (${pct(surv.length / N)})`);
if (ext.length) {
  const ey = ext.map(r => r.extinctYear).filter(Boolean);
  console.log(`  Extinctions: ${ext.length}  — died at year: min ${Math.min(...ey)}, median ${f(med(ey), 0)}, max ${Math.max(...ey)}`);
  const early = ey.filter(y => y <= 5).length, mid = ey.filter(y => y > 5 && y <= 25).length, late = ey.filter(y => y > 25).length;
  console.log(`    founding (≤y5): ${early}   establishing (y6-25): ${mid}   mature (>y25): ${late}`);
}

// ── 2. POPULATION ──
console.log('\n■ POPULATION (surviving colonies)');
console.log(line());
const finals = surv.map(r => r.population), peaks = surv.map(r => r.peakPop);
console.log(`  Final size:  min ${Math.min(...finals)}, p25 ${f(pctile(finals, 25), 0)}, median ${f(med(finals), 0)}, p75 ${f(pctile(finals, 75), 0)}, max ${Math.max(...finals)}`);
console.log(`  Peak size:   median ${f(med(peaks), 0)}, max ${Math.max(...peaks)}`);
console.log(`  Generations reached: median ${f(med(surv.map(r => r.generation)), 0)}, max ${Math.max(...surv.map(r => r.generation))}`);

// ── 3. LIFE & DEATH ──
console.log('\n■ LIFE & DEATH');
console.log(line());
const lifespans = rows.map(r => r.meanLifespan).filter(v => v != null);
console.log(`  Mean cat lifespan: ${f(med(lifespans), 0)} weeks (≈ ${f(med(lifespans) / 52, 1)} years)`);
console.log(`  Births/colony: median ${f(med(surv.map(r => r.totalBorn)), 0)};  Deaths/colony: median ${f(med(surv.map(r => r.totalDied)), 0)}`);
const deaths = {};
for (const r of rows) for (const [k, v] of Object.entries(r.deathCauses || {})) deaths[k] = (deaths[k] || 0) + v;
const td = Object.values(deaths).reduce((a, b) => a + b, 0) || 1;
console.log('  Cause of death (all colonies):');
for (const [k, v] of Object.entries(deaths).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(14)} ${pct(v / td).padStart(4)}`);

// ── 4. DIVERSITY / INBREEDING ──
console.log('\n■ DIVERSITY & INBREEDING (surviving colonies)');
console.log(line());
console.log(`  Genetic diversity (final): median ${f(med(surv.map(r => r.diversity)), 3)}`);
console.log(`  Inbreeding F (final):      median ${f(med(surv.map(r => r.meanInbreedingF).filter(v => v != null)), 3)}`);

// ── 5. TRAIT EVOLUTION — can each go both ways? ──
console.log('\n■ TRAIT EVOLUTION across colonies (drift = final − founder)');
console.log(line());
console.log('  Under random weather, do colonies drift each trait BOTH up and down?');
console.log(`  ${'trait'.padEnd(12)} ${'min'.padStart(7)} ${'p25'.padStart(7)} ${'med'.padStart(7)} ${'p75'.padStart(7)} ${'max'.padStart(7)}  ${'%up'.padStart(4)}  balance`);
for (const t of TRAITS) {
  const ds = surv.map(r => r.drift?.[t]).filter(v => v != null);
  if (!ds.length) continue;
  const up = ds.filter(v => v > 0.01).length, dn = ds.filter(v => v < -0.01).length;
  const upPct = up / ds.length;
  const range = Math.max(...ds) - Math.min(...ds);
  // "both ways" = a meaningful fraction goes each direction AND the spread is real
  const both = up >= ds.length * 0.2 && dn >= ds.length * 0.2 && range > 0.05;
  const verdict = both ? 'BOTH WAYS ✓' : upPct > 0.8 ? 'mostly UP' : upPct < 0.2 ? 'mostly DOWN' : 'narrow';
  console.log(`  ${t.padEnd(12)} ${sf(Math.min(...ds)).padStart(7)} ${sf(pctile(ds, 25)).padStart(7)} ${sf(med(ds)).padStart(7)} ${sf(pctile(ds, 75)).padStart(7)} ${sf(Math.max(...ds)).padStart(7)}  ${pct(upPct).padStart(4)}  ${verdict}`);
}

// ── 6. ENVIRONMENT → TRAIT correlation (do trade-offs work under natural weather?) ──
console.log('\n■ ENVIRONMENT → TRAIT (do the trade-offs steer evolution?)');
console.log(line());
console.log('  Compare trait drift in colonies with HIGH vs LOW exposure to each event.');
const events = ['predator', 'drought', 'harshWinter', 'epidemic', 'plentiful'];
for (const ev of events) {
  const withExp = surv.map(r => ({ exp: (r.eventExposure?.[ev] || 0), drift: r.drift })).filter(x => x.drift);
  if (withExp.length < 6) continue;
  const sorted = [...withExp].sort((a, b) => b.exp - a.exp);
  const hi = sorted.slice(0, Math.ceil(sorted.length / 3));     // top third exposure
  const lo = sorted.slice(-Math.ceil(sorted.length / 3));       // bottom third
  const diffs = TRAITS.map(t => {
    const h = med(hi.map(x => x.drift[t]).filter(v => v != null));
    const l = med(lo.map(x => x.drift[t]).filter(v => v != null));
    return { t, d: (h != null && l != null) ? h - l : null };
  }).filter(x => x.d != null && Math.abs(x.d) > 0.012).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const summary = diffs.slice(0, 3).map(x => `${x.t} ${sf(x.d)}`).join(', ') || '(no strong effect)';
  console.log(`  ${ev.padEnd(12)} high-exposure colonies drift: ${summary}`);
}

console.log('\n' + '═'.repeat(70));
console.log('Reading: "%up" near 50% with a wide min↔max range = trait freely evolves');
console.log('either direction. Environment section shows which traits each event pushes.');
console.log('═'.repeat(70) + '\n');
