---
name: wfm-sizing-simulation
description: Backoffice/email deferrable-transaction sizing model and the discrete-event simulator (DES) that drives this engine's headcount search — dispatch order, replications, CI-gated acceptance, agent apportionment. Use before changing anything in des-engine.ts or hc-search.ts's search loop, before answering "why not Erlang-C" questions, or when reasoning about deferrable/backoffice sizing behavior, drain windows, or the N_min floor.
---

# WFM Sizing & Simulation

This is the priority domain for this codebase: sizing headcount for **backoffice
deferrable-transaction work** (email, cases, tickets) against a **turnaround SLA**, using a
**discrete-event simulation (DES)**, not Erlang-C. Full derivations live in
`docs/wfm/04-capacity-planning-and-sizing.md` and `docs/wfm/06-simulation-des.md` — this
skill is the operational summary; read those files directly for anything not covered here.

## Why this isn't an Erlang-C problem

Erlang-C answers "how fast do we clear this instant of demand," assuming Poisson arrivals,
abandonment for anyone who waits too long, and a queue that empties every interval. None of
that holds for deferrable work:

| | Erlang-C | This engine (DES) |
|---|---|---|
| Arrival | Poisson, real-time | Any pattern, queues across days |
| Abandonment | Central to the model | Does not occur |
| Service target | Answer within seconds | Complete within hours/days (turnaround SLA) |
| Queue | Empties each interval | Legitimately carries over as opening WIP |
| Deadlines | Not modelled per-item | Per-case, drives dispatch order |

Applying Erlang-C to backoffice work typically **oversizes badly** — it sizes for
second-scale waiting on work whose actual target is measured in days. This codebase
deliberately contains no Erlang formula. If a request asks to "add Erlang" or "make it more
like a call-centre model," that is the wrong direction — say so and point here.

## The sizing chain (four stages)

```
Volume × AHT                          → Workload hours          (Stage 1, hc-search.ts)
Workload ÷ per-agent capacity         → Operational HC (N_min)  (Stage 2, hc-search.ts)
DES search over N candidates          → Recommended operational HC (Stage 3, des-engine.ts)
Operational HC ÷ (1 − shrinkage)      → Gross HC                (Stage 4, hc-search.ts)
```

**Stage 1** includes opening WIP (remaining minutes on partially-handled cases) — this term
is *what makes it deferrable-work sizing* rather than real-time; there's no analogue in a
real-time model because nothing is still waiting from yesterday.

**Stage 2** (`N_min`) answers "is there enough capacity in total?" but not "does it arrive in
time?" — that's what Stage 3 is for. Shrinkage is deliberately absent here (applied only in
Stage 4 — double-counting it in both is the classic WFM error).

**Stage 3 is the DES**, covered in detail below. `N_min` from Stage 2 is a **hard floor** on
the search — without it, a headcount below the steady-state line could "pass" purely by
exploiting the simulation's drain-window edge effect (see below) while being unsustainable
in a repeating period.

**Stage 4** grosses up *per category with its own shrinkage rate*, sums, then applies a
single `ceil` — blending rates first or ceiling-ing per category both introduce systematic
error. The blended-equivalent rate is a **harmonic** mean (not arithmetic), because gross-up
divides by `(1 − shrinkage)`, so the quantity that adds linearly is `1/(1−shrinkage)`.

## The DES simulator — mechanics you need before touching `des-engine.ts`

**Event-scheduling worldview.** A priority queue of future events ordered by time; pop
earliest, advance clock, process, possibly schedule more. Event types: `CaseArrival`,
`ProcessingComplete`, `CasePark`, `CaseResume`, `AgentAvailable`, `DayClose`,
`SimulationEnd`. Tie-breaking at identical timestamps must be total and deterministic
(`EVENT_TYPE_ORDER`, then entity id) — the CI-gated search compares candidates, and
non-determinism makes comparisons meaningless.

**Dispatch: Earliest Deadline First.** Cases are ordered by **Latest Safe Start**:
```
LSS = primaryDeadline − remaining AHT     (walked backwards through the business calendar)
```
Lowest LSS goes first — optimal for maximising on-time completions. Full order
(`CaseMinHeap.compare`): (1) parked/partially-worked first, (2) LSS ascending, (3) category
priority, (4) arrival time (FIFO), (5) synthetic id. LSS must go through the *business*
calendar (`subtractWorkingTime`), never wall-clock subtraction — a case needing 4 hours
against a 09:00-tomorrow deadline cannot start at 23:00 tonight.

**Replications and Common Random Numbers.** Arrival timing is random within an interval, so
the engine runs **R = 30 replications** per candidate, and — critically — reuses the *same*
R arrival realisations (`precomputedCaseSets`) across every candidate headcount. This is
deliberate variance reduction (Common Random Numbers): candidates then differ only by
headcount, not by luck of the draw. Never regenerate cases per candidate "to be more
random" — that reintroduces the noise CRN exists to remove.

**CI-gated acceptance.** A candidate passes only if the **95% CI bound** clears the target,
not the mean:
```
mean = Σx/R;  var = Σ(x−mean)²/(R−1);  SE = √var/√R
CI = mean ± t(0.975, R−1) × SE
```
Direction differs by constraint: SLA attainment (higher better) → require the **lower**
bound ≥ target. Occupancy/ASA caps (lower better) → require the **upper** bound ≤ cap. This
is deliberately conservative — it accepts a headcount only when the evidence supports it,
not when one lucky run cleared it.

**The search.** Leap upward in doubling steps (cheap probes, ≤5 reps) to a passing ceiling,
then walk down by −1 at full R, stopping at the first failure. The last passing N is the
answer. **This walk-down is only valid if `passesAllConstraints(N)` is monotone in N** — any
change that breaks monotonicity silently breaks the search: it halts at a spurious dip and
reports a non-minimal headcount.

**Terminating simulation, not steady-state.** Runs over a defined horizon from a defined
opening WIP (not to statistical equilibrium), plus a **drain window** (up to 14 days past
horizon end) so near-the-end arrivals aren't unfairly counted as failures. This creates an
edge effect the `N_min` floor exists specifically to guard against. Occupancy's denominator
is the *planned horizon*, not the drained span — widening it would make an undersized team
look adequately utilised because it took extra weeks.

## The apportionment trap — a real defect, do not reintroduce it

In the siloed architecture, agents split across categories. The original code used
**Hamilton's largest-remainder method**, recomputed per candidate N — subject to the
apportionment **Alabama paradox**: increasing the total can *decrease* one category's share,
because fractional remainders re-rank every time. Measured on a real workload split over
N=1..200: Hamilton produced **14 monotonicity violations and 21 starved silos** (one case:
category held 1 agent at N=19, **0** at N=20 — a silo with work and nobody to do it, caused
by *adding* an agent). The fix, `allocateAgentsToCategories`, uses a **divisor
(Webster/Sainte-Laguë) method**, assigning agents one at a time by
`workload / (2·seats + 1)`. Divisor methods are house-monotone *by construction* — N+1's
allocation is N's plus one more seat, nothing is ever taken away.

**Never revert this to largest-remainder/Hamilton.** It's a correctness requirement of the
search (the walk-down depends on monotonicity), not a stylistic choice.

## Validation you can lean on

- `verifyAgentTimelineInvariants` recomputes headline figures from an independent path (the
  per-agent timeline) and cross-checks busy-minute reconciliation, daily-budget compliance,
  no overlapping/gapped slices, and case-existence.
- The engine reports why N−1 fails, so the recommendation is demonstrably minimal.
- Same seed + same input must give the same answer — any drift is an ordering bug.

## Files

| Concern | File |
|---|---|
| DES event loop, dispatch, occupancy, apportionment | `src/utils/des-engine.ts` |
| Baseline `N_min`, CI search, shrinkage/FTE math | `src/utils/hc-search.ts` |
| Business-calendar arithmetic (used for LSS) | `src/utils/calendar.ts` |
| Full derivations and worked examples | `docs/wfm/04-capacity-planning-and-sizing.md`, `docs/wfm/06-simulation-des.md` |
| Decision log (check before "fixing" something deliberate) | `docs/wfm/07-known-defects-and-decisions.md` |

Before writing a fix in this area, also load `wfm-engine-testing` for the fail-first
protocol and the DES-specific test checklist (seed determinism, CI-gate correctness,
monotonicity sweep).
