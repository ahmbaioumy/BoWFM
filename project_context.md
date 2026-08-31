# Project Context — Backoffice WFM Sizing Engine

> **Who this is for.** Both a new engineer joining the project and an AI assistant working in
> this repository. It is written to be read start to finish once, then used as a reference.
> It is **self-contained** — you should not need to read other files to become productive,
> though pointers to deeper material are given where they exist.
>
> **If you read only one section, read [§6 Frozen decisions](#6-frozen-decisions).** This
> codebase contains several deliberate design choices that look like obvious candidates for
> simplification and are not. Changing one without understanding it produces a
> plausible-looking number that is wrong — which, in a capacity-planning tool, is worse than
> an obvious crash.

---

## Contents

1. [Orientation](#1-orientation)
2. [Getting started](#2-getting-started)
3. [Environment gotchas](#3-environment-gotchas)
4. [Architecture map](#4-architecture-map)
5. [The Required-HC chain](#5-the-required-hc-chain)
6. [Frozen decisions](#6-frozen-decisions)
7. [Domain primer](#7-domain-primer)
8. [Conventions](#8-conventions)
9. [Testing](#9-testing)
10. [Common tasks](#10-common-tasks)
11. [State of the codebase](#11-state-of-the-codebase)
12. [Where to look for what](#12-where-to-look-for-what)

---

## 1. Orientation

This is a **workforce-planning sizing tool for backoffice deferred-case work** — claims,
tickets, case management: work that arrives, queues legitimately for hours or days, and is
measured on turnaround time rather than speed of answer.

It answers one question: *how many people do we need to hire to meet our turnaround
commitment?* It does so by running a **discrete-event simulation** of individual cases ageing
against their own deadlines, across 30 replications per candidate headcount, and accepting a
headcount only when its configured confidence interval (default 95%; 90/95/99 on SLA Defaults)
clears every constraint.

It is a **React 19 + TypeScript + Vite + Tailwind** single-page app with no backend, and it
ships as **one self-contained HTML file** that runs entirely offline from `file://`.

Four things make it unusual, and all four constrain how you work on it:

1. **Zero network, zero runtime dependencies.** No `fetch`, no CDN, no storage APIs, no
   telemetry. The build fails loudly if the artifact references anything remote.
2. **The domain is precise and easy to get subtly wrong.** "Occupancy", "shrinkage",
   "adherence", "headcount" and "FTE" are distinct quantities that are routinely conflated;
   conflating them yields a number that looks fine and is not.
3. **Several design choices are deliberate and non-obvious** (§6).
4. **Correctness is testable and tested** — 251 automated checks plus an independently
   hand-derived ground-truth dataset.

---

## 2. Getting started

### Prerequisites
Node.js 20+ (developed on 24) and npm. Nothing else.

### Install and run

```bash
npm install
npm run dev               # dev server on :3000
```

### The four commands that matter

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm test` | Both regression suites (251 checks) + artifact freshness |
| `npm run lint` | `tsc --noEmit` typecheck |
| `npm run build:standalone` | Produces `BoWFM.html` — **the actual deliverable** |
| `npm run check:artifact` | Fails if `BoWFM.html` is missing or older than `src/` / build inputs |

Also available: `npm run test:sizing` (the faster sizing-chain suite alone), `npm run build`
(regular Vite build), `npm run clean`.

### The deliverable

`npm run build:standalone` writes **`BoWFM.html`** (~513 KB) to the repo root. That single
file *is* the product: all CSS and JavaScript inlined, no assets, no server. Open it directly
in a browser — including with no network connection at all. This is the artifact users
receive, so **always verify a change against the standalone build**, not just the dev server.

A Cursor `stop` hook (`.cursor/hooks/ensure-artifact-fresh.mjs`) and `npm run check:artifact`
enforce that agents cannot finish with a stale artifact — see
`.cursor/rules/50-docs-and-artifact-sync.mdc`.

### Before you consider any change done

```bash
npm run lint && npm test && npm run build:standalone && npm run check:artifact
```

---

## 3. Environment gotchas

Four things that will cost you time if you do not know them.

### 3.0 Cursor workspace root vs nested app repo

This zip often opens as a **parent** folder (`Bo_4Final-main (2)/`) that only contains the
inner app directory `Bo_4Final-main/`. Cursor loads project rules and hooks from the
**workspace** `.cursor/`, not from nested folders.

- Workspace-root `.cursor/` is a **bridge**: same `alwaysApply` rules + `stop` hook that
  resolve the app under `Bo_4Final-main/` and gate a stale `BoWFM.html`.
- Prefer opening the inner `Bo_4Final-main/` folder directly as the Cursor workspace so
  npm, rules, and hooks share one root.
- When the parent folder is open, run `npm …` from `Bo_4Final-main/` (where `package.json`
  lives). See `.cursor/rules/50-docs-and-artifact-sync.mdc`.

### 3.1 `tsx` fails with a `TransformError` about platform binaries

**Symptom:** any `npx tsx …` command dies with an esbuild error mentioning platform packages
and `supportedArchitectures`.

**Cause:** esbuild ships prebuilt platform-specific binaries. If `node_modules` was installed
on (or copied from) a different architecture, the binary for *your* platform is missing. This
project was developed on **win32-arm64**, and the checked-in dependency tree initially
contained only **win32-x64** — so no test and no build could run at all.

**Fix:**
```bash
npm install --no-save @esbuild/win32-arm64      # substitute your platform
```
Check what you have with `ls node_modules/@esbuild/` against
`node -p "process.platform + ' ' + process.arch"`.

### 3.2 There is no git repository

`git rev-parse` fails — there is no `.git` anywhere. **There is no undo, no diff, and no
history.** Read files before overwriting them, keep changes surgical, and strongly consider
`git init` before any substantial work.

### 3.3 Plain `node file.ts` will not run these sources

Node 24 strips TypeScript types natively, so it is tempting to skip `tsx`. It will not work
here, for two reasons: the sources use **extensionless relative imports** (`from './calendar'`),
which Node's ESM resolver rejects; and they import types as **value imports**
(`import { CalendarConfig } from '../types/wfm'`) rather than `import type`, which type
stripping cannot erase. Use `tsx`.

---

## 4. Architecture map

### Directory tour

```
Bo_4Final-main/
├── BoWFM.html                    ← THE DELIVERABLE (generated)
├── index.html                    ← dev entry point
├── PRD.md                        ← product requirements (as-built)
├── project_context.md            ← this file
├── README.md
├── metadata.json                 ← app manifest (see §11 — contains a stale flag)
├── test_complaint.csv            ← real sample input, 5,952 rows
├── trusted-source-validation.json ← hand-derived ground truth (see §9.2)
├── .cursor/rules/                ← enforced engineering rules (5 files)
├── docs/wfm/                     ← workforce-planning domain reference (7 files)
├── scripts/
│   ├── build-standalone.mts      ← inlines everything into BoWFM.html
│   ├── verify-fixes.mts          ← legacy regression suite (156 tests)
│   ├── verify-sizing-fixes.mts   ← sizing-chain suite (95 tests)
│   └── check-artifact-freshness.mts ← BoWFM.html mtime gate
└── src/
    ├── App.tsx                   ← state machine, navigation, orchestration
    ├── types/wfm.ts              ← all domain types
    ├── utils/                    ← THE ENGINE
    │   ├── des-engine.ts         ← discrete-event simulation
    │   ├── hc-search.ts          ← baseline, CI search, shrinkage/FTE math
    │   ├── calendar.ts           ← business-time arithmetic
    │   └── csv-parser.ts         ← ingestion + data-quality validation
    └── components/               ← UI, one component per flow
```

### Module responsibilities

| Module | Owns |
|---|---|
| `utils/des-engine.ts` | The event loop, case dispatch (EDF), agent state, parking/resume, occupancy, siloed agent apportionment, timeline invariant checks |
| `utils/hc-search.ts` | The analytical baseline `N_min`, the CI-gated headcount search, and the shrinkage → Gross HC → FTE staffing math |
| `utils/calendar.ts` | **All** business-time arithmetic: working days, open/close windows, holidays, add/subtract working time |
| `utils/csv-parser.ts` | Delimiter detection, flexible date parsing, column mapping, category discovery, the 14 data-quality rules, CSV export |
| `types/wfm.ts` | Every domain type. Read this first when orienting. |
| `App.tsx` | All application state (no router, no store — plain `useState`), navigation, and the run orchestration |
| `components/*` | One per sidebar flow, plus the progress modal, params inspector and reset modal |

### Data flow

```
CSV file
  → parseCSVRaw()              delimiter detection, RFC 4180 state machine
  → autoSuggestColumnMapping() header + value heuristics
  → mapRawRecordsToIntervals() StandardInterval[]
  → discoverAndSyncCategories() CategoryConfig[]
  → validateDataQuality()      DQResult — the blocking gate
  → searchOptimalHCAsync()     ← the UI entry point
        ├─ analytical baseline N_min
        ├─ generateCaseEntities() × R replications  (Common Random Numbers)
        ├─ runBackofficeDES() per candidate × R     (the simulation)
        ├─ CI-gated accept/reject per candidate
        └─ calculateStaffingRequirement()           (shrinkage → Gross HC → FTE)
  → HCSearchOutput → ResultsFlow
```

**Note:** `searchOptimalHC` (sync) also exists and is used only by the test harnesses. The two
have drifted — see §11.

### UI flow model

Five sidebar flows, each with sub-tabs; free-form navigation with **one** hard gate before
running the simulation.

```
1. Demand & Inflow   Upload · Column Map · Business Calendar · Data Quality · Opening WIP
2. Labor & Config    Labor & Productive Hours · SLA Defaults · Categories
3. Run Sizing        Pre-flight · Simulate
4. Results & Audit   Summary · Staffing Path · Case Browser · Agent Browser ·
                     Queue/WIP · Audit Drill · Assumptions
5. Sensitivity       Scenarios Matrix · Compare Scenarios
```

**Summary tab card order** (`ResultsFlow.tsx`, `currentTab === 'summary'`) — fixed JSX sibling
order, not a dynamic list:

1. Infeasibility alert (conditional)
  Dual Sizing Engine Verified headline banner (Net / Gross + planner strip)
3. Backoffice DES Sizing Engine record (mirrors completed `SimulationProgressModal`)
4. Primary SLA-Driven Requirement
5. Core Performance Grid
6. Per-Category Sizing Breakdown
7. Mathematical Invariants Audit (M1–M4, display-only)

State lives entirely in `App.tsx` as `useState`. Two derived memos drive almost everything:
`intervals` (from raw rows + column mapping) and `dqResult` (from intervals + config).
**Nothing persists** — no `localStorage`, no backend; a refresh loses everything.

---

## 5. The Required-HC chain

The single most important thing to understand. Four stages, each answering a different
question. Most sizing bugs are a factor applied at the wrong stage.

### Stage 1 — Demand → Workload
`hc-search.ts` `calculateStaffingRequirement` (~line 58) and the baseline block in the search.

```
Workload_hours = Σ (Volume_c × AHT_c / 60)  +  Σ openingWIP_remaining_minutes / 60
```

Per category, because AHT differs by category and a mix shift changes workload with flat
volume. Opening WIP uses *remaining* work, not full AHT.

### Stage 2 — Workload → analytical baseline `N_min`
`hc-search.ts` `computeAnalyticalNMin` / `resolveAgentHoursForNMin`.

```js
const { agentHours } = resolveAgentHoursForNMin(labor, workingDaysInHorizon);
// override only if source==='override' && hours > 0; else daily × days
const oMax = resolveOccupancyCapPct(sla) / 100; // 1.0 by default (toggle off) — see §6.3a
const denominator = oMax * agentHours * effectiveAdherence;
const nMinAnalytical = Math.max(1, Math.floor(totalWorkloadHours / denominator));
```

The steady-state floor (Workload HC). **Shrinkage is deliberately absent** — `N_min` is *operational*
headcount; shrinkage converts to rostered headcount at Stage 4. Manual Override default hours = 0.

### Stage 3 — Baseline → recommended headcount
`hc-search.ts` `searchOptimalHCAsync` (~line 949).

Leap upward in doubling steps to a passing ceiling, then **walk down by −1, stopping at the
first failure**. Each candidate is evaluated over 30 replications under Common Random Numbers,
and passes only when the configured CI bound (`sla.confidenceLevelPct`, default 95, range
50–99.9) clears every constraint. For Primary SLA (global and per-category), the pass line is
`effectivePrimaryTarget(officialPct, sla)`: when `slaAcceptanceSlackEnabled` is OFF (default),
that equals the official Primary %; when ON, it is `Primary% × (1 − slaAcceptanceSlackPct/100)`
(slack clamped 1–20). Deadlines, EDF dispatch, N_min, occupancy, and ASA are unchanged by
slack. t-critical values come from continuous `getTCrit(df, level)` (Acklam + Cornish–Fisher).
If HC equals `N_min`, CI is not binding.

> **This walk-down is only valid if pass/fail is monotone in N.** See §6.10 — that assumption
> was violated by a real defect, and the guard against it must not be removed. DES pass/fail
> monotonicity itself (as opposed to the apportionment/placement *output* monotonicity §6.10
> covers) remains an open, undischarged assumption — no proof exists anywhere in this
> codebase. The D39 empirical sweep (`verify-sizing-fixes.mts`) found no violation for the
> uniform-only predicate across N=1..25 on one config; that is evidence consistent with the
> assumption, not a proof, and the walk-down's safety (only ever returning a
> verified-passing N) does not depend on it holding — a violation would cost minimality, not
> safety. See `docs/wfm/07-known-defects-and-decisions.md` follow-up #6.

### Stage 3a — Deadline-coverage shift placement (opt-in)
`hc-search.ts` `computeShiftPlacement` / `computeCandidatePlacementDistribution` /
`pickPlacementOrUniform`; `calendar.ts` `getValidSlapStarts`; `des-engine.ts` staggered
`AgentAvailable` scheduling.

Root cause: every agent starts one uniform shift at business open; if
`dailyProductiveHours < businessWindowHours`, a persistent backlog exhausts every agent's
budget in lockstep, leaving the tail of the window permanently uncovered regardless of N.

`labor.shiftPlacementEnabled` (default `false`) lets `evaluateN` also try a shift-start
distribution before rejecting a candidate that fails under uniform start. The distribution is
computed **analytically, with zero extra DES runs**: every case's release (`clockStart`) and
deadline (`primaryDeadline`) are known before simulation, so a release-gated deadline-coverage
condition — a Hall/Horn-style feasibility check, bucketed to the same 30/60-min grid as valid
shift starts (`DemandGrid`, `buildOneDayDemandGrid`) — can be evaluated directly. A greedy
(`computeShiftPlacement`) places agents one at a time onto whichever grid window is currently
most under-covered, preferring the discriminating window over one every offset serves
identically (a whole-day-spanning window, for instance, is offset-invariant and must not
dominate the "worst" selection — see the function's doc comment for the measured failure mode
this guards against).

**House-monotone by construction**: the loop never depends on the target N, only on what's
been placed so far, so `place(N+1)` is always `place(N)` plus one agent, never fewer anywhere
— the same property, for the same reason, as §6.10's apportionment.

**Never-worse guarantee**: `pickPlacementOrUniform` only replaces the uniform-start result
when the placed distribution *verifiably passes* the same CI-gated check via a real DES run.
`N_min` stays the frozen hard floor unconditionally; two additional analytic floors
(`occupancyFeasibleFloor` / N_occ, and `shiftPlacement.placementFeasibleFloor` / N_sla) are
surfaced as diagnostics only, never as gates.

**Honest status**: the *safety* property above is solid and tested (D25). The *value*
property — whether placement reliably finds a better distribution on realistic demand — is
not: tested across many demand shapes, the raw distribution was frequently no better than,
sometimes worse than, uniform-start; it demonstrably can find a real improvement on a demand
shape purpose-built to need one (D22, verified against brute force). See PRD §6 Stage 3a and
`docs/wfm/07-known-defects-and-decisions.md` D20 for the full writeup, including a serious
eligibility-computation defect found and fixed during verification, and the known same-day-
SLA-window scope limit.

**2026-08-28 — N_sla walk-down safety-net fix (Gap A), adherence/capacity conflation (Gap B),
phantom API removed (Gap G).**
- **Gap A**: `pickPlacementOrUniform` only guarded the per-N placement-vs-uniform choice, but
  `placementFeasibleFloor` (N_sla) separately raised the search's STARTING N, and when that
  raised start passed immediately, the walk-down was skipped entirely — no verification ran
  in that path. Measured: 2 of 192 swept configs recommended a strictly higher headcount
  with the flag on than off. Fixed by removing N_sla from `startN`'s `Math.max(...)` in both
  `searchOptimalHC` and `searchOptimalHCAsync` — it remains reported as
  `HCSearchOutput.shiftPlacement.placementFeasibleFloor`, purely diagnostic now. D34 pins the
  exact falsifying config (9-17 open, 7.5h shift, evening-heavy: was off=14/on=15, now
  off=on=14) in both sync and async.
- **Gap B**: `shiftCapacityWithinDay` (feeding `computeShiftPlacement` /
  `findPlacementFeasibleFloor`) was credited un-adhered `dailyProductiveHours×60` per agent
  while the DES budget applies adherence — a measured 25% over-credit at adherence 0.8.
  `getValidSlapStarts`' window-fit test correctly keeps the un-adhered figure (a SPAN
  question — physical presence — not a capacity one); only the deficit/capacity-facing calls
  in `computeCandidatePlacementDistribution` and both search entry points' N_sla computation
  were changed to `dailyProductiveHours × adherence × 60`. D35 pins a closed-form example
  (N_sla=3 correct vs N_sla=2 buggy on a hand-computed scenario) and confirms the production
  search path reports the corrected value.
- **Gap G**: `LaborConfig.shiftPlacementMaxAttempts` was documented in detail (multiple
  distributions verified per candidate N) but never implemented anywhere, and the function
  its doc comment cited did not exist. Rather than build an under-verified multi-attempt
  search under time pressure — a version affecting accept/reject needs a monotonicity proof
  this pass didn't have room to do rigorously — the phantom field and its doc comment were
  removed. Confirmed via `grep` that no other code referenced it before removal.
- All three verified together: legacy suite 174/174 (unaffected), sizing suite 199/199
  (190 prior + D34's 4 + D35's 5).

**2026-08-28 — minimum-coverage floor (G1) + flag-independent redistribution repair.**
`SLAPolicyConfig.minCoverageEnabled`/`minAgentsPerInterval` (default: enabled, 1 — unlike
every other toggle on this tab, omission means ON, not off), mirroring the
`occupancyCapEnabled`/`occupancyCapPct` pattern. `DESResult` gained `minCoverageObserved`/
`passesCoverage`, tracked MODE-INDEPENDENTLY (works under `skipCaseResultsAndTimeline`,
which the CI-gated search replications always use) via `countAgentsOnShiftNow()` — built
entirely from state already maintained in both modes (`agentOnShiftToday`,
`agentDailyMinutesRemaining`), sampled at every event type that can change the count
(`AgentAvailable`, `ShiftEnd`, `CasePark`, `ProcessingComplete`). Aggregated across
replications as a hard floor, not a CI-gated mean like SLA/occupancy/ASA: the WORST
replication must individually satisfy it. Folded into `passesAllConstraints` in both
`runBackofficeDES` and `computeStatisticalEvaluation`.
**The critical safety piece**: `buildCoverageRepairDistribution` (`hc-search.ts`) computes
the minimal redistribution needed to satisfy the floor via a classic greedy minimal interval
cover (repeatedly pick the largest valid start at/before the current covered frontier),
moving the fewest possible agents off offset 0. Wired into both `evaluateN` and
`evaluateAsync` UNCONDITIONALLY — independent of `shiftPlacementEnabled` — because G1 is not
optional; without this, turning the floor on by default would exhaust every search whose
business window exceeds the shift length once `shiftPlacementEnabled` is off. Runs before
the existing SLA-driven greedy so a coverage-only need is resolved without paying for a
deficit-minimizing search. A real bug was caught by the suite's own fail-first check
(D33.4): the first version left offset 0 with zero agents whenever N exactly matched the
non-zero offsets' requirement, since offset 0 was treated as "whatever's left" rather than
independently required to meet the floor too — fixed by requiring `(nonZero.length + 1) ×
minAgentsPerInterval` seats, not just `nonZero.length × minAgentsPerInterval`.
**Proven on the field-reported config**: moving a single agent from 08:00 to 13:00 fixes a
genuine coverage violation at zero SLA cost (100% → 100%, same 33 heads) — see D33's
integration test, which runs the FULL search with `shiftPlacementEnabled` omitted and
confirms an identical recommendation with the floor on vs off. UI: a "Minimum Coverage
Floor" toggle in SLA Defaults (`ConfigFlow.tsx`, mirroring Occupancy Ceiling exactly) and a
"Minimum Coverage" results card next to Occupancy (`ResultsFlow.tsx`), both verified in a
live dev-server pass (toggle disables/enables the input correctly, zero console errors).
D32 (12 assertions: defaults, clamping, genuine detection, exact parity when disabled) and
D33 (8 assertions: unit behavior, the too-small-N null case, and the full-search integration
proof) — legacy suite 174/174 and prior sizing suite unaffected (190/190 total).

**2026-08-28 — shift-end enforcement + in-flight handover (non-24×7).** A root cause of the
weak *value* property above: staggeredMode gave every agent a real START but no END — an
agent stayed available (bounded only by daily budget) all the way to business close
regardless of shift length, so the analytic model's assumption of capacity confined to
`[offset, offset+shiftLength]` did not match what the simulator did. Fixed: each staggered
cohort now gets a real `ShiftEnd` event (`des-engine.ts`, skipped when it would coincide with
`DayClose`), and `dispatchSingleQueue`'s look-ahead gained a third bound — the agent's own
remaining shift minutes — alongside budget and business close. When shift-end is the binding
constraint, an in-progress case is handed back to the live queue immediately (not parked to
`parkedWIP` for next-day resume — that stays `DayClose`-only) so a still-on-shift colleague
picks it up the same day. D30/D31 suites (11 assertions) pin: mid-day cutoff genuinely
enforced, a shift ending exactly at close is NOT cut off early, invariants hold, and a
genuinely interrupted case is completed same-day by a different agent. **Scoped to non-24×7**
— `is24x7` calendars still have zero staggering (`getValidSlapStarts` returns `[0]`) and are
completely unaffected; real 24×7 multi-start (circular day grid, shifts wrapping midnight) is
tracked as its own follow-up, not yet implemented.

### Stage 4 — Operational HC → Extra OFF Roster Uplift → Gross HC / FTE
`hc-search.ts` `calculateStaffingRequirement` / `computeExtraOffPct`.

DES seats are calendar-open days only. The extra OFF roster uplift is applied **once** after
the search:

```js
extraOffDays = max(0, labor.offDaysPerWeek - calendarClosed); // calendarClosed = 7 - openDays
coverageDays = openDaysPerWeek - extraOffDays;      // days/week one agent actually covers
offPct = extraOffDays / 7;          // DISPLAY fraction only — never the applied multiplier
operationalHCWithOff = coverageDays > 0
  ? Math.floor((operationalHC * openDaysPerWeek) / coverageDays)
  : operationalHC;                  // rosterInfeasible: flagged in bindingConstraint, not silently 1x
opHCCat = operationalHCWithOff * share;
grossHCCat = opHCCat / (1 - shr);
grossHCTotal = Math.round(sumGrossHC);
effectiveShrinkagePct = 1 - 1 / Σ(share / (1 - shr));   // harmonic; OFF not mixed in
```

**Fixed 2026-08-28 (D40 in `verify-sizing-fixes.mts`, `T1_A2c` in `trusted-source-validation.json`):**
the multiplier used to be `(1 + offPct)`, i.e. `operationalHC * (1 + extraOffDays/7)` — dividing
by the *calendar* week. Agents only supply capacity on *open* days, so the correct multiplier is
the coverage ratio `openDaysPerWeek / coverageDays`. The two agree only when `extraOffDays = 0`
(the default 5-day-calendar/5-day-Labor config, which is why this shipped unnoticed); otherwise
the old formula **under-staffed**, worsening as off days rose (measured: 6-open/2-off gave 114
instead of the correct 120; 5-open/5-off gave 142 instead of 250). Computed integer-exact as
`floor(N * openDays / coverageDays)`, never `floor(N * (1 + fractionalUplift))` — the latter
loses a seat to binary float error in real configs (24×7 + 5-day agents at N=45: `62.999999999999999
→ 62`, not 63). `offPct` (`extraOffDays/7`) is kept as a **display-only** fraction — it is no
longer, and never correctly was, the applied multiplier.

`operationalHC` on the result remains the simulator N. Headline **Net Operational HC** and
Stage 4 Gross/FTE use `operationalHCWithOff`. The headline subtitle now shows both figures:
`X% OFF → +Y% roster uplift` (X = `offPct` display fraction, Y = the coverage-ratio uplift
actually applied) — showing only `offPct` would have been the same silent under-statement the
formula fix corrects.

Gross up **per category with its own rate**, then sum, then apply a **single** rounding.
`N_min` and `operationalHCWithOff` truncate (`floor`); the final pooled `grossHCTotal` uses
normal rounding (`round`) — see §6.7 for the rationale behind this split.

---

## 6. Frozen decisions

Ten decisions that look wrong and are right. **If you are about to change one of these, read
its entry first.**

### 6.1 DES, not Erlang-C
*Looks like:* a missing standard formula.
*Actually:* Erlang-C models real-time queueing with abandonment, waiting in seconds, and no
per-item deadline. Deferred work has no abandonment, has per-case deadlines, and queues across
days. Applying Erlang-C here oversizes badly. There is deliberately no Erlang formula in this
codebase.

### 6.2 Earliest-Deadline-First dispatch
`des-engine.ts` `CaseMinHeap.compare`.
*Looks like:* an over-complicated queue sort that could be FIFO.
*Actually:* EDF is optimal for maximising on-time completions under deadline scheduling. Cases
are ordered by *Latest Safe Start*, derived by walking **backwards through the business
calendar** — not wall-clock subtraction, because a case needing four hours against a
09:00-tomorrow deadline cannot start at 23:00 tonight.

### 6.3 Occupancy uses the **planned-horizon** denominator
`des-engine.ts` (~line 1258).
*Looks like:* a bug, because the simulation drains work past the horizon end but the
denominator does not widen, so occupancy can exceed 100%.
*Actually:* occupancy here is a **demand ÷ planned-capacity ratio**, and values above 100% are
the overload signal ("you need 43% more capacity"). Widening the denominator across drain days
would make an undersized team look *adequately utilised because it took extra weeks to
finish* — inverting the signal.

> This was challenged during an audit and confirmed correct on three independent grounds: the
> test `BUG-OCC-ROOT` asserts the denominator **stays** on the planned horizon; `wfm.ts`
> documents `rawOccupancyPct` as showing "true overload magnitude"; and the UI renders it as
> "capacity ratio". The per-agent `busy/(busy+idle)` figure in `ResultsFlow.tsx` is a
> *different, legitimate* metric, not a competing calculation.

### 6.3a Occupancy ceiling gate was inert — fixed 2026-08-27
*Looks like:* the metric bug above (6.3) — a run showing "Occupancy 100% (102.4% true)" and
status PASS looks like the same >100% signal being misread.
*Actually a different, real bug:* the metric (6.3) was always correct; the **gate** that is
supposed to reject a candidate above the target compared the **clamped** value —
`Math.min(100, rawOccupancyPct) <= sla.occupancyCapPct` — and with `occupancyCapPct` capped at
100 by the UI, `Math.min(100, raw) <= 100` is true for every input. The ceiling never rejected
anything, on or off. The statistical path (`hc-search.ts` `evaluateCandidateStatistical`) had it
twice: occupancy samples were built from the clamped `occupancyPct`, then the CI upper bound was
clamped again, so an overloaded candidate's CI collapsed to a point at 100 instead of the true
ratio. `occupancyCapEnabled: true` had zero test coverage anywhere in the repo before this fix.

Fixed by `resolveOccupancyCapPct(sla)` (`des-engine.ts`) — a single resolver every gate now
calls, returning 100 when the toggle is off (physical-feasibility-only default; ρ≥1 is an
unstable queue) or the clamped custom value when on — and gating on `rawOccupancyPct`
(unclamped) instead of the display-clamped value. `occupancyCapEnabled` changed meaning from
"enable a ceiling" to "use a custom target instead of the 100% default"; every
`!sla.occupancyCapEnabled ||` short-circuit on the pass predicate was removed (both the sync and
async `bindingConstraintType` blocks — same duplication hazard as §6.10/6.2).

**Deliberately not changed:** the default target stays 100%, not the COPC-aligned ~85%
suggested in the UI. This is a correctness fix, not a policy change, and it is provably neutral
for every already-valid scenario: `Math.min(100, raw) <= 100` and `raw <= 100` agree everywhere
except `raw > 100`, so `N_min`, recommended HC and Gross HC are bit-identical wherever occupancy
was already ≤100%. Only a previously-infeasible (>100%) recommendation moves, and only up to the
smallest feasible headcount. Pinned by `BUG-OCC-CAP` (`scripts/verify-fixes.mts`), which also
carries a no-regression assertion (`BUG-OCC-NEUTRAL`) that `computeAnalyticalNMin`'s `oMax`
with the toggle off is algebraically identical to the pre-fix `1.0`.

### 6.4 `N_min` is a hard floor for the search
*Looks like:* an unnecessary constraint that could hide a smaller valid answer.
*Actually:* the simulation grants a drain window past the horizon. Without the floor, a
headcount below the steady-state line could "pass" by exploiting that finite-horizon edge
effect while being unsustainable in a repeating period.

> **Update (explicit human approval):** `N_min` now truncates (`Math.floor`) rather than
> rounds up (`Math.ceil`) the raw workload/capacity ratio (e.g. 1.125 → 1, not 2). This
> makes the floor slightly looser at fractional ratios; the DES/CI-gated search above it
> still has to clear the SLA/occupancy bounds, so a genuinely under-sized headcount is
> still rejected at Stage 3 — floor vs ceil only changes where the search *starts*, not
> what it accepts. Tests `BUG-J` (`scripts/verify-fixes.mts`) and `D11.4`–`D11.8`
> (`scripts/verify-sizing-fixes.mts`) pin the new floor values.

> **Second Update (explicit human approval):** A **Workload Reduction** toggle now allows
> planners to discount modelled workload by a user-specified %. This is an opt-in lever that
> re-exposes the finite-horizon edge-effect risk: a discounted workload can now pass by
> exploiting the drain window when the true steady-state is higher. Mitigation: the toggle is
> OFF by default (preserving the guardrail for all existing runs), DES/CI gates still bind
> above the discounted floor (the search is DES-authoritative, not overridden), and results
> visibly label where the reduction was applied and show both the reduced and unreduced
> `N_min`. Use only with explicit planner intent and awareness of the trade-off. Tests pinning
> the reduced-floor math are `D12.*` in `scripts/verify-sizing-fixes.mts`.

> **Third Update — `WLR-DEAD`, fixed 2026-08-31.** The reduction above was applied **only**
> inside `computeAnalyticalNMin`, which made it a guaranteed **no-op on the recommendation**.
> The search starts at `startN = max(N_min, N_occ)` and never explores below it, and
> `computeOccupancyFloor` did not take the reduction — under the default derived-hours basis
> both floors share a denominator, so `N_occ = ceil(X)` while `N_min = floor(X·(1−r))`, i.e.
> `N_occ >= N_min` for every `r`. `startN` was pinned to the un-reduced `N_occ`. Measured on
> the real engine: a **50% reduction moved neither `recommendedHC` (16 → 16) nor `grossHC`
> (20 → 20)**. Discounting only the analytic floor could never have worked anyway, because
> `generateCaseEntities` still simulated full demand and the DES occupancy gate would have
> pushed any lower candidate straight back up.
>
> The reduction is now applied **once, to category AHT** (`applyWorkloadReductionToCategories`
> in `hc-search.ts`), so all four stages size against the same reduced workload. AHT is the
> right single point of application: `workload = volume × AHT`, so a `(1 − r)` factor reduces
> workload by exactly `r%` with no integer-rounding loss, leaves case counts (and therefore
> every SLA attainment denominator) untouched, and is seen identically by Stage 2 floors,
> Stage 3 DES and Stage 4 gross-up because all three derive workload from `cat.ahtMinutes`.
> `computeAnalyticalNMin` is deliberately **no longer** passed `workloadReduction*` — the
> workload it receives is already reduced, and passing both would double-apply. Post-fix
> measurement: 50% reduction → `recommendedHC` 16 → 8, `grossHC` 20 → 10. Tests: `D42.1`–`D42.9`.
> Opening WIP with an explicit `remainingWorkMinutes` is **not** discounted (measured work in
> flight, not a forecast assumption); unconfigured categories keep the un-reduced 30-min default.

> **`BIND-LABEL`, fixed 2026-08-31.** `bindingConstraintType` was decided by
> `recommendedHC === nMinAnalytical`, but the search starts at `max(N_min, N_occ)` and
> `N_occ = N_min + 1` in **533 of 540** swept workloads, so that test almost never fired even
> when the floor was exactly what bound. Control fell through to the default
> `statistical_primary_sla` / "Primary SLA … Target" description — surfaced to planners at
> `ResultsFlow.tsx:516`, `:1533`, `:2258`. The result: the UI named SLA as the binding
> constraint in precisely the runs where sweeping the SLA target across 50–99% provably moved
> nothing. Both search paths now capture `searchStartN` and attribute the result to the
> capacity floor whenever `recommendedHC === searchStartN`, naming `N_occ` when the occupancy
> floor is the higher of the two. A genuinely SLA-bound run (turnaround window near AHT) is
> still labelled `statistical_primary_sla` — pinned by `D42.14`/`D42.15` against
> over-correction. Tests: `D42.10`–`D42.15`.
>
> **Known modelling property (not a defect), measured 2026-08-31:** SLA targets are inelastic
> across most of their range. Once headcount clears the workload, EDF dispatch on deferrable
> work finishes cases far inside any multi-hour window, so attainment snaps to 100% and the
> target has nothing to bite on. Sweeping Primary % 50→99 or the window 2h→48h changed the
> recommendation by zero agents; the gate only bound once the window approached AHT (30–60 min
> against a 30-min AHT). Expect workload, occupancy cap, adherence and productive hours to be
> the real levers. See PRD §10 `L16`.

### 6.4a Extra OFF is a coverage ratio, not a calendar-week fraction
*Looks like:* `(1 + extraOffDays/7)` — off days as a share of the 7-day week, symmetric with
how `offPct` is displayed.
*Actually:* agents only ever supply capacity on calendar-**open** days, so the seat-to-roster
multiplier is `openDaysPerWeek / coverageDays` (`coverageDays = openDaysPerWeek - extraOffDays`),
not `1 + extraOffDays/7`. The two are the same quantity only when `extraOffDays = 0`; otherwise
dividing by the calendar week instead of the open week under-counts the roster, worse as off
days rise. This shipped as a real defect for over a year because the default config
(5-day calendar, 5-day Labor) always has `extraOffDays = 0`, so the bug never triggered under
default settings — see the Stage 4 fixed-2026-08-28 note above and `docs/wfm/07-known-defects-and-decisions.md`.
`offPct` (`extraOffDays/7`) remains a legitimate **display** fraction ("1 extra off day in 7");
it was never correctly the multiplier applied to seats, and still isn't.

### 6.5 Shrinkage applied once, at Stage 4 only
*Looks like:* an omission in the capacity baseline.
*Actually:* `N_min` is operational (on-the-floor) headcount. Shrinkage converts that to people
employed. Applying it in both places is the classic WFM double-count.

### 6.6 Harmonic effective-shrinkage blend
*Looks like:* an over-engineered average.
*Actually:* gross-up divides by `(1 − shr)`, so the quantity that adds linearly is
`1/(1 − shr)`, not `shr`. Two equal-share categories at 10% and 30%: arithmetic gives 20%
(factor 1.250); correct harmonic gives **21.25%** (factor 1.270). Pinned by test `D7.10`.

### 6.7 Per-category gross-up → sum → **one** rounding
*Looks like:* it could be simplified to a blended rate, or to per-category rounding.
*Actually:* blending first loses per-category structure; rounding per category compounds
error once per category instead of once at the pool.

> **Update (explicit human approval):** the pooled total's rounding changed from `Math.ceil`
> to `Math.round` (16.2 → 16, 16.7 → 17) — this is the final Gross HC number a planner
> hires to, and the always-round-up rule was overstating it. `N_min` (§6.4) and
> `operationalHCWithOff` upstream still truncate (`Math.floor`), not round — only the
> pooled `grossHCTotal` uses normal rounding. Tests `D10.4`/`D10.10` pin the new values.

### 6.8 CI-gated acceptance, not single-run
*Looks like:* 30× more simulation than necessary.
*Actually:* one run is one sample. Requiring the CI bound (not the mean) to clear the target
accepts a headcount only when the evidence supports it. Confidence level is configurable on
SLA Defaults (`confidenceLevelPct`: 50–99.9, default 95) and applies globally to Primary,
ASA, and occupancy CIs. Result fields stay named `ci95Low` / `ci95High` for compatibility.
When `recommendedHC === nMinAnalytical`, binding is `analytical_baseline` (N_min floor).

### 6.9 Common Random Numbers
*Looks like:* redundant precomputation that could be generated per candidate.
*Actually:* reusing identical arrival realisations across candidates is variance reduction —
candidates then differ by headcount, not luck. Removing it would require far more replications
to distinguish adjacent N.

### 6.10 House-monotone agent apportionment
`des-engine.ts` `allocateAgentsToCategories`.
*Looks like:* an oddly elaborate way to split agents proportionally; largest-remainder would
be simpler.
*Actually:* **largest-remainder is a real bug here.** The walk-down search stops at the first
failing N, which requires monotonicity. Hamilton's largest-remainder method is subject to the
apportionment **"Alabama paradox"** — adding an agent can *remove* one from a category.
Measured over N=1..200 on a realistic split: **14 reversals and 21 starved silos**, including a
category dropping from 1 agent to **0** (work with nobody to do it). The Webster/Sainte-Laguë
divisor method produces **zero**, because allocation(N+1) is always allocation(N) plus one more
seat.

**Never revert this to largest-remainder.**

---

## 7. Domain primer

Enough to work safely. Depth in `docs/wfm/`.

### The hours taxonomy — read this before touching any formula

Most errors are double-counts caused by two variables that both look like "hours per agent per
day":

| Level | Meaning | Reduced by |
|---|---|---|
| Paid hours | what the employer pays for | — |
| Contracted hours | what the contract commits to | unpaid breaks |
| **Scheduled hours** | rostered to be at work | leave, training, absence (*out-of-chair shrinkage*) |
| **Productive hours** | rostered time available for case work | breaks, meetings (*in-chair shrinkage*) |
| **Delivered hours** | productive time actually on cases | adherence loss |

Two rules:
1. **Shrinkage** converts rostered → available headcount. Stage 4 only.
2. **Adherence** converts scheduled productive → delivered time. Per-agent capacity only.

In this codebase: `labor.dailyProductiveHours` is *productive* hours (e.g. 7.5 of an 8-hour
shift); `labor.adherencePct` scales it to delivered hours in the DES;
`category.shrinkagePct` operates one level up, on rostered headcount.

> **Watch for cancellation.** Under Derived agent hours, engine FTE fields still satisfy
> `fteNet == operationalHCWithOff` (test `D7.5`). Headline Hiring FTE (M4) is **hidden in the UI**;
> Manual Override hours feed Workload HC (`N_min`) only when &gt; 0.

### Core terms

| Term | Meaning |
|---|---|
| **Workload** | `Volume × AHT`. Demand in hours, independent of headcount. |
| **AHT** | Average touch time per case, excluding queue time. |
| **TAT** | Turnaround time — receipt to completion. The primary backoffice service metric. |
| **Primary SLA %** | % of cases completed within the committed window. |
| **BO ASA** | Time to **first touch** (not completion). |
| **Occupancy** | Handling ÷ available. **Two valid denominators** — see §6.3. |
| **Shrinkage** | `1 − productive/scheduled`. Typically 25–35%. |
| **Adherence** | % of scheduled time spent as scheduled. *Timing* compliance. |
| **Operational HC** | People working the queue (DES seats). What the simulation sizes. |
| **Net Operational HC** | Seats after net extra OFF% (Labor offs beyond calendar-closed days). Headline number. |
| **Gross / Rostered HC** | People to employ after shrinkage on Net Op. **The hiring number.** |
| **Opening WIP** | Backlog carried into the horizon. |
| **Latest Safe Start** | Last moment work can start and still meet the deadline. |
| **Pooled vs Siloed** | Any agent takes any case, vs dedicated per-category teams. |
| **Drain window** | Period past horizon end when in-flight work may finish. |

### The two rules that prevent most domain bugs

1. **Never introduce a factor twice.** If a factor appears in both numerator and denominator
   of the same ratio it cancels — arithmetically fine, but fragile.
2. **Know which population a rate is over.** Occupancy over *planned* capacity answers "do I
   have enough people?"; over *actual on-duty* minutes it answers "how hard did they work?".
   Both valid, not interchangeable.

---

## 8. Conventions

### No console output in `src/`
Engine code ships inside the artifact users run. `console.log` / `debug` / `info` are banned in
`src/` and enforced by test `D9.3`. Use the test suites for visibility. `console.warn` /
`console.error` for genuine user-facing faults are acceptable.

### No new runtime dependencies
`dependencies` is closed (React, React-DOM, icons, plus build tooling). Implement new
capability in plain TypeScript in-repo. Four unused packages were removed for this reason and
must not return: `@google/genai`, `express`, `dotenv`, `motion`.

### No network, no storage
No `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, remote dynamic import,
CDN assets, web fonts, telemetry, `process.env`, `import.meta.env`, `localStorage`,
`sessionStorage`, `indexedDB`, or cookies. Enforced by suite `D9`. **Never weaken the build
guards in `scripts/build-standalone.mts`** to make a build pass.

### All time math goes through `calendar.ts`
Never hand-roll `Date` arithmetic in engine code. Business-hours math is subtle — holidays,
weekends, open/close windows, half-open horizon boundaries. Use `addWorkingTime`,
`subtractWorkingTime`, `workingDuration`, `isWorking`, `nextOpen`,
`getCalendarWorkingDaysInHorizon`.

> `getCalendarWorkingDaysInHorizon` treats the horizon as **half-open** `[start, end)`. An
> inclusive bound counts a trailing zero-demand day whenever `horizonEnd` lands exactly on
> midnight — which happens for whole-day interval data and *always* for 24/7 calendars.

### Determinism
Reproducibility for a given seed is a hard requirement — the CI-gated search compares
candidates, and variance would make comparisons meaningless.

- Never `Math.random()` — use the seeded `createPrng` in `des-engine.ts`.
- Never `Date.now()` / `new Date()` for anything affecting a computed result.
- `Map`/`Set` iteration follows insertion order — **sort explicitly** when order affects a
  result (`allocateAgentsToCategories` sorts category names for exactly this reason).

### Never duplicate an algorithm
`searchOptimalHC` and `searchOptimalHCAsync` are ~500 lines of near-identical logic that have
already drifted (§11). Do not add a third copy, and never fix a bug in one without the other.

### Round only at the presentation boundary
Keep full precision through the chain. Compare floats with a tolerance, never `===`.

---

## 9. Testing

### 9.1 Two suites, both must be green

```bash
npm test              # both suites — 454 checks + artifact freshness
npm run test:sizing   # sizing-chain suite only (faster)
```

| Suite | Tests | Covers |
|---|---|---|
| `scripts/verify-fixes.mts` | 174 | Legacy regression — CSV/date parsing, calendar arithmetic, CRN consistency, occupancy semantics, artifact integrity, analytical infeasibility diagnosis, 24x7 midnight budget accounting. **Treat as append-only.** |
| `scripts/verify-sizing-fixes.mts` | 280 | Sizing chain — `D1` working-day counting, `D3` apportionment monotonicity, `D7` staffing-chain integrity, `D9` offline enforcement, `D20`-`D26` deadline-coverage shift placement (Stage 3a: valid-slap enumeration, no-regression, greedy monotonicity/optimality, I1/I2 invariants under staggering, seed determinism, positive control, I4 occupancy-ceiling regression guard), `D27` day-open telemetry off-by-one, `D28` fast-path/full-path attainment agreement, `D29` I5 per-agent stagger-offset compliance (check #8), `D30`/`D31` shift-end enforcement + in-flight case handover, `D32`/`D33` minimum-coverage floor + flag-independent redistribution repair, `D34` N_sla walk-down safety-net fix, `D35` adherence/capacity conflation closed-form pin, `D36` 24×7 coverage-gate regression fix, `D37` real 24×7 multi-start (staggering, shift-end, coverage repair), `D38` "exact minimum" wording pin (source-text based — the message is unreachable dead code), `D39` empirical monotonicity sweep for the uniform-only predicate (N=1..25, no violation found), `D40` extra-OFF coverage-ratio fix (ratio table sweep + integer-exactness cases — see §6.4a), `D41` non-blocking DQ warnings for zero off-days / override-vs-horizon scale / calendar-open days with no uploaded rows |
| `scripts/check-artifact-freshness.mts` | gate | Fails if `BoWFM.html` is missing or older than `src/` / build inputs (`npm run check:artifact`) |

If a legacy test fails after your change, the default assumption is that **your change is
wrong**, not the test. Several encode deliberate decisions — `BUG-OCC-ROOT` pins the
planned-horizon occupancy denominator (§6.3).

**No test framework may be added** — that would breach the zero-dependency rule. Both suites
use a plain `assert(condition, name, detail)` helper and exit non-zero on failure.

### 9.2 Independent ground truth

`trusted-source-validation.json` holds expected values derived **by hand, using closed-form
arithmetic and calendar rules only — not by running this app's code**. The derivation uses
**Horn's theorem** for preemptive scheduling on identical machines.

This matters: a test comparing the code against itself proves only self-consistency. A
disagreement with an independently derived number is evidence of a **real** bug.

### 9.3 Fail-first is mandatory

For any behavioural fix:

1. **Write the test first.**
2. **Run it and capture the failure.** A test that has never failed proves nothing.
3. Apply the fix.
4. Re-run: new test passes, both suites stay green.
5. Report the fail-before output as evidence.

Include a **control case** — a near-identical scenario that passes both before and after. If
the control also fails before the fix, your test is measuring the wrong thing.

### 9.4 What a good engine test pins

- **Closed-form expectations**, not "whatever the code currently returns" (see `D7.10`, which
  pins the harmonic blend against its algebraic form).
- **Invariants over a swept range** (`D3.1` sweeps N=1..200; a single N would have missed all
  14 violations).
- **Degenerate inputs**: zero headcount, zero workload, inverted horizon, more categories than
  agents, a category in data but absent from config.
- **Determinism**: same seed + input ⇒ same recommendation.

---

## 10. Common tasks

### Add a configuration parameter
1. Add the field to the relevant interface in `src/types/wfm.ts`.
2. Add its default in `App.tsx` (`DEFAULT_CALENDAR` / `DEFAULT_LABOR` / `DEFAULT_SLA` /
   `DEFAULT_SIM_PARAMS`).
3. Add the control in the matching component (`ConfigFlow.tsx`, `CalendarConfigPanel.tsx`, or
   `RunFlow.tsx` for simulation params) with explicit bounds and a clamped fallback — the
   existing fields all follow `Math.min(max, Math.max(min, parseFloat(v) || fallback))`.
4. Thread it into the engine.
5. If it can invalidate a run, add a DQ rule (below).
6. Consider whether it belongs in the read-only `ParamsPanel` inspector and the Assumptions
   snapshot.
7. Sync `PRD.md` + `project_context.md`, then `npm run build:standalone` and
   `npm run check:artifact` (see `.cursor/rules/50-docs-and-artifact-sync.mdc`).

### Add a data-quality rule
In `csv-parser.ts` `validateDataQuality`, push an issue with `severity`, `field`, `message` and
optional `details`. **`error` blocks the simulation; `warning` does not** —
`passed = !hasErrors`. Add a test asserting both the trigger and the non-trigger case.

### Add a results metric
1. Compute it in the engine and add it to `DESResult` (or `HCSearchOutput`) in `wfm.ts`.
2. Render it in the appropriate `ResultsFlow.tsx` tab.
3. If it is displayed alongside a CI-gated decision, make sure it comes from the same
   statistics that drove the decision — not a separately-sampled replication (see D13 in §11).

### Change a formula safely
1. Read §5 and §6 first — establish which stage you are in and whether the behaviour is frozen.
2. Check `docs/wfm/07-known-defects-and-decisions.md` in case it is deliberate.
3. Write a test pinning the *current* behaviour, and a test pinning the *intended* behaviour.
4. Confirm the second fails, then change the formula.
5. Run both suites; investigate every delta.

### Debug a headcount that looks wrong
Work down the chain in order — the fault is almost always upstream of where it is noticed:

1. **Workload** — does `totalWorkloadHours` match `Σ volume × AHT / 60`? Check for categories
   in the data but missing from config.
2. **`N_min`** — is `workingDaysInHorizon` right? Check the horizon boundary, especially
   midnight-ending data and 24/7 calendars.
3. **Constraint** — which constraint is binding? Check `bindingConstraintType` and the
   per-candidate `failingReasons` in the search history.
4. **Boundary** — does N−1 genuinely fail? That is the minimality proof.
5. **Reconciliation** — run `verifyAgentTimelineInvariants`; it recomputes the headline figures
   from the independent per-agent timeline.

---

## 11. State of the codebase

### Recently fixed, with measured impact

| Defect | Impact when broken |
|---|---|
| **Unconfigured categories** dropped from the staffing gross-up | Hiring requirement understated **46%** (`grossHCTotal` 7 vs 13; `fteNet` 5 vs 10) |
| **Hamilton apportionment** in siloed mode | **14 monotonicity violations, 21 starved silos**; a category fell from 1 agent to 0 |
| **Working-day off-by-one** (inclusive horizon bound) | 24/7 weekly runs counted **8 days instead of 7**; `N_min` understated ~11% |
| **Debug `console.log`** in the search path | Shipped inside the artifact |
| **Four unused runtime dependencies** | `node_modules` 182M → 135M; 153 → 57 top-level packages |
| **Hardcoded 95% CI** (now continuous `confidenceLevelPct` 50–99.9 on SLA Defaults) | Planners could not loosen/tighten statistical gate without a code change |
| **Dead N_min binding check** (`nMinAnalytical > primaryDrivenHC`) | UI always claimed “Statistical CI” even when HC was held at the workload floor |
| **SLA Acceptance Slack** (`slaAcceptanceSlackEnabled` / `slaAcceptanceSlackPct`; Config SLA Defaults; D8 suite) | No planner band between policy Primary % and CI gate; Ops HC premium could only be cut by silently lowering Primary % |
| **Agent Browser state label `OFF` → `OOQ`** (display only; stored enum still `off`) | Planners read out-of-queue slices as weekly time-off |
| **Summary tab card order** — DES Engine record directly under Dual Sizing banner | Planners scrolled past Primary SLA / performance / category blocks before seeing the DES candidate feed |
| **Extra OFF% after DES** (`computeExtraOffPct`; Net Op = ceil(N×(1+extraOff/7)); Gross from that; D10 suite) | Labor offs/7 double-counted calendar-closed days already seats-off in DES; headline Net HC and Gross now use net extra only |
| **Workload HC agent hours** (`resolveAgentHoursForNMin`; D11): Derived = daily×days; Manual Override only if hours &gt; 0; M4 FTE UI hidden | Override previously affected FTE only and was ignored for `N_min`; 37.5 default could inflate floor |
| **CSV volume thousands separators** (T1-1; `mapRawRecordsToIntervals`) | `parseFloat` truncated at the first non-numeric char — `"12,500"` → `12`, silently dividing demand by ~1000. Now stripped before parsing, negatives rejected (not clamped), and a `Volume Parsing` DQ warning surfaces the correction |
| **AHT-exceeds-SLA-window infeasibility** (T2-1; `findImpossibleCategories` in `hc-search.ts`, shared by both search variants) | Previously discovered only by exhausting the leap-up search to `userMaxHC` (wasted compute), with a message recommending a headcount increase that could never help. Now an analytical precondition fails fast, names the category, and reports the achievable overall-SLA ceiling |
| **24x7 midnight daily-budget accounting** (T3-1; `AgentAvailable` in `des-engine.ts`) | A case in flight at midnight is never paused (deliberate — see `BUG-D`), but the daily-budget reset was blind, granting a second full day's budget on top of work already spent into the new day. Measured 738 busy-minutes against a 480-minute budget (53% phantom capacity). Fixed by crediting only the unconsumed remainder for agents still mid-task |
| **`subtractWorkingTime` midnight-close calendars** (D17/T3-2; `calendar.ts`) | Returned `Invalid Date` whenever the previous day's close normalised to hour-24, corrupting 44.6% of `latestSafeStart` values on a 2-business-day SLA window and poisoning dispatch ordering via `NaN` comparisons |
| **`getTCrit` df=2 Student-t coefficient** (T3-3; `hc-search.ts`) | Used `2·a` instead of `√2·a`, returning 6.08 against the textbook 4.30 (+41.4%) — reachable only at `replications: 3`; conservative direction (over-staffing), no under-sizing risk |
| **HC-chain rounding rule** (deliberate, explicitly approved change; `hc-search.ts`) | `N_min` and `operationalHCWithOff` changed `Math.ceil` → `Math.floor` (truncate); pooled `grossHCTotal` changed `Math.ceil` → `Math.round` (nearest whole HC). Not a bug fix — a requested behavior change. See §6.4, §6.7 |
| **Reason column added to Headcount Candidate Evaluation Feed** (`SimulationProgressModal.tsx`, `ResultsFlow.tsx`) | Planners could see a candidate N failed but not *why*; the engine already computed `failingReasons` per candidate (`hc-search.ts`) but neither table rendered it. Both the live-run modal and the completed-results record now render it identically — no engine/type change, presentation only |
| **Occupancy ceiling gate was inert** (`BUG-OCC-CAP`; `des-engine.ts`, `hc-search.ts`) | Gate compared the display-clamped `occupancyPct` against the cap — `Math.min(100, raw) <= 100` is true for every input, so a headcount at 142.9% true occupancy (demand 43% over capacity) recommended and displayed PASS. `occupancyCapEnabled: true` had zero test coverage before this fix. See §6.3a |
| **Audit Drill tab showed only 10 sample breaches at N-1** (`ResultsFlow.tsx`) | Planners had no way to see the full set of SLA-breaching cases at the recommended headcount N, only a 10-row boundary-proof sample at N-1. Added a second, paginated (50/page) table below the existing boundary evidence, filtered to `!c.primaryPassed` on `des.caseResults` (the final DES run at N), sorted by primary deadline, with a CSV export (`wfm_sla_breach_cases.csv`, UTF-8 BOM via the existing `exportToExcelCSV`). The existing N-vs-N-1 boundary table is unchanged. No engine/type changes — presentation only |
| **Zero-available-agents dead zone under uniform-start** (Stage 3a, opt-in `labor.shiftPlacementEnabled`, default off; `hc-search.ts`, `des-engine.ts`, `calendar.ts` — D20-D26 suites) | Every agent starting one uniform shift at business open, with `dailyProductiveHours < businessWindowHours`, made a persistent backlog exhaust every agent's budget in lockstep, leaving the tail of the window at zero available agents daily regardless of headcount. Addressed with an opt-in, analytically-computed (zero extra DES runs) shift-start distribution search, house-monotone by construction and gated by a never-worse verification against a real DES run (`pickPlacementOrUniform` — a placement result only ever replaces uniform when it verifiably passes). **Solid**: the search never recommends a worse headcount with the flag on. **Unproven**: the analytic distribution's ability to reliably improve the recommendation on realistic continuous demand — see D25 and `07-known-defects-and-decisions.md` D20. A serious secondary defect was found and fixed during verification: initial-day agent eligibility and idle-pool repopulation were computed using data only populated when `skipCaseResultsAndTimeline` is false, but the CI-gated replications that decide pass/fail always run with it true — inflating a candidate's scored attainment by ~25 percentage points versus the honestly-simulated result. `verifyAgentTimelineInvariants` also gained a new check (#7) closing a pre-existing gap: the `calendar` parameter it accepted was never actually used to assert agent activity stays within business hours |
| **Day-open queue-timeline telemetry off-by-one** (`des-engine.ts` main event loop; D27 suite; 2026-08-28) | `logTimelineState` was called at the TOP of the event loop, before the popped event was processed. Every day's opening `AgentAvailable` event therefore had its row logged while the idle list was still empty from the prior `DayClose`, reading `Available Agents = 0` at business open on every day after the first (day 0 was masked because the idle list is pre-seeded before the loop starts). Sizing was never affected — `agentTimeline`/DES metrics are computed from authoritative event-driven state, not this display log — but it read as a total staffing collapse and was traced back to a real customer-reported symptom. Fixed by deferring the log call until every event sharing the exact same timestamp has been processed. |
| **Per-agent stagger-offset compliance was unchecked** (`verifyAgentTimelineInvariants`, new check #8/I5; `des-engine.ts`; D29 suite; 2026-08-28) | Check #7 (added earlier, see the dead-zone entry above) only validates the GLOBAL business window and cannot catch an agent dispatched before *its own* assigned stagger offset while the business is already open. Measured: a synthetic timeline with exactly that violation passed `valid=true`. Fixed by reconstructing each agent's offset from `DESResult.shiftDistributionUsed` (already echoed — no new parameter) and asserting no busy slice starts before it. |
| **Fast-path/full-path attainment agreement now has a direct regression test** (`agentOnShiftToday`; D28 suite; 2026-08-28) | The ~25pp CI-gate inflation fix above (`agentOnShiftToday`) had no test pinning the specific mechanism — only D25's coarser end-to-end "never worse" check, which does not target it. D28 asserts `skipCaseResultsAndTimeline` true vs false agree within 1pp on the same staggered distribution; verified fail-first against a scratch-reverted tracker (reproduced a 6.4pp divergence) before being added as a permanent guard. |
| **Shift-end was never enforced under staggering** (`des-engine.ts` — new `ShiftEnd` event, `dispatchSingleQueue`'s third look-ahead bound; D30/D31 suites; 2026-08-28) | An agent stayed available all the way to business close regardless of shift length, disagreeing with the analytic placement model's `[offset, offset+shiftLength]` capacity assumption — root cause of the greedy routinely choosing distributions worse than uniform. Fixed with a real per-cohort shift-end event and a same-day handover for in-progress cases (return to the live queue for a still-on-shift colleague, not next-day parking). Scoped to non-24×7 — 24×7 multi-start is a tracked follow-up, not yet done. |
| **No coverage floor existed anywhere in the acceptance predicate** (FR-5.12; `des-engine.ts` mode-independent tracking, `hc-search.ts` `buildCoverageRepairDistribution`; D32/D33 suites; 2026-08-28) | A candidate could pass all statistical gates while legitimately leaving the queue with zero agents during open business hours whenever the window exceeded the shift length. New default-on floor (`minAgentsPerInterval`, default 1) gates on the WORST replication, not a CI mean. Satisfied by a flag-independent minimal-redistribution repair BEFORE ever raising headcount — proven on the field-reported config to cost zero extra heads (100%→100% SLA, same 33 agents, just one moved from 08:00 to 13:00). A fail-first-caught bug in the repair function's first version left offset 0 uncovered at small N; fixed before merge. |
| **N_sla could bypass the walk-down safety net** (Gap A; `hc-search.ts` `startN` calculation; D34 suite; 2026-08-28) | `placementFeasibleFloor` raised the search's starting N, and an immediately-passing raised start skipped the walk-down (and `pickPlacementOrUniform`) entirely — 2/192 swept configs recommended a higher headcount with placement on than off, falsifying the "never worse" claim. Fixed by excluding N_sla from `startN` in both search entry points; it remains reported as diagnostic telemetry only. |
| **Placement capacity math ignored adherence** (Gap B; `hc-search.ts` `computeCandidatePlacementDistribution` and both entry points' N_sla computation; D35 suite; 2026-08-28) | `shiftCapacityWithinDay` was fed un-adhered `dailyProductiveHours×60` as agent capacity — a measured 25% over-credit at adherence 0.8 versus the DES's actual daily budget. `getValidSlapStarts` correctly keeps the un-adhered figure (a span/presence question, not capacity). Closed-form pinned (N_sla=3 correct vs 2 buggy). |
| **`shiftPlacementMaxAttempts` was a phantom API — removed, then re-measured and closed** (Gap G; `wfm.ts`, `hc-search.ts`; 2026-08-28) | Documented in detail (multiple distributions verified per candidate N, `evaluateNWithPlacement`) but never implemented or referenced anywhere in `src/`. Removed rather than built, originally reasoned "a version affecting accept/reject needs a monotonicity proof not yet done" — **that reasoning was retracted on re-examination**: `evaluateN`/`evaluateAsync` already decide accept/reject via a three-way disjunction (uniform OR coverage-repair OR placement) with no such proof, so the objection applied equally to code already shipped. No monotonicity proof exists anywhere for DES pass/fail vs N (open assumption, see §9 and D39 below) — but that turned out to be a separate question from whether staggering actually helps. **Re-measured under the fixed shift-end model** (a throwaway scratchpad probe brute-forcing ~20-30 staggered 2/3-cohort distributions per candidate N against the classic 08:00-22:00/9h-shift dead-zone config, at small-N [4-9] and ~30-40-agent scale): no distribution flipped a reject into an accept at either scale — staggering measurably *hurt* primary-SLA attainment (e.g. 97.9% uniform vs 84.4% best-staggered at N=38) without fixing the coverage gate that was actually binding, because coverage needs presence at every interval, not thinned-out throughput. **Gap G closed** with this measured evidence — `shiftPlacementMaxAttempts` stays removed, no multi-attempt search was built. See `docs/wfm/07-known-defects-and-decisions.md` follow-up #6 for the full write-up. |
| **24×7 coverage gate inflated headcount, then real 24×7 multi-start delivered same day** (`calendar.ts` `getValidSlapStarts`, `des-engine.ts`, `hc-search.ts`; D36/D37 suites; 2026-08-28) | The default-on minimum-coverage floor was enforced for 24×7 calendars, but `staggeredMode` was unconditionally false there, so "on shift" degenerated to "has daily budget remaining" with BOTH repair levers unconditionally disabled — measured 267% inflation (N=3→11) on a scenario where SLA/occupancy already passed. Rather than stop at an interim guard, `getValidSlapStarts` now enumerates a real shift-start grid for 24×7 (was a degenerate `[0]`) over the fixed 1440-min day, and staggering/shift-end/coverage-repair all work for 24×7 exactly as for business-hours calendars (non-wrapping only — sufficient for full coverage; three 8h starts at 0/480/960 tile a day). Two further defects surfaced during validation: (1) coverage sampling fired immediately inside each event handler, so a same-timestamp `ShiftEnd`/`AgentAvailable` handoff between adjacent cohorts could sample a false-zero mid-transition — fixed by deferring the sample to the same point the interval-timeline log defers to (Gap H's mechanism, extended). (2) `agentDailyMinutesRemaining` is decremented at assignment time, not completion — an agent working their final chunk of budget showed `~0` remaining and was wrongly excluded from the on-shift count while still genuinely busy — fixed by also counting agents in `activeProcessing`. The 24×7-side of `buildOneDayDemandGrid` (all demand bucketed into one whole-day cell) remains a known, pre-existing limitation for placement-quality — coverage repair is unaffected since it needs no demand data. |
| **"Exact minimum" search messaging was an unwarranted claim** (`hc-search.ts` `searchOptimalHCAsync`; D38 suite; 2026-08-28) | DES pass/fail monotonicity in N is an open, undischarged assumption (§9) — the walk-down search only ever verifies N passed and N-1 failed, never that N is the exact minimum. Reworded `Exact minimum N=...` to `Lowest verified-passing N=... found (N-1=... failed the gate)`. Presentation-only, no logic change. Side-finding: the message is unreachable dead code in practice — the post-loop re-evaluate call it's built from always hits `evalCache` (the N was already evaluated earlier in the same walk-down loop), and a cache hit returns before `onProgress` fires — so D38 pins the literal source string rather than a runtime/`onProgress` observation. |
| **Empirical monotonicity sweep added** (D39 suite; 2026-08-28) | No prior test checked that DES pass/fail is actually monotone in N — only that specific *outputs* (placement distribution, apportionment shares) grow monotonically. D39 sweeps the uniform-only predicate (`evaluateCandidateStatistical`, no `shiftDistribution`) across N=1..25 on a plain business-hours config, same pattern as D3.1's apportionment sweep. No violation found in the range tested — consistent with, not proof of, the walk-down's resting assumption, which remains open and honestly labeled. The full 3-way-disjunction sweep (which would need `evaluateN`/`evaluateAsync`'s logic extracted into a shared function) was deliberately not attempted — the remediation plan reserved that extraction for if Gap G's re-measurement above concluded a multi-attempt search was worth building, which it did not. |
| **Sync-only off-hours mitigation removed** (PRD P0-2; `hc-search.ts:1443-1455`; D8, 2026-08-28) | A benchmark run against `trusted-source-validation.json` (135/135 passing) validated `searchOptimalHC`, not `searchOptimalHCAsync` — the path `App.tsx`/`SensitivityFlow.tsx` actually call. The gap was a real mitigation, sync-only: rewriting `sla.clockStartPolicy` from `'arrival'` to `'next_open'` when >15% of volume arrives off-hours. Measured impact on a reproduction dataset (5 days, 89% off-hours, `clockBasis: 'wall_clock'`): sync recommended HC=24, async reported fully infeasible on identical input. Fixed by deleting the block from sync, not porting it into async — `clockStartPolicy` is a deliberate planner toggle, `HCSearchOutput` has no field to report a silent override, and `csv-parser.ts:838`'s DQ warning already covers the same >15% threshold with the same recommended remedy. Verified zero effect on shipped behavior: async's output on the reproduction case is byte-identical before/after; only `scenario_T3_R2_invalid_date_interval_asymmetry` in the trusted-source file had inputs that triggered the deleted block, and its one assertion (`nMinAnalytical`) doesn't read `clockStartPolicy`, so it was unaffected. Full suite 215/215, trusted-source 135/135, both unchanged. |
| **A new upload/sample-load could silently blend with a stale prior session** (`UPLOAD-STALE-STATE`; `App.tsx` `handleFileUpload`/`handleLoadSample`/`handleConfirmResetAll`; 2026-08-31) | Uploading a new demand file already wholesale-replaced `rawRows`/`columnMapping` and cleared `searchOutput`, but left `calendar`/`labor`/`sla`/`categories`/`simParams`/`openingWIP` from any prior session in that browser tab untouched. Root-caused a user-reported sizing discrepancy: a stale tab held leftover config from an earlier run, the new upload only swapped the demand rows, and the search silently produced a materially different (lower) headcount with no indication anything was stale. Both `searchOptimalHC` and `searchOptimalHCAsync` were traced line-by-line and structurally diffed on the exact reported input and found byte-identical to the last commit — this was never an engine bug. Fixed by routing a new upload or sample-load, whenever the session already has data loaded (`rawRows.length > 0`), through the same `ResetConfirmModal` the Sidebar's Reset button already uses (`pendingResetAction` now carries `'reset' \| {type:'upload',...} \| {type:'sample',...}`; `handleConfirmResetAll` runs the shared reset body, then applies the pending upload/sample against the freshly-defaulted state). Cancelling leaves the existing session completely untouched. A brand-new session (no data loaded yet) is unaffected — the confirmation only fires when there is something to lose. |
| **Extra-OFF roster multiplier divided by the calendar week instead of the open week** (`computeExtraOffPct`, `calculateStaffingRequirement`; `hc-search.ts`; D40/D41 suites, `T1_A2c` trusted-source scenario; 2026-08-28) | `operationalHCWithOff` used `floor(N*(1+extraOffDays/7))`. Agents only supply capacity on open days, so the correct multiplier is the coverage ratio `openDaysPerWeek/coverageDays` — the two formulas agree only at `extraOffDays=0` (the default 5-day-calendar/5-day-Labor config), which is why this shipped unnoticed for over a year; `trusted-source-validation.json` had zero scenarios with `extraOffDays>0`. Measured under-statement: 6-open/2-off gave 114 instead of 120 (−5%); 5-open/5-off gave 142 instead of 250 (−43%); worst at 24×7, exactly where the UI's 24/7 toggle force-sets `offDaysPerWeek:0` and masked it further. Fixed by computing `floor((N*openDaysPerWeek)/coverageDays)` integer-exact — a naive `floor(N*(1+rosterUpliftPct))` reintroduces a *separate* binary-float bug (`45*(1+0.4)=62.999999999999999→62`, true value 63). Also added a `rosterInfeasible` guard for `coverageDays<=0` (surfaced in `bindingConstraint`, not silently 1×) and fixed the 24/7 toggle's missing untick-restore path (`App.tsx` now owns a pre-toggle snapshot — `CalendarConfigPanel` is conditionally mounted by `DemandFlow` and was discarding component-local state on every tab switch). Three new non-blocking DQ warnings added (`csv-parser.ts`): zero off-days on a non-24/7 calendar, Manual Hours Override far out of scale with the uploaded horizon, and calendar-open days inside the horizon with zero uploaded rows. See §6.4a and `docs/wfm/07-known-defects-and-decisions.md` D41. Full suite 454/454, trusted-source 164/164, both green. |

### Known drift risks — the things most likely to bite you

**The two search implementations can still diverge (D11), even though the one measured
instance of it is fixed.** `searchOptimalHC` (sync) previously contained an off-hours
mitigation, absent from `searchOptimalHCAsync` (the path the UI actually calls), that rewrote
`sla.clockStartPolicy` when >15% of volume arrived outside business hours — measured to flip a
recommendation from `HC=24` to fully infeasible depending on which entry point ran. Fixed
2026-08-28 by deleting the mitigation from sync (see `docs/wfm/07`, D8) rather than porting it
into async: `clockStartPolicy` is a deliberate planner toggle, the DQ layer
(`csv-parser.ts:838`) already warns at the same 15% threshold with the same recommended fix,
and there was no output field to report the override if it had been ported. ~500 lines of the
two functions remain near-identical; any future fix must still be applied twice, and nothing
prevents a new one-sided change.

**Two case-priority orderings exist (corrected — was previously stated backwards, D16).**
`pickNextCase` / `compareByUrgency` drives real dispatch — `dispatchSingleQueue` calls
`pickNextCase` directly, which independently re-implements parked-first tiering via its own
linear scan. `CaseMinHeap.compare` only governs the heap's internal push/pop order (still
live — it decides `.pop()` and the `len === 1` fast path), but is **not** what chooses among
2+ candidates during real dispatch. Two independent implementations of the same tiering is
still a drift risk (D18) even now that the doc correctly states which one ships.

**671 lines of dead code.** `DataTable.tsx` (308) and `NativeCharts.tsx` (363) are referenced
nowhere and do not reach the bundle. **The shipped app has no charts at all** — the "Staffing
Path" and "Queue/WIP" tabs are table-only despite purpose-built chart components existing for
exactly those views.

**The in-app "M1–M5 Compliance" panel is display-only.** It renders four statically-passing
cards without evaluating anything, under a heading claiming M1–M5 while showing M1–M4. Do not
treat it as verification — the real checks are the test suites and
`verifyAgentTimelineInvariants`.

**`metadata.json` declares `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API`** — stale after the
`@google/genai` removal. Unreferenced and absent from the artifact, but it advertises a
server-side AI capability contradicting the offline contract.

### Open items

Full register with IDs in `docs/wfm/07-known-defects-and-decisions.md`; prioritised as forward
requirements in `PRD.md` §11. Summary:

- **P0** — the hardcoded invariants panel; sync/async search divergence; boundary evidence
  sourced from a single-seed run rather than the CI decision that actually rejected N−1;
  Stage 3a labor-model correction and mandatory coverage floor (PRD §11 P0-4) — **fully
  closed**: day-open telemetry, the fast-path/full-path regression test, shift-end
  enforcement with in-flight handover (non-24×7), the minimum-coverage floor with
  redistribution-first repair, the N_sla walk-down safety-net fix, the adherence/capacity
  conflation, the 24×7 coverage regression, real 24×7 multi-start (staggering, shift-end,
  coverage repair — confirmed simpler than first estimated: non-wrapping shifts already
  suffice, no circular-day-grid work needed), AND Gap G (re-measured under the fixed
  shift-end model — no distribution flipped a reject into an accept at small-N or ~30-40
  agent scale; staggering measurably cost primary-SLA attainment without fixing the coverage
  gate; closed with that measured evidence, not the retracted monotonicity argument) are all
  fixed (see table above and `docs/wfm/07-known-defects-and-decisions.md` follow-up #6).
  DES pass/fail monotonicity in N remains an open, honestly-labeled assumption (see §9) —
  a separate question from Gap G, unaffected by its closure — pinned by the D39 empirical
  sweep (no violation found in the range tested) and reflected in the walk-down's messaging,
  which now says "lowest verified-passing N" rather than "exact minimum" (D38).
- **P1** — Export JSON omits Opening WIP; cancelling a run wipes results; CSV exports ignore
  active filters; no backlog-ageing report; the stale manifest flag.
- **P2** — dead code; hardcoded/ephemeral sensitivity analysis; sample-dataset copy mismatch;
  a 4-column grid rendering 3 cards; `intervalEndCol` with no UI; circular Demand/Config step
  ordering; assorted engine debt.
- **Modelling gaps** — rework/quality not modelled; resumption overhead assumed zero;
  fractional volumes rounded per interval.

---

## 12. Where to look for what

| Symptom / question | Start here |
|---|---|
| Wrong headcount recommendation | `hc-search.ts` — walk stages in §10 order |
| Wrong workload / FTE / Gross HC | `hc-search.ts` `calculateStaffingRequirement` |
| Wrong occupancy | `des-engine.ts` occupancy block — **read §6.3 first** |
| Wrong SLA attainment | `des-engine.ts` metrics compilation + `calendar.ts` deadline math |
| Cases handled in the wrong order | `des-engine.ts` `CaseMinHeap.compare` |
| Wrong number of working days | `calendar.ts` `getCalendarWorkingDaysInHorizon` (half-open) |
| Deadline lands at an impossible time | `calendar.ts` `addWorkingTime` / `subtractWorkingTime` |
| Siloed agents distributed oddly | `des-engine.ts` `allocateAgentsToCategories` — §6.10 |
| CSV will not import | `csv-parser.ts` `parseCSVRaw`, `parseFlexibleDate` (no US dates) |
| Unexpected DQ block | `csv-parser.ts` `validateDataQuality` — 14 rules |
| Categories missing or wrong | `csv-parser.ts` `discoverAndSyncCategories` |
| A UI field's default or bounds | `App.tsx` `DEFAULT_*`, then the owning component |
| Run button disabled | `RunFlow.tsx` pre-flight checklist (6 gates) |
| Results tab renders nothing | `ResultsFlow.tsx` empty state — `searchOutput` is null |
| Build fails on remote references | `scripts/build-standalone.mts` guards — **do not weaken** |
| `tsx` fails to start | §3.1 — platform esbuild binary |
| Domain term you do not recognise | §7, then `docs/wfm/01-glossary-and-metrics.md` |
| Whether a behaviour is deliberate | §6, then `docs/wfm/07-known-defects-and-decisions.md` |

---

## Related documentation

| Document | Purpose |
|---|---|
| `PRD.md` | Product requirements — as-built spec, prioritised backlog |
| `README.md` | Quick start and repository orientation |
| `docs/wfm/01`–`06` | Workforce-planning domain reference (glossary, COPC practice, forecasting, capacity planning, scheduling, DES) |
| `docs/wfm/07-known-defects-and-decisions.md` | Decision log and defect register |
| `.cursor/rules/` | Enforced engineering rules (offline contract, frozen architecture, testing, conventions) |
