# Backoffice WFM Sizing Engine

Headcount sizing for **backoffice deferred-case work** — non-real-time case/ticket
processing measured against a turnaround SLA, where backlog legitimately queues across days.

Ships as a **single self-contained HTML file** that runs entirely offline, with no server,
no network access, and no installation.

---

## Quick start

```bash
npm install
npm run dev              # development server
npm run build:standalone # produces BoWFM.html (the deliverable)
npm test                 # both regression suites
npm run lint             # typecheck
```

`BoWFM.html` is the product: open it directly from disk. It needs no network connection.

## What it does

1. **Ingests demand** — CSV of interval volumes by category, plus opening WIP (backlog).
2. **Computes workload** — `volume × AHT`, plus remaining work on carried-in cases.
3. **Establishes a capacity baseline** — `N_min`, the steady-state floor below which
   backlog grows without bound.
4. **Simulates** — a discrete-event simulation runs 30 replications per candidate
   headcount, dispatching cases earliest-deadline-first against the business calendar.
5. **Searches** — finds the minimum headcount whose 95% confidence interval clears every
   constraint: turnaround SLA, per-category SLA, backoffice ASA, and the occupancy cap.
6. **Converts to a hiring number** — operational headcount → gross/rostered headcount →
   FTE, applying per-category shrinkage.

It reports *why* N−1 fails, so the recommendation is demonstrably minimal rather than
merely asserted.

## Why simulation rather than Erlang-C

Erlang-C models real-time queueing with abandonment — callers hang up. Deferred backoffice
work has no abandonment, has per-case deadlines, and queues legitimately across days.
Applying Erlang-C here typically oversizes badly. See
[`docs/wfm/04-capacity-planning-and-sizing.md`](docs/wfm/04-capacity-planning-and-sizing.md).

## Documentation

**Start here:**

| Doc | Purpose |
|---|---|
| [PRD.md](PRD.md) | Product requirements — what this is, who it serves, every feature as built, and a prioritised backlog of what isn't |
| [project_context.md](project_context.md) | Engineering onboarding and working context — architecture, the frozen design decisions, conventions, common tasks |

**Workforce-planning reference** — read before changing sizing, shrinkage, occupancy, SLA,
forecasting, or simulation logic:

| Doc | Covers |
|---|---|
| [01 Glossary & metrics](docs/wfm/01-glossary-and-metrics.md) | Metric definitions and the **hours taxonomy** (the main source of double-counting bugs) |
| [02 COPC-aligned practice](docs/wfm/02-copc-standards.md) | Service/quality targets, deferred-transaction responsiveness, the occupancy ceiling |
| [03 Forecasting](docs/wfm/03-forecasting.md) | Arrival vs workload forecasting, accuracy, why bias beats MAPE |
| [04 Capacity planning & sizing](docs/wfm/04-capacity-planning-and-sizing.md) | The workload→FTE chain, shrinkage gross-up, Erlang vs DES |
| [05 Scheduling](docs/wfm/05-scheduling.md) | Turning a sizing number into a roster |
| [06 Simulation (DES)](docs/wfm/06-simulation-des.md) | Event loop, replications, CRN, CI acceptance, **monotonicity** |
| [07 Decisions & defect log](docs/wfm/07-known-defects-and-decisions.md) | What is deliberate, what is fixed, what is open |

**Engineering rules** live in [`.cursor/rules/`](.cursor/rules/) and apply to humans and AI
assistants alike — the offline contract, the frozen architecture decisions, the test
protocol, and code conventions.

## Architecture

| Concern | File |
|---|---|
| DES event loop, dispatch, occupancy, agent apportionment | `src/utils/des-engine.ts` |
| Baseline `N_min`, CI-gated search, shrinkage/FTE math | `src/utils/hc-search.ts` |
| Business-time / calendar arithmetic | `src/utils/calendar.ts` |
| CSV ingestion + data-quality validation | `src/utils/csv-parser.ts` |
| Domain types | `src/types/wfm.ts` |
| UI | `src/components/` |

## Two constraints that govern contributions

**Offline, zero runtime dependencies.** No `fetch`, no CDN assets, no web fonts, no
storage APIs, no new runtime dependencies. The build fails loudly if the artifact
references anything remote. See
[`.cursor/rules/00-offline-zero-dependency.mdc`](.cursor/rules/00-offline-zero-dependency.mdc).

**Several design choices are deliberate and must not be "simplified"** — DES over Erlang-C,
EDF dispatch, the planned-horizon occupancy denominator, `N_min` as a hard floor, the
harmonic shrinkage blend, and house-monotone agent apportionment. Each looks like something
worth tidying and is not. See
[`.cursor/rules/10-architecture-required-hc-chain.mdc`](.cursor/rules/10-architecture-required-hc-chain.mdc).

## Testing

```bash
npm test              # verify-fixes.mts (138) + verify-sizing-fixes.mts (58)
npm run test:sizing   # sizing-chain suite only
```

Every behavioural fix needs a test that **fails before the fix and passes after**. No test
framework may be added — that would breach the zero-dependency rule; both suites use a
plain assert helper. See
[`.cursor/rules/20-testing-protocol.mdc`](.cursor/rules/20-testing-protocol.mdc).

<!-- auto-push hook test 2026-08-28T16:33:13Z -->
