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
- M1 (population won't stay low) — needs tuning investigation, best done with
  the headless harness once Phase 2 lands.
