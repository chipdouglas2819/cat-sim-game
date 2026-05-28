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

// Lighten a #rrggbb hex color toward white by `amt` (0-1). Returns hex.
// Used by createCat (smoke trait modifies coat hex) and render code.
export function lightenHex(hex, amt) {
  if (!hex || !hex.startsWith('#')) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const nr = Math.floor(r + (255 - r) * amt);
  const ng = Math.floor(g + (255 - g) * amt);
  const nb = Math.floor(b + (255 - b) * amt);
  return '#' + [nr, ng, nb].map(v => v.toString(16).padStart(2, '0')).join('');
}

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
