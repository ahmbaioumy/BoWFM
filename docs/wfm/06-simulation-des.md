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
completions under deadline scheduling. Ordering (`CaseMinHeap.compare`):

1. Parked/partially-worked cases first (finish what is started; avoids a pile of
   half-done work)
2. Latest Safe Start ascending (EDF — the urgency signal)
3. Category priority
4. Arrival time (FIFO)
5. Synthetic id (deterministic final tie-break)

Note LSS must be computed through the *business* calendar, not by wall-clock subtraction: a
case needing 4 hours against a 09:00-tomorrow deadline cannot start at 23:00 tonight.

## Replications and Common Random Numbers

Arrival timing within an interval is random, so one run is one sample. The engine runs
**R = 30 replications** per candidate.

**Common Random Numbers**: the same R arrival realisations (`precomputedCaseSets`) are
reused across *every* candidate headcount. Candidates then differ only by headcount, not by
luck of the draw. This is a standard variance-reduction technique and it sharply reduces the
replications needed to distinguish adjacent N. It is deliberate — do not "optimise" it away
by regenerating cases per candidate.

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

## The search, and the property it depends on

1. Start at `N_min`.
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
- **A drain window** (up to 14 days past horizon end) lets in-flight work finish, so cases
  arriving near the end are not counted as failures merely because the clock stopped.

The drain window creates an edge effect: a headcount below the steady-state line could
"pass" by using drain-window time that would not exist in a repeating period. **`N_min` as a
hard floor is the guard against this** — which is why that floor must not be removed.

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
