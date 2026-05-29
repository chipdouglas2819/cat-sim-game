// ─── TIME / LIFE-CYCLE ────────────────────────────────────────
export const SIM_DAY_REAL_SEC = 4;          // 1 sim-day = 4 real seconds at 1x
export const KITTEN_DAYS = 15;
export const JUVENILE_DAYS = 30;
export const ADULT_END = 300;
export const SENIOR_END = 400;               // base lifespan

// ─── REPRODUCTION ─────────────────────────────────────────────
export const PREGNANCY_DAYS = 9;             // ~real cat ~9 weeks
export const BREED_COOLDOWN = 6;             // post-birth cooldown (lets females have 2 litters/season)
export const ESTRUS_CYCLE_WEEKS = 8;
export const ESTRUS_DURATION = 4;            // weeks per cycle receptive
export const MUTATION_RATE = 0.02;

// ─── FOOD / FORAGING ──────────────────────────────────────────
export const FOOD_LIFETIME = 80;             // sim-days a morsel persists
export const FEED_SPOTS_COUNT = 3;
export const FOOD_SPAWN_INTERVAL = 0.4;
export const FOOD_PER_CAT = 0.55;            // morsels per cat we aim to keep on the ground
export const FOOD_TARGET_MIN = 4;
export const FOOD_BURST_MAX = 4;
export const FOOD_RANDOM_CHANCE = 0.35;
export const FOOD_SPOT_JITTER = 80;

// ─── POPULATION ───────────────────────────────────────────────
// Soft carrying capacity — populations self-regulate via stress.
// Hard ceiling kept as a safety valve only (never hit in normal runs).
export const POP_SOFT_TARGET_BASE = 25;
export const POP_HARD_CEILING = 80;

// ─── NAMES ────────────────────────────────────────────────────
export const NAME_POOL = [
  'Whiskers','Mittens','Tabitha','Pippa','Marlow','Juno','Sable','Wren',
  'Cinder','Olive','Mochi','Bramble','Pebble','Pumpkin','Slate','Linden',
  'Clover','Soot','Apricot','Hazel','Felix','Dorian','Magnolia','Birch',
  'Cricket','Pip','Atlas','Bean','Fig','Saffron','Cosmo','Nettle','Reed',
  'Thistle','Daphne','Iris','Otis','Pearl','Quince','Rye','Sorrel','Tansy',
  'Acorn','Almond','Amber','Arrow','Ash','Aspen','Aster','Autumn','Basil',
  'Bay','Beech','Biscuit','Blossom','Boots','Briar','Brindle','Brook',
  'Buttons','Caramel','Cedar','Chestnut','Chip','Cocoa','Coffee','Crumpet',
  'Daisy','Dandelion','Dottie','Drift','Echo','Ember','Fennel','Fern',
  'Finch','Flax','Fleck','Flora','Frost','Ginger','Goose','Hawthorn',
  'Honey','Indigo','Ivy','Jasper','Juniper','Kettle','Lark','Laurel',
  'Lavender','Lichen','Lily','Loam','Loon','Lupin','Maple','Marigold',
  'Marrow','Marsh','Meadow','Milkweed','Minnow','Mist','Moss','Muffin',
  'Mulberry','Nimbus','Nutmeg','Oak','Onyx','Opal','Orchard','Otter',
  'Patches','Peach','Penny','Pickle','Pine','Pinto','Plover','Plum',
  'Poppy','Posy','Primrose','Quill','Rain','Raven','Rose','Rowan',
  'Rust','Sage','Scout','Seed','Shadow','Shale','Smoke','Smudge',
  'Sparrow','Stitch','Sweetpea','Sycamore','Tarragon','Teal','Thatch',
  'Tilly','Toffee','Truffle','Vesper','Violet','Walnut','Whimsy',
  'Willow','Winter','Wisp','Wisteria','Yarrow','Yew','Zephyr','Mango',
  'Mable','Lulu','Cleo','Suki','Tofu','Yuki','Suki','Pip','Bingo',
  'Beanie','Tucker','Milo','Theo','Oscar','Rusty','Charlie','Bruno'
];

// ─── GENETICS ─────────────────────────────────────────────────
// Visible gene alleles (ordered for dominance where applicable)
export const ALLELE_POOLS = {
  B: ['B','b'],                       // black > brown
  D: ['D','d'],                       // dense > dilute
  A: ['A','a'],                       // agouti > solid
  T: ['Mc','Cs','Sp','Tk'],           // tabby pattern (random pick, codom in inheritance)
  S: ['S','s'],                       // white spotting (codominant)
  L: ['L','l'],                       // short > long
  W: ['W','w'],                       // white > non-white (W rare)
  C: ['C','cs']                       // full color > colorpoint (cs recessive — Siamese pattern + blue eyes)
};
