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
| 11 | Final challenger | done | pass with corrections; 3 follow-up probes run |

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

### Step 11 — final challenger + follow-up probes

Challenger verdict: **pass with corrections** — the list is a usable basis for a fix plan. My rulings:

| Challenge | Ruling |
|---|---|
| HC-14 "blocker" overstated; surplus-at-offset-0 is documented design D33 (`docs/wfm/07-known-defects-and-decisions.md:413`, `project_context.md:421`), not a frozen decision | **Accepted.** HC-14 stays the top item but is reworded: a gap in a feature the PRD calls closed. Any fix reverses D33 for 24x7 and must regression-check non-24x7. Challenger reproduced it independently (third reproduction). Default SLA window confirmed 6 h (`default-config.ts:36`). |
| HC-20 undermines the HC-14 workaround | **Tested, mostly refuted for flat demand.** Probe A: with coverage OFF the 24x7 recommendation (24 and 6) still passes on a real even three-shift roster (SLA 96.7% / 98.7%), gap 0%. Not tested for peaky/overnight-heavy demand. HC-20 downgraded to a docs gap + one untested case. |
| HC-1 "right answer is 13" is an inference; PRD states no tie rule (`PRD.md:892`) | **Accepted.** HC-1 + HC-5 merged into one "rounding tolerance" item; severity = owner call (minor–major). |
| HC-3 is a documented deliberate floor (`hc-search.ts:1578-1582`, D40) | **Accepted.** Downgraded to owner decision + docs gap (L14 does not mention the floor). |
| HC-4 wording: only `categories` and `simParams` are raw on import (`App.tsx:450-451`); `sla` is sanitised (`:435-447`) | **Accepted.** Reworded. |
| DES-8: HC-level impact unproven; midnight history relates to BUG-D (`07-known-defects...:131-132`) | **Accepted.** Stays major; impact stated as "1–3 SLA points near saturation, at most about ±1 HC, unproven". Fix must not regress BUG-D. |
| HC-17 is not a major | **Accepted.** Downgraded to minor (tests gap). |
| Missed areas | Logged below as "not audited". |

Follow-up probes (tester):
- **Probe B — siloed 24x7:** HC-14 also hits siloed mode (6 h SLA, coverage ON → no recommendation). With a 24 h SLA it works (31 HC vs 24 coverage OFF). New minor **HC-21:** the smallest category (5% share, 2 seats) gets no shift distribution, so per-category coverage is not enforced for it — only the org-level check (`shiftDistributionUsed` had keys A and B only).
- **Probe C — Workload Floor OFF:** no violation on 4 datasets; floor OFF never went below max(N_min, N_occ); `belowWorkloadFloor` correctly false; occupancy ≤ 100%.
- **Docs:** `PRD.md:790-791` ("24×7 … still zero staggering pending a separate multi-start increment") is stale against `PRD.md:402-408`.
- **UNRECONCILED — check first in phase 2:** step 9 reported the claims sample recommending 19 HC "with defaults"; step 4 and Probe C report claims `N_min` = 30 and recommendation 31. Most likely different inputs (anchor date / labor config) between the two scripts, but a 19 below an `N_min` of 30 with the floor ON would breach frozen decision 4, so it must be ruled out by one run.

## Final ranked list (phase 1)

| Rank | ID | Severity | What the planner experiences | Product or internal? |
|---|---|---|---|---|
| 1 | HC-14 | **major — top priority** (blocker for 24x7 + sub-day SLA) | No recommendation on 24x7 with default coverage rule and default 6 h SLA; advice shown cannot work | Product |
| 2 | DES-8 | major | 24x7: paused case waits to midnight though another agent is free; SLA 1–3 points low near saturation; may over-staff ~1 | Product |
| 3 | HC-15 | major (display) | With Shift Placement ON, Results show CI/median for a roster that was not the one adopted (82.6% vs 80.2%) | Product (display) |
| 4 | HC-1 + HC-5 | owner call (minor–major) | Gross HC / `N_min` 1 seat low at exact ties due to float noise; depends on category order | Product |
| 5 | HC-4 (+HC-6, HC-11) | major on import path only | Hand-edited/imported config with bad `categories`/`simParams` gives ×100 or silently-unshrunk Gross HC, no warning | Product (import) |
| 6 | DES-12 | minor, cheap | Gates compare values rounded to 0.1 twice; up to ~0.1 point lenient | Product (marginal) |
| 7 | HC-3 | owner decision + docs | Extra-OFF uplift floored before gross-up: up to ~1 gross seat low; deliberate per code comment | Product (by design?) |
| 8 | HC-9 | minor | Replications = 1 silently drops the CI gate | Product (if chosen) |
| 9 | DES-1 | major only for fractional-volume uploads; zero on all current files | Sub-0.5 interval volumes vanish from simulation | Product (conditional) |
| 10 | HC-17, DES-13 | minor | Tests mostly exercise the sync search; invariant checker has gaps | Internal |
| — | CAL-1..4, DES-2..7, DES-9..11, DES-14, HC-2, HC-7, HC-8, HC-10, HC-12, HC-13, HC-16, HC-18..21 | minor / question / docs | See tables above | Mostly internal |

Frozen decisions verified as holding in code: 2 (EDF, heap = harness ordering), 3 (occupancy), 4 (floor via `resolveSearchBounds`), 5, 6, 7 (shrinkage chain), 8 (CI gate, for R>1), 9 (CRN), 10 (Webster monotone), 11 (presence). Decision 1 (no Erlang) not separately checked.

## Not audited in phase 1 (carry forward)

- Siloed mode end to end with recomputed numbers; staggered non-24x7 shifts (not fuzzed); opening-WIP paths (DES-7 open question).
- Holidays inside the 14-day drain window of the engine (DES-10).
- ASA gate and occupancy-cap-ON paths — code reading only, not run.
- Peaky / overnight-heavy 24x7 demand with coverage OFF (HC-20 residue).
- `UAT_BO.xlsx`, `test_breaks.xlsx` — no loader.
- `src/types/wfm.ts`, `agent-analytics.ts`, `export-rows.ts` → phase 2.
- Whether the UI can produce degenerate calendars (CAL-2) → phase 3.

## Usage

Weekly meter: 6% at start → 9% after step 11 and probes. Cap 20% respected.

# Phase 2

Meter at phase start: 9%. Challenger on the phase 2 plan: fail -> plan re-cut (all accepted, see `PLAN.md`).

### P2-0 — F0 reconcile claims 19 vs 31 (tester) — PASS, closed

- Explained by inputs: the phase 1 parity script built categories without the claims defaults (every category 30 min AHT) -> `N_min` 18, `N_occ` 19, recommended 19. The UI path (`discoverAndSyncCategories` with `DEFAULT_CATEGORIES`) gives `N_min` 30, `N_occ` 31, recommended 31, gross 40.
- No floor breach: `recommendedHC >= max(N_min, N_occ)` held in all 18 runs, sync = async in every one. Frozen decision 4 holds.
- P2-N1 (minor): `buildSampleDataset` says its anchor "must be a Monday 08:00" but does not enforce it; a Saturday/Wednesday anchor gives 59/56 HC instead of 31. The UI always passes a Monday (`App.tsx:214`), so only scripts/tests can hit it. Evidence: `sample-data.ts:124-129`.

### P2-5a — siloed, occupancy cap ON, BO ASA gate ON (tester, each number recomputed a second way)

| ID | Severity (my verdict) | Finding | Changes planner numbers? | Evidence |
|---|---|---|---|---|
| P2-A2 | **major — same root as HC-14, now shown on ordinary business-hours calendars** | Whenever the shift is shorter than the open day, the search evaluates the minimal coverage-repair roster: everyone starts at open except `minAgentsPerInterval` agents (default 1) at a late start. With the ASA gate ON this roster, not headcount, sets the wait: support sample N=30 → ASA 92.6 min on the repair roster vs 60.6 min on a uniform roster. ASA targets 45/60/75/90 min need 64/46/36/31 HC; uniform ASA at N=34 is already 53 min. With `asaClockBasis = clock_hours`, targets 150 and 90 min are **infeasible up to N=100** (99 agents at open, 1 at +150 min → ASA 224 min; uniform at N=100: 15 min). Message again says "Increase userMaxHC". | **Yes — over-staffs heavily, or no recommendation**, when the ASA gate is ON (opt-in, normal UI setting). Fix belongs with F1 (repair layout should spread surplus). | scratchpad `p3c.mts`, `p3e.mts`; `hc-search.ts:649-700` |
| P2-A3 | major (display) — worse than L15 documents | Binding-constraint label is wrong whenever the ASA gate binds: N−1 fails only on ASA, yet the result says `statistical_primary_sla` / "Primary SLA 80% Target". The `bo_asa_cap` branch tests the passing result's `passesBOASA`, which is always true, so it is unreachable. | Display only — planner is told the wrong reason for the headcount. | `hc-search.ts:~2902`, `:~3710`; targets 90/75/60/45 all mislabelled |
| HC-16 (upgrade) | **major (display)** — was minor, now confirmed by run | The N−1 "boundary evidence" run uses the uniform roster while the search gated on the repair roster. Support, ASA target 90: evidence shows N=30 with ASA 60.7 min "failing" and N=31 at 88.5 min passing — reads as if adding an agent made the wait worse. | Display only — evidence panel contradicts the gate. | `hc-search.ts:3673`; scratchpad `p3e.mts` |
| P2-A1 | owner question (pinned by test D45.2, not a frozen decision) | Pooled needs **more** HC than siloed on two samples: support 28 vs 21, healthcare 31 vs 27 (claims 31 = 31). In pooled mode equal-deadline cases are served in category-priority order, so the lower-priority category is starved (Technical_Escalations 77.2% at N=21 while Billing is 100%) and the per-category gate forces extra heads. Overall SLA is identical in both modes. | Yes — pooled recommendation is 15–33% higher than siloed on these samples. Intended? If yes, document; if no, tie-break needs a decision. | scratchpad `p1c.mts`; `verify-sizing-fixes.mts` D45.2 |
| P2-A4 | minor (docs) | Apportionment is Webster **after a guaranteed 1 seat per category** (differs from pure Webster only for tiny categories). CLAUDE.md decision 10 does not mention the 1-seat guarantee. | No. | `des-engine.ts:464` |

Matched an independent recompute exactly: siloed seat split for N=28..34 (7/7, plus a 0.86% category); isolation (0 wrong-category assignments in ~1,450 per N); per-category and overall SLA; all primary deadlines; `N_occ` on 10 cap/adherence combinations; reported occupancy vs handled minutes ÷ planned capacity (10/10, adherence applied once); CI upper-bound gate at rec and rec−1; mean ASA from per-case records (5 targets); monotonicity of HC in cap and in ASA target.

### P2-3 — `csv-parser.ts:1-535` (raw parsing, column mapping, dates; run under UTC, New York, Dubai)

| ID | Severity (my verdict) | Finding | Effect on the planner | Evidence |
|---|---|---|---|---|
| CSV-1 | **major** | Timestamps with `Z` or an offset are shifted into the machine's timezone. `2026-03-04T08:30:00Z` lands at 08:30 on a UTC machine, 12:30 in Dubai, 03:30 in New York; `…+04:00` lands on the **previous day** in New York. PRD FR-1.3 says `Z`/offsets are accepted but not that they shift. | **Demand silently lands on different intervals/days** depending on the PC. Reachable with any system/BI export in ISO-UTC. | `csv-parser.ts:431-451`; not tested |
| CSV-2 | **major** | Ragged rows and duplicate headers are mangled without warning: a short row shifts cells (volume becomes 0); extra cells are dropped; two `Volume` columns → the second silently overwrites the first. | **Wrong numbers or lost data, no warning.** Normal file with one missing delimiter. | `csv-parser.ts:148-157`; not tested |
| CSV-3 | **major** | An unterminated quote (e.g. a category named `5" screen`) swallows the rest of the file into one cell — 1 row loaded, no error. | **Rows lost silently.** | `csv-parser.ts:77-95` |
| CSV-4 | **major** | Comma-decimal volumes are read ~10× too high with no warning: `12,5` → 125; `1.234,5` → 1.2345. (Consumer at `:~598`; confirm in P2-4.) | **Wrong volumes silently** for European-locale files (semicolon delimiter). | `csv-parser.ts:~598` |
| CSV-5 | major (unusual file) | A title row above the header is not detected: the real header becomes data; no error from the parser. | Garbage or defaults; DQ may flag bad dates later. Common in BI exports. | `csv-parser.ts:144-145` |
| CSV-6 | major (unusual file) | Pipe-delimited file loads as one column; volume parsed as 2026 from the date text; no error. | Wrong numbers silently. | `csv-parser.ts:58-64` |
| CSV-7 | major (user error path) | A binary `.xlsx` (renamed, or accept-filter bypassed) loads as 55 garbage "intervals" with volume 0; no binary check in the upload handlers; `App.tsx:182-190` then syncs categories from it. Downstream DQ not yet checked. | Confusing garbage dataset instead of "this is not a CSV". | `csv-parser.ts:28-160` |
| CSV-8 | minor | Other cells read as numbers silently: `30 min` → 30, `12abc` → 12, `1e3` → 1000, `0x10` → 0 with no warning. | Rare. | P2-4 slice |
| CSV-9 | minor | Compact datetimes misread as Unix epoch: `202603040830` → 1976; `20260304083000` → year 2612; `20260304` rejected. | Unusual file; valid-looking wrong dates. | `csv-parser.ts:405-409` |
| CSV-10 | minor | Separate time column ignored when the date cell already carries `T00:00:00`; hours-only offset `+04` accepted but ignored (while `+04:00` is applied). | Unusual file. | `csv-parser.ts:413-454` |
| CSV-11 | minor | A local time inside a DST gap (`2026-03-08 02:30` in New York) is rejected as invalid — machine-dependent. | Row lost with a bad-date warning, only on DST-zone machines. | `csv-parser.ts:369-379` |
| CSV-12 | minor | Auto-mapping picks wrong defaults on some headers (`Actual AHT` → volume; `Service Level` or `Day Type` → category; `Due Date` before `Created Date`). Planner can correct on the mapping tab. | Wrong silent default. | `csv-parser.ts:192`, `:222-271` |

Clean: comma/semicolon/tab detection; quoted delimiters and newlines; `""` escapes; BOM; CRLF/LF/CR; empty and header-only files; leap years and impossible dates; AM/PM; dd/mm applied consistently per file and US `MM/DD` with day > 12 rejected as documented (L9); no `Date.now`/`Intl`. Not accepted (rejected as invalid, not a defect): `04-Mar-2026`, `Mar 4 2026`, `20260304`, Excel serials.
Baseline: all four `test_files/*.csv` parse fully (2976 / 7440 / 4464 / 4464 rows), zero bad dates, zero volume issues.

### P2-4 — `csv-parser.ts:536-1121` (interval mapping, category sync, data-quality rules) + independent verification of the two blockers

| ID | Severity (my verdict) | Finding | Effect on the planner | Evidence |
|---|---|---|---|---|
| CSV-13 | **BLOCKER — confirmed by a second, independent full-search run** | **Opening backlog pulls the planning horizon back to the oldest case's arrival date.** Empty working days before the data then count as fully staffed capacity in `N_min`, occupancy and the simulation. Clean week: 5 days, `N_min` 15, recommended 16. Add ONE backlog case 14 days old: 15 days, `N_min` 5, recommended 14, occupancy 37%. Add 50 such cases (more work): still 14. With a 3-day SLA window (typical deferred work): **16 → 9 (−44%)**, gross 20 → 11. Even backlog dated the previous working day: recommended 14 where ~17 is needed. Data quality says "passed"; only a generic "Coverage Gap" warning. Not documented anywhere as intended. | **Yes — under-staffs, up to −44%, on a core feature (opening backlog) with a realistic input.** The default 6 h SLA masks most of it (16 → 14); longer SLA windows do not. | `calendar.ts:499-513`; duplicated at `hc-search.ts:2395-2412` and `ConfigFlow.tsx:70-85`; `csv-parser.ts:895`, `:934-955`; WIP arrival accepted from import or manual form with no bound (`DemandFlow.tsx:222-236`, `:288-301`); scratchpad `hz_run.mts`, `dq_c.mts` |
| CSV-14 | **BLOCKER (typo path) — confirmed the same way** | One stray date stretches the horizon: one row dated 2062 → 9,240 working days, `N_min` 15 → 1, recommended 16 → 14, **occupancy shown as 0.1%**; a row only 2 months out → 46 days, occupancy 12%. No date-span guard anywhere in the UI. Same root cause as CSV-13. | Yes — under-staffs and shows nonsense occupancy; passes data quality. | `calendar.ts:499-502`; scratchpad `hz_run.mts` |
| CSV-4 (confirmed) | **major** | Comma-decimal volumes silently wrong: `12,5` → 125, `1,5` → 15, `1.234,5` → 1.2345. The regex treats the comma as a thousands separator and suppresses the warning. Only `12,500` is tested. | Yes — up to 10× volume → over-staffs. European/Egyptian-locale exports. | `csv-parser.ts:608-621`; `verify-fixes.mts:2597-2651` |
| CSV-15 | **major — PRD promise unmet** (worse than backlog item P2-5 states) | The 30-minute interval rule (L8, FR-2.2 #6) can never fire: with no interval-end column in the UI the end is always start + 30 min. 15-minute, hourly and off-grid (08:07) data all pass with zero issues. Hourly data loads with every second slot empty. | Total volume kept; intra-day arrival shape wrong; a rule the PRD calls blocking does nothing. | `csv-parser.ts:633-640`, `:813-816`, `:874-880` |
| CSV-16 | **major** | Category names that differ only by case/space become separate categories (`Billing`, `billing `, `BILLING` → three), each on fallback AHT 30 / shrinkage 20% and its own silo; an empty category cell creates a phantom `General`. No warning. | Yes — workload split across phantom silos with wrong AHT. Normal messy file. | `csv-parser.ts:597-600`, `:647`, `:679-702` |
| CSV-17 | **major** — contradicts L5 ("prevents silent understatement") | Categories on fallback values (AHT 30 min, shrinkage 20%) are never flagged: the "Category Config" error is unreachable, so the planner is not told which categories still carry defaults. A data category named like a built-in (`Claims_Auto`) silently inherits that built-in's AHT. | Yes — wrong AHT → wrong workload, either direction. | `csv-parser.ts:715-727`, `:966-972`; `RunFlow.tsx:78` |
| CSV-8 (confirmed) | major | Cells that merely start with a number pass silently: `30 min` → 30, `12abc` → 12, `0x10` → 0, `5%` → 5, `1e9` → 1,000,000,000 (no sanity cap; passes data quality). | Wrong numbers silently on dirty data. | `csv-parser.ts:608-610` |
| CSV-18 | minor (misleading) | Row numbers in data-quality messages refer to the sorted order, not the file — a bad first row is reported as "row 5". | Planner looks at the wrong row. | `csv-parser.ts:653-662`, `:791`, `:798` |
| CSV-19 | minor | Coverage Gap warning lists dates one day early on machines east of UTC (`toISOString` on local midnight) — hand-rolled date handling. | Cosmetic; affects every UTC+ planner. | `csv-parser.ts:941` |
| CSV-20 | minor | CSV exports do not neutralise cells starting with `=`, `+`, `-`, `@`; a category named `=HYPERLINK(...)` becomes a live formula in Excel. | Security hygiene. | `csv-parser.ts:1072-1076` |
| CSV-21 | minor | Category IDs embed `Date.now()` — non-deterministic IDs (no effect found on results). Breaks the determinism rule. | No. | `csv-parser.ts:716` |
| CSV-22 | minor | NaN remaining work on a backlog case → total workload NaN with `passed = true` (Run page gate still blocks). Mid-day gaps never reported. | Unusual. | `csv-parser.ts:1014-1018` |

Does data quality catch the P2-3 issues? Comma decimal: **no**. `30 min`/`12abc`/`1e3`/`0x10`: **no**. Ragged row: **no** (volume 0 + phantom `General`). Binary `.xlsx`: **blocked** but with a generic "Upload and map an inflow file" (CSV-7 downgraded to minor: message quality). Title row above header: **blocked**, message points at timestamps (CSV-5 downgraded to minor). `Z` timestamps shifted: **no** — only the >15% off-hours diagnostic may fire, without naming timezone.

PRD FR-2.2 rule check (18 rules): 2 can never fire (#6 Interval Length, #8 Category Config); duplicates are correctly **blocked** (not summed); zero-workload, orphan-backlog, timestamp errors fire and block; no rule is computed and hidden.
Clean: backlog ID generation deterministic; duplicate detection; zero-denominator guards; no ghost categories; export quoting and BOM.

### P2-1 — test strength A: mutation test of staffing maths, calendar, apportionment (tester, scratch copy)

Method: each frozen rule broken on purpose in a copy of the repo; a rule is protected only if a test then fails. Harness proven by a gross mutation (51 failures). Baseline in the copy: 174 / 518 / 164 / 60, all green.

| Mutation | Rule broken | Caught? | By |
|---|---|---|---|
| M1 single round → ceil | decision 7 | yes | D43.13 (11 assertions) |
| M2 per-category rounding | decision 7 | yes | D43.13, D45.2 (6) |
| M3a/b arithmetic blend (display, or display + total) | decision 6 | yes | D7.10, D10.15, D40.6 (3) |
| **M3c arithmetic blend in the Gross HC total only** | decisions 6–7 | **not by `npm test`** | only `verify-trusted-source` (T1_A2a, T1_A2c) — which `npm test` does not run |
| M4 shrinkage in Stage 2 | decision 5 | yes | D12.x, BUG-OCC-ROOT (38) |
| M5 occupancy denominator widened | decision 3 | yes | BUG-OCC-ROOT (25+) |
| M6 occupancy clamped at 100 | decision 3 | yes | Suite 26, BUG-OCC-ROOT (13) |
| M7 inclusive day bound | calendar half-open | yes | D1.4, D1.5 (3) |
| M8 Webster → Hamilton | decision 10 | yes, **by one assertion** | D3.1 only |
| M9 / M9b floor ignored | decision 4 | yes | D47.0a/b/d, D47.2, D42.10–12 |
| M10 `N_min` floor → ceil | documented | yes | D11.4–6, BUG-J (27) |
| M11 `N_occ` ceil → floor | — | yes | D42.12–13, D49.1a |
| M12 extra-OFF floor removed | — | yes | D40.1, D40.2b |

| ID | Severity (my verdict) | Finding | Effect | Evidence |
|---|---|---|---|---|
| TEST-1 | **major (tests)** | The Gross HC total can be switched to an arithmetic-blend formula and all 752 checks in `npm test` still pass (518 + 174 + 60). Only the trusted-source suite catches it, and `npm test` — the documented gate — does not run that suite. Existing checks pin only the *displayed* effective shrinkage. | Internal: frozen decisions 6–7 are unprotected at the gate the project actually runs. Two cheap fixes: add `test:trusted-source` to `npm test`; add one mixed-shrinkage total assertion (10% + 40%, HC 20 → 28, arithmetic would give 27). | M3c: sizing 518 passed, verify-fixes 174 passed, trusted-source 2 failed |
| TEST-2 | minor (tests) | Webster apportionment is protected by a single assertion (D3.1, monotonicity sweep); no direct pin of a seat table. | Internal. | M8: 1 failure |
| TEST-3 | minor (tests) | `verify-sizing-fixes` takes ~3.5 min alone and exceeded 400 s under parallel load. | Internal (CI timeouts). | exit 124 on M9b, M11 |

All kills were behavioural (a computed number changed) — none relied on a source-text grep. 12 of 13 mutations are caught by `npm test`.

### P2-6 — offline contract, conventions, build guards (investigator; greps and reads only)

**The contract itself holds.** `src/`, `index.html`, `index.css` and the Vite configs: no network primitive, no external asset, no storage/env read, no `Math.random`; the only `console.*` is a genuine `console.error` (`App.tsx:307`). Shipped `BoWFM.html`: only allowed identifier URLs (w3.org namespaces ×19, `react.dev/errors/` ×2, `tailwindcss.com` ×1); zero `XMLHttpRequest`/`WebSocket`/storage/`sourceMappingURL`/`<link>`/`<script src>`/`@import`/`@font-face`/`url(`. One `fetch(` exists — Vite's modulepreload polyfill, dead because the build strips every modulepreload link. No secrets found in the repo.

| ID | Severity (my verdict) | Finding | Effect | Evidence |
|---|---|---|---|---|
| OFF-1 | **major (guard)** | The artifact gate (`npm run check:artifact`) compares file modification times only — no content hash. After a fresh clone or `git checkout` every file has the same time, so it passes whether or not `BoWFM.html` matches the source; touching the HTML also passes. It also does not watch `package-lock.json` or `tsconfig.json`. | Internal, but this is the gate the Definition of Done relies on: it cannot prove the shipped file was built from the committed code. | `scripts/check-artifact-freshness.mts:11-17`, `:30`, `:43-63` |
| OFF-2 | major (rule breach, internals only) | `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite` sit under `dependencies`; the project rule says build tools are dev-only and `dependencies` is closed. Nothing wrong reaches the bundle. Suite D9 does not enforce the rule: it bans five named packages and checks `react` is present — any new runtime dependency would pass. | Internal. The "closed dependencies" rule has no working guard. | `package.json`; `verify-sizing-fixes.mts:688-694` |
| OFF-3 | major (guard) | Suite D9 covers less than CLAUDE.md implies: no check for `Math.random`, `Date.now`, or calendar-only time math; `console.log` checked only under `src/utils`; D9.12–14 only test that the guard's *message text* exists in the build script (a comment would satisfy them); source scan would miss `window['fetch']`, `import('https://…')`; artifact URL check is case-sensitive and its `tailwindcss.com` allow-entry has no boundary. | Internal — weaker protection than documented. | `verify-sizing-fixes.mts:627-725` |
| OFF-4 | minor (guard) | Build-guard CDN regex lists only `cdn`, `unpkg.com`, `jsdelivr`; would miss `googleapis`, `gstatic`, `cloudflare`, `esm.sh`, remote `url()` / `@import` / in-JS URLs. Not reachable today (Vite inlines everything; D9.9 backstops at test time). | Internal. | `scripts/build-standalone.mts:63-67` |
| OFF-5 | minor | Wall-clock `new Date()` can become a backlog case's arrival when the typed date is unparseable and no data is loaded (`DemandFlow.tsx:237`, `:296`, `:301`) — feeds the simulation. More hand-rolled date maths in the engine outside `calendar.ts`: `des-engine.ts:866-867`, `:1120`, `:1173`; `hc-search.ts:3056`. | Rare input; determinism/convention breach. | lines cited |
| OFF-6 | minor (docs/strays) | `npm test` omits the trusted-source suite and no doc says so; check counts disagree across docs (PRD 856, `project_context.md` 251 and 613; actual 916). `package.json` name is still `react-example`; `clean` script references a removed `server.js`; `test.mts` and `test_complaint.csv` are tracked but unreferenced; `.env.example` carries an empty `GEMINI_API_KEY=`; `metadata.json` stale capability (known P1-5). | Docs/internals. | `PRD.md:1115-1124`; `project_context.md:78`, `:849` |

Note for the owner: `.claude/hooks/auto-push.mjs` is a Stop hook in this repo that copies changed files to the `auto/agent-updates` branch and pushes it to GitHub. The audit branch itself has not been pushed (remote has only `main` and `auto/agent-updates`, last auto-sync 2026-09-30), but that hook may publish `PLAN.md` / `FINDINGS.md` when a turn ends.

### P2-2 — test strength B: mutation test of simulation and search rules (tester, scratch copy)

Harness re-verified (gross mutation → 84 failures). 21 mutations run, none skipped. "Caught" means a check in `npm test` failed.

| Mutation | Rule broken | Caught? | By |
|---|---|---|---|
| **B1 EDF → FIFO (order by arrival)** | decision 2 | **NO — all 916 checks green** | — |
| **B1b deadline order reversed (latest first)** | decision 2 | **NO** | — |
| **B2 `latestSafeStart` by wall-clock instead of business calendar** | decision 2 | **NO** | — |
| B3 presence needs remaining budget | decision 11 | yes | D36.x, D37.4, BUG-OCC-ROOT (31) |
| B4 SLA gate uses mean, not CI lower bound | decision 8 | barely — 1 unrelated assertion | D52.1c (a roster-polish check) |
| B5 SLA gate uses CI upper bound | decision 8 | barely — same 1 assertion | D52.1c |
| **B4b per-category gate uses mean** | decision 8 | **NO** | — |
| **B4c occupancy gate uses mean** | decision 8 | **NO** | — |
| **B4d ASA gate uses mean** | decision 8 | **NO** | — |
| **B6 Common Random Numbers broken (seed depends on N, case sets regenerated)** | decision 9 | **NO** | — |
| B7 floor opt-out ignored | decision 4 | yes | D47.0c, D47.2a–e (6) |
| B8 / B8a `belowWorkloadFloor` never set (both / async only) | decision 4 warning | yes | D47.2c / D47.3a (1 each) |
| B9 / B9a answer + 1 (both / async only) | smallest passing N | yes | Suite 29, BUG-R, D34.4, D36.5, D42.10 (20–41) |
| B10 async-only seed constant changed | sync = async | narrowly | D50.9d, D51.2f, D52.2c (roster-polish parity only) |
| B11 async-only polish adoption skipped | sync = async | yes | D50.3, D50.9d, D51.x (5) |
| B12 occupancy cap gate always passes | cap gate | yes | BUG-OCC-CAP, D26.2 (4) |
| **B13 volume `round` → `floor`** | L1 | **NO** | — |
| B14 opening backlog ignored | backlog | yes, by one test that crashes the suite | BUG-B |
| **B15 unfinished cases dropped from the SLA denominator** | SLA maths | **NO** | — |

| ID | Severity (my verdict) | Finding | Effect | Evidence |
|---|---|---|---|---|
| TEST-4 | **major (tests)** | **Dispatch order is not tested at all.** Switching the simulator from Earliest-Deadline-First to first-in-first-out, or reversing the deadline order, or computing `latestSafeStart` by wall-clock, changes no result in any of 916 checks (including the hand-traced trusted-source scenarios). | Frozen decision 2 has zero protection. Also means every fixture is insensitive to dispatch order. | B1, B1b, B2 |
| TEST-5 | **major (tests)** | **Confidence-interval gating is almost untested.** SLA gate: one incidental assertion. Per-category, occupancy and ASA gates: nothing. Replacing the CI bound with the mean passes everything. | Frozen decision 8 effectively unprotected. Cheap fix: call `computeStatisticalEvaluation` directly with samples [78,82,80,79,81] vs target 80 — mean passes, lower bound must fail. | B4, B4b, B4c, B4d, B5 |
| TEST-6 | **major (tests)** | **Common Random Numbers is untested.** Seeding per candidate N and regenerating arrivals passes everything. | Frozen decision 9 unprotected. | B6 |
| TEST-7 | **major (tests)** | "Unfinished cases count as SLA failures" is untested — excluding them (which would inflate SLA % for under-sized teams) passes everything. | An under-staffing bug of this kind would ship silently. | B15 |
| TEST-8 | minor (tests) | Volume rounding rule, opening-backlog generation (1 test), and async seed parity (3 roster-polish assertions) are thinly covered. | Internal. | B13, B14, B10 |

Well protected: presence rule (decision 11), workload floor and its opt-out/warning (decision 4), smallest-passing-N incl. async-only, occupancy cap gate, polish adoption parity.

**Combined result of P2-1 + P2-2 — frozen decisions vs `npm test`:** protected: 3, 4, 5, 7, 10 (one assertion), 11, calendar half-open. Unprotected or barely protected: **2 (EDF), 8 (CI gate), 9 (CRN)**, and the Gross HC total under 6–7 (TEST-1).
