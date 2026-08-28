---
name: wfm-domain-guide
description: Workforce-planning vocabulary and metric definitions for contact-centre / backoffice sizing — hours taxonomy, occupancy vs utilisation, shrinkage vs adherence, headcount vs FTE, deferrable vs real-time channels, and which docs/wfm/0X file answers which question. Use before changing or discussing sizing, forecasting, shrinkage, occupancy, SLA, or scheduling logic, or when a request uses WFM terms loosely (e.g. "utilization" when the answer depends on which one).
---

# WFM Domain Guide

This engine encodes contact-centre workforce-planning methodology. The terms are precise
and easy to get subtly wrong — conflating them produces a plausible-looking number that is
wrong. This skill is the vocabulary layer; for the sizing/simulation *mechanics* specifically,
use `wfm-sizing-simulation` instead.

## Two rules that prevent most domain bugs

**Never introduce a factor twice.** Shrinkage belongs in the operational→gross conversion,
not in the capacity baseline. Adherence belongs in per-agent capacity. If a factor appears
in both the numerator and denominator of the same ratio, it cancels — and someone will later
"fix" one side and silently break it.

**Know which population a rate is over.** Occupancy over *planned* capacity answers "do I
have enough people?"; occupancy over *actual on-duty* minutes answers "how hard did the
people I had work?". Both are valid; they are not interchangeable, and this codebase
deliberately uses the first for the sizing constraint.

## Deferrable transactions vs. real-time channels

The most common category error: reaching for real-time contact-centre intuition (Erlang-C,
service-level-in-seconds) on backoffice/email work that is fundamentally deferrable.

| | Real-time (voice/chat) | Deferrable (email/case/backoffice) |
|---|---|---|
| Lateness measured in | seconds (caller still on the line) | hours/days (turnaround SLA) |
| Unfinished work | abandons | carries into tomorrow as opening WIP |
| Queue behaviour | empties every interval | legitimately queues across days |
| Per-item deadline | not modelled | drives dispatch order |
| Standard model | Erlang-C | Discrete-event simulation |

This codebase is exclusively the right column. See `wfm-sizing-simulation` for the model
itself.

## Hours taxonomy (the #1 source of double-counting bugs)

`docs/wfm/01-glossary-and-metrics.md` has the full chain:

```
Paid hours → Contracted hours → Scheduled hours → Productive hours → Delivered hours
```

Each arrow subtracts something (unpaid breaks, absence, shrinkage-eligible time, non-productive
activity). Applying a shrinkage-like factor at the wrong arrow — or twice — is the classic
error: per this engine's frozen sizing decisions (see `CLAUDE.md`), shrinkage belongs at
exactly one stage in the chain (Stage 4, gross-up), never in the Stage 2 baseline.

## Term pairs that are routinely conflated

- **Occupancy vs utilisation** — occupancy (this engine) = demand ÷ *planned* capacity, can
  exceed 100% to express overload magnitude. Utilisation = realised busy time ÷ actual
  on-duty time, always ≤ 100%. Different questions, different denominators.
- **Shrinkage vs adherence** — shrinkage = the gap between paid/scheduled time and time
  actually available to work (absence, breaks, training, meetings). Adherence = how closely
  an agent follows their schedule once on shift. Shrinkage converts operational→gross
  headcount (Stage 4 of the sizing chain); adherence scales per-agent capacity in the
  baseline (Stage 2). They must not be applied at the same stage.
- **Headcount vs FTE** — headcount = bodies (operational or gross). FTE = required hours ÷
  contractual hours per FTE. When agent hours are derived from the same horizon/daily-hours
  basis used to compute required hours, `FTE == Operational HC` exactly by construction —
  if they diverge unexpectedly, check which one uses a Manual Override.

## Which `docs/wfm/` file to open

| Doc | Use it when |
|---|---|
| `01-glossary-and-metrics.md` | Any metric definition; the hours taxonomy above |
| `02-copc-standards.md` | Service/quality targets, why an occupancy ceiling sits alongside the SLA target, deferred-transaction responsiveness standards |
| `03-forecasting.md` | Arrival vs workload forecasting, intraday profiles, accuracy measures, why bias matters more than MAPE for capacity |
| `04-capacity-planning-and-sizing.md` | The workload→FTE chain, shrinkage gross-up, backlog carry-in, Erlang-vs-DES comparison, sanity-check checklist |
| `05-scheduling.md` | Turning a sizing number into a roster; coverage vs requirement |
| `06-simulation-des.md` | DES mechanics, dispatch order, CI-gated acceptance, apportionment |
| `07-known-defects-and-decisions.md` | Decision log — check before "fixing" something that may be deliberate; append when you resolve a defect |

## Sanity checks before trusting any sizing number

1. Does `N_min` ≤ recommended HC? (search floor)
2. Does Gross HC ≥ Operational HC? (equality only when shrinkage is zero)
3. Do category shares sum to 1?
4. Is occupancy at the recommendation below the cap? If far below, the binding constraint
   is timing (TAT/deadlines), not raw capacity — worth surfacing to the planner.
5. Is the horizon at least as long as the SLA window? Otherwise attainment is vacuously high.
6. Does N−1 actually fail? That's the evidence the answer is minimal.
