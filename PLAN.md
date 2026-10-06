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
