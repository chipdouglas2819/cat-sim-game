# Colony — Code Audit

Findings from a systematic pass through the simulation, grouped by severity.

## Critical (causes lag / breaks intended behavior)

### A1. Unbounded `state.deceased` memory leak  — **FIXED**
Every cat that ever died pushed a full snapshot (genes object, phenotype, childrenIds array) into
`state.deceased`, retained for the whole run. A run with 45,000 births = 45,000 retained objects.
This is a major contributor to late-run lag — it's not just live cats, it's the entire accumulated
mortuary. Fix: cap `deceased` to the most recent N (e.g. 300) for pedigree lookups, and track
all-time record holders (oldest, most prolific, etc.) incrementally as cats die instead of scanning
the full list at the end.

### A2. Contradictory size selection — **FIXED**
We deliberately made small cats reproduce more (r-strategy) by removing bodyScale from litter
fitness. But the mate-compatibility code still multiplies `compat` by `partnerFitness * myFitness`
where both include `bodyScale`. So big cats still get a large *mating-success* advantage that
compounds, undercutting the small-cat balance. Net effect: size selection is still biased upward.
Fix: use condition (not condition×bodyScale) in the mating fitness term.

### A3. "Genetic diversity" chart ignores behavioral genes
The diversity metric only measures heterozygosity of the 6 visible coat genes (B/D/A/S/L/W). The
behavioral genes the player actually watches evolve aren't included. The chart can look flat/healthy
while behavioral traits are converging hard — misleading the player about what's happening.
Recommendation: add a second "behavioral variance" line (variance of boldness/energy/etc. across
the population) so the player sees behavioral convergence directly.

## Moderate (imbalance / correctness)

### M1. Population doesn't actually stay low
Despite food carrying-capacity, runs still hit 2900+ cats. The cap limits *food on the ground*, but
nursing transfers + opportunistic eating let many cats survive on little. The intended ~150-400
equilibrium isn't holding. Needs investigation — possibly nursing is too generous, or food per
morsel feeds too many. This is also why evolution stays flat (huge pop resists drift).

### M2. seek_food vs opportunistic eating inconsistency — **FIXED**
A cat actively foraging eats a flat 0.75 per bite. A cat opportunistically grabbing food eats
`0.6 + bodyScale*0.25 + boldness*0.1`. So the big-cat eating advantage only applies to one of the
two eating paths. Fix: both paths now use the same `0.6 + bodyScale*0.25 + boldness*0.1` biteCap.

### M3. Dead code: popPressure() and POP_HARD_CEILING — **FIXED**
`popPressure()` has no callers (removed when food-capacity replaced it). `POP_HARD_CEILING = 80` is
never enforced. Both are leftover. Removed popPressure; kept the constant commented for reference.

## Minor (fragile / cosmetic)

### N1. Diversity loop precedence is formatting-fragile
`if (...) het++; n++;` works only because `n++` is meant to be unconditional. One reflow and it
breaks silently. Added braces.

### N2. setTimeout for kitten cry uses real-world ms in a speed-scaled sim — **FIXED**
At 8× the 1500ms cry-cooldown is effectively much longer in sim-time. Fix: replaced
`setTimeout(() => { cat._cryShown = false; }, 1500)` with a sim-time countdown
(`cat._cryUntil = sim.simTime + 0.4` weeks ≈ 1.5 real-seconds at 1×), so throttling
is consistent across all speeds and works in headless runs.

### N3. state.food.indexOf() inside eat — O(n) lookup — **FIXED**
Minor since food is capped, but splicing by indexOf scans the array. Fix: `findNearestFood` now
returns the index alongside the target, so the eat path splices directly by index.

### N4. Maternal grief setTimeout / floatText spam not throttled at high pop — **FIXED**
Grief and cries push floatTexts even when 2000 cats exist. Throttled elsewhere but not here.
Fix: maternal grief float now skipped when population exceeds 500.

## What I fixed this pass
- A1 (memory leak — capped deceased + incremental records)
- A2 (size mating bias)
- M3 (dead code)
- N1 (diversity braces)

## Follow-up pass
- M2 (eating consistency — both paths now share biteCap formula)
- N3 (food.indexOf — findNearestFood returns idx)
- N4 (grief float throttled at pop > 500)
- N2 (kitten cry — converted from setTimeout to sim-time countdown during the
  sim.js refactor, since headless runs have no event loop)

## What still needs work (bigger jobs)
- A3 (behavioral diversity metric) — needs new chart series. The diversity
  module already computes behavioral spread, but the chart only plots the
  blended index. Could split into two series.

---

# Bench findings — evolution / balance (2026-05-28)

Ran headless sweeps (bench/run.js, bench/analyze.js, bench/environments.js):
a colonyScale sweep (4 scales × 24 seeds × 22yr) and a forced-environment
battery (6 environments × 12–30 seeds). Verdict: **you currently CANNOT
witness evolution in most directions.** Findings, worst first:

### B1. colonyScale floor bug — **FIXED**
Food-capacity floors were flat (`max(15,…)`, `max(6,…)`, `FOOD_TARGET_MIN=4`),
clamping every colonyScale ≤ ~0.6 to identical capacity. Scales 0.1/0.25/0.5
produced byte-identical runs. Fixed: floors scale with colonyScale; medPop now
13/18/239/550 across 0.1/0.25/0.5/1.0. Scale 1 (live default) unchanged.

### B2. Starvation drowns out all other selection — **OPEN (design)**
Starvation = 82–87% of all deaths. Predator 1%, harsh winter 1%, drought 0%,
plague 0%. The environmental events that are supposed to create trait
trade-offs cause ~3% of deaths combined — far too weak to steer evolution.
The only real selective pressure is "don't starve" → small body, low appetite.

### B3. The environmental trade-offs barely work / several are broken — **OPEN (design)**
Forcing an environment to dominate (4× weight) still barely moves traits:
- predator does NOT select for aggression (should) — flat
- predator does NOT meaningfully select against boldness (should) — flat
- epidemic selects slightly FOR sociability (BACKWARDS — should select against)
- winter does NOT select for large body (should) — body still shrinks
4 of 7 traits (boldness, sociability, playfulness, aggression) are FLAT under
every environment. Only energy/appetite/bodyScale respond, and only weakly.

### B4. Body size is a one-way downward ratchet — **OPEN (design)**
bodyScale drifts DOWN in every environment (−0.036 to −0.063), never up — even
in winter, which is designed to favor large cold-resistant bodies. The
small-cat advantage (r-strategy litters + longevity) overwhelms everything.
You can never evolve big cats.

### B5. playfulness has no selection pressure at all — **OPEN (design)**
Grep confirms: playfulness is read for behavior (zoomies, pounce, play state)
but never in any survival or reproduction path. It can only drift randomly —
not be directed. Flat in all bench runs (|drift| ~0.012, the lowest).

### B6. Drift plateaus by ~year 10 — **OPEN (design)**
Trajectory analysis: |drift| peaks ~Y10 then flattens (boldness 0.015→0.039→
0.031). Once the colony hits a few hundred cats, large-N resistance freezes the
mean. Only bodyScale keeps creeping. Net visible drift stays < 0.06 (the
"visibly evolving" target is ~0.05–0.15).

### B7. 54% of colonies go extinct at founding — **OPEN (design)**
The 2-founder bottleneck: median extinction year 7. Frustrating when trying to
watch a colony evolve. Small colonies (low colonyScale) are even more fragile.

**Bottom line:** to let the player witness directed evolution we need (a) small
colonies — now possible via B1 fix; (b) environmental selection strong enough
to overcome starvation (B2/B3); (c) body size able to go both ways (B4); (d) a
selection pressure on playfulness (B5); (e) less founding extinction (B7).
These are tuning/design changes — see chat for the proposed plan.
