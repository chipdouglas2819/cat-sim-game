# Colony — Roadmap

This file captures three threads we've discussed but haven't finished planning. Each is a separate
piece of work, not something to bolt onto the current sim file.

---

## 1. Headless test harness (validating evolution actually works)

**The problem:** running long visual sims is slow, and outliers/blind spots in selection only show
up after hours of simulating. We need to batch-run hundreds of headless seeds to see what's actually
happening to gene drift across populations.

**Move target:** Claude Code, as a sibling Node.js script that imports the simulation logic.

**Refactor needed first:** the current `colony.html` mixes simulation logic with rendering, DOM, and
event listeners. Step one is extracting all pure simulation code (gene rolling, inheritance, update
loops, selection pressure functions, environmental events) into a `colonySim.js` module that has no
DOM dependencies. Then both the HTML file and the headless runner import from it.

**Headless runner shape:**
```
node bench.js --seeds=200 --years=40 --workers=8
```
Each worker simulates one seed end-to-end (no rendering), captures:
- Founder gene means
- Per-year gene means
- Final colony composition
- Cause of death distribution
- Event sequence that occurred
- Population trajectory

Outputs go to CSV / JSON. Then a separate analysis script answers questions like:

- "Across 200 random seeds, what's the median drift on each trait?"
- "Do colonies that hit 3+ harsh winters consistently drift toward higher energy?"
- "What's the longest stable trait spread before population homogenizes?"
- "Are there seeds where the colony dies out, and what's the cause?"

**Why this matters:** every iteration on selection pressure right now is gambling. We change a
multiplier, run one 40-year sim by hand, and read the end screen. With a harness, we'd see the
effect across 200 runs in under a minute and know whether a tuning change actually nudged the
distribution or just got lost in noise.

**Difficulty:** the refactor is moderate (~2-4 hours), the runner itself is easy after that. Worth
doing before any more major balance changes.

---

## 2. Plague-style: Genetic conquest

A spinoff where the cats are the player's "weapon" instead of subjects of study.

**Core loop:**
- Player picks a starting trait emphasis for their founder pair
- Cats breed and spread across a world map (regions, climates, biomes)
- Player unlocks/picks mutations as the colony grows — each mutation is a chance card with a cost
- Goal: every region "fallen" (population threshold met)
- Resistance comes from humans, dogs, other predators, regional difficulty
- Each region has its own selection environment that pushes the lineage's genes

**What's different from the current sim:**
- Map screen instead of single arena
- "Mutation" picker between regions — discrete unlocks rather than emergent drift
- Win/lose condition
- Probably much faster pacing (each region resolves in 2-5 minutes)
- Cats don't need detailed individual rendering — abstracted to a region-level statistic

**What's similar:**
- Gene model could carry over
- Some environmental pressures could be reused (predator, drought, etc.) as regional flavors

**Status:** idea-level. Would be a separate file/project. Best to finish the current sim's
evolution feeling right before forking.

---

## 3. Cozy cat breeding sim

The opposite direction — slow, decorative, progression-driven.

**Core loop:**
- Player has a fenced area (the "pen")
- Buys upgrades: feeding bowls, water troughs, beds, scratching posts, sleeping shelves, sun spots
- Each upgrade increases pen capacity OR cat happiness OR breeding chance OR food regen
- Buys cats from a market, breeds them, sells offspring
- Rare phenotypes (calico, longhair, smoke, odd-eyed) sell for more
- Expand outward — multiple pens, outdoor area, eventually a whole estate
- Time-based passive income; speed boosts as a purchasable upgrade
- Maybe seasonal challenges or limited-time visitors that want specific phenotypes

**Tone:** A Little Garden / Stardew / Neko Atsume. Music, soft particles, accomplishment chimes.
The opposite of the current sim's "selection is brutal" feel.

**What's different from the current sim:**
- Player has goals and money
- Cats are objects, not subjects (no need for evolution depth)
- Visual polish becomes very important
- Probably tile/grid based pen layout
- Save state matters — long-term progression
- UI shifts toward management/shop screens

**What's similar:**
- Coat genetics could be lifted entirely — calicos, torties, longhair, all the patterns
- Cat rendering could be reused
- Inheritance Mendelian logic stays the same

**Status:** idea-level. Bigger scope than the conquest version because it needs an economy, shop
UI, persistence, save states, art for upgrades. Probably 3-4× the work.

---

## What to do next on the current sim

If we stay in the current sim file rather than forking:

1. **Test harness** (above) is the highest leverage thing — every other balance tweak is darts in
   the dark without it.
2. **Strengthen events further** — verify via harness that 40-year runs actually show 30+ point
   drifts on multiple traits, not just one.
3. **Visual diversity at scale** — at 2000+ cats the screen becomes a uniform field. Maybe
   color/aura intensity could scale with how extreme the colony's drift is, making the *whole
   field* of cats visually shift over time as evolution progresses.
4. **Per-cat lineage view** — show the line a cat descends from (great-great-grandparents), useful
   in the inspector and on the end screen.

If we fork, the order would be:
1. Refactor sim into module
2. Build test harness on the module
3. Decide which branch (conquest vs cozy) is more compelling
4. Fork that into its own project
