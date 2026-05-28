# Colony — Simulation & Test Harness Spec

This is the plan for moving Colony to Claude Code and building the headless test harness, so we can
stop hand-running sims and instead measure behavior across hundreds of seeds automatically.

Everything below is written so a fresh session (or you, later) can pick it up cold.

---

## Why we're doing this

The core problem: tuning evolution by hand is a broken loop. Each change requires running a 30-75
year sim live, screenshotting the end screen, and eyeballing six drift numbers. One data point per
several minutes of human time. We cannot tell whether a tuning change actually helped or whether we
got a lucky/unlucky seed, because we never see the distribution.

The fix: extract the simulation into a headless module with no DOM/rendering, then run it hundreds
of times across seeds/configs in seconds and analyze the aggregate. Turn "I think this helped" into
"median boldness drift went from 4 to 19 points across 200 seeds."

---

## Phase 1 — Refactor into a testable module

The current `colony.html` is a single file mixing three concerns:
1. **Simulation** — gene model, inheritance, update loop, selection, events, population dynamics
2. **Rendering** — canvas drawing, cat sprites, charts
3. **UI/DOM** — setup screen, inspector, event listeners, log

### Target structure
```
colony/
  src/
    sim.js          # PURE simulation — no DOM, no canvas, no window. Exports a Simulation class.
    genetics.js     # rollGenes, inheritGenes, calculatePhenotype, inbreedingCoefficient
    events.js       # rollSeasonalEvent, driftWeather, applyEnvironmentalPressure
    constants.js    # all the tuning constants in one place (see "Tuning knobs" below)
  web/
    index.html      # the visual game — imports sim.js, adds rendering + UI
    render.js       # all canvas drawing
    ui.js           # setup screen, inspector, charts
  bench/
    run.js          # headless batch runner
    analyze.js      # aggregate + report
  COLONY_SIM_SPEC.md (this file)
  COLONY_ROADMAP.md
  COLONY_AUDIT.md
```

### The key requirement for `sim.js`
The `Simulation` class must:
- Take a config object (seed, colonyScale, founder genes or "random", all tuning constants)
- Use a **seeded PRNG** (not `Math.random()`) so runs are reproducible. This is critical — every
  `Math.random()` call in the current code must route through an injected RNG. Replace the global
  `rand`, `gauss`, `pick` helpers to draw from a seeded generator (e.g. mulberry32 or a small xorshift).
- Expose `step(dt)` to advance one tick, and `runYears(n)` to fast-forward headlessly
- Expose a `snapshot()` returning all the metrics we care about (see "Metrics" below)
- Have NO references to `document`, `window`, `canvas`, `requestAnimationFrame`, `performance`, or
  `setTimeout`. (The current code uses setTimeout for kitten cries and childbirth death — those must
  become tick-based timers.)

The web game then becomes a thin layer: it owns a `Simulation`, calls `step()` each animation frame,
and renders `sim.cats` to canvas. All the gameplay logic lives in the shared module, so the game and
the harness always test the same code.

### Refactor gotchas (things in the current code that will fight this)
- `setTimeout` is used in: maternal-death-in-childbirth, kitten cry cooldown, log render throttle,
  end-screen scroll reset. All four must be removed or converted to tick-based / web-only.
- `performance.now()` is used in the log throttle — web-only, fine to leave in the web layer.
- `state` is a single global object. The Simulation class should own its own state instead.
- `catById`, `parentsById`, `spatialGrid` are module-level globals — move them onto the Simulation.
- Rendering reads `state.simTime` for tail-wag animation etc. — that's fine, it's in the web layer.

---

## Phase 2 — The headless runner (`bench/run.js`)

```
node bench/run.js --seeds=200 --years=50 --out=results.json
node bench/run.js --seeds=100 --years=50 --colonyScale=0.4 --out=small.json
node bench/run.js --seeds=100 --years=50 --founders=random --out=baseline.json
```

For each seed it constructs a Simulation, runs N years, and records the full metric set. Should use
worker threads (or just run synchronously — a headless sim with no rendering is fast; 50 years
should be well under a second per seed). Output one JSON row per seed.

### Config matrix we want to sweep
- **colonyScale**: 0.25, 0.5, 1, 2, 4  (the big question: what carrying capacity produces visible drift?)
- **inheritance σ**: 0.015, 0.025, 0.04  (heritability fidelity)
- **assortative weight**: 0, 0.25, 0.5  (does it help or freeze drift?)
- **mutation rate**: 0.01, 0.02, 0.04
- **founder variance**: the σ on founder gene rolls
- **event frequencies**: scale all event probabilities up/down together

---

## Phase 3 — Analysis (`bench/analyze.js`)

Reads the JSON and answers the questions we keep guessing at:

### Primary questions
1. **Does evolution happen?** Across 200 seeds, what's the median & distribution of |drift| for each
   behavioral trait over 50 years? (drift = final colony mean − founder mean). If median is <5 points
   the model is too static; if it's wild (>40) it's too chaotic.
2. **What colonyScale is the sweet spot?** Plot median drift vs colonyScale. Find where drift is
   visible (15-30 pts) without being pure noise.
3. **Do environments select correctly?** Filter seeds by which events dominated. Do predator-heavy
   runs actually drift toward aggression & away from boldness? Do drought-heavy runs drift smaller?
   This validates the trade-off model is real, not just theoretical.
4. **Is size selection balanced?** Does body size drift both up AND down depending on environment,
   or does it always go one way? (We've fixed this twice — need to confirm.)
5. **Convergence vs extinction.** What fraction of seeds go extinct? At what year? What causes it
   (disease wipeout, founder infertility, drought collapse)? We disliked disease wipeouts before —
   confirm they're rare.

### Secondary / blind-spot detection
6. **Outlier hunt.** Flag seeds with extreme outcomes — population explosions, total homogenization
   (diversity → 0), single-trait runaway, immortal-cat bugs, negative values, NaNs.
7. **Population stability.** Does pop oscillate healthily or boom-bust to extinction? Plot the
   trajectories.
8. **Inbreeding.** Does F climb to dangerous levels in small colonies? Is the lineage-walk correct
   across many generations? (We fixed a bug where dead ancestors weren't counted — verify.)
9. **Performance.** Time per simulated year at each colonyScale, to know where the web version will
   start to lag.

### Output
A short markdown/CSV report per run: median/min/max/stddev per trait, extinction rate, the
environment-correlation table, and a flagged-outliers list. This is what replaces screenshotting.

---

## Metrics the sim must expose (per snapshot)

Per year (time series) and at end:
- Population (alive), births cumulative, deaths cumulative, stillborn
- Mean + stddev of each behavioral gene: boldness, sociability, playfulness, aggression, energy,
  appetite, size
- Mean bodyScale
- Genetic diversity (visible het + behavioral spread)
- Mean inbreeding coefficient F
- Active event + weather biases
- Death-cause histogram (old age, starvation, illness, predator, drought, harsh winter, injury,
  childbirth, plague, orphaned)
- Generation number
- Founder gene means (constant, captured at start)

---

## Tuning knobs to centralize in `constants.js`

All currently scattered as magic numbers through the code. Pull them out so the harness can sweep them:
- `MUTATION_RATE` (0.02)
- inheritance σ (0.025) — currently inline in `inheritGenes`
- founder gene roll means + σ — inline in `rollGenes`
- `PREGNANCY_DAYS` (9), `BREED_COOLDOWN` (6), `ESTRUS_CYCLE_WEEKS` (8), `ESTRUS_DURATION` (4)
- carrying capacity divisor (20000) + `colonyScale`
- food: `FOOD_PER_CAT`, `FOOD_TARGET_MIN`, `FOOD_BURST_MAX`, season/event multipliers
- event base probabilities (per season, per type) + weather drift step (0.25) + reversion (0.08)
- selection strengths: fight lethality coefficient, predator risk, drought vuln, winter mortality,
  litter trait bonuses, mate-fitness exponent, assortative similarity weight (0.25)
- lifespan base + σ (55) + size-life modifier (0.35)
- maturation ages (kitten/juvenile/adult/senior thresholds)

---

## Known open problems the harness should settle

From COLONY_AUDIT.md and our iteration history:
- **M1: population won't stay low.** Even with carrying capacity, runs hit 1000-2900. Large pops
  resist drift. The harness should tell us the exact colonyScale where drift becomes visible, so we
  can set the default correctly instead of guessing.
- **Drift flattens after ~year 5.** Is this real equilibrium or pop-size resistance? The
  colonyScale sweep answers this.
- **Energy hitting founder ceiling.** Founders sometimes roll 0.92 — drift looks flat because
  there's no headroom. Consider whether founder rolls should be more centered.
- **Is assortative mating helping or hurting?** We dialed it 0.9 → 0.25 because it froze drift.
  Sweep 0/0.25/0.5 to find the truth.

---

## Future game branches (post-harness, separate projects)

These stay parked until the core evolution model is validated. Both reuse the genetics module.

### Branch A — "Genetic Conquest" (Plague Inc style)
- Cats spread across a world map; player picks mutations to overcome regional resistance
- Discrete mutation picks rather than emergent drift; win/lose condition
- Fast pacing, region-level abstraction (no individual cat rendering at scale)
- Reuses: gene model, environmental pressure types as regional flavors
- New: map screen, mutation tech-tree, resistance/difficulty per region, victory condition

### Branch B — "Cozy Cattery" (Neko Atsume / Stardew style)
- Player buys/breeds/sells cats; builds out pens with purchasable upgrades
- Upgrades: feeders, water, beds, sun spots, scratching posts → capacity / happiness / breed rate
- Rare phenotypes (calico, smoke, longhair, odd-eyed, dwarf, giant) sell for more
- Economy + progression + save states; speed boost as a purchasable upgrade
- Reuses: full coat genetics, Mendelian inheritance, cat rendering
- New: economy, shop UI, tile-based pen layout, persistence, upgrade art, cozy audio/visual polish

### Shared foundation both need first
1. The genetics module (`genetics.js`) cleanly extracted
2. Confidence the inheritance + phenotype model is correct (harness validates)
3. The cat renderer extracted as a reusable component

---

## Immediate next steps (in order)

1. Move `colony.html` into the new folder structure; split out `sim.js` with a seeded RNG.
2. Verify the web game still plays identically after the split.
3. Write `bench/run.js`; run 200 seeds × 50 years at colonyScale=1; confirm it matches what we see
   in the live game (sanity check the extraction didn't change behavior).
4. Run the colonyScale sweep; find where drift becomes visible; set that as the game default.
5. Run the environment-correlation analysis; confirm trade-offs actually steer evolution.
6. Fix whatever blind spots the outlier hunt surfaces.
7. Only then: decide whether to fork Branch A or B.
