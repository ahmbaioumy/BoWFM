# Plan — Deep audit of BoWFM, in phases (report + fix plan, no code changes)

## Context

- You asked for a **very deep** full-project audit, under a hard usage cap of 20% weekly.
- Both cannot fit in one session, so you chose: **deep, in phases**. Each session audits one area line by line and stops at the cap.
- Output each phase: ranked findings with evidence **plus a fix plan**. Nothing in `src/` is changed.
- End user of the product: the WFM planner who opens `BoWFM.html` from disk, offline.
- Weekly meter at planning time: **6%**. Hard stop: **20%**. Budget this session: about 14 points.

## Phases

| Phase | Session | Area | Lines | Why this order |
|---|---|---|---|---|
| 1 | **This one** | Sizing engine: `calendar.ts`, `des-engine.ts`, `hc-search.ts` | 6,768 | Wrong here = wrong headcount for the planner |
| 2 | Later | Test strength (`scripts/verify-*.mts`), CSV ingestion, offline contract | ~9,600 | Do the tests really prove the frozen decisions; bad data in |
| 3 | Later | UI components + the shipped `BoWFM.html` in a browser | ~9,000 | What the planner sees and exports |
| 4 | Later | Docs vs code (`PRD.md`, `project_context.md`), merged fix plan | ~2,600 | Cheapest; depends on phases 1–3 |

- `FINDINGS.md` and `PLAN.md` at project root carry everything between sessions. A later session starts with `/supervise continue audit phase N`.
- If phase 1 does not finish inside the cap, its leftover steps become the start of the next session.

## Usage cap — how it is enforced

- I read the weekly meter (`get_usage`) before every agent dispatch and after every agent returns.
- **Soft line 17%:** no new agent is started. I write up what exists and stop.
- **Hard line 20%:** stop immediately.
- Agents run **one at a time**, never in parallel, so the meter is checked between each.
- Honest limit: I cannot read the meter while an agent is running. Each agent gets one bounded slice of code (700–1,200 lines) so one run cannot jump far past the line. That is why the soft line sits 3 points below the hard one.
- Findings are written to `FINDINGS.md` after **every** agent, so a stop loses nothing.
- Anything not reached is listed as **"not audited"** — never silently skipped.

## Setup (after approval)

1. Create local branch `audit/2026-10-06` (currently on `main`; no push).
2. Write `PLAN.md` at project root (this plan).
3. Dispatch `challenger` on `PLAN.md`; fix what holds up. *(Plan mode blocked writing `PLAN.md` before approval.)*
4. `MAP.md` skipped: line ranges below already cover it.

## Phase 1 steps — in this order, one agent each (re-cut after challenger review, round 0)

| # | Slice | Agent | What "deep" means here |
|---|---|---|---|
| 1 | Health baseline | `tester` | `npm run lint`, `npm test`, `npm run test:trusted-source`. `git status --short` before and after. A freshness-check failure is informational only — never rebuild |
| 2 | `calendar.ts` (564 lines, whole file) | `sonnet-investigator` | Half-open `[start,end)` bounds, backwards walk in `subtractWorkingTime`, day-boundary and 24x7 edge cases, off-by-one days |
| 3 | `des-engine.ts:1-719` (heap, PRNG, apportionment, case generation) | `sonnet-investigator` | EDF compare vs `compareByUrgency`, seed determinism, Webster apportionment monotone, Map/Set order |
| 4 | Independent recompute | `tester` | `N_min` and Gross HC only (DES-recommended HC cannot be hand-computed). Formulas written fresh from `docs/wfm/` + `CLAUDE.md`, **no engine imports**, script in the scratchpad dir. Also reads `default-config.ts` and `run-inputs.ts` |
| 5 | `hc-search.ts:1-212` + `1300-1688` (`computeAnalyticalNMin`, `computeOccupancyFloor`, `calculateStaffingRequirement`) | `sonnet-investigator` | Shrinkage absent from Stage 2, harmonic blend, per-category gross-up then sum then single `round`, units, precision |
| 6 | `des-engine.ts:720-1500` (`runBackofficeDES`, part 1) | `sonnet-investigator` | Dispatch, presence (`countAgentsOnShiftNow` 1214), adherence as budget. Ends with an interface summary handed to step 7 |
| 7 | `des-engine.ts:1500-2375` (part 2 + invariants) | `sonnet-investigator` | Occupancy numerator/denominator, drain window, SLA counting, `verifyAgentTimelineInvariants`. Receives step 6's interface summary |
| 8 | `hc-search.ts:1689-2356` (CI statistics, `resolveSearchBounds`) | `sonnet-investigator` | CI bound direction, floor on/off bounds |
| 9 | `hc-search.ts:2357-3829` (sync vs async search, known risk D11) | `sonnet-investigator` | Mechanical diff of the two functions first, then read only the hunks that differ |
| 10 | `hc-search.ts:213-1299` (shift placement, roster polish) | `sonnet-investigator` | Lowest risk to headline HC |
| 11 | Final challenge | `challenger` | Attacks the findings: wrong, overstated, or missed |

Budget rules added after challenger review:
- Cost of steps 1–2 is measured; if the average is above ~1.5 points per agent, later steps are dropped up front.
- No audit agent starts at or above **15.5%**, so the final challenger (step 11) always has room. Challenger itself starts only below 17.5%.
- Not covered by phase 1, carried to phase 2: `src/types/wfm.ts`, `src/utils/agent-analytics.ts`, `src/utils/export-rows.ts`.

Rules given to every agent:
- Read-only. No edits to project files.
- Read the whole slice, not excerpts. Report by `file:line`.
- Look for: logic errors, unit mix-ups, off-by-one, float `===`, unsorted Map/Set iteration, `Math.random`/`Date.now`, hand-rolled date math, rounding before the display boundary, breaches of the 11 frozen decisions in `CLAUDE.md`.
- Do **not** re-report items already written down as open (PRD §10 L1–L18, §11 backlog, `project_context.md` §11) unless docs say "fixed" and code says otherwise, or the real impact is worse than the doc states.
- A bug in *how* the floor/ceiling is implemented is reportable; a proposal to change the design is not.
- `calendar.ts` is the allowed home of `Date` math — not a finding there.
- A finding that needs a number check may be marked "suspected, needs recompute".
- Do **not** propose changing the `N_min` floor, the occupancy ceiling, or SLA inelasticity (L16) — settled.
- Standard `VERDICT / FINDINGS / NEXT ACTION` format. No evidence → dropped.

## Lead already found during planning (parked for phase 2)

- `package.json` lists `vite`, `@tailwindcss/vite`, `@vitejs/plugin-react`, `lucide-react` under `dependencies`.
- Project rule: `dependencies` is closed; build tools belong in `devDependencies`.
- Likely impact: internals only for the build tools; `lucide-react` does ship in the bundle. To confirm.

## Judging and deliverables

- I write every finding to `FINDINGS.md` with my verdict. I read raw code myself only where a finding is disputed or rated blocker.
- Each finding is labelled: severity (blocker / major / minor), area, and **whether it changes planner-visible numbers or only docs/tests/internals**.
- Fix plan appended to `PLAN.md`: one entry per blocker/major — what to change, file/section, risk tier, the fail-first test that would prove it. Minors go to a backlog list.
- Both files committed locally on the audit branch.

## Acceptance criteria (phase 1)

| Criterion | Proof |
|---|---|
| Usage cap respected | Final `get_usage` reading ≤ 20%, quoted in the report |
| Each step 1–11 is done or marked "not audited" | Status table in `FINDINGS.md` |
| Every finding has evidence | `file:line`, command output, or recompute working |
| Numbers checked a second way | Step 7 hand calculation shown next to engine output |
| No product code changed | `git diff main --stat` shows only `PLAN.md` and `FINDINGS.md` |
| Fix plan covers every blocker and major | Entry count = blocker + major count |

## Final report to you (short)

1. What was audited line by line, what was not reached.
2. Findings by severity, product impact vs internal-only.
3. What is still risky.
4. Challenger's strongest dissent.
5. Recommendation, fix plan for approval, and what phase 2 starts with.

---

# Fix plan — phase 1 findings (for approval; nothing built yet)

Every item follows the fail-first rule (`wfm-engine-testing`): failing test first, fix in **both** `searchOptimalHC` and `searchOptimalHCAsync` where the search is touched, then `PRD.md` / `project_context.md` / rebuild `BoWFM.html` / `npm run check:artifact`.

| # | Finding | What changes | Where | Tier | Proof it is fixed | Needs your decision? |
|---|---|---|---|---|---|---|
| F0 | Unreconciled claims 19 vs 31 | Nothing — one run of the claims sample with documented defaults through both search functions | scratch script only | — | Recommended HC ≥ `N_min` with floor ON | No. **Do first.** |
| F1 | HC-14 | On 24x7, when the repair layout meets coverage but fails SLA, try a third layout that spreads surplus seats across the cover starts (house-monotone split). Keep D33 "fewest agents moved" for non-24x7. Fix the misleading message (HC-18). | `hc-search.ts:649-748` + both search bodies | 3 | New test: 24x7, flat demand, 6 h SLA, coverage ON → a recommendation near coverage-OFF HC with coverage ≥ 1. D36/D37 and all non-24x7 audit-sample HCs unchanged (`npm run test:audit`). | **Yes** — this reverses documented design D33 for 24x7. |
| F2 | DES-8 | 24x7 budget-park resumes at once (same as business hours) so another idle agent can take it; remove hand-rolled midnight maths | `des-engine.ts:1635-1650`, `:1852-1856` | 3 | New test: the 2-agent c1/c2 case completes same day ~01:15. BUG-D tests (`verify-fixes.mts:374`, `:2879`) still pass. | No (docs already say "resume at next open"). |
| F3 | HC-15 | After polish adoption, store the full-R statistics of the polished roster as `primaryStatistical` and in the history row | `hc-search.ts:3559-3607` and sync twin | 2 | New test: placement ON, siloed healthcare — `primaryStatistical` matches `finalDESResult`; sync = async deep-equal | No. |
| F4 | HC-1 + HC-5 | Tolerance on the single Gross HC `round` and on the `N_min` floor (e.g. 1e-9); decision 7 unchanged | `hc-search.ts:131`, `:1653` | 3 | New tests: `AJM_Simu.csv` HC 10 @ 20% → 13; 123.75 h case → `N_min` 2; result independent of category order | **Yes** — confirm half-up is the intended tie rule (PRD states none). |
| F5 | HC-4, HC-6, HC-11 | Validate imported `categories` and `simParams` (finite, shrinkage 0–0.99, unique names, integer replications); reject with a visible message | `App.tsx:450-451` | 2 | Import of a bad JSON shows an error and changes nothing | No. |
| F6 | DES-12 | Gates and CI maths use unrounded values; round only for display | `des-engine.ts:2084-2125`; `hc-search.ts:1911-2007` | 3 | New test: 100.044% occupancy fails an exact 100 cap; all sample HCs re-baselined and any change listed | **Yes** — may move a recommendation by 1 at an exact edge. |
| F7 | HC-3 | Decision only: keep the floor and document it in L14, or carry 12.5 unfloored into the gross-up | `hc-search.ts:1585-1587`, `PRD.md` L14 | 1 (docs) or 3 | Docs line, or new D40 expectation | **Yes.** |
| F8 | HC-9 | Warn in Run step when Replications = 1 ("no confidence interval") | `RunFlow.tsx:322` | 1 | Warning visible at R=1 | No. |
| F9 | HC-17 | One deep-equal sync-vs-async parity test over ~6 scenarios (the audit script is the template) | `scripts/verify-sizing-fixes.mts` | 1 | Test present and green | No. |
| F10 | Docs | Fix stale `PRD.md:790-791`; state per-category gating (HC-13); state unbounded presence when no shift distribution (HC-20); add HC-14 to §10 until F1 ships; correct check count 856 → 916 | `PRD.md`, `project_context.md` | 1 | Lines present | No. |

Backlog (minor, no plan yet): CAL-1..4, DES-2..7, DES-9..11, DES-13, DES-14, HC-7, HC-8, HC-10, HC-12, HC-16, HC-19, HC-21, DES-1 (fractional volumes — already G-3).

Suggested order: F0 → F2 → F3 → F1 → F4 → F5, then the rest. One item per `/supervise` run.

Phase 2 starts with: F0 if not yet done, then test-strength review of `scripts/verify-*.mts`, CSV ingestion, offline contract (incl. the `package.json` `dependencies` lead), and the "not audited" list in `FINDINGS.md`.

---

# Phase 2 — test strength, CSV ingestion, offline contract, leftover engine paths

Approved by owner 2026-10-06 ("approve, continue to phase 2"). Same rules as phase 1: read-only, one agent at a time, meter read before and after each agent, no audit agent starts at or above 15.5% weekly, hard stop 20%. Meter at phase start: 9%.

| # | Step | Agent | What "deep" means here |
|---|---|---|---|
| P2-0 | F0 — reconcile claims 19 vs 31 | `tester` | Run the claims sample with documented defaults through sync and async search; explain the 19; confirm recommended HC ≥ `N_min` with floor ON |
| P2-1 | Test strength A — staffing maths + calendar | `tester` | Mutation test on a scratch COPY of the repo: break one frozen rule at a time (single round → ceil / per-category round; harmonic → arithmetic blend; shrinkage added to Stage 2; half-open → inclusive day count; occupancy denominator widened to drain; Webster → largest-remainder) and record which suite catches it. A mutation no test catches = an unprotected frozen decision |
| P2-2 | Test strength B — simulation + search | `tester` | Same method: EDF order reversed/FIFO; presence = budget remaining; CI lower bound → mean; CRN broken (seed varies with N); floor ignored; SLA `<=` deadline → `<` |
| P2-3 | `csv-parser.ts:1-560` | `sonnet-investigator` | Line by line + run against `test_files/` and hand-made bad files: delimiters, quotes, BOM, dates, 30-min interval rule, duplicates |
| P2-4 | `csv-parser.ts:561-1121` | `sonnet-investigator` | Data-quality rules vs what PRD promises; opening WIP; silent drops/coercions; rows lost without a warning |
| P2-5 | Leftover engine paths | `tester` | Run, not read: siloed end-to-end with hand-recomputed seats; staggered non-24x7 fuzz; holidays inside the 14-day drain; ASA gate ON; occupancy cap ON; peaky 24x7 with coverage OFF |
| P2-6 | Offline contract + conventions | `sonnet-investigator` | Banned primitives in `src/`, `console.log`, `Math.random`, `Date.now`; `package.json` dependency split; build guards (`build-standalone.mts:34-67`); scan shipped `BoWFM.html` for remote URLs; suite D9 really enforces it |
| P2-7 | `agent-analytics.ts`, `export-rows.ts`, `run-inputs.ts`, `wfm.ts` | `sonnet-investigator` | Display maths recomputed; export rows match on-screen values; types vs defaults consistent |
| P2-8 | Final challenge | `challenger` | Attacks phase 2 findings |

Order is risk order; steps not reached are marked "not audited" and carried to phase 3.

Phase 2 re-cut after challenger review (all accepted): run order is P2-0, P2-5a (siloed + ASA + occupancy-cap recompute), P2-3 (`csv-parser.ts:1-535`), P2-4 (`csv-parser.ts:536-1121`) plus an .xlsx-upload probe, P2-1 (mutations A), P2-6 (offline contract, plus stray scripts and `trusted-source-validation.json`), P2-2 (mutations B), P2-5b (staggered fuzz, holidays in drain, peaky 24x7), P2-7 (adds `default-config.ts`, `sample-data.ts`), P2-8. Mutation harness rules: scratch copy with a `node_modules` junction, `cd` into the copy, prove each mutation applied by diff, run `verify-sizing-fixes` + `verify-fixes` first and stop at first kill, skip the freshness check, never rebuild, classify source-text kills separately, max ~8 mutations per run. Added mutations: wall-clock instead of `subtractWorkingTime` for `latestSafeStart`; CI upper bound to mean for occupancy/ASA; floor opt-out flag. Dropped: SLA `<=` to `<`.

---

# Fix plan — phase 2 findings (for approval; nothing built yet)

F0 is closed (claims 19 vs 31 was a script-input difference; no floor breach in 18 runs). Same rules as the phase 1 fix plan: fail-first test, both search functions, docs + rebuild + `npm run check:artifact`.

| # | Finding | What changes | Where | Tier | Proof it is fixed | Needs your decision? |
|---|---|---|---|---|---|---|
| G1 | CSV-13 + CSV-14 | Capacity horizon comes from demand intervals only; backlog `arrival` keeps driving the deadline clock (do NOT clamp arrival). One shared horizon function replaces the three copies. Data quality blocks a date span far beyond the data (stray row) and names the row. | `calendar.ts:488-516`, `hc-search.ts:2395-2412`, `ConfigFlow.tsx:70-85`, `csv-parser.ts:895-955` | 3 | Clean week + 1 backlog case 14 days old → still 5 working days, `N_min` 15, recommended ≥ 16; +50 cases → recommended ≥ baseline; backlog deadlines unchanged; stray 2062 row → blocking error. All sample-file HCs unchanged (`npm run test:audit`). | **Yes** — confirm empty pre-data days must never count as capacity. |
| G2 | CSV-4, CSV-8 | Strict numeric parse for volume: accept one clean number; decide decimal-comma per file; warn (or block) on anything else; sanity cap. | `csv-parser.ts:608-621` | 3 | `12,5` in a semicolon file → 12.5 or a blocking error, never 125; `30 min`, `12abc`, `0x10`, `1e9` → flagged | **Yes** — accept decimal commas, or reject them? |
| G3 | CSV-1 | Timestamps with `Z`/offset: read the wall-clock digits as written (or block with a clear message) so the result never depends on the PC timezone. | `csv-parser.ts:431-451` | 3 | Same file → same intervals under UTC, Dubai, New York | **Yes** — keep digits as written, or reject such files? |
| G4 | CSV-2, CSV-3, CSV-5..7 | Raw parser: flag ragged rows, duplicate headers, unterminated quote; detect binary/non-text and title rows with a plain message. | `csv-parser.ts:28-160` | 2 | Each bad file → named warning/error with file row number (fixes CSV-18 too) | No. |
| G5 | CSV-16, CSV-17 | Merge category names case/space-insensitively (or warn); list every category still on fallback AHT/shrinkage in data quality. | `csv-parser.ts:597-727`, `:966-972` | 2 | `Billing`/`billing ` → one category or a warning; fallback categories listed | **Yes** — auto-merge or warn only? |
| G6 | UI-1 | Editing/importing backlog clears results or raises the "changed since run" banner; snapshot covers demand + backlog. | `App.tsx:262`, `:598`; `run-inputs.ts` | 2 | Run, edit backlog, open Results → banner or cleared | No. |
| G7 | UI-2 | Category filter: keep available/scheduled as recorded (as the code comment already says). | `agent-analytics.ts:395-454` | 2 | Support pooled HC 12, filter Billing → available 49,591, new AA test | No. |
| G8 | P2-A2 + HC-14 (= F1) | Extends F1: when the repair roster fails SLA **or ASA**, try a spread roster — on any calendar, not only 24x7. Fix label (P2-A3) and N−1 evidence roster (HC-16) with it. | `hc-search.ts:649-748`, `:~2902`, `:~3710`, `:3673` | 3 | Support, ASA 60 min → HC near uniform-roster need (~34), not 46; `clock_hours` targets feasible; label says ASA | **Yes** (as F1: reverses D33 minimal-move design). |
| G9 | DES-10 | Drain window measured in business days / extended to the latest deadline, or not-yet-due cases excluded from failures. | `des-engine.ts:829`, `:1954-1960` | 3 | 8 post-horizon holidays → same HC as without (8, not 12) | **Yes** — which of the two rules. |
| G10 | DES-7 | Decision: opening backlog counts as "parked" only when truly in progress, or document today's rule. | `des-engine.ts:187-189`; docs | 1 or 3 | Doc line, or new-case SLA 93.3% in the probe | **Yes.** |
| G11 | HC-20, UI-3, P2-A1, CSV-15, OFF-6 | Wording/docs: note under the Min-coverage toggle on 24x7 ("assumes agents can be scheduled at any hour"); rename Fairness "Occupancy %"/"Available"; fix PRD §5.9; explain pooled vs siloed priority; either wire the 30-minute rule or remove the promise (L8, FR-2.2 #6); correct check counts. | `ConfigFlow.tsx:1107`, `ResultsFlow.tsx:1853-1865`, `PRD.md` | 1 | Text present | CSV-15: **Yes** — enforce the 30-minute rule or drop it? |
| G12 | TEST-1, TEST-4..7 | Seven small tests: two-SLA EDF fixture; business-time `latestSafeStart` across a weekend; direct CI-gate test (SLA, category, occupancy, ASA) with [78,82,80,79,81] vs 80; CRN (same arrivals at N and N+1); unfinished cases in the SLA denominator (6 of 10 → 60%); mixed-shrinkage Gross HC total (10% + 40%, HC 20 → 28); add `test:trusted-source` to `npm test`. Then re-run the surviving mutations — each must now fail. | `scripts/verify-sizing-fixes.mts`, `package.json` | 1 | Mutations B1, B1b, B2, B4b–d, B6, B15, M3c all killed | No. **Cheapest high-value item — do early.** |
| G13 | OFF-1, OFF-2, OFF-3 | Content-hash artifact gate; move build tools to `devDependencies`; D9 asserts the exact `dependencies` set, `Math.random`/`Date.now`, and the guard logic (not its message text). | `scripts/check-artifact-freshness.mts`, `package.json`, D9 | 2 | Gate fails on a hand-edited HTML; D9 fails on an added dependency | `package.json` change needs your OK (closed list). |

Backlog (minor): CSV-9..12, CSV-19..22, UI-4..8, OFF-4, OFF-5, TEST-2, TEST-3, TEST-8, P2-A4, P2-B1, P2-N1.

Suggested overall order across both phases: **G12** (tests first, so later fixes are protected) → **G1** → F2 → F3 → G2/G3/G4/G5 (input safety) → G6, G7 → G8 (with F1) → F4, F5, F6 → G9, G10 → G11, G13, F7–F10. One item per `/supervise` run.

Phase 3 starts with: the UI components line by line and the shipped `BoWFM.html` in a real browser, plus the "not audited" list in `FINDINGS.md`.

---

# Phase 3 — UI and shipped file (approved 2026-10-06; resume point after compaction)

State at start: weekly meter 15%. Hard stop 20%. No new audit agent at or above 17%; keep about 1 point for the write-up. One agent at a time, meter read (`get_usage`) before and after each. Read-only: no product code changes; findings go to `FINDINGS.md` after every agent; fix plan appended here at the end. Pre-plan challenger skipped to save budget; final challenger only if the meter is below 17.5%.

| # | Step | Agent | What is checked |
|---|---|---|---|
| P3-1 | Shipped `BoWFM.html` in a real browser (`file:///`, `browser-automation` skill) | `tester` | Loads with no console errors and no network requests; load each built-in sample; run sizing end to end; headline HC / Gross HC / SLA / occupancy on screen equal a direct engine run with the same seed (claims: recommended 31, gross 40); edit backlog after a run (UI-1); category filter in Agent Analytics (UI-2); upload a bad file (comma decimals, title row, .xlsx) and record the messages |
| P3-2 | `ResultsFlow.tsx:1-1200` | `sonnet-investigator` | Every displayed figure traced to its engine field: unit, rounding, label; live state vs run snapshot; `|| 100` style fallbacks (UI-4); crash paths on null/infeasible results |
| P3-3 | `ResultsFlow.tsx:1200-2387` | `sonnet-investigator` | Same, plus exports and the fairness/agent tables (UI-3) |
| P3-4 | `DemandFlow.tsx` (1227) | `sonnet-investigator` | Upload, mapping, backlog (WIP) entry and import incl. date column, data-quality display; can the UI create bad input states |
| P3-5 | `ConfigFlow.tsx` (1292) + `CalendarConfigPanel.tsx` (428) | `sonnet-investigator` | Input clamps and validation; can the UI produce degenerate calendars (CAL-2: overnight window, 0:00-0:00, no working days), duplicate categories, shrinkage out of range; horizon copy at `ConfigFlow.tsx:70-85` |
| P3-6 | `App.tsx`, `RunFlow.tsx`, `SensitivityFlow.tsx`, modals, `Sidebar.tsx`, `ParamsPanel.tsx`, `AgentAnalyticsPanel.tsx` | `sonnet-investigator` | State resets, cancel path, config import/export round trip, stale-state paths |

Steps not reached are marked "not audited" and carried to the next session. Known findings not to re-report: everything in `FINDINGS.md` (IDs CAL-, DES-, HC-, CSV-, UI-, OFF-, TEST-, P2-).

---

# Phase 3 status

Done: P3-1 (browser), P3-2, P3-3 (Results), P3-4 (Demand), P3-5 (Settings + calendar). **Not reached: P3-6** (`App.tsx`, `RunFlow.tsx`, `SensitivityFlow.tsx`, `AgentAnalyticsPanel.tsx`, modals, sidebar). Final challenger not run. Stopped at the 17% soft line.

# Fix plan — phase 3 findings (for approval; nothing built yet)

Same rules as before: fail-first test where engine or parsing code changes, docs + rebuild + `npm run check:artifact`, one item per `/supervise` run.

| # | Finding | What changes | Where | Tier | Proof it is fixed | Needs your decision? |
|---|---|---|---|---|---|---|
| H1 | UI-41, UI-42, UI-43, UI-44 | Number fields keep what is typed and clamp only when the field is left (blur); negative productive hours rejected; adherence/shrinkage show one decimal. First confirm UI-41 in a browser. | `ConfigFlow.tsx:129-131`, `:154`, `:921-924`, `:1071`, others in UI-42 | 2 | Browser: select occupancy cap, type 85 → field and stored value 85; same for adherence 85, confidence 95; paste −3 into productive hours → rejected | No. |
| H2 | UI-28, UI-29, UI-31, UI-35 | Backlog import: unrecognised/blank category uses the fallback category's own AHT and priority (or the row is rejected); strict number parse shared with G2; every defaulted row counted and listed (category, minutes, date); message text corrected. | `DemandFlow.tsx:185-262`, `:1068-1080` | 3 | `7,5`, `2h`, `1:30`, `N/A`, −5, blank date, unknown category → each counted in a visible warning; none silently stored | **Yes** — reject bad rows, or import with a counted warning? (Recommend: import + warning.) |
| H3 | UI-10, UI-9, UI-19 | Show the engine's "representative run slightly below target, CI satisfied" note; label the headline card "representative run"; colour history rows from the CI bound against the same floor the engine uses; reword the N−1 text. | `ResultsFlow.tsx:775`, `:965-972`, `:1086-1111`, `:2211`; `hc-search.ts:2957` (text only) | 2 | Fixture with CI low ≥ target and representative run below → note visible, card not red-as-failed; history colour equals Pass/Fail on every row | No. |
| H4 | UI-40 | Either remove the per-category ASA inputs and fix the help text, or make the engine honour them. | `ConfigFlow.tsx:642-643`, `:738`, `:844-878` (remove) — or `hc-search.ts:1966`, `des-engine.ts:2116` (wire) | 1 (remove) / 3 (wire) | Control gone and text corrected — or a per-category ASA test moves the result | **Yes.** Recommend remove: cheaper, no engine risk. |
| H5 | UI-17, P3-T2, UI-18 | Agent Summary reads the engine's category assignment; pooled runs get a "Pooled" option (or the dropdown is hidden); filters labelled as shared. Do with G7. | `ResultsFlow.tsx:323`, `:339-341`, `:399` | 2 | Siloed run with an idle agent → correct category on screen and CSV; pooled filter no longer empties the table | No. |
| H6 | P3-T3, UI-37, UI-38, UI-39 | Plain messages for empty file, header-only file, unreadable file, unmapped required column; clear the file input after each pick; ignore drops outside the box. Do with G4. | `DemandFlow.tsx:118-127`, `:170-183`, `:373-378`, `:714`; `App.tsx:189` | 2 | Browser: each bad file → named message; drop outside the box → page stays | No. |
| H7 | UI-16 | Neutralise cells that start with `=`, `+`, `-`, `@`, tab in CSV exports. | `csv-parser.ts:1072-1076` | 2 | Category `=1+1` → exported as text; negative numbers still export as numbers | No. |
| H8 | UI-45, UI-46 | Calendar tab: block zero open days and close ≤ open with a message on that tab; show the productive-hours-vs-window check there too. | `CalendarConfigPanel.tsx:35-45`, `:69-79` | 2 | Untick every day → message, run blocked, no crash | No. |

Backlog (minor): UI-11..15, UI-20..27, UI-30, UI-32..34, UI-36, UI-47, UI-48, P3-T1.

Suggested order across all three phases: **G12** (tests) → **G1** (horizon) → **H1** (typed values) → F2 → F3 → G2–G5 + **H2** + **H6** (input safety together) → G6, G7 + **H5** → **H3**, **H4** → G8/F1 → F4–F6 → G9, G10 → H7, H8, rest.

Next session options: `continue audit phase 3b` (P3-6 + browser confirmation of UI-41 + challenger), then phase 4 (docs vs code).

---

# Phase 3b status and fix-plan update (after P3-6, P3-7 browser confirmation, P3-8 challenger)

Phase 3 is complete except the small panels listed under "Not audited" in `FINDINGS.md`. Changes to the phase 3 fix plan above:

| # | Change |
|---|---|
| H1 | **Now first in the whole queue**: UI-41 is browser-confirmed and under-sizes by about 16% in the tested case. Add the Run-screen fields (UI-54) to the same fix. Proof adds: typed adherence 85 on claims → recommended 37, gross 48. |
| H2 | Add the priority column parse (`DemandFlow.tsx:209-210`). |
| H5 | UI-17: confirm `agentFairness.perAgent[i]` is index-aligned before changing. |
| H7 | UI-16 downgraded to minor; keep (cheap). |
| H6 | P3-T3 downgraded to minor; keep with G4. |

New items:

| # | Finding | What changes | Where | Tier | Proof it is fixed | Needs your decision? |
|---|---|---|---|---|---|---|
| H9 | UI-49 (do with G6 / UI-1), UI-58 | Column mapping joins the run snapshot comparison, so a mapping change raises the "changed since run" banner (or clears results); header chip shows the same stale marker. | `run-inputs.ts:14-41`; `App.tsx:262`, `:517-526`, `:593`, `:452` | 2 | Browser: run, change Category mapping → banner on Results and header | No. |
| H10 | UI-56, UI-60, UI-38, UI-51 ("lost work" theme) | Settings import: validate shape, merge onto defaults, honest message when nothing applies (extends F5); add an error boundary so a render error shows a recoverable message; "leave page?" guard when data is loaded; keep the Sensitivity matrix when leaving the tab and cancel its search. | `App.tsx:414-467`, `:667`; `SensitivityFlow.tsx:45-125`; new boundary component | 2 | Import `{}` → "nothing applied"; import file without `holidays` → loads with defaults, no white screen; refresh with data → browser prompt | No. |
| H11 | UI-55, UI-59 | Warning when replications < 30 (stronger at 1: "no confidence check"); labels reflect the real value; Run gates for zero open days, close ≤ open, zero categories, ceiling below `N_min`. Do with H8. | `RunFlow.tsx:75-106`, `:276`, `:312`, `:328` | 2 | Replications 1 → visible warning; no working days → gate blocks before Run with a calendar message | No. |
| H12 | UI-50, UI-52, UI-53 | Sensitivity: do not round AHT; show "infeasible" on failed cells; handle Stop/errors with a message. | `SensitivityFlow.tsx:53-129`, `:84`, `:260`, `:351` | 2 | AHT 7.5 → base cell equals the Results headline | No. |

**Overall order across all phases:** **H1** (typed values, confirmed under-staffing) → **G12** (tests) → **G1** (horizon) → F2 → F3 → G2–G5 + H2 + H6 (input safety) → G6 + H9, G7 + H5 → H3, H4 → H10, H11 → G8/F1 → F4–F6 → G9, G10 → H7, H8, H12, rest.

Next: phase 4 (docs vs code, plus the leftovers in "Not audited"), in a new session after the weekly reset.

---

# Phase 4 plan — docs vs code (resume point)

State at start: weekly meter 17%. Hard stop 20%. No new agent at a meter reading of 19%. One agent at a time, meter read before and after each. Read-only. Pre-plan challenger skipped (budget).

| # | Slice | Agent | Check |
|---|---|---|---|
| P4-1 | `PRD.md` lines 1-684 (overview, journey, section 5 functional requirements) | sonnet-investigator | Every stated behaviour, default, limit, label and rule vs the code; report doc-says / code-does mismatches |
| P4-2 | `PRD.md` lines 684-1465 (methodology, design decisions, non-functional, validation, limitations, backlog, glossary) | sonnet-investigator | Formulas and decisions vs code; limitations and backlog items still true; check counts |
| P4-3 | `project_context.md` (1116) + `CLAUDE.md` (178) | sonnet-investigator | Architecture map, commands, frozen decisions, conventions, open-items list vs code and `package.json` |
| P4-4 | Final challenge | challenger | Only if meter reads below 19% |

Not in scope this session unless budget remains: `docs/wfm/*.md` (1742 lines), leftover UI panels. Steps not reached are listed as not audited.

---

# Phase 4 status and fix plan (docs) — audit complete

Done: P4-1, P4-2, P4-3. P4-4 challenger not run (budget). All four audit phases are finished; leftovers are listed under "Not audited (end of audit)" in `FINDINGS.md`.

| # | Finding | What changes | Where | Tier | Proof it is fixed | Needs your decision? |
|---|---|---|---|---|---|---|
| J0 | TEST-4 correction | Re-run mutations B1/B1b against `compareByUrgency` before scoping G12. Read-only test, no product change. | scratch copy only | — | Mutation killed or survives, recorded in `FINDINGS.md` | No. **Do first — it decides how big G12 is.** |
| J1 | DOC-40, DES-15 | Correct `CLAUDE.md` decision 2 and the Code Conventions bullet, `project_context.md` §6.2 and §12: real dispatch is `pickNextCase` / `compareByUrgency`. Optionally remove the duplicate ordering in `CaseMinHeap.compare` (engine change, Tier 3, both orderings proven equal first). | `CLAUDE.md`; `project_context.md:515`, `:1091`; `des-engine.ts:185-197` | 1 (docs) / 3 (code) | Docs name the function at `des-engine.ts:1334` | **Yes** — `CLAUDE.md` frozen-decision wording is yours to approve; removal of the duplicate is optional. |
| J2 | PRD §10/§11 gap | Add every unfixed audit finding to PRD §10 (limitations) or §11 (backlog) in the existing ID style; correct L8 (30-minute rule), NFR-2.2 (build tools), §9.1 (suites). Shrinks as fixes land. | `PRD.md:1072`, `:1115-1124`, `:1164-1366` | 1 | Each of the 13 items in the P4-2 table has a PRD line | No. **Cheap and honest — recommend doing right after H1.** |
| J3 | DOC-20, DOC-41, DOC-50 | One correct test table in both documents (174 + 518 + 60 in `npm test`; 164 trusted-source — separate until G12 adds it); scripts tree completed. | `PRD.md:1115-1124`; `project_context.md:56`, `:78`, `:173-176`, `:849-856` | 1 | Numbers equal the suite output | No. |
| J4 | DOC-21, DOC-42, DOC-45..49, DOC-1, DOC-2, DOC-4..6, DOC-22..25 | Stale text sweep: invariants panel description / P0-1, "no git repository", defaults location, "ten decisions", stale formula and line references, export columns, file size, line counts. | `PRD.md`, `project_context.md` | 1 | Each quoted line corrected | No. |
| J5 | DOC-43, DOC-44, DOC-3 | Small code items: widen the D9 console/network scan to all of `src/` (with G13); category ID without `Date.now()`; upper clamps on replications and search ceiling (with H1). | `scripts/verify-sizing-fixes.mts:652-684`; `csv-parser.ts:716`; `RunFlow.tsx:316-346` | 2 | D9 fails on a `console.log` in a component | No. |

# Whole-audit fix order (phases 1–4)

1. **H1** — typed settings stored wrong (browser-confirmed, under-staffs ~16%).
2. **J0** then **G12** — tests that protect the frozen decisions, so later fixes are safe.
3. **G1** — planning horizon stretched by old backlog dates (under-staffs).
4. **J2 + J3** — make the PRD honest about what is still open (docs only).
5. F2, F3 — 24x7 midnight resume; post-polish statistics.
6. G2–G5 + H2 + H6 — input safety (demand file and backlog file).
7. G6 + H9, G7 + H5 — stale results; agent tables.
8. H3, H4, H10, H11 — Results colours and warnings; dead control; lost-work guards; run warnings.
9. G8 / F1 — coverage-repair roster (owner decision).
10. F4–F6, G9, G10 — ties, config validation, gate rounding, drain window, backlog priority (owner decisions).
11. J1, J4, J5, H7, H8, H12, G11, G13, F7–F10 and the minor backlog.

Owner decisions still open: F1/G8, F4, F6, F7, G1, G2, G3, G5, G9, G10, 30-minute rule (G11), G13 (`package.json`), H2, H4, J1.

---

# BUILD PLAN — H1: number fields keep what is typed (approved by owner 2026-10-06)

Weekly cap raised by the owner to **25%** (hard stop). Meter at start: 18%. No new agent at a reading of 24%.

**Task:** number fields on the Settings and Run screens must store exactly what the planner types; clamping happens when the field is left (blur) or Enter is pressed, never per keystroke.
**End user:** the WFM planner opening `BoWFM.html` from disk.
**Tier 2** (changed behaviour, several sections; no engine maths). Reviewers: `tester` + `auditor`; `user-side` folded into the tester brief (typing experience).
**Skills:** `browser-automation` (free gate, tester); `wfm-engine-testing` not needed (no `src/utils` engine change) but the fail-first rule is kept for the new helper.

## Steps (builder: `sonnet-executor`, one at a time)

1. New pure helper `src/utils/number-input.ts`: `commitNumberDraft(draft: string, opts: {min, max, integer?, fallback})` → returns the committed number: parse the draft (`Number`, trimmed; reject empty, NaN, non-finite → return `fallback`, which callers pass as the CURRENT stored value, not a default), round to integer when `integer`, clamp to `[min, max]`. No `|| default`, so a legitimate 0 survives where `min` allows it.
2. New component `src/components/NumberField.tsx`: controlled by a local draft string; shows the stored value when not focused; `onChange` only updates the draft; on blur or Enter calls `commitNumberDraft` and `onCommit(value)`; Escape restores the stored value; re-syncs the draft when the stored value changes from outside (e.g. settings import, toggle). Props: `value`, `onCommit`, `min`, `max`, `integer`, `step`, `disabled`, `className`, `ariaLabel`/pass-through attributes. No new dependency.
3. `ConfigFlow.tsx`: replace the per-keystroke handlers with `NumberField`, same documented ranges: daily productive hours (1–24, decimal — closes UI-43: negatives rejected), adherence % (10–100, shown and stored to one decimal, closes UI-44), working days per week (1–7 integer, keep `offDaysPerWeek = 7 − value`), primary SLA % (1–100), SLA window (≥1), ASA target (≥1), per-category target %, window, ASA, confidence level (50–99.9, one decimal), slack (1–20), workload reduction (1–50), occupancy cap (50–100 integer), min agents per interval (0–999 integer), manual-override hours (≥0), AHT (≥1, decimal as today), shrinkage % (0–99, one decimal), priority (≥1 integer). Stored units unchanged (fractions where fractions today).
4. `RunFlow.tsx`: replications (1–100 integer), search ceiling (1–5000 integer), seed (integer, 1–2147483647) through `NumberField` — adds the upper bounds the PRD already states (FR-8.2, FR-8.3; closes DOC-3, UI-54).
5. Fail-first tests in `scripts/verify-sizing-fixes.mts` (new suite, next free D-number) for `commitNumberDraft`: "85" with min 50 → 85; "8" with min 50 → 50; "" → fallback; "abc" → fallback; "-3" with min 1 → 1; "99999" max 100 → 100; "12.5" integer → 13 (or 12 — state the rule) ; "0" with min 0 → 0; "1e9" → max. Plus a source-level guard: no `onChange` in `ConfigFlow.tsx`/`RunFlow.tsx` number inputs calls `Math.max(`/`Math.min(` on `e.target.value` (regression guard against per-keystroke clamps).
6. Docs + artifact (Definition of Done): `PRD.md` (§5 field rows: "validated when the field is left"; bump version/date; remove nothing else), `project_context.md` (§4 file list: new helper + component; §11 recently fixed: UI-41/42/43/44/54, DOC-3), `FINDINGS.md` status line; `npm run lint && npm test && npm run build:standalone`; `npm run check:artifact`.

## Scope lock

May edit only: `src/utils/number-input.ts` (new), `src/components/NumberField.tsx` (new), `src/components/ConfigFlow.tsx` (number inputs and their handlers only), `src/components/RunFlow.tsx` (the three inputs only), `scripts/verify-sizing-fixes.mts` (new suite only), `PRD.md`, `project_context.md`, `BoWFM.html` (rebuild output). Nothing in `src/utils/hc-search.ts`, `des-engine.ts`, `calendar.ts`, `csv-parser.ts`, `default-config.ts`. No change to defaults, ranges, units or engine behaviour. `package.json` untouched.

## Acceptance criteria and proof

| # | Criterion | Proof (real key presses on the rebuilt `BoWFM.html`, `file:///`) |
|---|---|---|
| 1 | Occupancy cap keeps typed value | Enable cap, select all, type `8`,`5`, Tab → field 85; type `7`,`0`, Tab → 70; type `3`,`0`, Tab → 50 (clamped on leave) |
| 2 | Adherence keeps typed value | Select all, type `8`,`5`, Tab → 85 |
| 3 | Confidence keeps typed value | Select all, type `9`,`5`, Tab → 95 |
| 4 | Headcount follows the typed value | Claims sample, adherence typed 85 → recommended **37**, gross **48**, `N_min` 36 (the audit's pasted-85 reference); defaults untouched → **31 / 40 / 30** |
| 5 | Fields can be emptied while typing | Search ceiling: Backspace ×3 → empty field (no snap), type `8`,`0`, Tab → 80; empty + Tab → previous value restored |
| 6 | Upper bounds enforced | Replications `99999` + Tab → 100; ceiling `99999` + Tab → 5000 |
| 7 | Negative productive hours rejected | Paste `-3` + Tab → 1 (or previous value); Run gate unaffected |
| 8 | Decimals shown as stored | Shrinkage `12.5` + Tab → field 12.5; adherence `92.5` → 92.5 |
| 9 | No regression | `npm run lint` clean; `npm test` all green with the new suite; `npm run test:trusted-source` 164 green; `npm run test:audit` sample HCs unchanged; page loads with zero console errors; three samples still give 31/40, 27/34, 31/39 |
| 10 | Docs and artifact in sync | `PRD.md`, `project_context.md` updated; `npm run check:artifact` passes |
| 11 | Scope respected | `git diff <checkpoint>..HEAD --stat` lists only the scope-lock files |

## H1 plan — revision after challenger (FAIL → all points accepted; this section overrides the steps above where they differ)

**Commit rule (replaces "on blur or Enter" only):**
- On every change the draft string is kept as typed. **If the draft already parses to a number that satisfies the field's rule (finite, within `[min, max]`, integer when required), it is committed immediately.** So typing `8`,`5` into a 50–100 field holds "8" as a draft and commits 85 on the second key; arrow keys / spinner clicks commit at once.
- On blur, Enter and **unmount** (effect cleanup), a pending draft is committed through `commitNumberDraft` (clamped; empty or unparseable → the current stored value). Escape restores the stored value.
- The draft is re-synced whenever the displayed stored value changes from outside while the field is not being edited (settings import, toggle flip, sample load).
- Integer rule: `Math.round`. Decided.

**Units:** `NumberField` works in DISPLAY units only. Callers pass `value` already converted for display (adherence and shrinkage: `Math.round(fraction * 1000) / 10`, i.e. percent to one decimal) and convert back inside `onCommit` (`/ 100`). Stored units do not change. Each existing handler body is kept: `onCommit` receives the committed number and the caller writes the same fields it writes today (working days still writes `offDaysPerWeek = 7 − value`; window fields still write what they write today, including any `primaryWindowMinutes`; occupancy cap still displays 100 when its toggle is off). Fallback for empty/invalid is always the CURRENT stored value, never a hard-coded default.

**Seed:** no range change. Integer only, any sign, as today; an emptied field restores the current seed; `0` keeps today's behaviour (stored as 12345). Replications and search ceiling get the upper bounds the PRD already states (1–100, 1–5000); a stored 0 from an imported file is displayed as stored after clamping to the minimum (1), not as a made-up default.

**Scope lock — extended:** also `src/components/CalendarConfigPanel.tsx` (its 4 number inputs) and `src/components/DemandFlow.tsx` (the 1 manual-backlog "remaining minutes" input only — closes UI-33; integer ≥ 1 as today, no other backlog change, that is H2). Every `type="number"` input in `src/` must go through `NumberField` after this change (26 today); the builder lists each one with its range in the hand-back. Rows rendered in lists pass a stable `key` (category id).

**Tests (replaces step 5's regex guard):** new suite for `commitNumberDraft` and for a second pure helper `draftIsCommittable(draft, opts)` (the "commit immediately" rule): "8" with min 50 → not committable; "85" → committable 85; "" → not; "-" → not; "1e" → not; "12.5" integer → not committable, commits 13 on blur; "99999" max 100 → not committable, commits 100; "0" min 0 → committable 0; stored 0.925 displays 92.5 and commits back to 0.925 (round-trip helper). Source guard, labelled as a guard not proof: no `<input` with `type="number"` remains in `src/components/*.tsx` outside `NumberField.tsx`.

**Acceptance criteria — added / changed:**

| # | Criterion | Proof |
|---|---|---|
| 4 (source) | Reference numbers 37 / 48 / 36 and 31 / 40 / 30 | Recorded in `FINDINGS.md`, section "P3-7", row "UI-41 size of effect" (pasted-85 run on the shipped file before the fix) |
| 12 | No Tab needed | Adherence: select all, type `8`,`5`, then click the Run step in the sidebar and Run with the mouse (no Tab, no Enter) → run uses 85 (recommended 37) |
| 13 | Unmount keeps the value | Occupancy cap: type `3`,`0` (out of range, pending), click another Settings tab, return → field shows 50 (clamped), not the old value and not 30 |
| 14 | Two-field handlers intact | Working days: type `6`, Tab → off days reads 1; type `5` → off days 2 |
| 15 | Toggle re-sync | Occupancy cap: toggle off → field 100 disabled; toggle on → stored cap shown |
| 16 | Arrow keys | Focus replications, ArrowUp once → 31 stored without leaving the field |
| 17 | Calendar and backlog fields | Calendar open hour: clear, type `9` → 9 stored; backlog remaining minutes: clear (stays empty), type `4`,`5` → 45 |
| 18 | Every number input converted | `grep -c 'type="number"'` over `src/components` → only inside `NumberField.tsx` |

Strongest surviving objection (challenger): commit-on-blur alone silently loses typed values on unmount and spinner clicks — addressed by the commit rule above; criteria 12, 13 and 16 prove it.

---

# J0 result — dispatch-order mutation re-test (2026-10-06)

Mutations applied to the functions that really dispatch (`compareByUrgency`, `pickNextCase`), in a scratch copy; real repo untouched.

| Mutation | Caught by `npm test`? | By what |
|---|---|---|
| EDF → FIFO (`compareByUrgency` by arrival) | **Yes** | 11 checks in `verify-sizing-fixes` (D43.7 order digest, D43.14, D45.2, D49.1b) — digests and pinned numbers only; trusted-source does not catch it |
| Reversed deadlines | **Yes** | 5 + 19 + 8 checks across three suites |
| Parked-first rule removed | Yes, by **one** check | `verify-fixes` Suite 30 Test B only |
| Priority step removed from `compareByUrgency` | **No — survived all 939 checks** | — |
| Control: `CaseMinHeap.compare` deadline reversed | No (expected) | Confirms that method does not decide dispatch |

**TEST-4 is corrected:** frozen decision 2 (EDF) IS protected by `npm test`. What remains open: the priority tie-break has no test (new, TEST-9), the business-calendar `latestSafeStart` (mutation B2) has no test, and FIFO is caught only indirectly.

# BUILD PLAN — G12: tests that protect the frozen decisions

Weekly cap 25% (hard stop). Meter at start: 19%. No new agent at a reading of 24%.

**Task:** add the missing tests so that breaking a frozen sizing rule makes `npm test` fail; add the trusted-source suite to `npm test`.
**End user:** the WFM planner (indirectly: a future change cannot silently alter headcount rules).
**Tier 1** (tests and one script line; no product behaviour). Reviewer: `tester` — re-runs the surviving mutations; each must now be killed.

## Steps (builder: `sonnet-executor`)

New suite(s) appended to `scripts/verify-sizing-fixes.mts` (next free D-number after D54), in that file's style, each test written against the PUBLIC exported functions:

| # | Rule protected | Test | Mutation it must kill |
|---|---|---|---|
| T1 | Priority tie-break in dispatch | `pickNextCase` with two new cases, same `latestSafeStart`, different priority → higher-priority first; and same again through a tiny `runBackofficeDES` run | M4 (priority line removed) |
| T2 | EDF directly | `pickNextCase`: case A arrives first with a LATER deadline, case B arrives later with an EARLIER deadline → B first | M1 (FIFO) directly, not via digests |
| T3 | `latestSafeStart` walks the business calendar | Mon–Fri 08–18 calendar, business-hours SLA, case due Monday 10:00 needing more handling time than Monday morning allows → `latestSafeStart` falls on Friday, not on a weekend clock time | B2 (wall-clock subtraction) |
| T4 | CI gate, SLA | `computeStatisticalEvaluation` (or the exported gate function actually used by the search) with samples [78, 82, 80, 79, 81], target 80: mean 80 passes a mean test, the 95% lower bound is below 80 → must FAIL; and a set whose lower bound clears → PASS | B4 (mean), B5 (upper bound) |
| T5 | CI gate, per-category / occupancy cap / ASA | Same shape for each of the three other gates: mean on the passing side, bound on the failing side → gate fails (occupancy and ASA use the UPPER bound against the cap) | B4b, B4c, B4d |
| T6 | Common Random Numbers | Search (or the helper that builds `precomputedCaseSets`) at N and N+1 with the same seed → identical arrival realisations (same case count, same arrival times, same handle times per replication) | B6 |
| T7 | Unfinished cases count as SLA failures | Tiny run with capacity for 6 of 10 cases inside horizon + drain → achieved % = 60 (denominator 10), not 100 | B15 |
| T8 | Gross HC total: per-category gross-up → sum → one round (harmonic effective shrinkage) | Two categories, shrinkage 10% and 40%, equal operational HC 10 each → gross total `round(10/0.9 + 10/0.6)` = 28 (arithmetic-blend answer `20/0.75` = 26.67 → 27 must NOT appear) | M3c (arithmetic blend) |
| T9 | Volume rounding rule | Interval volume 2.5 / 2.4 → generated case count follows `Math.round` | B13 (round → floor) |

- `package.json`: `scripts.test` also runs `test:trusted-source` (before the artifact-freshness check). Scripts only — `dependencies` untouched.
- If a needed function is not exported, the builder may add the `export` keyword ONLY (no logic change) in `src/utils/hc-search.ts` or `des-engine.ts`, must list each one, and must then rebuild (`npm run build:standalone`) because `src/` changed. Preferred: test through already-exported functions.
- Docs: `PRD.md` §9.1 and `project_context.md` §9 / lines 56, 78, 173-176, 849-856 — one correct suite table (counts as measured after this change; trusted-source now part of `npm test`); `project_context.md` §11 one "recently fixed" row. Bump PRD version/date only if the project's own convention bumps for test-only changes (follow existing practice).
- Every new test must be shown to FAIL against its mutation before it is accepted (builder applies each mutation temporarily in a scratch copy or with a local revert, records the failing output, restores).

## Scope lock

`scripts/verify-sizing-fixes.mts` (append only — no existing test changed or removed), `package.json` (`scripts.test` line only), `PRD.md`, `project_context.md`; `export`-keyword-only edits in `src/utils/hc-search.ts` / `des-engine.ts` if unavoidable, plus the rebuilt `BoWFM.html` in that case. No other file. No engine logic, default, or guard changed.

## Acceptance criteria and proof

| # | Criterion | Proof |
|---|---|---|
| 1 | All suites green on the real code | `npm run lint` clean; `npm test` exit 0 and now includes the 164 trusted-source checks; counts reported |
| 2 | Each listed mutation is now killed by `npm test` | Tester re-applies, one at a time in a scratch copy: M4, M1 (must fail a T2 check directly), B2, B4, B5, B4b, B4c, B4d, B6, B15, M3c, B13 → each produces at least one failure in a NEW test, named |
| 3 | No existing test weakened | `git diff` of `verify-sizing-fixes.mts` shows additions only |
| 4 | Tests are not tautologies | Auditor-style read by the tester: each new test calls engine code and compares to an independently stated expected value |
| 5 | Sample headcounts unchanged | `npm run test:audit` (or the three samples 31/40, 27/34, 31/39) unchanged |
| 6 | Docs and artifact | Suite counts in both docs equal the real output; `npm run check:artifact` passes |
| 7 | Scope respected | `git diff <checkpoint>..HEAD --stat` lists only scope-lock files |

## G12 plan — revision after challenger (FAIL, all points accepted; overrides the table above where they differ)

- **Export pre-authorised:** `computeStatisticalEvaluation` (`hc-search.ts:1882`) gets the `export` keyword only (no logic change); rebuild `BoWFM.html` afterwards. Any other export must be listed and justified.
- **T4/T5:** call `computeStatisticalEvaluation` with hand-built replication results. Gate statistic: 95% CI from mean, sample SD and the engine t-value (about 2.776 for 5 samples). Samples [78,82,80,79,81], target 80, slack OFF: mean 80, lower bound about 78.0, so `passesPrimaryCI` must be false while mean is at or above 80. Passing fixture e.g. [80,80,80,81,81]; also assert its UPPER bound so an upper-bound mutation is killed. One separate fixture per gate (primary, per-category, occupancy cap, ASA) where only that gate flips and the others pass; assert the specific flags (`passesPrimaryCI`, `categoryPasses[cat]`, `passesOccupancyCap`, `passesBOASA`), not only the combined verdict. Occupancy and ASA use the upper bound. `minCoverageObserved` set to Infinity; ASA enabled for the ASA fixture.
- **T6 (CRN):** must go through the search path (`evaluateCandidateStatistical` with the shared `precomputedCaseSets`, or `searchOptimalHC`), not the generator helper alone. Accepted only when shown red under mutation B6 as defined in the scratch harness.
- **T7:** hand-built `precomputedCases` passed to `runBackofficeDES`: 10 cases, 1 agent, AHT sized so exactly 6 finish before the drain window ends and all 6 are inside their deadline (long SLA window). Assert `primaryAchievedPct` = 60 and `unfinishedCases` = 4.
- **T8:** via `calculateStaffingRequirement` with two categories of equal workload, shrinkage 10% and 40%, total operational HC 20, calendar/labor chosen so the OFF-day floor is the identity. Assert `grossHCTotal` = 28 AND `effectiveShrinkagePct` = 0.28 (arithmetic answer 0.25 / 27 must not appear).
- **T1/T2:** aim at `pickNextCase` / `compareByUrgency` (real dispatch). Priority: lower number first. At least two cases per test (single-case early return). `remainingWorkMinutes` equal to `totalAhtMinutes` so the parked rule does not interfere. Add one parked-first check (parked case with a later deadline beats a new case with an earlier one). `CaseMinHeap.compare` is NOT tested here (it does not decide dispatch; see DES-15).
- **T3:** through `generateCaseEntities`, one opening-backlog case and one demand case (both code sites). Example: deadline Monday 10:00, 180 handling minutes, Mon-Fri 08:00-18:00 gives latest safe start Friday 17:00. Build dates the way `calendar.ts` does (local time) so the assert holds in any timezone. Backlog case uses remaining minutes, not total AHT.
- **T9:** count generated cases for volumes 2.5 (3), 2.4 (2), 0.4 (0).
- **package.json:** chain `npx tsx scripts/verify-trusted-source.mts` before the freshness check; confirm it exits non-zero on a failure; re-measure its check count.
- **Rule for acceptance:** every new test is shown RED under its own mutation (definitions in the scratch harness `mut.mjs` / `mut2.mjs` and the J0 table) before it counts. A test that stays green under its mutation is reported, not kept as proof.
- Deferred (not in G12): sync/async parity test (belongs to F9).

---

# BUILD PLAN — G1: planning horizon comes from the demand data only (CSV-13 + CSV-14)

Weekly cap 25% (hard stop). Meter at plan time: 21%. No new agent at a reading of 24%. If the build cannot finish inside the cap it stops after a committed, green step and resumes after the weekly reset.

**Task:** empty days before the demand data starts (or after a stray date) must never count as planned capacity; a backlog case's own arrival still drives its deadline.
**End user:** the WFM planner opening `BoWFM.html` from disk.
**Tier 3** (engine numbers). Reviewers: `tester` + `auditor` + `user-side` + final `challenger`.
**Skills:** `wfm-engine-testing` (fail-first protocol), `wfm-sizing-simulation` (builder reads before touching the DES), `browser-automation` (free gate, tester).

## Facts established (investigator, with probes; scratch `g1/`)

- The stretch lives in three copies: `calendar.ts:488-516` (`computeIntervalHorizon`, lines 507-513 take the minimum with backlog arrival), `hc-search.ts:2391-2414` (sync search) and `:3045-3067` (async search), `ConfigFlow.tsx:71-89` (preview). `generateCaseEntities` (`des-engine.ts:530`) and `validateDataQuality` (`csv-parser.ts:895`) call the shared one.
- Consumers of the working-day count: `N_min`, `N_occ`, the occupancy denominator (`des-engine.ts:2100-2102`), Gross HC inputs, agent day scheduling from `horizonStart` (`des-engine.ts:1119-1174`), simulation start (`:833`), drain end (`:829`).
- Before-baseline (Mon–Fri week, 6 cases per interval, AHT 30): no backlog → 5 working days, `N_min` 7, recommended 8. One backlog case 14 days old → 15 days, `N_min` 2, recommended 7 (6 h SLA) or 5 (3-day SLA). One stray demand interval 2 years out → 524 days, `N_min` 1, recommended 7 / 5; data quality "passed".
- **Hazard that the fix must also close:** every case is injected at its own arrival time (`des-engine.ts:820-822`) and agents are seeded idle regardless of the clock (`:918`). If only the horizon is moved, an old backlog case arriving in open hours is worked BEFORE the horizon by agents who are not rostered yet (probe: 16 timeline slices before the horizon start, case counted as passed). That is free capacity — under-sizing by another route.
- No test asserts the stretching and no document calls it deliberate (`docs/wfm/07:921` says the horizon uses validated intervals). The fix reverses no recorded decision.

## Design

1. **One horizon function.** `computeIntervalHorizon(intervals, openingWIP?)` in `calendar.ts`: start = earliest valid interval start, end = latest valid interval end. Backlog arrivals no longer move it. Fallback when there are NO valid intervals (backlog-only data, used by existing tests): start = earliest valid backlog arrival, end = start + 7 days, exactly as today; with neither, today's behaviour is kept unchanged.
2. **Three copies become one.** Both search functions and `ConfigFlow.tsx` call the shared function (sync and async edited identically; no third copy).
3. **Backlog older than the horizon.** In the simulation each case is injected at `max(arrival, horizonStart)`. Its `arrival`, `clockStart`, deadline and `latestSafeStart` are NOT changed — an overdue backlog case still counts as an SLA failure and still sorts first under EDF. No work can start before the horizon.
4. **Data quality (new rules):**
   - **Blocking error** — "Date gap in demand data": the demand data contains a run of more than 30 consecutive calendar days with no rows between two dated rows. Message names the last date before the gap, the first date after it, and the row of the isolated date ("check for a mistyped date"). This stops the stray-date case, which the fix above cannot repair by itself.
   - **Warning** — "Old backlog arrival": the oldest backlog arrival is more than 30 calendar days before the first demand interval (names the case and date). Harmless to capacity after the fix; flags typos such as year 2006.
   - The existing "coverage gap" warning stays as is.
5. No change to any frozen decision: occupancy is still demand ÷ planned capacity (the planned horizon is now the data's own span), the `N_min` floor logic, EDF, CRN, gross-up are untouched.

## Steps (builder `sonnet-executor`, fail-first)

1. Tests first, shown red on today's code (new suite in `scripts/verify-sizing-fixes.mts`): (a) horizon of a Mon–Fri week + one backlog case 14 days old = the week itself, 5 working days; (b) `N_min` and `N_occ` equal the no-backlog values (7 / 8 in the baseline fixture); (c) recommended HC with one old backlog case ≥ the no-backlog recommendation, at 6 h and at 3-day SLA, sync and async equal; (d) the old backlog case keeps its original deadline, is scored failed if overdue, `firstStartTime >= horizonStart`, zero timeline slices before `horizonStart`; (e) 50 old backlog cases → recommended HC ≥ baseline (they are real extra work); (f) backlog arriving inside the horizon behaves exactly as before (digest of case results unchanged); (g) backlog-only dataset: horizon as today; (h) data quality: 31-day hole → blocking error naming both dates, 30-day hole → no error; backlog 31 days old → warning, 30 → none; (i) sync search and async search read the horizon from the shared function (same result object fields).
2. `calendar.ts` — remove the backlog pull-back (keep the backlog-only fallback).
3. `hc-search.ts` — both searches call the shared function. `ConfigFlow.tsx` — preview calls it.
4. `des-engine.ts` — inject at `max(arrival, horizonStart)`.
5. `csv-parser.ts` — the two data-quality rules.
6. Full verification: `npm run lint`; `npm test` (987 + new); `npm run test:audit` — every sample-file headcount unchanged (samples have no backlog); explain any existing test that had to change (expected: none that assert old behaviour; any expected-value edit must be justified one by one and is reviewed).
7. Docs + artifact: `PRD.md` (§5 data-quality table: two new rules, count 18 → 20; §6 horizon definition; §10 note; version + date bump — product behaviour changes), `project_context.md` (§5 horizon, §11 recently fixed, duplication note), `docs/wfm/07-known-defects-and-decisions.md` (new entry), rebuild `BoWFM.html`, `npm run check:artifact`.

## Scope lock

`src/utils/calendar.ts` (`computeIntervalHorizon` only), `src/utils/hc-search.ts` (the two horizon blocks only), `src/utils/des-engine.ts` (case-arrival scheduling line(s) only), `src/utils/csv-parser.ts` (`validateDataQuality`: two new rules only), `src/components/ConfigFlow.tsx` (horizon preview block only), `scripts/verify-sizing-fixes.mts` (append; existing expected values only with per-line justification), `PRD.md`, `project_context.md`, `docs/wfm/07-known-defects-and-decisions.md`, rebuilt `BoWFM.html`. Nothing else.

## Acceptance criteria and proof

| # | Criterion | Proof |
|---|---|---|
| 1 | Old backlog no longer lowers the floor | Baseline fixture + 1 backlog case 14 days old: working days 5, `N_min` 7, `N_occ` 8 (were 15 / 2 / 3) — test + tester's independent script |
| 2 | Recommendation not lowered by old backlog | Same fixture: recommended ≥ 8 at 6 h SLA and at 3-day SLA (were 7 and 5); sync = async |
| 3 | Backlog is real work | 50 old backlog cases → recommended ≥ baseline and workload hours include them |
| 4 | Deadline clock intact | Old backlog case: deadline unchanged vs today's code, scored failed when overdue, sorted first; hand-computed deadline for one case shown |
| 5 | No work before the horizon | Zero timeline slices and zero busy minutes before `horizonStart`; `firstStartTime >= horizonStart` for every case |
| 6 | In-horizon backlog unchanged | Case-result digest identical before/after for backlog arriving on or after the first interval |
| 7 | Stray date is stopped | File with one row 2 years out → blocking error naming the dates; Run disabled in the browser; the same file without that row runs and gives the baseline HC |
| 8 | Old-backlog typo is visible | Backlog case dated 2006 → warning naming the case; run still allowed; headcount equals the run without the typo's capacity effect |
| 9 | No regression | lint clean; `npm test` all green; `npm run test:audit` sample HCs unchanged; three built-in samples in the browser still 31/40, 27/34, 31/39; zero console errors |
| 10 | One implementation | `grep` shows no hand-rolled min/max horizon loop left in `hc-search.ts` or `ConfigFlow.tsx`; sync and async call the same function |
| 11 | Mutation proof | Tester re-adds the backlog pull-back, and separately removes the injection clamp, in a scratch copy → new tests fail each time |
| 12 | Docs and artifact | PRD, project_context, docs/wfm/07 updated; `npm run check:artifact` passes |
| 13 | Scope respected | `git diff <checkpoint>..HEAD --stat` lists only scope-lock files |

## Decisions needed from the owner before the build

| # | Decision | Recommended | Alternative |
|---|---|---|---|
| D1 | Stray date inside the demand file (hole of more than 30 days) | **Block the run** with a message naming the dates — the sizing is meaningless otherwise | Warning only (run allowed; headcount still understated) |
| D2 | Hole size that triggers it | **More than 30 calendar days** with no rows | 14 days (stricter) or 60 (looser) |
| D3 | Backlog-only data (no demand rows) | **Keep today's behaviour** (horizon = 7 days from the earliest backlog arrival) | Block the run |

## G1 plan — challenger verdict: FAIL (accepted). Build NOT started; owner decisions required first.

| Challenge | Ruling |
|---|---|
| **Blocker:** backlog that arrived before the horizon (ordinary Friday carry-over) keeps its old deadline, so after the fix it is already overdue when the first agents start and fails at EVERY headcount. `findImpossibleCategories` (`hc-search.ts:2268-2320`) does not see such cases. Enough of them push the search to the cap: infeasible or inflated result on normal data. Today they pass only because phantom pre-horizon agents work them. | **Accepted.** The plan needs an explicit rule for backlog already overdue at horizon start — owner decision D4. |
| Wait-time (ASA) for old backlog is measured from its original clock start (`des-engine.ts:1969-1978`): one 14-day-old case adds days to the mean and can fail the ASA gate at any headcount. | **Accepted.** Same rule as D4 must cover ASA. |
| Case `arrival` stays in the past while the case is injected at horizon start; consumers of `arrival` (exports, tie-breaks at `des-engine.ts:200`, `:252`) not listed. | **Accepted.** Builder lists every consumer; clamp approach kept (simpler than blocking dispatch). |
| Data-quality hole rule: a stray date 10-30 days out still stretches the horizon silently; a real multi-week shutdown would be blocked. | **Accepted.** Revised rule: block only when the hole is longer than 30 days AND one side of it is isolated (a few rows); warn on any stray span below that. Placement stated relative to early returns. |
| Acceptance criteria 2 and 4 depend on the D4 rule; add a Friday-backlog + Monday-demand fixture that must not hit the cap; pin the SLA target. | **Accepted.** |
| Workload already includes backlog remaining minutes (`hc-search.ts:2441-2460`); horizon end unaffected; frozen decisions 3 and 4 not altered in logic (numbers change — owner confirmation recorded). | Noted. |

**Owner decisions now required:** D1 (stray date: block vs warn), D4 (backlog already overdue at horizon start: exclude from the SLA/ASA gates and report separately — recommended; or restart its clock at horizon start; or keep as failures with a clear infeasible message). D2 and D3 keep the recommended defaults unless changed.

## G1 plan — FINAL revision (owner decisions 2026-10-06; overrides the sections above where they differ)

**Owner decisions:** D1 = block the run on an isolated stray date. D4 = backlog already overdue at horizon start is **excluded from the SLA and wait-time checks and reported separately**. D2, D3 = recommended defaults (30 days; backlog-only data behaves as today).

**Rule D4, exact:**
- Applies only to opening-backlog cases whose `arrival` is before `horizonStart` (pre-horizon backlog).
- Such a case is **overdue at start** when it cannot meet its deadline even if work begins at the first working instant of the horizon: `latestSafeStart < nextOpen(horizonStart)` (calendar functions only; `latestSafeStart` already accounts for remaining minutes).
- Overdue-at-start cases: still injected at `max(arrival, horizonStart)`, still dispatched by the normal EDF order (they sort first), still counted in workload, handling minutes, occupancy and unfinished counts. They are NOT counted in the primary SLA numerator or denominator (overall and per category) and NOT in the wait-time (ASA) mean. Each case result carries `overdueAtStart: true`; the run result carries `overdueAtStartCount` (and per category).
- Pre-horizon backlog that is still attainable stays fully scored against its ORIGINAL deadline. Its wait time is measured from `max(clockStart, horizonStart)` (the wait the team can influence).
- Backlog arriving on or after `horizonStart`: no change at all.
- Results screen: when the count is above 0, a visible note next to the SLA headline: "N opening-backlog cases were already overdue when the plan starts. They are worked first and counted as workload, but are not part of the SLA % above." Case table and case CSV: an "Overdue at start" marker/column. Data quality: a warning listing the count before the run.

**Data-quality rule D1, exact:** after interval validation and before the working-day calculation: sort the distinct data dates; if a run of more than 30 consecutive calendar days has no rows AND the smaller side of that gap holds no more than 1% of the rows (minimum 1 row, maximum 20 rows) then **blocking error** "Isolated date(s) far from the rest of the data" naming the isolated date(s), the row count and the main data range. Any other empty run longer than 30 days: warning (existing coverage-gap warning text extended to say so). Old backlog arrival more than 30 days before the first interval: warning naming the case.

**Scope lock — extended:** also `src/types/wfm.ts` (new optional fields only), `src/components/ResultsFlow.tsx` (the note, the case-table marker), `src/utils/export-rows.ts` (case CSV column), `src/utils/agent-analytics.ts` only if it reads SLA eligibility (report if so). Builder lists every consumer of case `arrival` / `clockStart` and states whether each needs a change.

**Acceptance criteria — replaced / added:**

| # | Criterion | Proof |
|---|---|---|
| 2 | Recommendation not lowered by old backlog | Baseline fixture (Mon-Fri, 6 per interval, AHT 30, target 80%): 1 backlog case 14 days old gives recommended >= 8 at 6 h SLA and at 3-day SLA (were 7 and 5); sync = async |
| 4 | Overdue-at-start rule | Friday-backlog + Monday-demand fixture, 40 backlog cases due Friday: `overdueAtStartCount` = 40; SLA % computed over the other cases only (hand count shown); all 40 are worked (complete) and their minutes are in the workload; recommended HC is finite and >= the no-backlog recommendation; search does NOT hit the cap |
| 4b | Attainable old backlog still scored | Backlog arriving Friday with a 3-day business SLA (due Wednesday): `overdueAtStart` false, scored normally, deadline equal to the hand-computed one |
| 4c | Wait time | Old attainable backlog: wait measured from horizon start; overdue-at-start cases absent from the ASA mean; ASA gate ON does not fail solely because of old backlog |
| 7 | Stray date blocked | One row 2 years out: blocking error naming it, Run disabled in the browser; a 10-day-out stray row: warning; a file with a real 5-week closure and substantial data on both sides: warning, not blocked |
| 14 | Planner sees it | Browser: load a demand file plus dated old backlog, run: the note with the count appears beside the SLA headline; case CSV has the marker; no note when the count is 0 |
| 15 | Mutation proof | In a scratch copy: re-add the backlog pull-back; remove the injection clamp; score overdue-at-start cases again: each makes a new test fail |
