# 04 — Capacity Planning and Sizing

The workload→FTE chain, and how this engine implements it.

---

## The chain

```
Volume × AHT                    →  Workload hours
Workload ÷ per-agent capacity   →  Operational HC   (on-duty bodies)
Operational HC ÷ (1 − shrinkage)→  Rostered/Gross HC (bodies to employ)
Required hours ÷ contract hours →  FTE
```

Each arrow is a different question. Keep them separate; most sizing errors are a factor
applied at the wrong arrow.

---

## Stage 1 — Workload

```
Workload_hours = Σ (Volume_c × AHT_c) / 60  +  Σ openingWIP remaining minutes / 60
```

Per category, because AHT differs by category and a mix shift changes workload without
changing volume. **Opening WIP belongs here**: deferred work carries backlog across
periods, and a model that ignores carry-in undersizes from day one. Use *remaining* work on
partially-handled cases, not full AHT.

## Stage 2 — Capacity baseline (`N_min` / Workload HC)

```
agentHours = Manual Override if source=override AND hours > 0
           else DailyProductiveHours × calendarWorkingDaysInHorizon
N_min = floor( Workload_hours / (OccCap × agentHours × Adherence) )
```

**Uses `floor`, not `ceil` — confirmed, no further discussion (2026-08-28).** `N_min` is a
*starting* floor for the DES search, not itself a claim that capacity clears demand at that
exact headcount: at a fractional ratio (e.g. 1.125 agents) `floor` truncates to 1, which can
sit fractionally below break-even capacity. The real feasibility guarantee comes from Stage 3
— the CI-gated DES search evaluates upward from `N_min` and only accepts a headcount whose
simulated SLA/occupancy actually clears the target; under-sizing is caught there, not asserted
away at Stage 2. Default Manual Override hours = **0** (ignored → Derived). Override feeds
**Workload HC only**, not a separate FTE hiring step.

**Shrinkage is deliberately absent.** `N_min` is *operational* headcount — bodies on the
floor. Shrinkage converts that to bodies employed, at Stage 4. Including it here and there
is the classic double-count.

**The occupancy cap belongs in the denominator.** Dividing available hours by the
utilisation ceiling expresses "size so required utilisation stays at or below the cap". With
no custom cap the term resolves to 1.0 (100%), which assumes 100% occupancy is achievable — a
weak lower bound. *Corrected 2026-08-27:* "safe, since the simulation refines upward from it"
was not reliably true — if the floor at `oMax=1.0` happened to also pass the Primary SLA CI on
the first evaluation, the walk-down search never ran and the recommendation was published at
`N_min` unrefined. Combined with a separate gate defect (the occupancy cap comparison used the
display-clamped value, so it could never reject anything — see
`07-known-defects-and-decisions.md`), this let a headcount at >100% true occupancy pass. The
gate is fixed; the floor still assumes 100% achievable by default, so treat "occupancy at the
recommendation" (sanity check below) as load-bearing, not optional, whenever `N_min` and the
recommendation coincide.

**Why a floor at all?** The simulation grants a drain window past the horizon end. Without
the floor, a headcount below the steady-state line could appear to pass by exploiting that
finite-horizon edge effect while being unsustainable in a repeating period.

## Stage 3 — Simulation search

`N_min` is necessary but not sufficient: it ignores *timing*. Capacity that exists on
Friday cannot serve a deadline that fell on Tuesday. The DES tests whether each candidate
headcount actually meets the deadline distribution — see `06-simulation-des.md`.

## Stage 4 — Shrinkage gross-up

```
opHC_c    = OperationalHC × share_c            # share by workload
grossHC_c = opHC_c / (1 − shrinkage_c)
GrossHC   = ceil( Σ_c grossHC_c )
```

**Order of operations matters.** Gross up *per category with its own rate*, then sum, then
apply a single ceiling:
- Blending rates first and grossing the total loses the per-category structure.
- Ceiling per category over-rounds systematically (a 5-category split rounds up 5 times).

### Why the harmonic mean

To express one blended rate equivalent to a set of per-category rates, you need the rate
that reproduces the same total gross headcount:

```
Σ_c ( share_c / (1 − shr_c) )  =  1 / (1 − shr_eff)

⟹  shr_eff = 1 − 1 / Σ_c ( share_c / (1 − shr_c) )
```

This is a **harmonic** blend. Because gross-up divides by `(1 − shr)`, the quantity that
adds linearly is `1/(1 − shr)`, not `shr`.

Worked check — two categories, equal shares, 10% and 30%:
- Arithmetic (wrong): 20% → factor 1.250
- Harmonic (correct): `1 − 1/(0.5/0.9 + 0.5/0.7)` = **21.25%** → factor 1.270

The arithmetic mean understates required headcount by ~1.6% here, and the gap widens as
rates diverge. Pinned by test `D7.10`.

### Every category with workload must get a share

If workload is counted in the denominator for a category that receives no allocation, the
shares sum to less than 1 and the requirement is understated proportionally. Measured in
this codebase: one unconfigured category halved `fteNet` (5 instead of 10) and understated
Gross HC by 46%. Fixed, but configure categories explicitly rather than relying on the
fallback defaults.

## Stage 5 — FTE (engine only; UI hidden)

```
FTE = required hours / contractual hours per FTE
```

Note the identity: when agent hours are *derived* from the same horizon and daily
hours used to compute required hours, the terms cancel and `FTE == Operational HC` exactly
(test `D7.5`). **Headline Hiring FTE (M4) is temporarily hidden in the UI** so Manual Override
is only the Workload HC denominator. Engine fields remain for tests / future restore.

---

## When Erlang applies — and when it does not

| | Erlang-C | Deferred/DES |
|---|---|---|
| Arrival | Poisson, real-time | Any pattern, queues across days |
| Abandonment | Central to the model | Does not occur |
| Service target | Answer within seconds | Complete within hours/days |
| Queue | Empties each interval | Legitimately carries over |
| Deadlines | Not modelled per-item | Per-case, drives scheduling |

**Erlang-C is wrong for deferred work.** It assumes work not served promptly is abandoned
or lost, and has no concept of a per-item deadline or of backlog carried across days.
Applying it to backoffice work typically oversizes badly, because it sizes for
seconds-scale waiting on work whose target is measured in days.

Use Erlang-C for real-time voice/chat. Use simulation for deferred work with deadlines,
backlog, and business-calendar effects. This codebase deliberately contains no Erlang
formula.

## Sanity checks before trusting any number

1. **Does `N_min` ≤ recommended HC?** If not, the search floor is broken.
2. **Does Gross HC ≥ Operational HC?** Equality only when shrinkage is zero.
3. **Do category shares sum to 1?**
4. **Is occupancy at the recommendation below the cap?** If it is *far* below, the binding
   constraint is TAT/timing, not capacity — worth surfacing to the planner.
5. **Is the horizon at least as long as the SLA window?** Otherwise attainment is
   vacuously high.
6. **Does N−1 actually fail?** That is the evidence the answer is minimal.
