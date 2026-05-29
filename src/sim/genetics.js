import { MUTATION_RATE, ALLELE_POOLS } from './constants.js';
import { rand, pick, gauss, clamp } from './util.js';

// Roll a founder cat's full gene set. `sex` is 'M' or 'F'.
export function rollGenes(sex) {
  // Visible — sample alleles with frequency biases for variety
  const g = {
    B: [rand() < 0.7 ? 'B' : 'b', rand() < 0.7 ? 'B' : 'b'],
    D: [rand() < 0.7 ? 'D' : 'd', rand() < 0.7 ? 'D' : 'd'],
    A: [rand() < 0.65 ? 'A' : 'a', rand() < 0.65 ? 'A' : 'a'],
    T: [pick(ALLELE_POOLS.T), pick(ALLELE_POOLS.T)],
    S: [rand() < 0.4 ? 'S' : 's', rand() < 0.4 ? 'S' : 's'],
    L: [rand() < 0.78 ? 'L' : 'l', rand() < 0.78 ? 'L' : 'l'],
    W: [rand() < 0.05 ? 'W' : 'w', rand() < 0.05 ? 'W' : 'w'],
    C: [rand() < 0.12 ? 'cs' : 'C', rand() < 0.12 ? 'cs' : 'C'],   // colorpoint recessive (q≈0.12 → ~1.5-2% pointed)
    O: sex === 'M'
      ? [rand() < 0.3 ? 'O' : 'o']
      : [rand() < 0.3 ? 'O' : 'o', rand() < 0.3 ? 'O' : 'o'],
    // Wider variance on founders — extreme starting pairs lead to different colonies (founder effect)
    boldness: clamp(0.5 + gauss() * 0.30, 0.05, 0.95),
    sociability: clamp(0.5 + gauss() * 0.28, 0.05, 0.95),
    playfulness: clamp(0.5 + gauss() * 0.28, 0.05, 0.95),
    aggression: clamp(0.4 + gauss() * 0.25, 0.02, 0.95),
    energy: clamp(0.55 + gauss() * 0.25, 0.10, 0.95),
    appetite: clamp(0.5 + gauss() * 0.25, 0.15, 0.95),
    size: clamp(0.5 + gauss() * 0.22, 0.05, 0.95),   // heritable body size gene
  };
  return g;
}

// Inherit a kitten's gene set from mom + dad. `kittenSex` is 'M' or 'F' (drives X-linked O allele).
export function inheritGenes(mom, dad, kittenSex) {
  const mg = mom.genes, dg = dad.genes;
  const pickAllele = (alleles) => pick(alleles);
  const maybeMutate = (allele, pool) => {
    if (rand() < MUTATION_RATE) return pick(pool);
    return allele;
  };
  const g = {
    B: [maybeMutate(pickAllele(mg.B), ALLELE_POOLS.B), maybeMutate(pickAllele(dg.B), ALLELE_POOLS.B)],
    D: [maybeMutate(pickAllele(mg.D), ALLELE_POOLS.D), maybeMutate(pickAllele(dg.D), ALLELE_POOLS.D)],
    A: [maybeMutate(pickAllele(mg.A), ALLELE_POOLS.A), maybeMutate(pickAllele(dg.A), ALLELE_POOLS.A)],
    T: [maybeMutate(pickAllele(mg.T), ALLELE_POOLS.T), maybeMutate(pickAllele(dg.T), ALLELE_POOLS.T)],
    S: [maybeMutate(pickAllele(mg.S), ALLELE_POOLS.S), maybeMutate(pickAllele(dg.S), ALLELE_POOLS.S)],
    L: [maybeMutate(pickAllele(mg.L), ALLELE_POOLS.L), maybeMutate(pickAllele(dg.L), ALLELE_POOLS.L)],
    W: [maybeMutate(pickAllele(mg.W), ALLELE_POOLS.W), maybeMutate(pickAllele(dg.W), ALLELE_POOLS.W)],
    C: [maybeMutate(pickAllele(mg.C || ['C','C']), ALLELE_POOLS.C), maybeMutate(pickAllele(dg.C || ['C','C']), ALLELE_POOLS.C)],
  };
  // O is X-linked. Mom contributes one of her two Os; dad's contribution depends on kitten sex.
  // Female kitten gets X from mom + X from dad → 2 alleles.
  // Male kitten gets X from mom + Y from dad → 1 allele.
  if (kittenSex === 'F') {
    g.O = [maybeMutate(pickAllele(mg.O), ['O', 'o']), maybeMutate(dg.O[0] === 'O' ? 'O' : 'o', ['O', 'o'])];
  } else {
    g.O = [maybeMutate(pickAllele(mg.O), ['O', 'o'])];
  }
  // Behavioral — midparent + drift. σ raised 0.025→0.045 so kittens vary more
  // visibly from their parents (each litter has a real spread of personalities),
  // while still heritable enough that selection compounds over generations.
  const blend = (k) => clamp(((mg[k] + dg[k]) / 2) + gauss() * 0.045, 0.02, 0.98);
  g.boldness = blend('boldness');
  g.sociability = blend('sociability');
  g.playfulness = blend('playfulness');
  g.aggression = blend('aggression');
  g.energy = blend('energy');
  g.appetite = blend('appetite');
  g.size = blend('size');
  // "SPORT" kittens (~9%): one or two traits take a larger jump from the
  // midparent — a noticeably different personality in the litter (not a freak,
  // just an outlier). This keeps real variation in the population to see + select
  // on, instead of everyone converging to the colony mean.
  if (rand() < 0.09) {
    const keys = ['boldness', 'sociability', 'playfulness', 'aggression', 'energy', 'appetite', 'size'];
    const nJump = rand() < 0.35 ? 2 : 1;
    for (let j = 0; j < nJump; j++) {
      const k = pick(keys);
      g[k] = clamp(g[k] + gauss() * 0.18, 0.02, 0.98);
    }
    g._sport = true;   // flag for a possible visual cue
  }
  return g;
}

// Realistic iris color. No cat has black eyes; warm gold/copper/green/amber are
// common, blue is special-cased to white/colorpoint cats only. Returns a hex.
export function deriveEyeColor(genes, ph) {
  // Colorpoint cats always have blue eyes
  if (ph.pointed) return '#9ccbe0';
  // White / high-white cats: ~30% blue, else warm
  const veryWhite = ph.baseColor === 'white' || (ph.whiteAmount != null && ph.whiteAmount >= 0.8);
  if (veryWhite && rand() < 0.30) return '#bcdcee';
  // Warm gradient by a hidden melanin roll. Orange/red coats bias coppery.
  const orange = ph.orangeMode === 'full' || ph.baseColor === 'red' || ph.baseColor === 'cream';
  let r = rand();
  if (orange) r = r * 0.6 + 0.4;   // skew toward gold/copper end
  if (r < 0.30) return '#5fa45a';  // green
  if (r < 0.55) return '#d39b2c';  // amber/yellow
  if (r < 0.80) return '#7a4a1e';  // gold/copper
  if (r < 0.95) return '#9fae5a';  // hazel
  return '#e8d24a';                // pale yellow
}

// Display name for a tabby pattern allele.
export function patternName(p) {
  return { Mc: 'mackerel tabby', Cs: 'classic tabby', Sp: 'spotted tabby', Tk: 'ticked tabby', solid: 'solid' }[p] || '';
}

// Translate a gene set into the visible phenotype (color, pattern, white spotting, hair length).
export function calculatePhenotype(genes, sex) {
  // Dominant white masks everything else
  const hasW = genes.W.includes('W');
  if (hasW) return {
    baseColor: 'white', baseHex: '#f0e9d2',
    pattern: 'solid', whiteAmount: 1, longHair: genes.L.every(a => a === 'l'),
    description: 'all white'
  };

  // Orange expression (X-linked)
  let orangeMode;
  if (sex === 'M') {
    orangeMode = genes.O[0] === 'O' ? 'full' : 'none';
  } else {
    const oCount = genes.O.filter(a => a === 'O').length;
    orangeMode = oCount === 2 ? 'full' : oCount === 1 ? 'tortie' : 'none';
  }

  // Non-orange base
  const hasB = genes.B.includes('B');
  const isDilute = genes.D.every(a => a === 'd');
  let nonOrangeName, nonOrangeHex;
  if (hasB) {
    if (isDilute) { nonOrangeName = 'blue'; nonOrangeHex = '#7a7e80'; }
    else { nonOrangeName = 'black'; nonOrangeHex = '#2e2c28'; }
  } else {
    if (isDilute) { nonOrangeName = 'lilac'; nonOrangeHex = '#b6a89a'; }
    else { nonOrangeName = 'chocolate'; nonOrangeHex = '#5b3f30'; }
  }
  const orangeHex = isDilute ? '#e8c887' : '#c7733a';
  const orangeName = isDilute ? 'cream' : 'red';

  // Deterministic per-cat jitter (stable across re-renders — derived from fixed
  // gene values, NOT rand(), so the same cat always looks the same).
  const jraw = (genes.size ?? 0.5) * 31.7 + (genes.boldness ?? 0.5) * 17.3 + (genes.appetite ?? 0.5) * 11.1;
  const jit = jraw - Math.floor(jraw);   // 0..1

  // GRADED WHITE SPOTTING — continuous locket→tuxedo→bicolor→van instead of 3 bins.
  const sCount = genes.S.filter(a => a === 'S').length;
  let whiteAmount;
  if (sCount === 0) whiteAmount = jit < 0.15 ? 0.05 : 0;       // occasional throat locket
  else if (sCount === 1) whiteAmount = 0.15 + jit * 0.20;      // 0.15-0.35 tuxedo/bib
  else whiteAmount = 0.45 + jit * 0.40;                        // 0.45-0.85 bicolor→van

  // Determine display name + hex
  let baseColor, baseHex, description;
  if (orangeMode === 'full') {
    baseColor = orangeName;
    baseHex = orangeHex;
  } else if (orangeMode === 'tortie') {
    baseColor = whiteAmount > 0.1 ? 'calico' : 'tortie';
    baseHex = nonOrangeHex; // primary
  } else {
    baseColor = nonOrangeName;
    baseHex = nonOrangeHex;
  }

  // Pattern: agouti shows tabby; orange always shows pattern (regardless of A)
  const showsPattern = genes.A.includes('A') || orangeMode === 'full' || orangeMode === 'tortie';
  let pattern = 'solid';
  if (showsPattern) {
    // Take first allele as expressed (simple)
    pattern = genes.T[0];
  }

  const longHair = genes.L.every(a => a === 'l');

  // COLORPOINT (Siamese) — recessive cs/cs: pale body, dark extremities, blue eyes.
  // The would-be coat color becomes the point color; body goes pale cream.
  let pointed = false, pointHex = null;
  if (genes.C && genes.C.every(a => a === 'cs')) {
    pointed = true;
    pointHex = baseHex;
    baseHex = '#efe7da';
    baseColor = 'colorpoint';
    pattern = 'solid';
  }

  description = pointed
    ? `colorpoint${longHair ? ', longhair' : ''}`
    : `${pattern === 'solid' ? '' : patternName(pattern) + ' '}${baseColor}${whiteAmount > 0.1 ? ' & white' : ''}${longHair ? ', longhair' : ''}`.trim();

  return {
    baseColor, baseHex, pattern, whiteAmount, longHair,
    orangeMode, orangeHex, nonOrangeHex,
    pointed, pointHex,
    description
  };
}

// Gene-summary tags for the setup card.
export function genesToTags(genes, sex, ph) {
  const tags = [];
  tags.push(ph.description);
  if (genes.boldness > 0.7) tags.push('bold');
  else if (genes.boldness < 0.3) tags.push('timid');
  if (genes.sociability > 0.7) tags.push('social');
  else if (genes.sociability < 0.3) tags.push('aloof');
  if (genes.aggression > 0.6) tags.push('aggressive');
  if (genes.playfulness > 0.7) tags.push('playful');
  if (genes.energy > 0.75) tags.push('high-energy');
  if (genes.energy < 0.3) tags.push('mellow');
  return tags;
}
