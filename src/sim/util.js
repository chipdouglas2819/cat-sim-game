// Random source — Math.random by default. Bench harness calls setRandomSource(mulberry32(seed))
// to get reproducible runs. The web game leaves it default.
let _random = Math.random;

export function setRandomSource(fn) { _random = fn; }
export function getRandomSource() { return _random; }

export const rand = (a = 1, b) => b === undefined ? _random() * a : a + _random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = arr => arr[Math.floor(_random() * arr.length)];
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const dist = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); };

// Box-Muller normal sample
export const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = _random();
  while (v === 0) v = _random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// Seeded PRNG (mulberry32) — pass the result to setRandomSource() for reproducible runs.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
