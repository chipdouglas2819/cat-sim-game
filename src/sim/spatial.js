import { dist } from './util.js';

// Spatial index built once per tick. Queries only inspect cells within range
// instead of every cat. Critical for performance at high pop.
export const SPATIAL_CELL = 100;  // cell size in logical px

// Rebuild sim.spatialGrid + sim.catById from the current sim.cats array.
// Call once at the top of each tick before any neighbor queries.
export function rebuildSpatialIndex(sim) {
  sim.spatialGrid.clear();
  sim.catById.clear();
  for (const c of sim.cats) {
    sim.catById.set(c.id, c);
    if (c.dying) continue;
    const cx = Math.floor(c.x / SPATIAL_CELL);
    const cy = Math.floor(c.y / SPATIAL_CELL);
    const key = cx + ',' + cy;
    let bucket = sim.spatialGrid.get(key);
    if (!bucket) { bucket = []; sim.spatialGrid.set(key, bucket); }
    bucket.push(c);
  }
}

// Iterate cats whose grid cells overlap a circle of radius r around (x, y).
// callback(cat) — return true to short-circuit (early exit).
export function forCatsNear(sim, x, y, r, callback) {
  const reach = Math.ceil(r / SPATIAL_CELL);
  const cx = Math.floor(x / SPATIAL_CELL);
  const cy = Math.floor(y / SPATIAL_CELL);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const bucket = sim.spatialGrid.get((cx + dx) + ',' + (cy + dy));
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        if (callback(bucket[i])) return;
      }
    }
  }
}

export function findNearest(sim, cat, predicate, maxDist = Infinity) {
  let best = null, bestD = maxDist;
  if (maxDist === Infinity || maxDist > Math.max(sim.arenaW, sim.arenaH)) {
    // Unbounded — fall back to full sweep (rare)
    for (const c of sim.cats) {
      if (c === cat || c.dying) continue;
      if (!predicate(c)) continue;
      const d = dist(cat, c);
      if (d < bestD) { best = c; bestD = d; }
    }
  } else {
    // Bounded — use spatial grid (fast path for the common case)
    forCatsNear(sim, cat.x, cat.y, maxDist, (c) => {
      if (c === cat || c.dying) return false;
      if (!predicate(c)) return false;
      const d = dist(cat, c);
      if (d < bestD) { best = c; bestD = d; }
      return false;
    });
  }
  return { target: best, d: bestD };
}

export function findNearestFood(sim, cat) {
  let best = null, bestD = Infinity, bestIdx = -1;
  for (let i = 0; i < sim.food.length; i++) {
    const f = sim.food[i];
    const d = Math.hypot(cat.x - f.x, cat.y - f.y);
    if (d < bestD) { best = f; bestD = d; bestIdx = i; }
  }
  return { target: best, d: bestD, idx: bestIdx };
}

// Count cats within 90px of `cat` (excluding self and dying cats).
export function localDensity(sim, cat) {
  let n = 0;
  forCatsNear(sim, cat.x, cat.y, 90, (c) => {
    if (c === cat || c.dying) return false;
    if (dist(cat, c) < 90) n++;
    return false;
  });
  return n;
}
