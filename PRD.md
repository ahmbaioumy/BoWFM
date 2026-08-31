# Product Requirements Document — Backoffice WFM Sizing Engine

| | |
|---|---|
| **Status** | Draft — as-built specification |
| **Version** | 1.9.0 |
| **Date** | 2026-08-31 |
| **Owner** | _(unassigned)_ |
| **Product** | Backoffice WFM Sizing Engine |
| **Artifact** | `BoWFM.html` — single self-contained offline HTML file (~534 KB) |

> **Scope of this document.** This is an **as-built** PRD: §1–§10 specify the product as it
> actually behaves today, verified against source. §11 carries known defects and unbuilt
> capabilities as forward requirements. Where the implementation has a quirk or a limitation,
> it is documented as such rather than described aspirationally.

---

## Table of contents

1. [Product overview](#1-product-overview)
2. [Problem statement](#2-problem-statement)
3. [Users and personas](#3-users-and-personas)
4. [User journey](#4-user-journey)
5. [Functional requirements](#5-functional-requirements)
6. [The sizing methodology](#6-the-sizing-methodology)
7. [Design decisions and rationale](#7-design-decisions-and-rationale)
8. [Non-functional requirements](#8-non-functional-requirements)
9. [Validation and quality](#9-validation-and-quality)
10. [Known limitations](#10-known-limitations)
11. [Not yet built](#11-not-yet-built)
12. [Glossary](#12-glossary)

---

## 1. Product overview

The Backoffice WFM Sizing Engine answers one question with defensible evidence:

> **How many people do we need to hire to meet our turnaround commitment?**

It takes a demand forecast (interval volumes by work category), a set of operating
assumptions (business calendar, productive hours, shrinkage, AHT), and a service commitment
("90% of claims closed within 2 business days"), and returns the **minimum headcount** that
meets that commitment — plus the evidence that one fewer person would fail.

The engine simulates individual cases ageing against their own deadlines using a
**discrete-event simulation (DES)**, runs 30 replications per candidate headcount, and
accepts a headcount only when its **configured confidence interval** (default **95%**,
numeric **50–99.9** on SLA Defaults) clears every constraint.

### What it is for

**Backoffice deferred-case work**: claims processing, ticket handling, case management,
document review, back-office fulfilment. Work that arrives, queues — legitimately, sometimes
for days — and is measured on **turnaround time**.

### What it is explicitly *not* for

**Real-time channels** — voice, chat, or anything measured on speed-of-answer within an
interval. Those need Erlang-C or equivalent real-time queueing models. This engine contains
no Erlang formula, deliberately (see §7.1).

### Positioning

| | Spreadsheet | Erlang calculator | **This engine** |
|---|---|---|---|
| Per-case deadlines | ✗ | ✗ | **✓** |
| Backlog carried across days | ✗ | ✗ | **✓** |
| Business-calendar SLA clock | manual | ✗ | **✓** |
| Statistical confidence | ✗ | ✗ | **✓ CI (50–99.9%)** |
| Proof the answer is minimal | ✗ | ✗ | **✓ N−1 evidence** |
| Runs offline, no install | ✓ | varies | **✓ single HTML file** |

---

## 2. Problem statement

Backoffice capacity planners are typically forced to choose between two inadequate tools.

**Spreadsheets** compute `workload ÷ capacity` and stop there. That answers "is there enough
capacity in total?" but not "does the work get done *in time*?" — capacity available on
Friday cannot serve a deadline that fell on Tuesday. Spreadsheets also cannot represent
backlog carried across days, per-case deadlines, or a business calendar with holidays and
partial-day operating windows.

**Erlang-C calculators** are built for a different problem entirely. Erlang-C assumes
real-time queueing where callers abandon, models waiting in seconds, and has no concept of a
per-item deadline or a queue that legitimately persists overnight. Applying it to deferred
work typically **oversizes badly**, because it sizes for seconds-scale waiting on work whose
target is measured in days.

Neither approach produces an auditable answer. A headcount number nobody can interrogate
does not survive a finance review, and "the spreadsheet says 23" is not a defence.

### Consequences of getting it wrong

- **Undersized**: backlog grows without bound. Because deferred work never abandons, unserved
  demand does not disappear — it accumulates. Recovery requires sustained overtime or a
  service failure.
- **Oversized**: direct, ongoing salary cost.
- **Right number, no evidence**: the plan is not approved, or is approved and then cut
  arbitrarily.

### What the product must therefore do

1. Model **timing**, not just volume — deadlines, business calendar, queue discipline.
2. Model **backlog carry-in**, because deferred queues are never empty at period start.
3. Produce a number that is **minimal and provably so**.
4. Express **uncertainty honestly** — a single simulation run is one sample, not an answer.
5. Constrain **sustainability** as well as service — a headcount that hits the SLA at 98%
   occupancy is not a viable plan.
6. Run **anywhere**, including locked-down corporate desktops with no internet access.

---

## 3. Users and personas

### 3.1 WFM Analyst / Capacity Planner — *primary user*

Owns the sizing model and runs the tool. Comfortable with AHT, shrinkage, occupancy and
forecast accuracy. Typically working in a spreadsheet today.

**Needs:** load their own forecast; encode real operating rules (calendar, holidays,
shrinkage per work type, SLA per category); get a defensible number; test sensitivity to
volume and AHT assumptions; export evidence.

**Key question:** *"What headcount do I commit to, and how do I defend it?"*

### 3.2 Operations Manager — *consumer*

Runs the floor. Needs to understand what the recommendation implies operationally.

**Needs:** understand what drives the number; see whether it is service-driven or
capacity-driven; understand occupancy implications for the team; see what happens if volume
runs hot.

**Key question:** *"Is this achievable with my team, and what breaks if I get it wrong?"*

### 3.3 Finance / Leadership — *approver*

Approves the hire. Not a WFM specialist.

**Needs:** a single hiring number with clear provenance; the cost implication; confidence
that the number is minimal, not padded.

**Key question:** *"Why this number and not fewer?"*

> This persona is the reason the engine reports **boundary evidence** — the specific cases
> that breach at N−1. "One fewer person and these 47 cases miss their deadline" is an answer
> to a budget challenge; "the model says 23" is not.

---

## 4. User journey

Navigation is a five-step sidebar, each step with sub-tabs. **Navigation is free-form** —
steps are not locked and can be visited in any order. There is one hard gate, before running
the simulation.

```
1. Demand & Inflow   →  Upload · Column Map · Business Calendar · Data Quality · Opening WIP
2. Labor & Config    →  Labor & Productive Hours · SLA Defaults · Categories
3. Run Sizing        →  Pre-flight · Simulate
4. Results & Audit   →  Summary · Staffing Path · Case Browser · Agent Browser ·
                        Queue/WIP · Audit Drill · Assumptions
5. Sensitivity       →  Scenarios Matrix · Compare Scenarios
```

Cold start lands on **Demand → Upload**.

### 4.1 The path

**Step 1 — Demand.** The user drags in a CSV (or loads one of three built-in benchmark
datasets), maps columns to the fields the engine needs, configures the business calendar, and
clears the Data Quality gate. Optionally they enter opening backlog (Opening WIP), manually
or by bulk CSV import.

**Step 2 — Config.** Productive hours, adherence, and the FTE contractual basis; SLA policy
(target %, window, clock basis, clock start policy, statistical CI confidence, optional ASA
target, optional occupancy cap); then per-category AHT, shrinkage and priority. Categories are
**auto-discovered** from the uploaded data.

**Step 3 — Run.** A six-item pre-flight checklist must be fully green. The user sets four
simulation parameters and runs. A blocking modal shows live progress: the analytical
baseline, then each candidate headcount tested with its SLA/occupancy/ASA result.

**Step 4 — Results.** Headline numbers (Net Operational HC, Pooled Gross HC), the derivation waterfall, per-case and per-agent drill-downs, the queue timeline, the
N−1 boundary proof, and a full assumption snapshot.

**Step 5 — Sensitivity.** A 5×5 matrix across ±20% volume and ±20% AHT, and a comparison view
of five named scenarios.

### 4.2 Progression gating

There is exactly **one** hard gate, enforced in two places:

- The **Run button** is disabled unless all six pre-flight checks pass.
- `handleRunSizing` **re-checks** the DQ result on invocation and, if it fails, sets an error
  and force-navigates to **Demand → Data Quality**.

Everything else is freely navigable. Results and Sensitivity render empty states when no
simulation has run.

### 4.3 Documented journey quirks

These are real, verified behaviours a user will encounter:

- **The step order is circular.** Business Calendar sits in step 1, but Labor sits in step 2 —
  and the step-1 Data Quality gate includes a "Capacity Basis (M1)" check that validates
  `dailyProductiveHours ≤ daily business window`. A first-time user who fails that check must
  go **forward** to step 2 to fix a step-1 blocker.
- **Sample datasets skip Column Map.** Loading a benchmark dataset hardcodes the mapping and
  jumps straight to Data Quality, so a demo user never sees the mapping step.
- **Nothing persists.** There is no `localStorage` and no backend. A page refresh loses
  everything. Export/Import JSON is the only save path — **and it does not include Opening
  WIP** (see §11, P1).

---

## 5. Functional requirements

Acceptance criteria are written to be testable against current behaviour.

### 5.1 Data ingestion

| ID | Requirement | Acceptance criteria |
|---|---|---|
| **FR-1.1** | Accept a delimited demand file by drag-and-drop or file browse | Accepts `.csv`, `.txt`, `.tsv`. Comma, semicolon and tab delimiters auto-detected from the first 4096 characters. Pipe (`\|`) is **not** supported. |
| **FR-1.2** | Parse RFC 4180 CSV correctly | Handles quoted fields, `""` escaped quotes, embedded newlines and delimiters inside quotes, and `\r\n` / `\r` / `\n` line endings. Blank rows dropped; blank headers auto-named `Column_{n}`; short rows padded. |
| **FR-1.3** | Parse dates flexibly but unambiguously | Accepts Unix timestamps (9–14 digits), ISO 8601 (with `Z` or `±HH:MM` offsets), `DD/MM/YYYY`, and `DD/MM/YY` (pivot: `≥70` → 1900s, else 2000s). **US `MM/DD/YYYY` is deliberately rejected.** Times accept `HH:mm[:ss]` with optional AM/PM. |
| **FR-1.4** | Reject impossible dates | Calendar-validated: rejects `31/02`, `31/04`, `29/02` in non-leap years, month outside 1–12, hours >23, minutes/seconds >59, year <1000 or >9999. Constructed dates are round-tripped to defeat JavaScript's silent normalisation. |
| **FR-1.5** | Auto-suggest column mapping | Matches header names against known synonym sets for date, time, volume and category; falls back to inspecting the first data row for time-shaped and date-shaped values; then to positional defaults. |
| **FR-1.6** | Allow manual column mapping | Four selects: **Date / Day** (mandatory), **Interval / Time** (optional), **Vol / Offered** (mandatory), **Categ / Seg** (optional). Unmapped category → single `General` category. |
| **FR-1.7** | Provide built-in benchmark datasets | Three: *Financial Claims (Multi-Seg)* — 5 days, 3 categories; *Customer Operations Backlog* — 7 days, 2 categories; *Healthcare Authorization* — 10 days. All generated 08:00–17:30 in 30-minute slots starting the next Monday, with a sine-shaped diurnal curve. |
| **FR-1.8** | Auto-discover categories from data | Category list derived from mapped intervals. New categories seeded with **AHT 30 min, shrinkage 20%**, priority by alphabetical index, inheriting global SLA defaults. Categories no longer present are dropped. Fixed 2026-08-31 (`UPLOAD-STALE-STATE`): a re-upload or sample-load into a session that already has data loaded now goes through the same Reset confirmation as FR-12.3 first — see that row for why. A brand-new session (no data loaded yet) is unaffected: the first upload or sample-load applies immediately. |
| **FR-1.9** | Normalise intervals | Volume: missing/NaN → 0, negatives rejected to 0 (flagged, not silently clamped), thousands separators/currency symbols/whitespace stripped before parsing. Interval end = mapped end column, else **start + 30 minutes**. Rows sorted chronologically with invalid dates last; `intervalIndex` reassigned 0..n−1. |

### 5.2 Data Quality gate

**FR-2.1 — The DQ gate must block simulation on any error-severity issue.**
`passed = !issues.some(i => i.severity === 'error')`. Warnings never block.

**FR-2.2 — The following 18 checks must be performed.** Errors block; warnings inform.

| # | Field | Severity | Trigger |
|---|---|---|---|
| 1 | Column Mapping | **error** | Interval Start or Volume column unmapped |
| 2 | Inflow Data | **error** | Zero intervals found *(early-returns; skips all later checks)* |
| 3 | Operating Hours & Demand Distribution Diagnostic | warning | >15% of volume arrives outside operating hours |
| 4 | Volume Parsing | warning | A volume cell needed correction (thousands separator/currency stripped, or a negative value rejected to 0) |
| 5 | Timestamps | **error** | Any unparseable timestamp — message names `dd/mm/yyyy`, notes `mm/dd` is rejected |
| 6 | Interval Length | **error** | Any interval whose duration differs from 30 minutes by >0.1 min |
| 7 | Duplicate Slots | **error** | Repeated category + timestamp. Adds a hint when a separate time column exists but is unmapped ("…intervals do not all collapse to 00:00") |
| 8 | Category Config | **error** | A category in the file has no AHT/shrinkage configuration |
| 9 | Category AHT | **error** | `ahtMinutes <= 0` |
| 10 | Category Shrinkage | **error** | Shrinkage outside `[0, 1)` |
| 11 | Opening WIP | **error** | A WIP category is not present in the demand forecast |
| 12 | Total Workload | **error** | Total workload hours is 0 |
| 13 | Capacity Basis (M1) | **error** | `dailyProductiveHours > dailyWindowLength + 0.05` |
| 14 | Labor Adherence | **error** | Adherence outside `(0, 1]` |
| 15 | Labor Adherence | warning | Adherence `< 0.70` |
| 16 | Labor Off Days | warning | `offDaysPerWeek === 0` on a non-24/7 calendar — often the residue of toggling 24/7 back off |
| 17 | Manual Agent Hours Override | warning | Override active and far out of scale (>3× or <⅓) vs. `dailyProductiveHours × calendarWorkingDaysInHorizon` |
| 18 | Calendar/Data Coverage Gap | warning | A calendar-open day inside the horizon has zero uploaded rows (only when every timestamp parsed cleanly, to avoid a wall-clock-dependent horizon fallback) |

**FR-2.3 — The DQ tab must summarise the dataset**: Total Intervals, Total Case Volume,
Working Days in Horizon, Total Workload (hours).

**FR-2.4 — The off-hours diagnostic must classify volume** into Inside Hours, Weekday
Off-Hours, and Weekend/Non-Work, each as a percentage and case count, surfaced both in DQ and
on the Run pre-flight screen.

### 5.3 Business calendar configuration

| ID | Requirement | Detail |
|---|---|---|
| **FR-3.1** | 24/7 mode toggle | Default **off**. Enabling forces all seven working days and sets `workingDaysPerWeek: 7`, `offDaysPerWeek: 0`; disables the working-days selector, hours grid and holidays block. |
| **FR-3.2** | Working days of week | Seven toggle chips for working-day membership (**default: Mon–Fri**). A separate **Week starts** picker (any weekday, default Mon) only rotates chip display order; stored `workingDays` indices (`0=Sun…6=Sat`) and calendar/DES logic are unchanged. |
| **FR-3.3** | Daily open/close times | Open hour 0–23 (**default 8**), minute 0–59 step 5 (**default 0**); close hour 0–24 (**default 18**), minute 0–59 step 5 (**default 0**). Close hour 24 zeroes and disables the minute field. |
| **FR-3.4** | Midnight normalisation | A `00:00` close with a non-zero open, or hour ≥24, is treated as 24:00 — the window runs through 23:59:59 rather than parking evening cases early. |
| **FR-3.5** | Operating window presets | `08:00–17:00`, `09:00–18:00`, `09:00–24:00`, `00:00–24:00`. |
| **FR-3.6** | Holiday closures | Date picker; stored `YYYY-MM-DD`, sorted, duplicates ignored. Default empty. Bypassed under 24/7. |
| **FR-3.7** | Window length read-out | Displays daily business window length in hours, live. |

### 5.4 Labor configuration

| ID | Field | Bounds | Default |
|---|---|---|---|
| **FR-4.1** | Scheduled Daily Productive Hours | 1–24, step 0.1 | **7.5** |
| **FR-4.2** | Schedule Adherence % | 10–100, step 1 | **100%** |
| **FR-4.3** | Working Days per Week | 1–7 | **5** (auto-sets off-days = 7 − value) |
| **FR-4.4** | DES Present Hours / Day | read-only | `dailyProductiveHours × adherence` |
| **FR-4.5** | Agent hours for Workload HC | `Derived (Horizon Default)` or `Manual Override` | **Derived**; override default **0** (ignored until user enters hours &gt; 0) |

**FR-4.6** — The Capacity Basis (M1) rule must be displayed live with a `COMPLIANT` /
`VIOLATION` indicator: scheduled daily productive hours must not exceed the daily business
window.

### 5.5 SLA policy configuration

| ID | Setting | Options | Default |
|---|---|---|---|
| **FR-5.1** | SLA Clock Basis | `Business Time` / `Wall Clock` | **Business Time** |
| **FR-5.2** | Clock Start Policy | `Arrival Time` / `Next Open` | **Arrival Time** |
| **FR-5.3** | Primary SLA target | 1–100% | **80%** |
| **FR-5.4** | Primary SLA window | ≥1, unit Min/Hrs/Days | **6 Hrs** |
| **FR-5.5** | BO ASA target | toggle; target ≥1 + unit; basis `Business Window` / `24/7 Clock` | **Off**; 60 minutes; Business Window |
| **FR-5.6** | Occupancy ceiling | toggle sets a **custom** target 50–100%; always enforced | **Off** → target is **100%** (physical feasibility only); On → target is the configured %, 85% suggested (COPC-aligned) |
| **FR-5.9** | Statistical CI confidence | numeric **50–99.9** (global; SLA Defaults tab) | **95** |
| **FR-5.10** | SLA Acceptance Slack | toggle; slack % **1–20** | **Off**; **5%** |
| **FR-5.11** | Workload Reduction | toggle; reduction % **1–50** | **Off**; **5%** |
| **FR-5.12** | Minimum Coverage Floor | toggle; min agents/interval **0–operationalHC** | **On**; **1** |

**FR-5.12 detail (added 2026-08-28).** The queue may never be left with fewer than
`minAgentsPerInterval` agents on shift during any open business interval — a structural
requirement (G1), not a statistical target: the gate fails a candidate if the WORST
replication's minimum observed coverage falls below the floor, with no averaging across
replications the way Primary SLA/occupancy/ASA are gated. **On by default at 1** — unlike
every other toggle on this tab, omitting `minCoverageEnabled` or `minAgentsPerInterval`
resolves to enabled/1, not off (`resolveMinAgentsPerInterval`, `des-engine.ts`). Off, or
`minAgentsPerInterval: 0`, reproduces pre-2026-08-28 behavior exactly (D32 parity suite).
When it binds, the search satisfies it by **redistributing shift starts at the current N
first** (`buildCoverageRepairDistribution`, `hc-search.ts`) — independent of
`labor.shiftPlacementEnabled` — and only raises the recommendation if no redistribution at
that N can satisfy it. Root cause this closes: a business window wider than the shift length
made every agent exhaust their daily budget in lockstep under uniform-start, leaving the
tail of the window at zero coverage regardless of headcount (Stage 3a's original problem
statement) — but coverage had never been an enforced constraint until now, only a
side-effect Stage 3a's optimizer might or might not fix. Results show a "Minimum Coverage"
card next to the Occupancy card when enabled.

**24×7 — regression fixed, then real multi-start delivered same day (§11 P0-4 now closed).**
A same-day sequence: the gate above was briefly not enforced for `calendar.is24x7` after an
interim fix (`staggeredMode` was unconditionally false for 24×7, so "on shift" degenerated
to "still has daily budget remaining" with neither repair lever available — measured 267%
inflation, N=3→11, on a scenario where SLA/occupancy both already passed). Rather than leave
24×7 with no coverage guarantee, `getValidSlapStarts` now enumerates a real shift-start grid
for 24×7 (previously a degenerate `[0]`) over the fixed 1440-minute day, and staggering,
shift-end enforcement, and coverage repair all now work for 24×7 exactly as they do for
business-hours calendars — non-wrapping shifts only (a rostering nicety, not a coverage
requirement: three 8h starts at 0/480/960 already tile a full day). The same scenario that
needed N=11 under the interim guard now finds a genuinely covering N well below that via
real redistribution (suite D37). Two further defects were found and fixed while validating
this: (1) coverage sampling fired immediately inside each event handler, so an outgoing
cohort's `ShiftEnd` and an incoming cohort's `AgentAvailable` landing on the identical
timestamp could sample a transient false-zero between them — fixed by deferring the sample
to the same point the interval-timeline log already defers to (Gap H's mechanism); (2) an
agent working their final chunk of daily budget showed `agentDailyMinutesRemaining ≈ 0` (it
is decremented at assignment time, not completion time) and was wrongly excluded from the
on-shift count while still genuinely present and busy — fixed by also counting agents
currently in `activeProcessing`. One remaining known limitation: `buildOneDayDemandGrid`
still buckets all 24×7 demand into a single whole-day cell (pre-existing, not introduced
here), so the SLA-driven placement greedy has little signal for 24×7 — coverage repair is
unaffected (pure geometry, independent of demand data) and is the mechanism that actually
matters for this fix.

**FR-5.6a — The ceiling is always in force.** `occupancyCapEnabled` does not switch a
constraint on and off — it selects whether to use a custom target instead of the 100% default.
A recommendation can never exceed the resolved target (see `resolveOccupancyCapPct` in
`des-engine.ts`), because at ≥100% true occupancy the queue is unstable by definition (demand
meets or exceeds capacity). *Fixed 2026-08-27:* before this, the gate compared the **clamped**
display value (`Math.min(100, raw) <= 100`), which is true for every input — the ceiling never
rejected anything, regardless of the toggle. See §7.3a.

**FR-5.7 — Per-category SLA overrides.** A matrix allows per-category Primary SLA target,
window and unit, and (when ASA is enabled) per-category ASA target. Resolved deadlines are
shown as a read-out. CI confidence is **global only** — it is not per-category and is not
copied by bulk template apply.

**FR-5.8 — Bulk template application.** "Apply Template to All Categories" copies the global
Primary/ASA baseline onto every category (not CI confidence).

**FR-5.9 detail.** The CI level drives a continuous Student’s-t critical value (Acklam
inverse-normal + Cornish–Fisher inverse-t) used for Primary SLA, BO ASA, and occupancy
intervals. Pass rule: CI lower bound ≥ **sizing floor** (or median when R=1); ASA/occupancy
use the matching upper bound vs their targets. The sizing floor equals the official Primary %
when Acceptance Slack is OFF; when ON it is `Primary% × (1 − slack/100)`. **Search never goes
below analytical `N_min`**; if the CI already passes at that floor, changing to a looser CI
does not reduce Req HC. Re-run after changing the field.

**FR-5.10 detail.** Optional planner acceptance band on the Primary CI gate only. When ON,
global and per-category Primary CI passes against the sizing floor (e.g. policy 80%, slack 5%
→ floor 76%). Stated policy Primary %, case deadlines/windows, EDF dispatch, N_min,
occupancy, and ASA are unchanged. When OFF, behaviour is identical to pre-1.3 (CI ≥ Primary %).
Results must show both **policy** and **sizing floor** and must not claim a statistical
guarantee above the floor when slack is ON. Audit snapshot records
`sla_acceptance_slack: off | N% (sizing floor X%)`.

**FR-5.11 detail.** Optional workload discount on the analytical N_min baseline only. When ON,
the total workload-hours input to Stage 2 (`floor(Workload × (1 − reduction%) / denominator)`)
is discounted by the user-specified %; this produces a lower `N_min` that becomes the DES search
floor. DES may still recommend above this discounted floor if Primary SLA / BO ASA / occupancy
constraints bind higher. When OFF, behaviour is unchanged. Results must label where reduction
is applied and show both the unreduced N_min (when the reduction had no effect due to floor rounding)
and the reduced N_min. **Limitation:** Rounding can mask small % cuts (e.g. 590h ÷ 100h → `floor(5.9)=5`;
at 10% → `floor(5.31)=5`, unchanged). Audit snapshot records
`workload_reduction_pct: off | N%`.

### 5.6 Category configuration

| ID | Field | Bounds | Default (auto-discovered) |
|---|---|---|---|
| **FR-6.1** | AHT (Minutes) | ≥1 | **30** |
| **FR-6.2** | Shrinkage % | 0–99 | **20%** |
| **FR-6.3** | Priority Rank | ≥1 | alphabetical index |

**FR-6.4** — Primary SLA and BO ASA are displayed read-only here (centrally governed in the
SLA Policy tab) with a lock indicator.

Seeded defaults before any upload: `Claims_Auto` (AHT 35, shrinkage 20%, priority 1),
`Claims_Home` (45, 20%, 2), `Claims_Life` (60, 25%, 3).

### 5.7 Opening WIP (backlog carry-in)

| ID | Requirement | Detail |
|---|---|---|
| **FR-7.1** | Manual entry | Category (select), Remaining Work minutes (≥1, **default 30**), Arrival/Clock Start (`datetime-local`, defaults to first interval start). IDs auto-generate as `WIP-0001`. |
| **FR-7.2** | Bulk CSV import | Six mappings: Category*, Arrival/Date*, Time, Case ID, Remaining Work, Priority. Auto-detected where possible. |
| **FR-7.3** | Import validation feedback | Reports rows skipped for date-format violations and categories that will fall back to the first configured category. |
| **FR-7.4** | Import preview | First four parsed cases shown before commit. |
| **FR-7.5** | Import modes | `Replace WIP (n)` or `Append +n to existing (m)`. |
| **FR-7.6** | WIP list management | Table of all WIP with per-row delete and Clear All; shows total pending work in minutes and hours. |

### 5.8 Simulation execution

| ID | Parameter | Bounds | Default |
|---|---|---|---|
| **FR-8.1** | Queue Architecture | `Pooled (Cross-Skilled)` / `Siloed (Dedicated)` | **Pooled** |
| **FR-8.2** | Statistical Replications | 1–100 | **30** |
| **FR-8.3** | Search Ceiling (userMaxHC) | 1–5000 | **500** |
| **FR-8.4** | Base PRNG Seed | integer | **12345** |

**FR-8.5 — Pre-flight checklist.** Six checks, each `PASSED` / `REQUIRED`, with a global
`ALL GATES CLEARED` / `GATE BLOCKED` state:
1. Labor & Business Calendar Configured
2. Capacity Basis Rule Compliant (M1)
3. AHT & Shrinkage Set for Every Inflow Category
4. Mandatory 30-Minute Inflow File Mapped
5. Data Quality (DQ) Gate Passed
6. Workload Demand > 0 Hours

**FR-8.6 — Live progress.** A blocking modal reports phase, percentage, current candidate N,
the analytical lower bound, evaluated step count, and a live feed of every candidate
headcount with its Primary SLA, Occupancy, BO ASA (when enabled) and PASS/Fail status.

Phases: *Analytical Workload Baseline* (10%) → *Workload Baseline Established* (25%) →
*Building CRN replications* (25–30%) → *Statistical Primary SLA Search (Testing N = n)* →
*Final Audit Pass & Boundary Verification* (94%) → *Sizing & Verification Complete* (100%).

**FR-8.7 — Cancellation.** A `Stop Simulation` button cancels mid-run. Cancellation is
treated as clean — no error is raised.
*Current behaviour: cancelling also clears any previously computed results (see §11, P1).*

**FR-8.8 — Determinism.** For a fixed seed and input, repeated runs must produce identical
results.

### 5.9 Results and evidence

**FR-9.1 — Summary tab** must present the following sections **in this top-to-bottom order**
(infeasibility banner first when present; otherwise the Dual Sizing banner leads):
1. An **infeasibility banner** when no headcount within the search cap satisfies the
   constraints, carrying the reason.
2. A **Dual Sizing Engine Verified** headline banner with two headline figures:
   **Net Operational HC** (post-DES seats after the **extra OFF roster uplift** — see Stage 4;
   subtitle `X% OFF → +Y% roster uplift` where X is the net extra OFF display fraction and Y is
   the seat-to-roster coverage-ratio uplift actually applied — the two differ whenever extra OFF
   is nonzero, since Y accounts for agents supplying capacity on open days only),
   **Pooled Gross HC (M2)**; plus a
   **planner sizing strip**: Workload HC → SLA on-duty HC (simulator seats, pre-OFF, with delta
   and % vs workload) → Hire after shrinkage. Binding-constraint caption remains on this banner.
   (Headline Hiring FTE / M4 is temporarily hidden — see §11.)
3. A **Backoffice DES Sizing Engine** record card (mirrors the completed Run progress modal):
   completion status, recommended HC, analytical lower bound (`N_min`), evaluated step count,
   and the headcount candidate evaluation feed (`searchHistory`: tested HC, Primary SLA,
   occupancy, optional BO ASA, pass/fail).
4. **Primary SLA-Driven Sizing** with CI lower/upper bound at the configured confidence level
   (default 95%), sample median, mean and σ, and a plain-language statistical guarantee
   statement that cites that level against the **sizing floor** (policy Primary % when slack
   is OFF; effective floor when FR-5.10 is ON). When slack is ON, Results also show policy vs
   sizing floor and audit `sla_acceptance_slack`.
5. A **core performance grid**: Primary SLA Achieved (with progress bar vs sizing floor),
   BO ASA, and Handling Occupancy %. When raw occupancy exceeds 100%, an explicit overload
   message: *"True capacity ratio: X% — demand exceeds capacity, staffing is insufficient."*
6. A **per-category breakdown**: workload hours, workload share, Net HC, shrinkage, Gross HC,
   achieved vs sizing floor Primary SLA (policy shown when slack ON), mean ASA,
   with a pooled total row.
7. A **Mathematical Invariants Audit** panel (M1–M3 shown; display-only — see §10).

**FR-9.2 — Staffing Path tab** must show the five-step derivation waterfall — Total Workload
→ Analytical Baseline (N_min) → Statistical Primary SLA Search → Extra OFF Roster Uplift (Labor
offs beyond calendar-closed days, applied as a coverage ratio) → Pooled Gross HC & Harmonic
Shrinkage — each with its value and formula. When the labor policy makes coverage infeasible
(off days meet or exceed open days), this step must say so explicitly rather than silently
leaving Net Op un-adjusted.

**FR-9.3 — Case Browser** must list every simulated case with Case ID, Category, Arrival,
Primary Deadline, First Start, Completed, Parks and SLA Outcome; support free-text search,
category filter and status filter (`Completed Only` / `Breached SLA Only` / `Unfinished
Remainder Only`); paginate at 50 rows.

**FR-9.4 — Agent Browser** must provide:
- A **proof strip**: Occupancy Proof (timeline busy vs DES handling minutes vs available
  productive vs daily budget), SLA & Headcount, and Workload Roster Floor.
- An **audit invariant banner** running `verifyAgentTimelineInvariants` and listing any
  reconciliation failures.
- An **Agent Performance Summary**: per-agent busy/idle/off minutes, occupancy %, cases
  handled, resumes, max daily busy vs daily budget (flagged on violation), and an
  Existing/New roster-source split at the analytical floor.
- An **Agent Work Slice Drill**: every timeline slice with state, case, category, from/to and
  minutes; click-through filtering from the summary table. Slice **state** is stored as
  `busy` / `idle` / `off`; the UI and slice CSV display `off` as **OOQ** (out of queue),
  not `OFF`, so planners do not confuse out-of-queue time with weekly time-off. The state
  filter option reads **OOQ Only** (filter value remains `OFF` against the stored enum).

**FR-9.5 — Queue / WIP tab** must show interval-by-interval Queued WIP, Active Handling,
Parked WIP, Cumulative Completed and Available Agents, with a CSV export of the timeline
(UTF-8 BOM, `wfm_queue_wip_timeline.csv`). Each row's counts are captured only after every
event scheduled at that exact timestamp has been processed (fixed 2026-08-28 — previously the
day-open row of every day after the first was logged one event too early, reading
`Available Agents = 0` at business open even though the roster was fully staffed a moment
later within the same tick; see decision log).

**FR-9.6 — Audit Drill tab** must present the boundary decision rationale and a sample of
breaching cases at N−1 with Case ID, Category, Arrival, Primary Deadline, Latest Safe Start
and failure reason. It must also present the full, paginated list of every case that fails
the primary SLA in the final simulated run at the recommended headcount N — Case ID,
Category, Arrival, Primary Deadline, Latest Safe Start, First Start, Completed, Parks and
failure reason — sorted by Primary Deadline, 50 rows per page, with a CSV export of the
complete breach list (UTF-8 BOM, `wfm_sla_breach_cases.csv`), and an empty-state message
when there are no breaches at N.

**FR-9.7 — Assumptions tab** must show a full parameter snapshot (labor/calendar policy and
SLA/simulation policy) and export it as JSON.

### 5.10 Sensitivity analysis

| ID | Requirement | Detail |
|---|---|---|
| **FR-10.1** | 5×5 stress matrix | Volume deltas × AHT deltas, each `[−20, −10, 0, +10, +20]%`. **Fixed, not user-configurable.** |
| **FR-10.2** | Full re-simulation per cell | Each of the 25 cells runs a complete headcount search with scaled volume and AHT. |
| **FR-10.3** | Metric toggle | `Net Operational HC` / `Pooled Gross HC (M2)`. |
| **FR-10.4** | Progress and cancellation | Live "Testing scenario i of n" with a Stop control. Partial results are discarded on cancel. |
| **FR-10.5** | Comparison view | Five named scenarios: Baseline, Light Efficiency (−10/−10), High Volume Inflow (+20/0), High Complexity (0/+20), Severe Combined Stress (+20/+20). |

### 5.11 Export and configuration portability

| ID | Export | Contents |
|---|---|---|
| **FR-11.1** | Cases CSV | `wfm_simulated_cases.csv` — every case with timestamps, deadline, latest safe start, park count, WIP flag, SLA outcome, ASA duration and censoring flag. |
| **FR-11.2** | Agent Slices CSV | `wfm_simulated_agent_slices.csv` — every timeline slice with local and ISO timestamps. |
| **FR-11.3** | Agent Summary CSV | `wfm_simulated_agent_summaries.csv` — per-agent totals, occupancy, budget compliance. |
| **FR-11.4** | Assumptions JSON | `wfm_config_snapshot_{timestamp}.json` — calendar, labor, SLA, categories, sim params, column mapping. |
| **FR-11.5** | Config import | Restores the same six keys defensively; reports invalid JSON. |
| **FR-11.6** | SLA Breach Cases CSV | `wfm_sla_breach_cases.csv` — every case failing the primary SLA at recommended HC N (Audit Drill tab), with timestamps, latest safe start, park count and failure reason. |
| **FR-11.6** | Excel compatibility | All CSV exports are UTF-8 with BOM, fully quoted, `\r\n` line endings. |

*Current behaviour: exports always contain the full result set, not the filtered view
(see §11, P1).*

### 5.12 Application shell

| ID | Requirement |
|---|---|
| **FR-12.1** | Persistent header showing breadcrumb, a DQ status pill (`DQ Gate Cleared` / `DQ Gate Blocked`), and once results exist a `Net HC / Gross HC` chip. |
| **FR-12.2** | A read-only **Params & Logic Inspector** drawer summarising SLA clock basis, capacity basis, contractual hours, discovered categories and the PRNG seed. |
| **FR-12.3** | Reset All with a confirmation modal, restoring every default and clearing all data and results. Fixed 2026-08-31 (`UPLOAD-STALE-STATE`): the same confirmation now also gates uploading a new demand file or loading a sample dataset whenever a session already has data loaded — previously a new upload silently replaced only the CSV rows while calendar/labor/SLA/categories/sim-params/opening WIP from the prior session persisted untouched, which could blend an old policy configuration with new demand data with no warning (root cause of a user-reported sizing discrepancy: a stale browser tab produced a materially different, wrong headcount with no indication anything was stale). Cancelling the confirmation leaves the existing session completely untouched, so a user can export their config first if they want to keep it. A brand-new session (no data loaded yet) skips the confirmation and applies immediately — see FR-1.8. |

---

## 6. The sizing methodology

Four stages. Each answers a different question; the separation is deliberate.

### Stage 1 — Demand → Workload

```
Workload_hours = Σ (Volume_c × AHT_c / 60)  +  Σ openingWIP_remaining_minutes / 60
```

Per category, because AHT differs by category and a shift in category *mix* changes workload
even when total volume is flat. Opening WIP uses **remaining** work on part-processed cases,
not full AHT.

### Stage 2 — Workload → analytical baseline (`N_min`)

```
agentHours = Manual Override if source=override AND hours > 0
           else DailyProductiveHours × calendarWorkingDaysInHorizon
N_min = floor( Workload_hours / (OccupancyCap × agentHours × Adherence) )
```

The **steady-state floor** (Workload HC): below this, capacity is less than demand and backlog
grows without bound regardless of scheduling. Default Manual Override hours = **0** (ignored).

Two deliberate properties:
- **Shrinkage is absent here.** `N_min` is *operational* headcount — people on the floor.
  Shrinkage converts that to people employed, in Stage 4. Applying it in both places is the
  classic double-count.
- **The occupancy cap is in the denominator**, expressing "size so that required utilisation
  stays at or below the ceiling". `OccupancyCap` here is the **resolved** target (100% when the
  toggle is off — see FR-5.6a), not a hard-coded 1.0; scenarios that already sized correctly at
  ≤100% occupancy are unaffected, since `1.0` is exactly what the resolver returns by default.
- **Override hours feed Workload HC only** — not a separate FTE hiring step (M4 UI hidden).

### Stage 3 — Baseline → recommended headcount (DES + CI search)

`N_min` ignores *timing*. Capacity available on Friday cannot serve a Tuesday deadline. The
simulation tests whether each candidate headcount actually meets the deadline distribution.

1. Start at `N_min`.
2. **Leap** upward in doubling steps until a candidate passes (cheap probes at 5 replications,
   confirmed at full 30).
3. **Walk down** by −1 from that ceiling, re-testing at full replications, stopping at the
   first failure. The last passing N is the answer.

Each candidate is evaluated over **30 replications** under **Common Random Numbers** — the
same arrival realisations are reused across every candidate, so candidates differ by headcount
and not by luck of the draw.

A candidate passes only when the **configured confidence interval bound** (default 95%;
90 or 99 when selected on SLA Defaults) clears the **sizing floor**: lower bound ≥ sizing
floor for Primary SLA attainment (official Primary % when Acceptance Slack is OFF; effective
floor when ON — see FR-5.10), upper bound ≤ cap for occupancy and ASA. The occupancy check runs
**unconditionally** against the resolved target (FR-5.6a) — it is never skipped, only its
target value changes with the toggle.

Within the simulation, cases are dispatched **Earliest Deadline First**, ordered by *Latest
Safe Start* — the last moment work can begin and still meet the deadline, computed by walking
backwards through the business calendar.

### Stage 3a — Deadline-coverage shift placement (opt-in, off by default)

**Root cause it addresses.** When every agent starts one uniform shift at business open
(today's default, unchanged), and `dailyProductiveHours` is shorter than the business window,
a persistent backlog keeps every agent continuously busy from open — so all of them exhaust
their daily budget in lockstep partway through the day, leaving the remainder of the window
with **zero available agents** every day, regardless of headcount.

**What it does.** `labor.shiftPlacementEnabled` (default `false`) lets the search also try a
*shift-start distribution* — different agents starting at different grid-aligned times within
the window (`labor.shiftSlapMinutes`, default 30) — before rejecting a candidate N that fails
under the uniform-start model. A valid shift start is only offered where the agent's full
daily-productive-hours budget fits entirely inside the business window with no truncation
(`getValidSlapStarts`, `src/utils/calendar.ts`).

**How a distribution is chosen.** Deterministic and analytic, **zero extra DES runs**: every
case's release (`clockStart`) and deadline (`primaryDeadline`) are known before simulation
runs, so a release-gated deadline-coverage condition (a Hall/Horn-style feasibility check,
bucketed to the same grid as shift starts) can be evaluated directly. A house-monotone greedy
(`computeShiftPlacement`, `src/utils/hc-search.ts`) places agents one at a time, always onto
whichever grid-aligned window is currently most under-covered — house-monotone by
construction, so `place(N+1)` is always `place(N)` plus one more agent, never fewer anywhere,
which is what keeps the walk-down search's monotonicity assumption intact.

**Never-worse guarantee, now UNCONDITIONAL (fixed 2026-08-28, Gap A).** A distribution only
replaces the uniform-start result for a candidate N when it **verifiably passes** the same
CI-gated check the uniform model uses; if it does not pass (or the flag is off), the search
behaves byte-for-byte as before. `N_min` remains the frozen hard floor, unconditionally.
This guarantee previously had a narrow exception: `placementFeasibleFloor` (N_sla) also
raised the search's STARTING point, and when that raised start passed immediately, the
walk-down was skipped entirely — no verification check ran in that path at all. Measured on
2 of 192 swept configs, enabling the flag recommended a strictly higher headcount than
leaving it off. Fixed by removing N_sla from the starting-point calculation entirely; it
remains reported as `shiftPlacement.placementFeasibleFloor` for diagnostics only, never used
to seed or gate the search. This is the property the feature actually
guarantees: enabling it never makes the recommendation worse.

**Shift-end is now enforced (non-24×7, 2026-08-28).** An agent's presence is now bounded by
their own shift length, not just the daily-minute budget and business close — previously an
agent stayed available all the way to close regardless of when their shift started, which
disagreed with this section's own capacity model (confined to
`[offset, offset+shiftLength]`) and was the root cause of the greedy routinely choosing
distributions worse than uniform-start. When an agent's shift ends mid-case, the case is
handed to a still-on-shift colleague the same day rather than parked overnight. 24×7
calendars are unaffected (still zero staggering) pending a separate multi-start increment.
See PRD §11 P0-4.

**Capacity now correctly applies adherence (fixed 2026-08-28, Gap B).** The deficit/capacity
math (`shiftCapacityWithinDay`, feeding `computeShiftPlacement` and
`findPlacementFeasibleFloor`) previously credited each agent with un-adhered
`dailyProductiveHours × 60` minutes — a measured 25% over-credit at adherence 0.8 relative
to the DES's actual daily budget. `getValidSlapStarts`' window-fit test correctly keeps
using the un-adhered figure (a valid start is a SPAN question — is the agent physically
present within the window — not a capacity one). Closed-form pinned in suite D35.

**`shiftPlacementMaxAttempts` removed (2026-08-28, Gap G).** This field was documented in
detail — "Attempt 1 is always the analytically-optimal greedy... Attempts 2..max only
refine the reported schedule at an already-passing N" — but never implemented anywhere; the
function its doc cited did not exist in the codebase. Rather than build an under-verified
multi-attempt search under time pressure, the phantom field and its misleading doc comment
were removed. A real multi-candidate search remains valuable future work (see P0-4) but
needs a proven monotonicity argument before it can safely gate accept/reject, not just
before it changes which passing schedule is displayed.

**Honest status on value.** The analytic distribution has not been shown to reliably improve
the recommendation on realistic continuous demand — tested across many demand shapes, it was
frequently no better than, and sometimes worse than, a uniform start. It demonstrably can
find a genuine, verified-against-brute-force improvement on a demand shape purpose-built to
need one. Treat it as a safe, experimental lever, not a dependable fix — see L13.

**Diagnostics surfaced, not authoritative.** Two additional floors are computed analytically
before the search runs, for transparency only — they never gate or override `N_min`:
- `occupancyFeasibleFloor` (**N_occ**) — the smallest N whose occupancy can possibly clear the
  cap, computed on the **same** hours basis the DES occupancy gate actually uses
  (`dailyProductiveHours × adherence × workingDaysInHorizon`). When this basis disagrees with
  the contractual hours `N_min` uses (e.g. a contractual override larger than what the
  simulator delivers per agent), `N_min` can sit below the lowest N the occupancy gate will
  ever accept — this makes that gap visible instead of it being discovered by simulating
  doomed candidates.
- `shiftPlacement.placementFeasibleFloor` (**N_sla**) — the smallest N whose optimal placement
  analytically clears the SLA target, only computed when the flag is on.

**Known scope limit.** The demand-coverage model assumes each case's deadline falls on the
same working day as its release (same-day SLA windows — the common case for backoffice
turnaround targets of a few hours); a deadline on a later calendar day is treated
conservatively as "due by end of the release day," which never under-constrains but is not
perfectly tight for genuinely multi-day windows.

### Stage 4 — Operational HC → Extra OFF Roster Uplift → Gross HC / FTE

DES returns on-duty **seats** for calendar-open days only (closed weekdays are already
agent-off in the simulation). Stage 4 then applies the **extra OFF roster uplift** once, then
shrinkage:

```
openDays       = openDaysPerWeek                      // 24×7 → 7
calendarClosed = 7 − openDays
extraOffDays   = max(0, labor.offDaysPerWeek − calendarClosed)
coverageDays   = openDays − extraOffDays               // days/week one agent actually covers
OFF%           = extraOffDays / 7             // DISPLAY fraction only, never the multiplier
NetOpHC        = coverageDays > 0
                   ? floor(OperationalHC × openDays / coverageDays)
                   : OperationalHC            // infeasible roster — flagged, not silently 1×
opHC_c         = NetOpHC × workload_share_c
grossHC_c      = opHC_c / (1 − shrinkage_c)
GrossHC        = round( Σ grossHC_c )
effShrink      = 1 − 1 / Σ( share_c / (1 − shrinkage_c) )        ← harmonic; OFF not mixed in
```

**Agents only supply capacity on open days**, so the seat-to-roster multiplier is the coverage
ratio `openDays / coverageDays`, not `(1 + OFF%)` — OFF% divides by the calendar week, but a
head only ever covers the open week. The two formulas agree only when `extraOffDays = 0`
(the default 5-day-calendar + 5-day-Labor config); `(1 + OFF%)` under-states the roster for
every other configuration, worse as off days rise. (Prior to 2026-08-28 this stage used
`floor(OperationalHC × (1 + OFF%))`, which — outside the zero-extra-OFF default — under-sized
the roster; see `scripts/verify-sizing-fixes.mts` Suite D40 and
`trusted-source-validation.json` scenario `T1_A2c_extraoff_coverage_ratio`.) `NetOpHC` is
computed integer-exact as `floor(N × openDays / coverageDays)`, never via
`floor(N × (1 + fractionalUplift))`, which loses a seat to binary float error in real
configurations (e.g. 24×7 + 5-day agents: `45×(1+0.4) = 62.999999999999999 → 62`, not 63).

Order of operations matters: **extra OFF before shrinkage** (separate factors — never combine
into one %). Gross up **per category with its own shrinkage rate**, then sum, then apply a
**single** rounding. Blending rates first loses the per-category structure; rounding-per-
category over/under-rounds systematically. `N_min` and `NetOpHC` truncate to a whole number
(never round up); the final pooled `GrossHC` — the headline number a planner staffs to —
uses normal rounding to the nearest whole HC. Default 5-day calendar + 5-day Labor yields
extra OFF = 0 (weekends already in DES). Example: Labor 2 offs, business open 6 days →
extra = 1 → coverageDays = 5 → roster uplift = 6/5 − 1 = 20% (not OFF%'s 14%) →
Net Op = floor(100 × 6/5) = 120 → Gross = round(120 / 0.8) = 150.

### 6.1 Occupancy is a ratio, not a utilisation percentage

This is the single most misread number in the product, and it is deliberate.

```
Occupancy = handling minutes ÷ PLANNED capacity minutes
```

The denominator is **planned horizon capacity**, not actual minutes worked. Consequently
`rawOccupancyPct` **can exceed 100%**, and when it does it is reporting overload magnitude:
*"you need 43% more capacity than you have."*

| Denominator | Question answered | Used for |
|---|---|---|
| **Planned capacity** | *"Do I have enough people?"* | **Sizing** — this is the constraint |
| Actual on-duty minutes | *"How hard did my people work?"* | Per-agent reporting only |

Widening the denominator to include the backlog-drain window would make an undersized team
look adequately utilised *because it took extra weeks to finish* — inverting the signal a
capacity planner needs. See §7.3.

---

## 7. Design decisions and rationale

Ten decisions that look like candidates for simplification and are not. Each has been
validated; changing any of them requires deliberate review.

### 7.1 Discrete-event simulation, not Erlang-C
Erlang-C models real-time queueing with abandonment. Deferred work has no abandonment, has
per-case deadlines, and queues legitimately across days. Simulating individual cases ageing
against their own deadlines is the correct model for this problem class.

### 7.2 Earliest-Deadline-First dispatch
Cases are ordered by Latest Safe Start. EDF is optimal for maximising on-time completions
under deadline scheduling — better than FIFO or static priority. LSS is derived by walking
*backwards* through the business calendar, not by wall-clock subtraction: a case needing four
hours against a 09:00-tomorrow deadline cannot start at 23:00 tonight.

### 7.3 Planned-horizon occupancy denominator
See §6.1. Occupancy is a demand ÷ capacity ratio. This was challenged during audit and
**confirmed correct** — the proposed "fix" would have inverted the overload signal. Retained
deliberately, with a regression test pinning the denominator.

### 7.3a Occupancy ceiling gate — fixed 2026-08-27
The *metric* (7.3) was always correct. The *gate* that is supposed to reject a candidate above
the target was not: it compared `Math.min(100, rawOccupancyPct)` — the display-clamped value —
against the cap, and `Math.min(100, raw) <= 100` is true for every possible input. A headcount
at 142.9% true occupancy (demand 43% over capacity) could pass with the toggle on and a 100%
target, and passed unconditionally with the toggle off. Fixed by gating on `rawOccupancyPct`
(unclamped) via `resolveOccupancyCapPct`, which always resolves a target — 100% by default
(physical feasibility: ρ≥1 is an unstable queue by definition), the configured value when the
toggle is on. The CI-gated statistical path had the same defect twice over: occupancy samples
were pre-clamped and the CI upper bound clamped again, so an overloaded candidate's confidence
interval collapsed to a point at exactly 100 instead of reporting the true ratio.

**Deliberately not changed:** the default planning assumption stays 100%, not the COPC-aligned
~85% suggested in the UI (FR-5.6). This is a correctness fix, not a policy change — every
scenario whose recommendation already sat at ≤100% occupancy produces an identical
recommendation, because `Math.min(100, raw) <= 100` and `raw <= 100` agree everywhere except
above 100. Only scenarios that were silently returning an infeasible (>100%) recommendation are
affected, and only up to the smallest feasible headcount.

### 7.4 `N_min` as a hard search floor
The simulation grants a drain window past the horizon end so in-flight work can finish.
Without a floor, a headcount below the steady-state line could appear to pass by exploiting
that finite-horizon edge effect while being unsustainable in a repeating period.

`N_min` itself is computed with `floor`, not `ceil` (deliberate change, see §7.7): it
truncates the raw workload/capacity ratio to a whole number rather than rounding up. This
makes `N_min` a slightly looser floor than before at fractional ratios (e.g. 1.125 agents
→ 1, not 2) — the DES search still has to clear the CI-gated SLA/occupancy bounds above
that floor, so under-sizing is still caught at Stage 3, not silently passed at Stage 2.

### 7.5 Shrinkage applied once, at Stage 4
`N_min` is operational headcount; shrinkage converts to rostered headcount. Applying it in
both stages is the most common WFM sizing error.

### 7.6 Harmonic effective-shrinkage blend
Because gross-up divides by `(1 − shrinkage)`, the quantity that adds linearly is
`1/(1 − shrinkage)`, not shrinkage itself.

> Worked example — two equal-share categories at 10% and 30%:
> arithmetic mean gives 20% (factor 1.250); the correct harmonic blend gives **21.25%**
> (factor 1.270). The arithmetic mean understates headcount, and the gap widens as rates
> diverge.

### 7.7 Per-category gross-up, then sum, then one rounding
A rounding operation applied per category would round once per category, systematically
compounding error across categories. Gross-up is summed across categories first, and only
the pooled total is rounded, once. As of this revision the pooled `GrossHC` total uses
normal rounding (`round`, nearest whole HC) rather than `ceil` — a deliberate, explicitly
approved change from the prior always-round-up rule. `N_min` and `NetOpHC` upstream still
truncate (`floor`) rather than round up or down to nearest.

### 7.8 Confidence-interval-gated acceptance
A single simulation run is one sample, not an answer. Requiring the CI bound to clear the
sizing floor — rather than the mean — accepts a headcount only when the evidence supports it.
The confidence level is a global SLA Defaults parameter (`confidenceLevelPct`: **50–99.9**,
default 95); result field names remain `ci95Low` / `ci95High` for compatibility and hold
bounds at the configured level. Optional **SLA Acceptance Slack** (`slaAcceptanceSlackEnabled`,
default OFF) lowers the Primary sizing floor to `Primary% × (1 − slack/100)` without changing
deadlines or dispatch. When recommended HC equals `N_min`, the binding constraint is reported
as the analytical baseline (not CI).

### 7.9 Common Random Numbers
Reusing identical arrival realisations across candidates is variance reduction, not
redundancy. It sharply reduces the replications needed to distinguish adjacent headcounts.

### 7.10 House-monotone agent apportionment
The walk-down search stops at the first failing N, which is valid **only if pass/fail is
monotone in N**. Agent allocation across silos therefore uses a divisor (Webster/Sainte-Laguë)
method, which is house-monotone by construction.

> This was a real defect. The original largest-remainder (Hamilton) method is subject to the
> apportionment **"Alabama paradox"**: measured over N=1..200 it produced **14 reversals**
> where adding an agent *removed* one from a category — including a silo dropping from 1 agent
> to **0**, leaving work with nobody to do it. The divisor method produces **zero**.

---

## 8. Non-functional requirements

### 8.1 Offline operation — *hard constraint*

| ID | Requirement |
|---|---|
| **NFR-1.1** | The product must run with **no network access whatsoever**, opened directly from `file://`. |
| **NFR-1.2** | No `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, or remote dynamic import in shipped source. |
| **NFR-1.3** | No CDN assets, remote stylesheets, web fonts, remote images or remote source maps. |
| **NFR-1.4** | No telemetry, analytics or error reporting. No user data leaves the machine. |
| **NFR-1.5** | The build must **fail loudly** if the artifact references anything remote. |

Absolute URLs that are *identifiers rather than fetches* are permitted: W3C XML namespace
URIs, React's error-documentation URL inside a message string, and the Tailwind attribution
comment. Nothing else.

### 8.2 Zero runtime dependencies

| ID | Requirement |
|---|---|
| **NFR-2.1** | Runtime dependencies limited to React, React-DOM and the icon library. No new runtime dependency may be added without explicit approval. |
| **NFR-2.2** | Build tooling is devDependency-only and must never reach the artifact. |

### 8.3 Deliverable

| ID | Requirement |
|---|---|
| **NFR-3.1** | A **single** HTML file with all CSS and JavaScript inlined (~513 KB). |
| **NFR-3.2** | No installer, no server, no runtime prerequisites beyond a modern browser. |

### 8.4 Determinism and reproducibility

| ID | Requirement |
|---|---|
| **NFR-4.1** | Identical seed + identical input ⇒ identical output, always. |
| **NFR-4.2** | No `Math.random()`, `Date.now()` or ambient clock reads may influence a computed result. |
| **NFR-4.3** | Every sizing run must be reproducible from its exported assumption snapshot. |

### 8.5 Data handling and privacy

| ID | Requirement |
|---|---|
| **NFR-5.1** | All processing is in-browser. No data is transmitted anywhere. |
| **NFR-5.2** | **No persistence** — no `localStorage`, `sessionStorage`, `indexedDB` or cookies. State is lost on refresh. *This is current behaviour, stated as fact.* |

### 8.6 Performance

| ID | Requirement |
|---|---|
| **NFR-6.1** | A typical sizing run (5-day horizon, ~1,200 cases, 30 replications) must complete without the UI becoming unresponsive — the async engine yields between replications. |
| **NFR-6.2** | Long runs must report live progress and be cancellable. |
| **NFR-6.3** | The engine must handle multi-thousand-interval datasets (the reference input is 5,952 rows). |

### 8.7 Compatibility

| ID | Requirement |
|---|---|
| **NFR-7.1** | Current Chromium, Firefox and Safari; ES2020+; no IE support. |
| **NFR-7.2** | Desktop-first layout — this is an analyst tool. |

---

## 9. Validation and quality

### 9.1 Automated test suites — 251 checks

| Suite | Tests | Covers |
|---|---|---|
| `scripts/verify-fixes.mts` | 156 | Legacy regression: CSV parsing, date handling, calendar arithmetic, CRN consistency, occupancy semantics, standalone artifact integrity, analytical infeasibility diagnosis, 24x7 midnight budget accounting |
| `scripts/verify-sizing-fixes.mts` | 95 | Sizing chain: working-day counting, apportionment monotonicity, staffing-chain integrity, offline/zero-dependency enforcement |
| `scripts/check-artifact-freshness.mts` | gate | Fails if `BoWFM.html` is missing or older than shippable sources (`npm run check:artifact`) |

Run with `npm test` (suites + freshness gate). No test framework is used — that would breach NFR-2.1; both suites use a
plain assert helper.

### 9.2 Independent ground truth

`trusted-source-validation.json` holds expected values derived **by hand, independently, using
closed-form arithmetic and calendar rules only — not by running the app's own code**.

The derivation uses **Horn's theorem** for preemptive scheduling on identical machines:
minimum feasible headcount equals the ceiling of the maximum, over all release/deadline
windows, of required processing time divided by available working minutes in that window.

This matters: a test that compares the code against itself proves only self-consistency. A
disagreement with an independently derived number is evidence of a **real** bug.

### 9.3 Internal reconciliation

`verifyAgentTimelineInvariants` recomputes the headline figures from an independent data path
— the per-agent timeline — and cross-checks that busy minutes reconcile with total handling
minutes, no agent exceeds their daily budget, no timeline slices overlap or gap, and every
referenced case exists. Failures surface in the Agent Browser.

### 9.4 Boundary evidence

The engine reports why **N−1** fails, with specific breaching cases. The recommendation is
therefore demonstrably minimal rather than merely asserted.

### 9.5 Test protocol

Every behavioural fix requires a test that **fails before the fix and passes after**. A test
that has never failed proves nothing. Each defect test is paired with a control case that
passes both before and after, to confirm the test measures the right thing.

> **Caveat.** The in-app *"Mathematical Invariants Audit (M1–M5 Compliance)"* panel on the
> Summary tab renders four statically-passing cards; it does **not** evaluate the invariants
> at runtime, and despite the title only M1–M4 are shown. It is a description of the model's
> design, not a live check. See §11, P0.

---

## 10. Known limitations

Behaviours a user must understand to interpret results correctly.

| # | Limitation | Impact and workaround |
|---|---|---|
| **L1** | **Volume is rounded per interval.** Fractional forecast volumes (e.g. 5.4) are rounded to the nearest integer for each interval. | Roughly unbiased across many intervals, but individual intervals shift. Material only for very low-volume intervals. |
| **L2** | **Resumption overhead is assumed zero.** A case parked overnight and resumed pays no context-switching cost. | Heavily-parked scenarios are modelled slightly optimistically. Inflate AHT to compensate, and record that you did. |
| **L3** | **Rework and quality are not modelled.** Sizing runs against clean volume. | If 5% of cases return for correction, true workload is ~5% higher. Inflate input volume, and record it. |
| **L4** | **Capacity is counted in whole days.** A partial final day counts as a full working day. | Slight overstatement of capacity when the horizon ends mid-day. |
| **L5** | **Unconfigured categories use fallback defaults** (AHT 30 min, shrinkage 20%). | Prevents silent understatement, but the defaults are unlikely to match your operation. **Configure every category explicitly.** |
| **L6** | **A horizon shorter than the SLA window makes attainment near-vacuous.** With a 5-day horizon and a 5-day TAT, almost every case has until the end to complete. | Use a horizon comfortably longer than the SLA window. |
| **L7** | **Nothing persists.** A refresh loses all work. | Export config JSON regularly. Note this does **not** capture Opening WIP. |
| **L8** | **The 30-minute interval requirement is strict.** Any interval not exactly 30 minutes is a blocking DQ error. | Pre-aggregate demand to 30-minute buckets before upload. |
| **L9** | **US date format is rejected.** `MM/DD/YYYY` will not parse. | Use `DD/MM/YYYY` or ISO `YYYY-MM-DD`. |
| **L10** | **Blended/filler work is not modelled.** Backoffice work done between calls, where capacity is a residual of voice demand, has no representation. | Reduce effective productive hours to approximate. |
| **L11** | **SLA Acceptance Slack is a planner band, not a rewritten ops commitment.** When ON, the search accepts CI ≥ sizing floor while the stated Primary % remains the policy target. | Treat the official COPC/ops SLA as the Primary % on the config; use slack only with planner/MGT agreement. Stacking slack + tight CI + occupancy cap still oversizes if all are enabled. |
| **L12** | **Workload Reduction discounts modelled handling time across the whole chain.** Fixed 2026-08-31 (`WLR-DEAD`): it is applied once, to category AHT, so Stage 2 `N_min`, the occupancy floor `N_occ`, the Stage 3 DES simulation and Stage 4 Gross HC all size against the same reduced workload. Previously it was applied only inside `computeAnalyticalNMin`, which made it a guaranteed **no-op** on the recommendation — the search starts at `max(N_min, N_occ)` and `N_occ` ignored the reduction, so a measured 50% reduction moved neither Recommended HC nor Gross HC. Integer rounding can still absorb a small % (a 5% cut may change nothing). Opening WIP carrying an explicit remaining-work value is **not** discounted — that is measured work in flight, not a forecast assumption. Categories present in the data but absent from config keep the un-reduced 30-minute parser default. | Use for an assumed efficiency or deflection gain. Results show both the reduced and un-reduced `N_min`. Tests: `D42.1`–`D42.9` in `scripts/verify-sizing-fixes.mts`. |
| **L13** | **Deadline-coverage shift placement (Stage 3a) has not been shown to reliably improve the recommendation on realistic demand.** It is opt-in, off by default. Its *safety* is solid and, as of 2026-08-28, unconditional — the search never recommends a higher headcount with the flag on than with it off (the prior narrow exception via N_sla is fixed; see above), because a placement result only ever replaces the uniform-start one when it verifiably passes the same CI-gated check. Its *value* is unproven beyond a controlled instance built to need it: across many tested realistic continuous-demand shapes, the analytic distribution was no better than, and sometimes worse than, uniform-start — root-caused to the DES's shift-end enforcement gap, now fixed for non-24×7 calendars, but the greedy's objective itself has not been reworked to exploit it. Treat it as an experimental lever that can only help or do nothing, not as a dependable fix for a specific dead-zone symptom. | Enable it and compare the recommendation with the flag on vs off on your own data before relying on any improvement. Compare `occupancyFeasibleFloor` (N_occ) against the recommendation either way to see the theoretical best case. |
| **L14** | **Extra OFF roster uplift (Stage 4) is a flat weekly ratio, not a per-agent rest-day rotation.** It answers "how many total heads are needed," not "which specific head works which specific day" — that is a rostering decision made downstream, outside this tool's scope (see `docs/wfm/05-scheduling.md`: "Sizing number ≠ roster"). The ratio assumes off days are staggered evenly across the team; a small headcount (e.g. 3 heads, 2 off days/week each) cannot actually stagger evenly, so the flat multiplier is an approximation at low N. Separately, a labor policy where off days meet or exceed open days makes coverage arithmetically infeasible (`coverageDays <= 0`) — the engine flags this rather than silently applying no uplift. | For small teams, sanity-check the rounded Net Operational HC against what a real weekly roster can actually stagger. Treat a flagged infeasible-roster result as a labor-policy configuration error, not a sizing answer. |
| **L15** | **The binding-constraint label distinguishes a capacity floor from an SLA gate.** Fixed 2026-08-31 (`BIND-LABEL`): when the search passes at its first candidate (`startN = max(N_min, N_occ)`) the result is attributed to the capacity floor, naming `N_occ` when the occupancy floor is the higher of the two. Previously the label tested `recommendedHC === nMinAnalytical`, but `N_occ = N_min + 1` in 533 of 540 swept workloads, so that test almost never fired and the label defaulted to "Primary SLA … Target" — telling planners SLA was binding in exactly the runs where sweeping the SLA target across 50–99% provably moved nothing. | If the label reads as a capacity floor, SLA settings will not move the number; change occupancy cap, adherence, productive hours, or workload instead. Tests: `D42.10`–`D42.15` in `scripts/verify-sizing-fixes.mts`. |
| **L16** | **SLA targets are inelastic across most of their range.** Not a defect — a property of deferrable work. Once headcount clears the workload, EDF dispatch finishes cases far inside any multi-hour window, so attainment snaps to 100% and the target % has nothing to bite on. Measured: with a 30-minute AHT, sweeping Primary % from 50→99 or the turnaround window from 2h→48h changed the recommendation by **zero** agents; the SLA gate only bound once the window approached the AHT itself (30–60 min). | Expect the recommendation to be driven by workload, occupancy cap, adherence and productive hours — not by the SLA block — unless your turnaround target is close to your handling time. Read the binding-constraint label (L15) to see which regime you are in. |

---

## 11. Not yet built

Forward requirements, prioritised by user impact.

### P0 — Correctness and trust

**P0-1 — The "M1–M5 Compliance" panel must evaluate its invariants or be relabelled.**
It currently renders four hardcoded passing cards with no condition evaluated, under a heading
claiming M1–M5 compliance while showing only M1–M4. A user reasonably reads this as
verification. Either wire it to real checks or rename it to make clear it is describing the
model's design. *Rationale: a false assurance in an audit panel is worse than no panel.*

**P0-3 — Source boundary evidence from the deciding statistic.**
The "why N−1 failed" evidence comes from a fresh single-seed run, while N−1 was actually
rejected by the 30-replication CI decision. These can disagree — the single-seed audit can
even show N−1 passing. *Rationale: the user-facing explanation can contradict the decision it
explains.*

**P0-4 — Deadline-coverage shift placement (Stage 3a) needs a labor-model correction and a
mandatory coverage floor, not just the L13 caveat.** A 2026-08-28 audit (prompted by a
customer-reported zero-agent-interval symptom, since traced to the display bug fixed in
FR-9.5 above — the underlying scheduling was not at fault in that case) found:
(a) the DES never enforces a shift END — an agent stays available until business close no
matter when their shift started, so the optimizer's capacity model (`shiftCapacityWithinDay`,
confined to `[offset, offset+shiftLength]`) does not match what the simulator actually does,
which is the root cause of the greedy in Stage 3a routinely choosing distributions *worse*
than uniform-start; (b) `N_sla` (`placementFeasibleFloor`) can raise the search's starting
point past what a lower N would already satisfy, and the walk-down is skipped entirely when
that raised start immediately passes — a genuine (if narrow) violation of the "never worse"
guarantee L13 describes, confirmed on two synthetic configs; (c) `shiftCapacityWithinDay`
uses un-adhered `dailyProductiveHours×60` as agent capacity where the DES budget applies
adherence, a ~25% over-credit at adherence 0.8; (d) `LaborConfig.shiftPlacementMaxAttempts`
is documented (multiple distributions verified per candidate N) but never implemented —
exactly one greedy attempt is tried; (e) there is no coverage floor anywhere in the
acceptance predicate, so a passing candidate can legitimately leave the queue with zero
agents present during open business hours. *Rationale: the sizing engine's stated purpose is
minimum headcount for a target SLA under a faithful simulation — an unenforced coverage floor
and a labor-model mismatch between the optimizer and the simulator both violate that
directly, not just the L13 caveat about value being unproven.* Tracked fix plan: enforce a
configurable minimum-coverage floor (default 1 agent, satisfied by redistribution before
headcount), give the DES a real shift-end event with in-progress-case handover, extend that
to real multi-start support for 24×7 calendars, then replace the single greedy attempt with a
small DES-verified candidate set. **Done (2026-08-28):** the day-open telemetry defect
(FR-9.5), the fast-path/full-path attainment regression test, the per-agent stagger-offset
invariant, shift-end enforcement with in-flight-case handover for non-24×7 calendars, the
minimum-coverage floor with flag-independent redistribution-first repair (FR-5.12 — proven
on the field-reported config to cost zero extra headcount), the N_sla walk-down safety-net
fix (never-worse is now unconditional, see Stage 3a above), and the adherence/capacity
conflation (Gap B, closed-form pinned).

**Correction (2026-08-28, same day) — the greedy-objective/multi-attempt rework decision was
re-examined and the original reasoning retracted.** This PRD previously stated
`shiftPlacementMaxAttempts` was removed because "a version affecting accept/reject needs a
monotonicity proof not yet done." That justification does not survive scrutiny: the shipped
search predicate is *already* a three-way disjunction —
`uniformPasses(N) OR coverageRepairPasses(N) OR placementPasses(N)` — decided without any
monotonicity proof, so the same objection applied equally to work already merged. No
monotonicity proof exists anywhere in the codebase for DES pass/fail vs N (the
"house-monotone" comments on the placement greedy and the divisor apportionment method
guarantee only that *those specific outputs* grow with N, not that pass/fail does); it is an
open, undischarged assumption (`project_context.md`). The walk-down's actual failure mode
under non-monotonicity is returning a **non-minimal but verified-passing** N, not an unsafe
one — a precision concern, not the safety blocker this PRD claimed. The real argument for
not building it was always empirical (brute-force testing found near-zero benefit), but that
evidence predates the shift-end fix above and needed re-measurement before the question could
be honestly closed either way.

**Gap G — CLOSED (2026-08-28, re-measured under the fixed labor model).** A throwaway
brute-force probe (never committed; reused `evaluateCandidateStatistical`,
`buildCoverageRepairDistribution`, `computeCandidatePlacementDistribution` directly) compared
uniform-start against ~20-30 hand-built 2- and 3-cohort staggered distributions per candidate
N, on the classic dead-zone config (08:00–22:00 window, 9h shift, minimum-coverage floor ON)
at two scales: small-N (N=4–9, coarse per-agent granularity) and large-N (N=28–38, ~30-40
agent scale, fine granularity). Result: **no distribution flipped a reject into an accept at
either scale.** More specifically, staggering measurably *hurt* primary-SLA attainment
relative to uniform-start without fixing the coverage gate that was actually failing — e.g.
at N=38 (large scale), uniform achieved 97.9% primary SLA vs. the best staggered candidate's
84.4%, and neither passed the coverage floor. The reason is now understood, not just
observed: this window (14h) is wider than the shift (9h) specifically so the queue is
attended for the whole window; splitting agents across staggered starts thins the coverage at
each individual moment rather than deepening it, which is the wrong lever for a floor that
needs *presence*, not *volume-weighted throughput*, at every interval. **Decision: no
multi-attempt search was implemented.** The correct closing reason is measured near-zero (in
fact negative) benefit even under the corrected shift-end-enforced labor model — not the
retracted monotonicity-proof argument this PRD stated earlier. See
`docs/wfm/07-known-defects-and-decisions.md` for the full measurement write-up.

**Remaining on this item:** none — **P0-4 is now fully closed.** 24×7 multi-start was DONE
same day as the item above (real shift starts, shift-end enforcement, and coverage repair all
work for 24×7 — non-wrapping only, which is all a coverage guarantee ever required despite
this PRD's earlier claim that "a circular day grid, shifts wrapping midnight" was needed), and
Gap G is now closed per the re-measurement above. Note: the walk-down's "exact minimum" claim
in `hc-search.ts` messaging was also corrected (2026-08-28) to say "lowest verified-passing N"
— monotonicity of DES pass/fail vs N remains an undischarged, honestly-labeled assumption (see
D39 empirical sweep in `project_context.md` §9), though the walk-down's safety property (only
ever returns a verified-passing N) does not depend on it.

### P1 — Data loss and usability

**P1-1 — Include Opening WIP in config export.**
Export JSON omits `openingWIP`. Combined with zero persistence, manually entered or
bulk-imported backlog is unrecoverable after a refresh — while the Reset modal treats WIP as a
first-class data item. *Rationale: loses real user work.*

**P1-2 — Preserve results when a run is cancelled.**
Cancelling clears `searchOutput`, discarding a previously completed sizing. *Rationale:
a user exploring a second scenario loses their first result with no warning.*

**P1-3 — Make CSV exports respect active filters.**
All three exports dump the complete result set regardless of the filters applied on screen.
*Rationale: users reasonably expect to export what they are looking at.*

**P1-4 — Add a backlog-ageing report.**
No aged-backlog view exists (>24h / >48h / >72h buckets). COPC-style backoffice reporting
expects this alongside turnaround attainment, because attainment can look healthy while a tail
of very old cases accumulates. The data already exists in the case results. *Rationale:
a standard reporting expectation, cheap to build.*

**P1-5 — Remove the stale AI-capability declaration.**
`metadata.json` still declares `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API`, left over from a
removed dependency. It is unreferenced and does not reach the artifact, but it advertises a
server-side AI capability that directly contradicts the offline contract. *Rationale: a
compliance reviewer reading the manifest would reasonably conclude the product calls out.*

### P2 — Polish and technical debt

**P2-1 — Resolve 671 lines of dead code.** `DataTable.tsx` (308 lines: sorting, page-size
selection, filtered export) and `NativeCharts.tsx` (363 lines: a staffing-search curve and a
queue/WIP timeline chart) are referenced nowhere and do not reach the bundle. **The shipped
app has no charts at all** — the "Staffing Path" and "Queue / WIP" tabs are table-only despite
purpose-built chart components existing for exactly those views. Either wire them up or delete
them.

**P2-2 — Make sensitivity analysis configurable and exportable.** The 5×5 grid and the five
named comparison scenarios are hardcoded constants; results are component-local and are lost
on navigation, with no export.

**P2-3 — Fix the sample-dataset copy mismatch.** The Healthcare card advertises "4 Segs
(PriorAuth, Pharmacy, Appeals, Inquiries)" but three are generated — the copy splits the single
category `Pharmacy_Appeals` into two.

**P2-4 — Fix the Summary performance grid layout.** Declared as four columns, renders three
cards.

**P2-5 — Expose or remove `intervalEndCol`.** It exists in the column-mapping model and is
honoured by the parser, but has no UI control, so every interval end defaults to start + 30
minutes — which the "Interval Length" DQ check then validates.

**P2-6 — Reconsider the Demand/Config step ordering.** The Business Calendar sits in step 1
while Labor sits in step 2, yet the step-1 DQ gate validates a rule spanning both, sending
first-time users forward to fix a backward blocker.

**P2-7 — Engine debt.** Search duplication (root cause of P0-2); horizon computed from
validated intervals while workload sums unvalidated ones; representative-replication selection
by an unrelated metric; ASA censoring measured only to horizon end; a dead `primaryEligible`
field; and two independent case-priority orderings where only one ships.

**P2-8 — Restore Headline Hiring FTE (M4) UI when a clean FTE product story exists.**
Engine still computes `fteNet` / `fteGross*`. UI hides M4 so Manual Override is only the
Workload HC agent-hours denominator (Option B). Re-expose FTE only without dual-role confusion.

### Modelling fidelity gaps

**G-1 — Model rework/quality.** Rework is real workload; sizing against clean volume
understates. Currently requires manual input inflation (L3).

**G-2 — Model resumption overhead.** Parked-and-resumed cases pay no context-switching cost
(L2).

**G-3 — Consider fractional-volume handling.** Rounding per interval (L1) is defensible but
alternatives (accumulating fractional remainder across intervals) would preserve total demand
exactly.

---

## 12. Glossary

### The hours taxonomy

Most sizing errors are double-counts caused by two variables that both look like "hours per
agent per day". The ladder:

| Level | Meaning | Reduced by |
|---|---|---|
| **Paid hours** | What the employer pays for | — |
| **Contracted hours** | What the contract commits to | unpaid breaks |
| **Scheduled hours** | Rostered to be at work | leave, training, absence (*out-of-chair shrinkage*) |
| **Productive hours** | Rostered time available for case work | breaks, meetings, coaching (*in-chair shrinkage*) |
| **Delivered hours** | Productive time actually spent on cases | adherence loss |

Two rules follow:
1. **Shrinkage** converts rostered headcount → available headcount. It belongs in the
   operational→gross conversion, never in the capacity baseline.
2. **Adherence** converts scheduled productive time → delivered time. It belongs in per-agent
   capacity, never in the gross-up.

### Terms

**AHT (Average Handle Time)** — average touch time to process one case, excluding queue time.
May span multiple sessions if a case is parked and resumed.

**Workload** — `Volume × AHT`. Demand expressed in hours, independent of headcount.

**TAT (Turnaround Time)** — elapsed time from receipt to completion. The primary backoffice
service metric.

**Primary SLA %** — percentage of cases completed within the committed window. The engine's
main service constraint.

**BO ASA** — time from SLA clock start to **first touch**. Distinct from TAT, which runs to
completion. A case can be picked up quickly and still breach TAT.

**Occupancy** — handling time ÷ available time. See §6.1: the denominator here is **planned
capacity**, so values above 100% indicate overload magnitude.

**Shrinkage** — `1 − (productive hours / scheduled hours)`. Everything that stops a rostered
person doing the work. Typically 25–35%.

**Adherence** — percentage of scheduled time the agent was where the schedule said, doing what
it said. Measures *timing* compliance.

**Conformance** — whether the agent worked the right *total* hours, ignoring timing. An agent
who works a full shift an hour late has good conformance and poor adherence.

**Operational HC** — people actively working the queue (DES seats on calendar-open days). What
the simulation sizes (`staffing.operationalHC`).

**Net Operational HC** — post-DES seats after the **extra OFF roster uplift**:
`floor(OperationalHC × openDaysPerWeek / coverageDays)`, where `coverageDays =
openDaysPerWeek − max(0, laborOff − calendarClosed)`. Calendar-closed days are already off in
DES and are not added again; the multiplier is a coverage ratio (agents only supply capacity
on open days), not `(1 + extraOffDays/7)`. Shown on Results with `X% OFF → +Y% roster uplift`
(X = the display fraction `extraOffDays/7`; Y = the coverage-ratio uplift actually applied).

**Gross / Rostered HC** — people you must employ so that Net Operational HC are available after
shrinkage. **This is the hiring number.**

**FTE (Full-Time Equivalent)** — headcount normalised to a standard contract. Two half-time
staff = 1 FTE.

**Opening WIP** — backlog carried into the horizon: cases already in the queue at simulation
start, with their remaining work.

**Latest Safe Start (LSS)** — the last moment work can begin and still meet the deadline,
computed backwards through the business calendar. Sorting by LSS is Earliest-Deadline-First
scheduling.

**Clock basis** — whether the SLA clock runs on *business time* (pausing overnight and at
weekends) or *wall-clock* time. "2 business days" and "48 hours" are very different
commitments.

**Clock start policy** — whether the SLA clock starts on *arrival* or at the *next open* of
the business window.

**Pooled vs Siloed** — whether any agent can take any case (pooled, more efficient) or agents
are dedicated per category (siloed, reflects real skill boundaries but strands capacity).

**Common Random Numbers (CRN)** — reusing identical random arrival realisations across
candidate headcounts so they differ only by headcount. A variance-reduction technique.

**Drain window** — the period past the horizon end during which in-flight work is allowed to
finish, so cases arriving near the end are not counted as failures merely because the clock
stopped.

---

## Related documentation

| Document | Purpose |
|---|---|
| `project_context.md` | Engineering onboarding and working context |
| `README.md` | Quick start and repository orientation |
| `docs/wfm/` | Workforce-planning domain reference (7 documents) |
| `docs/wfm/07-known-defects-and-decisions.md` | Decision log and defect register |
| `.cursor/rules/` | Enforced engineering rules |
