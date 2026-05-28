import { clamp } from './util.js';

// Genetic diversity index — combines visible-gene heterozygosity with behavioral
// gene spread. The behavioral component matters because that's what the player
// watches evolve.
//
// Returns 0..1: 0 = clones, 1 = maximally diverse.
export function computeDiversity(sim) {
  const live = sim.cats.filter(c => !c.dying);
  if (live.length === 0) return 0;

  // Visible heterozygosity over six diploid coat genes.
  let hetSum = 0;
  for (const c of live) {
    let het = 0;
    const n = 6;
    for (const k of ['B', 'D', 'A', 'S', 'L', 'W']) {
      if (c.genes[k][0] !== c.genes[k][1]) het++;
    }
    hetSum += het / n;
  }
  const visibleHet = hetSum / live.length;

  // Behavioral spread: mean of per-trait standard deviations
  // (0 = clones, higher = diverse).
  const traits = ['boldness', 'sociability', 'playfulness', 'aggression', 'energy', 'appetite', 'size'];
  let spreadSum = 0;
  for (const t of traits) {
    let mean = 0;
    for (const c of live) mean += c.genes[t];
    mean /= live.length;
    let varSum = 0;
    for (const c of live) { const d = c.genes[t] - mean; varSum += d * d; }
    spreadSum += Math.sqrt(varSum / live.length);
  }
  const behavioralSpread = spreadSum / traits.length;   // ~0 to ~0.3

  // Blend visible + behavioral into a single 0..1 index (behavioral scaled
  // to comparable range).
  return clamp(visibleHet * 0.5 + (behavioralSpread / 0.3) * 0.5, 0, 1);
}
