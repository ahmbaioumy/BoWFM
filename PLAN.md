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

## Phase 1 steps — in this order, one agent each

| # | Slice | Agent | What "deep" means here |
|---|---|---|---|
| 1 | Health baseline | `tester` | `npm run lint`, `npm test`, `npm run test:trusted-source`. Records pass counts so later findings are judged against a known-green or known-red start |
| 2 | `calendar.ts` (564 lines, whole file) | `sonnet-investigator` | Line by line: half-open `[start,end)` bounds, backwards walk in `subtractWorkingTime`, day-boundary and 24x7 edge cases, off-by-one days |
| 3 | `des-engine.ts:720-1500` (event loop, part 1) | `sonnet-investigator` | Dispatch order, presence (`countAgentsOnShiftNow` at 1214), adherence as budget not gap, event ordering ties |
| 4 | `des-engine.ts:1500-2375` (event loop, part 2 + invariants) | `sonnet-investigator` | Occupancy numerator/denominator, drain window, SLA attainment counting, `verifyAgentTimelineInvariants` |
| 5 | `hc-search.ts:1-1200` (demand → workload → `N_min`) | `sonnet-investigator` | Shrinkage absent from Stage 2, units (minutes/hours/days), precision kept until display |
| 6 | `hc-search.ts:1200-2356` (shrinkage, gross-up, `resolveSearchBounds`) | `sonnet-investigator` | Harmonic blend, per-category gross-up then sum then single `round`, floor on/off bounds |
| 7 | Independent recompute | `tester` | Works out `N_min` and Gross HC for the sample dataset **by hand a second way** and compares with engine output |
| 8 | `hc-search.ts:2357-end` (sync vs async search) | `sonnet-investigator` | Block-by-block diff of `searchOptimalHC` and `searchOptimalHCAsync`; CI gate direction, CRN reuse, any logic present in one only |
| 9 | `des-engine.ts:1-719` (heap, PRNG, apportionment, case generation) | `sonnet-investigator` | EDF compare vs `compareByUrgency`, seed determinism, Webster apportionment monotone, Map/Set order |
| 10 | Final challenge | `challenger` | Attacks the findings: wrong, overstated, or missed |

Rules given to every agent:
- Read-only. No edits to project files.
- Read the whole slice, not excerpts. Report by `file:line`.
- Look for: logic errors, unit mix-ups, off-by-one, float `===`, unsorted Map/Set iteration, `Math.random`/`Date.now`, hand-rolled date math, rounding before the display boundary, breaches of the 11 frozen decisions in `CLAUDE.md`.
- Do **not** re-report items already written down as open (PRD §10 L1–L18, §11 backlog, `project_context.md` §11) unless docs say "fixed" and code says otherwise.
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
| Each step 1–10 is done or marked "not audited" | Status table in `FINDINGS.md` |
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
