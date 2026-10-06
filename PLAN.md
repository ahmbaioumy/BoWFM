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
