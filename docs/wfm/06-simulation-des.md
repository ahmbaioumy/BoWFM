# 06 — Discrete Event Simulation

How the engine decides whether a candidate headcount actually works, and the properties the
search depends on.

---

## Why simulation

The analytical baseline `N_min` answers "is there enough capacity in total?". It cannot
answer "does the work get done *in time*?" — capacity available on Friday cannot serve a
deadline that fell on Tuesday. Deferred backoffice work has per-case deadlines, backlog
carried across days, business-calendar effects, and priority interactions between
categories. No closed form covers that combination. Simulation does.

## Event-scheduling worldview

The simulation holds a priority queue of future events ordered by time, pops the earliest,
advances the clock to it, and processes it — possibly scheduling further events. Nothing is
computed for instants where nothing happens, so cost scales with event count, not with
simulated duration.

Event types: `CaseArrival`, `ProcessingComplete`, `CasePark`, `CaseResume`,
`AgentAvailable`, `DayClose`, `SimulationEnd`.

**Tie-breaking must be total and deterministic.** Events at the identical timestamp need a
defined order or results vary run to run. `EVENT_TYPE_ORDER` supplies a type precedence,
with entity id as a final tie-break. Determinism is not cosmetic here — the CI-gated search
compares candidates, and non-determinism would make comparisons meaningless.

## Dispatch: Earliest Deadline First

When an agent frees up, which case next? The queue is ordered by **Latest Safe Start** —
the last moment work could begin and still meet the deadline:

```
LSS = primaryDeadline − remaining AHT     (walked backwards through the business calendar)
```

Lowest LSS goes first: **Earliest Deadline First**, which is optimal for maximising on-time
completions under deadline scheduling. The case actually served is chosen by `pickNextCase`
(`des-engine.ts`), a linear scan of the queue:

1. Parked/partially-worked cases first (finish what is started; avoids a pile of
   half-done work). This is a rule of the scan itself: the best parked case is taken if
   there is any, otherwise the best new case.
2. Within each group, `compareByUrgency` orders by:
   1. Latest Safe Start ascending (EDF — the urgency signal)
   2. Category priority
   3. Arrival time (FIFO)
   4. Synthetic id (deterministic final tie-break)

`CaseMinHeap.compare` mirrors the same order but only decides heap push/pop order; it does
not decide which case is served. The two must stay in agreement (suite D80). Edit dispatch
in `pickNextCase` / `compareByUrgency`, and keep the heap comparator in step.

Note LSS must be computed through the *business* calendar, not by wall-clock subtraction: a
case needing 4 hours against a 09:00-tomorrow deadline cannot start at 23:00 tonight.

## Agent selection: who takes the case

Case selection (above) is separate from agent selection. Once the next case is chosen, the
engine picks which idle, eligible agent (has daily budget, inside their own shift) takes it.
The old rule was a stack — the agent who just finished took the next case — which piled work
on a few agents whenever capacity was spare. The current rule (`selectFairAgent`, one shared
function for pooled and siloed) is a cascade; each level keeps only agents within a tolerance
of that level's minimum:

1. Utilisation: busy minutes ÷ the agent's own on-shift minutes (default band 2 pp)
2. Cases completed (credited to the agent who finishes the case; band 1)
3. Busy minutes (band 5)
4. Longest idle
5. Seeded random pick among the rest (its own PRNG stream derived from the run seed; consumed
   only when more than one agent is left, and never touching the case-generation stream, so
   Common Random Numbers are preserved)

Siloed agents choose only within their own category. Counters run in every replication; the
per-case assignment ledger and per-agent summary exist only in the single-seed audit run.
It changes *who* works a case, not *which* case goes next, and not the requirements — N_min is
unchanged, and recommended HC is identical to the legacy pick in all 18 re-measured scenarios (the earlier +1 in 2 of 125 was the
budget-as-presence coverage artefact, removed 2026-09-29: coverage presence is now the agent's own shift window
[start, start + shiftLength), independent of remaining budget; since 2026-10-08 dispatch obeys that same window on every
non-24x7 run, with or without a start distribution — with none, every agent is at offset 0 and leaves `dailyProductiveHours`
after open; 24x7 without a distribution keeps agents on around the clock). A Labor-tab button turns it off (`dispatchFairness.enabled
= false`), which restores the legacy pick and the original numbers exactly. Note: once a daily
budget binds, a different agent choice can shift when cases are parked, so case *timing* may
differ; case *order* is identical while budgets do not bind.

## Replications and Common Random Numbers

Arrival timing within an interval is random, so one run is one sample. The engine runs
**R = 30 replications** per candidate.

**Common Random Numbers**: the same R arrival realisations (`precomputedCaseSets`) are
reused across *every* candidate headcount. Candidates then differ only by headcount, not by
luck of the draw. This is a standard variance-reduction technique and it sharply reduces the
replications needed to distinguish adjacent N. It is deliberate — do not "optimise" it away
by regenerating cases per candidate.

### Optional arrival-count noise (volume variability)

By default each interval brings its forecast volume (rounded) and only the arrival *times* are random. With
`sla.volumeVariability` on, the *count* is random too: Poisson with mean equal to the interval volume rounded to a whole number (the figure Off uses) (exact below 30
expected cases, rounded normal above), drawn from a separate seeded stream per replication so the same counts are
reused for every candidate N (CRN still holds) and the arrival-time stream is not shifted. This is day-to-day noise
around the forecast, not forecast error, and per-interval noise averages out over a long horizon. Roster design and
siloed seats stay on the forecast. See PRD FR-5.14 / L39.

## CI-gated acceptance

A candidate passes only if the **95% confidence interval bound** clears the target, not
merely the mean:

```
mean  = Σx / R
var   = Σ(x − mean)² / (R − 1)        # Bessel-corrected
SE    = √var / √R
CI    = mean ± t(0.975, R−1) × SE
```

Direction matters, and differs per constraint:
- **SLA attainment** (higher is better) → require the **lower** bound ≥ target
- **Occupancy / ASA caps** (lower is better) → require the **upper** bound ≤ cap

This is deliberately conservative: it accepts a headcount only when the evidence supports
the claim, rather than when a single lucky run happened to clear it.

### Independent confirmation block

A candidate that passes the gate on the search's own R replications must also pass the same,
unchanged gate on a second, disjoint block of R case sets (the confirmation block). Its seed
is derived from the run seed by pure arithmetic (`deriveConfirmationBaseSeed`,
`createConfirmationBlock`), so the two blocks never share a replication, and Common Random
Numbers still hold inside the block. A candidate that clears the main days but not the second
set is a non-passing result and the search continues as for any failure; the history row shows
"N=… passed on the main simulated days but not on a second, independent set (…)". One state
machine (`createPassConfirmation`) is shared by `searchOptimalHC` and `searchOptimalHCAsync`.
Every evaluation at the full R is confirmed; the 5-replication leap probes of a larger R stay
primary-only (runs with R of 5 or fewer confirm every evaluation). One confirmation set lowers,
but does not remove, the chance of adopting a lucky headcount (PRD L35); it can only raise the
answer, never lower it.

### Roster layouts tried at each candidate

At each candidate N the search tries rosters in a fixed order, each judged by the same
primary-plus-confirmation gate: the uniform layout, the coverage-repair roster (Minimum
Coverage ON, default; tried first when the shift is shorter than the open day, because uniform
cannot cover the tail then), the even-spread layout of the repair roster
(`buildCoverageSpreadDistribution`), and, only with Shift Placement ON (opt-in), the analytic
placement roster and finally the rescue ladder (`buildRescueLadder`, late-start shares
`RESCUE_LATE_SHARES`), which is also confirmed on the second block. The roster polish chain (opt-in Shift Placement) runs only after
the headcount is decided and does not change it.

## The search, and the property it depends on

1. Start at `max(N_min, N_occ)`, where `N_occ` is the smallest headcount whose occupancy can
   clear the cap on the simulator's own hours basis (`resolveSearchBounds`,
   `computeOccupancyFloor`). With the Workload Floor ON (default) the search never walks below
   this start; with it OFF the same start is used but the walk-down may go as low as N = 1.
2. **Leap** upward in doubling steps until a candidate passes (cheap probes at
   `min(R,5)` replications, confirmed at full R).
3. **Walk down** by −1 from that ceiling, re-testing at full R, **stopping at the first
   failure**. The last passing N is the answer.

> **The walk-down is only valid if `passesAllConstraints(N)` is monotone in N** — if adding
> an agent can never make things worse. Any change that breaks monotonicity silently breaks
> the search: it will halt at a spurious dip and report a headcount that is not minimal.

### The apportionment trap (a real defect found here)

In the **siloed** architecture, agents are divided among categories. The original code used
**Hamilton's largest-remainder method**, recomputed from scratch for each candidate N. That
method is subject to the **apportionment "Alabama paradox"**: increasing the total can
*decrease* an individual category's allocation, because every candidate's fractional
remainders re-rank.

Measured on a realistic workload split (6270/2300/1230/200) over N=1..200:

| Method | Monotonicity violations | Starved silos |
|---|---|---|
| Hamilton (largest remainder) | **14** | **21** |
| Webster/Sainte-Laguë (divisor) | **0** | **0** |

At N=19 category 'D' held 1 agent; at N=20 it held **0** — a silo with work and nobody to
do it, i.e. an unbounded queue, produced by *adding* an agent.

**Fix:** `allocateAgentsToCategories` uses a **divisor (highest-averages) method**, assigning
agents one at a time by `workload / (2·seats + 1)`. Divisor methods are *house-monotone by
construction*: the allocation for N+1 is the allocation for N plus one more seat, so nothing
can be taken away. Every category holding work also receives one agent before any receives a
second — in a siloed model an unstaffed queue never drains, so starvation is worse than a
small proportionality error.

**Never revert this to largest-remainder.** It is a correctness requirement of the search,
not a stylistic preference.

## Terminating vs steady-state, and the drain window

This is a **terminating** simulation: it runs over a defined horizon with a defined starting
state (opening WIP), rather than to statistical equilibrium. Two consequences:

- **Opening WIP is the initial condition** and must be supplied. Starting from an empty
  queue is a modelling choice that flatters the result.
- **A drain window** lets in-flight work finish, so cases arriving near the end are not counted
  as failures merely because the clock stopped. It runs until the **later of horizon end + 14
  calendar days and the latest case deadline** (Item 4, 2026-10-16), never longer than horizon
  end + 366 days (`DESResult.drainCapped` is set when that cap bit). A case is therefore never
  counted as failed before its own deadline has passed - holidays after the horizon push
  deadlines out and used to inflate the headcount (DES-10 / G9). The end is computed once per
  run by `computeDrainEnd` in `des-engine.ts` (non-finite deadlines are skipped).

The drain window creates an edge effect: a headcount below the steady-state line could
"pass" by using drain-window time that would not exist in a repeating period. **`N_min` as a
hard floor is the guard against this** — which is why that floor is ON by default. The
planner opt-out added 2026-09-30 (`sla.nMinFloorEnabled: false`) re-exposes exactly this risk,
so any result below the floor carries a red "below the workload floor" warning.

Relatedly, occupancy uses the **planned horizon** as its denominator, not the drained span.
Widening it to include drain days would make an undersized team look adequately utilised
because it took extra weeks to finish — inverting the signal. See
`10-architecture-required-hc-chain.mdc` (frozen decision 3).

## Validation

- **`verifyAgentTimelineInvariants`** recomputes headline figures from an independent data
  path (the per-agent timeline) and cross-checks: busy minutes reconcile with total handling
  minutes, no agent exceeds their daily budget, no overlapping or gapped slices, every
  referenced case exists.
- **Boundary evidence** — the engine reports why N−1 fails, so the recommendation is
  demonstrably minimal rather than merely asserted.
- **Determinism** — same seed, same input, same answer. Any drift means an ordering bug.
