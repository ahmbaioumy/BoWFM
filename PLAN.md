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
