# 02 — COPC-Aligned Practice for Backoffice Operations

> **Scope note.** This describes COPC-*aligned* practice as it bears on sizing decisions in
> this engine. It is a working reference, not a substitute for the COPC CX Standard itself.
> The Standard is versioned and licensed; verify exact requirements, thresholds and clause
> wording against the current official release before making a compliance claim. Nothing
> here should be cited as an authoritative COPC requirement.

---

## What the framework is for

COPC is a performance-management framework for customer-experience operations. Its
relevance to a sizing engine is that it insists a service target is **never optimised in
isolation** — service, quality, cost and employee outcomes are managed together, because
each can be improved by sacrificing another.

That principle is the reason this engine constrains **both** TAT attainment **and** an
occupancy ceiling. A model optimising only for the SLA target will happily return a
headcount that meets service at 98% occupancy — technically passing, operationally
unsustainable, and guaranteed to degrade quality and drive attrition.

## The metric families

| Family | Examples | Relevance here |
|---|---|---|
| **Service** | TAT attainment, service level, responsiveness | The engine's primary constraint |
| **Quality** | Accuracy, error/rework rate | Not modelled — see gap below |
| **Efficiency** | Occupancy, utilisation, AHT, forecast accuracy | Occupancy cap; AHT is an input |
| **Cost** | Cost per transaction | Downstream of Gross HC / FTE |
| **People** | Attrition, absenteeism, satisfaction | Feeds shrinkage assumptions |

## Deferred (non-real-time) transactions specifically

Backoffice work is measured differently from voice, and the distinction drives the whole
design of this engine:

- Service is expressed as **turnaround time** — "X% completed within N business
  hours/days" — not as speed-of-answer within an interval.
- **Abandonment does not exist.** Work waits until someone does it. All demand must
  eventually be served, so unserved work becomes backlog rather than disappearing.
- **Backlog is a first-class quantity.** Opening WIP must be modelled explicitly; a
  deferred-work model that starts each period from an empty queue systematically
  undersizes.
- **The business calendar governs.** A TAT commitment stated in business days must be
  measured against actual operating hours, holidays and weekends.
- **Ageing must be visible.** TAT attainment alone can look healthy while a tail of very
  old items accumulates. Attainment percentage and backlog age are complementary, and
  neither substitutes for the other.

## Occupancy as a managed constraint

Conventional guidance puts sustainable backoffice occupancy around **85%**, and the engine
offers this as the suggested value when the ceiling is set to a custom target — it is *not*
the shipped default. Correction (2026-08-27): this section previously stated 85% "is the
engine's default cap"; the shipped default target is **100%** (physical feasibility only —
the ceiling is always enforced, but resolves to 100% unless a planner opts into a custom,
lower target such as 85%). The reasoning for going below 100% is queueing behaviour, not
comfort: as utilisation approaches 100%, waiting time rises non-linearly, so a team sized to
~100% occupancy has no absorptive capacity for normal variance and converts any demand spike
into a backlog it cannot recover from. Enabling the ceiling at ~85% also protects the quality
and people metrics that a service-only optimisation would silently trade away — but doing so
is the planner's choice, not an engine default. See
`07-known-defects-and-decisions.md` for the related gate defect that made the ceiling inert
regardless of this setting until fixed.

## Forecast accuracy

Capacity plans inherit forecast error. Two points matter for sizing:

- **Bias matters more than dispersion.** A forecast that is 5% low *every* period compounds
  into a persistent, growing backlog. A forecast with ±15% random error but zero bias
  self-corrects. Track bias separately from MAPE and never let a low MAPE reassure you
  about a biased forecast.
- **Accuracy must be measured at the granularity you plan at.** Accurate monthly totals
  built from badly-distributed daily volumes still produce a bad plan.

See `03-forecasting.md`.

## Verification and control

Two habits this codebase already reflects:

- **Prove the recommendation.** The engine reports boundary evidence (why N−1 fails),
  search history, and a confidence interval rather than a bare number. A sizing figure
  nobody can interrogate will not survive contact with a finance review.
- **Reconcile independently.** Agent-timeline invariants are recomputed from a separate
  data path and cross-checked against the headline figures (`verifyAgentTimelineInvariants`).

## Known gap in this implementation

**Quality/accuracy is not modelled.** Rework is real workload: if 5% of cases come back for
correction, effective volume is ~5% higher than the forecast says. The engine currently
sizes against clean volume only. If rework is material in your operation, inflate input
volume (or AHT) to compensate, and record that you have done so — otherwise the same
adjustment will silently be applied twice.

**Backlog ageing is not reported.** The data exists in `CaseRunResult` (`arrival`,
`clockStart`, `completeTime`) but no aged-backlog view is surfaced. See
`07-known-defects-and-decisions.md`.
