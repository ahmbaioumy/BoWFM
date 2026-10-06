# FINDINGS — Deep audit of BoWFM

Branch `audit/2026-10-06`. Read-only audit; no product code changed. Plan: `PLAN.md`.
Usage cap: stop at 20% weekly. Meter at start: 6%.

## Phase 1 status (sizing engine)

| # | Step | Status | Verdict |
|---|---|---|---|
| 0 | Challenger on plan | done | fail → plan re-cut (see Round 0) |
| 1 | Health baseline | done | pass |
| 2 | `calendar.ts` | done | 4 minor (CAL-1..4) |
| 3 | `des-engine.ts:1-719` | done | 1 major (DES-1), 5 minor, 1 question |
| 4 | Independent recompute | done | 1 major (HC-1); N_min exact on 7 datasets |
| 5 | `hc-search.ts:1-212` + `1300-1688` | done | 2 major (HC-3, HC-4), 4 minor |
| 6 | `des-engine.ts:720-1500` | done | 1 major (DES-8), 3 minor |
| 7 | `des-engine.ts:1500-2375` | done | DES-8 confirmed major; 3 new minor |
| 8 | `hc-search.ts:1689-2356` | done | pass; 5 minor, 1 docs gap |
| 9 | `hc-search.ts:2357-3829` sync vs async | done | no drift; 2 major (HC-14, HC-15), 1 tests gap, 1 minor |
| 10 | `hc-search.ts:213-1299` | done | HC-14 confirmed (blocker on 24x7 short SLA); 2 minor, 1 question |
| 11 | Final challenger | pending | |

## Round 0 — challenger on the plan

All accepted and folded into `PLAN.md`:
- Slices cut functions mid-body and step 5 described the wrong content → re-cut at function boundaries.
- Risk order wrong → case generation/apportionment and the recompute moved up; sync/async drift (known D11) moved down.
- Recompute not independent if it imports engine functions → no engine imports, scratchpad script, N_min and Gross HC only.
- Challenger budget not reserved → no audit agent starts at ≥15.5%.
- `wfm.ts`, `agent-analytics.ts`, `export-rows.ts` uncovered → carried to phase 2.
- Freshness check could false-alarm → informational only, never rebuild.

## Step 1 — health baseline (tester) — PASS

- `npm run lint`: exit 0.
- `npm test`: exit 0, ~188 s. verify-fixes 174/174, verify-sizing-fixes 518/518, verify-agent-analytics 60/60, artifact fresh (613.3 KB, mtime 2026-09-30T13:03:47Z).
- `npm run test:trusted-source`: exit 0, 164/164 (T0 35, T1 71, T2 31, T3 27).
- `git status` clean before and after.
- Note (minor, docs): PRD §9.1 says "856 checks (174 + 518 + 164)"; that sum excludes the 60 agent-analytics checks. Actual total run = 916. To confirm in phase 4.

## Findings

(appended per step below)

### Step 2 — `calendar.ts` (whole file, scripts run under UTC and New York)

| ID | Severity (my verdict) | Finding | Changes planner numbers? | Evidence |
|---|---|---|---|---|
| CAL-1 | minor (agent said major; downgraded — effect is 1 s per day crossed) | `subtractWorkingTime` rewinds a 24:00 close to 23:59:59, losing 1 s per day boundary. Mon–Fri 08:00–24:00: `subtractWorkingTime(Wed 09:00, 600)` → Tue 14:59:59, expected 15:00:00. Add-then-subtract of 2000 min returns 09:59:58 not 10:00:00. Close 18:00 round-trips exactly. | Practically no. Shifts `latestSafeStart` (EDF priority, `des-engine.ts:578`, `:640`) by seconds; could flip a tie-break only. | `calendar.ts:303-307`; not tested (Suite 24 only checks `isWorking(23:59:59)`) |
| CAL-2 | minor — **needs phase 3 check: can the UI produce these calendars?** | Degenerate calendars fail silently and inconsistently. Empty working days: `addWorkingTime` returns the start (deadline = start), `subtractWorkingTime` returns Invalid Date. Open 0:00/close 0:00 non-24x7 → zero-length window. Overnight window (22:00–06:00): add throws, subtract returns NaN. `durationMinutes = NaN` passes the `<= 0` guard. | Only if such a calendar reaches the engine; then deadlines collapse / NaN reaches the heap and output is untrustworthy. Severity rises to major if the UI allows an overnight window. | `calendar.ts:189`, `:197-201`, `:294-296`, `:313-315`; only empty-calendar subtract is tested (`verify-fixes.mts:956-968`) |
| CAL-3 | minor | Invalid-date fallbacks return `new Date()` (wall clock) in `nextOpen`, `addWorkingTime`, `subtractWorkingTime`, `computeIntervalHorizon` — breaks the determinism rule on bad input. | Only on invalid input. | `calendar.ts:113`, `:188`, `:250`, `:504` |
| CAL-4 | minor (dead code) | `createCumulativeWorkingCalendar` is never called anywhere; steps days by fixed 24 h (DST-unsafe if ever used). | No. | grep: definition only |

Clean: `isHoliday`, `isWorkingDay`, `getDailyOpenClose`, `isWorking`, `nextOpen`, `workingDuration` (agrees with `addWorkingTime`), `addWorkingTime`, `getCalendarWorkingDaysInHorizon` (half-open confirmed, `calendar.ts:349`), `getDailyWindowLengthHours`, `getValidSlapStarts`, `convertSlaDurationToMinutes`.

### Step 3 — `des-engine.ts:1-719` (heap, PRNG, apportionment, case generation)

| ID | Severity (my verdict) | Finding | Changes planner numbers? | Evidence |
|---|---|---|---|---|
| DES-1 | **major** (known as L1 / G-3, but the doc understates it — supervisor read the line and confirms) | The simulator rounds each interval's volume to a whole case (`Math.round(interval.volume)`), while the `N_min` workload uses raw volume. Any interval below 0.5 cases vanishes from the simulation. Synthetic test: 232.4 raw cases → 98 simulated (58% lost). PRD L1 calls the rounding "roughly unbiased"; with many sub-0.5 intervals it is one-sided. | **Yes.** Simulated demand, SLA % and occupancy look better than reality → risk of under-staffing. Partly masked by the `N_min` floor (raw volume); **not masked when the Workload Floor toggle is OFF.** Size on real files measured in step 4. | `des-engine.ts:601-603` vs `hc-search.ts:1548`, `:2436`; no conservation test in any suite |
| DES-2 | minor | `resolveOccupancyCapPct` returns NaN for a non-numeric cap when the cap is enabled → every candidate fails the cap gate. No UI path (input falls back to 85, `ConfigFlow.tsx:1071`); only via imported config. | Only with a bad imported config: over-staff / no convergence. | `des-engine.ts:700`, `:2125` |
| DES-3 | minor | When N < number of categories, first seats go to alphabetically-first categories, not the heaviest (A=1,B=50,C=30 at N=1 → A gets the seat). Sum and monotonicity still hold — not a frozen-decision breach. | No (such N fails anyway). | `des-engine.ts:481-485` |
| DES-4 | minor | Fractional `operationalHC` makes seats sum above N (2.5 → 3). Callers pass integers. | No. | `des-engine.ts:488` |
| DES-5 | minor | Seeds collapse: 0 ≡ 123456789, 42 ≡ 42.9. Production seeds are integers and never collide. | No. | `des-engine.ts:288`; 0-case asserted at `verify-trusted-source.mts:371` |
| DES-6 | minor | `narrowSurvivors` would read `surv[-1]` if all fairness metrics were NaN. Unreachable today. | No. | `des-engine.ts:324-337` |
| DES-7 | question for owner | Opening WIP with partly-done work counts as "parked" and jumps ahead of earlier-deadline new cases. Looks deliberate (both orderings agree) but is a departure from pure EDF. | Confirm intent. | `des-engine.ts:187`, `:270` |

Proven clean by running:
- Apportionment: 4 weight vectors, N=0..200 — seats always sum to N, zero monotonicity violations (frozen decision 10 holds).
- `CaseMinHeap` vs `pickNextCase`: 300 random queues × 40 cases with ties — identical order (no drift between the two orderings).
- Case generation: all arrivals inside the horizon; same seed → same arrivals; arrivals independent of N (CRN, frozen decision 9, holds).

### Step 4 — independent recompute (tester; own arithmetic, no engine imports)

| ID | Severity (my verdict) | Finding | Changes planner numbers? | Evidence |
|---|---|---|---|---|
| HC-1 | **major** | Gross HC at an exact .5 tie is decided by floating-point noise, not the maths. `AJM_Simu.csv`, operational HC 10, 5 categories all at 20% shrinkage: exact 10 / 0.8 = 12.5 → 13; engine returns **12**. The per-category sum lands at 12.499999999999998 in the engine's summation order. With uniform 20% shrinkage (the default) a tie exists at every operational HC ≡ 2 mod 4; over HC 1..200 the engine was 1 seat low at 5–22 HC values per dataset (e.g. healthcare sample: 22). Result also depends on category order. | **Yes — Gross HC 1 seat low** at those ties (under-staff). Fix is a tolerance on the single `round` (frozen decision 7 itself is unchanged: still per-category gross-up → sum → one round). | `hc-search.ts:1627-1628`, `:1653`; scratchpad `tie.mts`, `sweep.mts` |
| DES-1 (update) | major in principle, **zero effect on every current sample file** | All 7 loadable datasets have whole-number volumes: raw sum = rounded sum, 0% loss. The rounding only bites uploads with fractional/forecast volumes. | Today: no. With fractional forecasts: yes. | Rounding table, step 4 |
| HC-2 | note (documented, floor is settled design — not for change) | `computeAnalyticalNMin` uses `Math.floor` (e.g. `AJM_Only.csv` 9.45 → 9). | As designed. | `hc-search.ts:131` |

Recompute result — `N_min` matched exactly on all 7 datasets (claims 30, support 20, healthcare 18, AJM_Only 9, AJM_Simu 62, EGS+Reduction 42, EGS 53); working-day count matched an independent loop on all 7.
Method discrimination (3 categories at 10/25/40% shrinkage, HC 37): correct = 51, engine = 51; per-category rounding would give 50, arithmetic blend 49, ceil 52. Frozen decisions 5, 6, 7 hold in code.
Not covered: `UAT_BO.xlsx`, `test_breaks.xlsx` (no cheap loader).

### Step 5 — `hc-search.ts:1-212` + `1300-1688` (N_min, occupancy floor, staffing requirement)

| ID | Severity (my verdict) | Finding | Changes planner numbers? | Evidence |
|---|---|---|---|---|
| HC-3 | **major — owner decision** (tests currently assert the floor as intended: D40.2b, `verify-sizing-fixes.mts:449`, `:2501`, `:2508`) | Extra-OFF uplift is floored **before** the shrinkage gross-up. HC 10, calendar open 5 days, team works 4, shrinkage 20%: floor(12.5) = 12 → Gross HC 15; unfloored 12.5 / 0.8 = 15.625 → 16. 12 heads × 4 days = 48 seat-days against 50 needed. | **Yes — Gross HC up to ~1 seat low** whenever the team works fewer days than the calendar is open. Reachable from normal UI (`ConfigFlow.tsx:180`). Related to L14 but L14 does not mention the floor. | `hc-search.ts:1585-1587` |
| HC-4 | **major** (import path only) | Imported config is loaded without per-field checks (`App.tsx:450`), bypassing the UI's 0–99 clamp. Shrinkage 1.0 → clamped to 0.99 → Gross HC ×100 (10 → 1000). Shrinkage NaN/missing → shrinkage silently dropped (Gross HC 10), row shows NaN while effective shows 0. | **Yes**, for a bad/hand-edited config file: over- or under-staff with no warning. Not reachable by typing in the UI. Full check belongs to phase 3. | `hc-search.ts:1626-1632`; `ConfigFlow.tsx:1236-1239` |
| HC-5 | minor (same family as HC-1 — fix together) | `computeAnalyticalNMin` loses a seat to float noise when workload ÷ capacity is an exact integer (7.5 h, adherence 0.55, 15 days, 123.75 h → 1, expected 2). 236 of 4,800 grid cases. `computeOccupancyFloor` (ceil): 0 mismatches. | Rarely: `N_min` 1 low; matters mainly with Workload Floor OFF. | `hc-search.ts:130-131` |
| HC-6 | minor (import only) | Duplicate category names double-count workload share (A,A → Gross HC 25, expected 13). No UI path to create duplicates. | Only via imported config. | `hc-search.ts:1605`, `:1618-1620` |
| HC-7 | minor | `calculateStaffingRequirement` does not clamp negative opening-WIP minutes; the search path (`:2456`) and parser (`csv-parser.ts:1017`) do. Two paths differ. | Not from UI. | `hc-search.ts:1559-1563` |
| HC-8 | minor | Empty demand: workload silently replaced by 1 h; Gross HC 0 while operational HC shows 10. | Edge case only. | `hc-search.ts:1568` |

Clean by run: workload reduction applied once; shrinkage absent from Stage 2; adherence not double-applied; effective shrinkage reproduces Gross HC; per-category rows sum to total; divide-by-zero guarded. Rounding inventory: only lines 131 (floor), 157 (ceil), 1587 (floor, HC-3), 1653 (final round, HC-1) feed calculation — the other 13 are display-only.

### Step 6 — `des-engine.ts:720-1500` (`runBackofficeDES`, first half)

| ID | Severity (my verdict) | Finding | Changes planner numbers? | Evidence |
|---|---|---|---|---|
| DES-8 | **major** (24x7 calendars; second opinion requested in step 7) | In a 24x7 calendar, a case parked because its agent ran out of daily budget is resumed only at the next midnight — even when another agent is idle with budget right now. Repro: 2 agents, 1 productive hour/day; c1 (40 min) at 00:00, c2 (30 min) at 00:45. Agent 1 takes both, parks c2 after 20 min; agent 0 idle with 60 min. c2 completes next day 00:10; expected ~01:15 same day (~23 h late). Non-24x7 calendars resume immediately. | **Yes** — SLA % understated on 24x7 with hours-level TAT → tends to **over-staff**. Reachable with default settings on any 24x7 calendar; fair assignment (default on) makes it rarer, not impossible. | park decision `des-engine.ts:1450-1482`; midnight resume `:1635-1647`, `:1852-1857`; scratchpad `t1.mts`; not tested |
| DES-9 | minor | "Fits in remaining budget" test has no float tolerance (`:1419`). When cases exactly fill a day's budget, a ~1e-13-minute remainder parks the last case to the next day. 181 of 420 exact-fit combinations. The same file uses a 0.01 tolerance at `:1305`, `:1585`. | Slight SLA understatement (over-staff) on coincidental exact fits; compounds with DES-8 on 24x7. | `des-engine.ts:1419`; scratchpad `t2.mts` |
| DES-10 | minor — suspected, not run | Drain window is a hard-coded 14 calendar days after the horizon; a case with a longer TAT, unfinished at that point, counts as failed. | Possibly, for TAT windows near/over 14 days or holiday-heavy tails. Needs a test. | `des-engine.ts:829-830` |
| DES-11 | minor (latent) | Dead `maxWorkPossible <= 0` branch (`:1409-1413`) would leak `agentActive` and abandon other eligible agents if ever reached. | No (unreachable today). | `des-engine.ts:1344`, `:1409-1413` |

Proven clean by fuzz (400 random 24x7 / non-24x7 / staggered / siloed scenarios, zero violations): busy minutes per completed case = AHT; no agent over daily budget; no overlapping work; no case started before clock start. Presence rule (frozen decision 11) confirmed: fixed shift window, half-open, no budget term. Event tie-break order sensible and deterministic.

### Step 7 — `des-engine.ts:1500-2375` (`runBackofficeDES` second half + invariants)

| ID | Severity (my verdict) | Finding | Changes planner numbers? | Evidence |
|---|---|---|---|---|
| DES-8 (second opinion) | **major — confirmed by an independent auditor** | Reproduced exactly. Same scenario on a Mon 08–18 calendar resumes at once (c2 done 09:15 by agent 0); 24x7 waits to midnight. Docs say "resumes at the next open" (`docs/wfm/05-scheduling.md:90`); nothing documents a midnight wait. Measured on 24x7, 7 days, 7.5 h/day, 6 h TAT (original → engine copy with immediate resume): fairness ON, AHT 37, HC 12: 98.7 → 100; HC 11: 83.8 → 86.0; fairness OFF, AHT 30, HC 10: 97.1 → 100 (4% of cases parked). With AHT 30 and fairness ON: no parks (30 divides the 450-min budget). Also hand-rolls date maths outside `calendar.ts`. | **Yes** — SLA % understated by ~1–3 points near saturation on 24x7 → tends to over-staff. | `des-engine.ts:1635-1650`, `:1852-1856`; scratchpad `p1/p2/p4/p5.mts` |
| DES-12 | minor (rule breach: "round only at presentation"; cheap fix) | Gates compare values already rounded to 0.1: `primaryAchievedPct`, per-category `primaryPct`, `boAsaMeanMinutes`, `rawOccupancyPct`. The search samples these rounded values, then rounds the CI bounds again. Repro: handled 2251 min vs capacity 2250 (100.044%) → reported 100, cap passes. A true 79.96% SLA clears an 80% target. | Marginally — up to ~0.05–0.1 point, direction: slight under-staff. Rarely flips an integer HC. | `des-engine.ts:2084-2106`, `:2111`, `:2125`; `hc-search.ts:1935`, `:1953`, `:2149`, `:2238` |
| DES-13 | minor (test tooling) | `verifyAgentTimelineInvariants` gaps: never checks work past an agent's own shift END; checks #7/#8 skipped entirely on 24x7 (which now has staggered shifts); check #2 duplicates check #1. | No (a safety net is weaker than it looks). | `des-engine.ts:2213-2230`, `:2300`, `:2331-2371` |
| DES-10 (update) | minor — narrowed | Long TAT with light load: no false failures (20- and 30-day TAT → 100%). Only when heavily overloaded do unfinished not-yet-due cases count as failed, and `rawOccupancyPct` under-reports the overload (true ~533% shown as 300%). Run already fails there. | No headcount effect; overload magnitude shown is too low. | `des-engine.ts:829`, `:1957-1960`, `:2164`; scratchpad `lt.mts` |
| DES-14 | minor | `doubleBookedAssignments` is returned but nothing in the product reads it — a test-only signal, never shown to the planner. | No. | `des-engine.ts:2177`; `verify-sizing-fixes.mts:3225-3231` |

Confirmed clean: occupancy numerator/denominator match frozen decision 3 (planned-horizon denominator, drain not widening it, adherence applied once, `:2099-2102`); budget accounting conserved, no refunds; stale events unreachable (150-run fuzz, 0 hits; staggered mode not fuzzed); completion exactly at deadline counts as met (`:1957`); per-category rows sum to totals; no NaN on empty input.

### Step 8 — `hc-search.ts:1689-2356` (CI statistics, gates, `resolveSearchBounds`) — PASS, minors only

| ID | Severity (my verdict) | Finding | Changes planner numbers? | Evidence |
|---|---|---|---|---|
| DES-12 (extension) | minor (same fix as DES-12) | CI bounds are rounded to 0.1 a second time before the gate: lower bound 79.96 passes an 80 floor; occupancy upper bound 85.04 passes an 85 cap. | Up to 0.05 point lenient → can under-staff by one agent at an exact edge. Default settings. | `hc-search.ts:1911`, `:1944`, `:1962`, `:2005` → gates `:1928`, `:1950`, `:1973`, `:2007` |
| HC-9 | minor | With Replications = 1 (UI allows 1–100, `RunFlow.tsx:322`) the gate silently becomes a single-run point test — contradicts frozen decision 8 (CI-gated) with no warning to the planner. | Yes if the planner picks R=1: under-staffs vs a CI-gated run. | `hc-search.ts:1928`, `:1950`, `:1973`, `:2007` |
| HC-10 | minor | Student-t critical value approximation is slightly low for tiny R at high confidence (df 3 at 99.9%: 12.39 vs 12.92, −4%; at 95%: −0.12%). At default R=30 / 95% error < 0.01%. | Negligible at defaults. | `hc-search.ts:1810-1841`; only df 1, 2, 29 tested (`verify-fixes.mts:2655-2665`) |
| HC-11 | minor (import only) | Non-integer / NaN `replications` not sanitised (NaN → TypeError at `:1993`; 2.5 → 3 runs divided by 2.5). UI path is safe (`parseInt`, `|| 30`). | Imported config only. | `hc-search.ts:1864`, `:2126`, `:2214`, `:2489`, `:3168` |
| HC-12 | minor (unreachable today) | `resolveSearchBounds` does not guard NaN inputs or `searchCap = 0`; with floor ON, `N_occ > cap` while `N_min <= cap` is not flagged `capInfeasible` (left to the gates). | No today. | `hc-search.ts:2344-2355` |
| HC-13 | docs gap | Every category is gated separately, so a small category can fail while the blended SLA passes. Looks intended; PRD/docs do not say so. | As designed; document it. | `hc-search.ts:1996-2016` |

Confirmed clean: Student-t with Bessel correction, as documented (default R=30); gate directions correct (SLA lower bound `>=`, occupancy/ASA upper bound `<=`) — frozen decision 8 holds for R>1; clamps cannot turn a fail into a pass; seeds deterministic and identical across N (CRN) in all three places; start point and floor come only from `resolveSearchBounds` (frozen decision 4 holds); slack band applied once.

### Step 9 — `hc-search.ts:2357-3829` (sync vs async search)

**Drift verdict: none.** 52 diff hunks after stripping async noise — ~35 plumbing, ~17 cosmetic, **0 behavioural**. 19 scenarios run through both functions, full result objects deep-equal in all 19 (defaults, floor OFF, occupancy cap, 24x7, siloed, infeasible cap, placement ON, R=1, R=3, `AJM_Only.csv`, `EGS_Only.csv`). D11 remains a risk, not a live defect.

| ID | Severity (my verdict) | Finding | Changes planner numbers? | Evidence |
|---|---|---|---|---|
| HC-14 | **major, possibly blocker for 24x7 users — second opinion requested in step 10** | 24x7 calendar + default Min-coverage gate ON + demand spread over the day → **"infeasible" at every headcount up to 500**; no recommendation. With Min-coverage OFF the same inputs give 12–16 HC. Cause as reported: uniform layout cannot meet 24x7 coverage, so the search falls back to the coverage-repair layout, which puts one agent at each extra start and **all surplus at offset 0** — extra heads never add evening/night capacity (N=30: coverage 1 but SLA 58.9%). Existing tests D36/D37 pass because their demand is all in the first 10 hours. | **Yes — planner gets no answer** on 24x7 with defaults. Workaround: turn Min-coverage off. Not in PRD §10/§11. | `hc-search.ts:649-700` (`:680` `baseCount`), `:712-737`; scratchpad `probe2/3/5.mts` |
| HC-15 | **major (display only — headcount unaffected)** | After roster polish adopts a roster, the CI/median shown in Results (`primaryStatistical`) and the history row for the recommended HC still describe the **pre-polish** roster; `finalDESResult` describes the polished one. Siloed healthcare sample, placement ON: screen CI median 82.6% vs actual 80.2% (target 80); pooled: history ASA 29.6 min vs 6.9 min. Gates were re-checked before adoption — the verified figures are just not stored. | Headcount: no. **What the planner reads: yes**, two different SLA figures for one recommendation. Only with shift placement ON (opt-in). | `hc-search.ts:3559-3607` (`:3606`), `:3720-3733`, `:3802`; `ResultsFlow.tsx:222`; same in sync |
| HC-16 | minor (read from code, not run) | The "at N−1 the SLA was X%" evidence run uses the uniform layout even when the gate rejected the repair layout. | Explanation text only. | `hc-search.ts:3673`, `:3282-3291` |
| HC-17 | **tests gap (major for future safety, no current effect)** | Suites call the sync search ~71 times vs ~28 for async — the planner runs async. No test compares full result objects between the two; existing parity checks compare `recommendedHC` only on 3–4 pooled fixtures. A future drift would not be caught. | No today. | `verify-sizing-fixes.mts:2151`, `:2267`, `:3128-3133`, `:3163` |

Confirmed clean: a 5-replication probe is never accepted without a full-R confirmation; cap/iteration limit returns `recommendedHC = null` + `isInfeasible`; cancellation throws, no partial result; no `Math.random`/`Date.now`. Non-monotone pass/fail: result is "passing N with N−1 failing", already documented in PRD.

### Step 10 — `hc-search.ts:213-1299` (shift placement, coverage repair, roster polish)

| ID | Severity (my verdict) | Finding | Changes planner numbers? | Evidence |
|---|---|---|---|---|
| HC-14 (second opinion) | **blocker for 24x7 with a short SLA window; confirmed by an independent auditor with own scripts** | Exact trigger: 24x7 calendar + Min-coverage ON (default) + SLA window shorter than about a day (default is 6 h) + demand continuing past the first shift length of the day. All 32 coverage-ON runs returned no recommendation; coverage OFF gave 20–32 HC at 98–100% SLA. Repair layout for 8 h shifts is always `0:N−2, 480:1, 960:1` — SLA 33% at N=24, 55% at N=100 (occupancy 24%), so it can never reach 80%. A hand-built even three-way split passes at N=24 (95.8%, coverage 8). The search tries only uniform, then repair — no third layout. No UI setting helps (more shift starts, Shift Placement ON: same result). A 24 h+ SLA window avoids it, which is why D36/D37 (4-day SLA, demand in hours 0–10) pass. The DES midnight-resume defect (DES-8) does **not** contribute. PRD says the opposite: lines 400–409 and 421–423 call P0-4 closed and 24x7 coverage repair working. | **Yes — no recommendation at all**, plus advice ("Increase userMaxHC") that can never work. | `hc-search.ts:667-680`, `:733`; `PRD.md:400-423`; `verify-sizing-fixes.mts:2226-2248`, `~:2330-2342`; scratchpad `p1/p2/p3.mts` |
| HC-18 | minor (display) | The infeasibility message shows the uniform layout's "0 agents on shift" even when the layout that finally failed was the repair one, on SLA. | Message only — points the planner at the wrong cause. | `hc-search.ts:740-748` |
| HC-19 | minor (read from code, not run) | Coverage profile samples presence at bucket start only; a 7.5 h shift on a 60-min grid counts as present for the whole last bucket → coverage slightly overstated in the polish comparison (non-24x7, placement ON). | Roster choice within a fixed HC only. | `hc-search.ts:887` |
| HC-20 | question for owner | On 24x7 with no shift distribution ("uniform"), agents are not shift-bounded in the simulation — they can work at any hour up to their daily budget. So the Min-coverage-OFF 24x7 result assumes round-the-clock availability from a pool that, by the presence rule, is on shift only 0–8 h. Confirm this is the intended meaning of a 24x7 recommendation with coverage OFF. | Possibly under-states 24x7 need when coverage is OFF. Not verified — needs its own test. | step 10 report; `des-engine.ts` staggered-mode switch |

Clean: seat counts always sum to N; no negative/duplicate/out-of-range offsets; placement greedy and repair are monotone in N; interpolation and both K-search state machines deterministic; tolerances used on floats; no `Math.random`/`Date.now`.
