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

### P2-5b — staggered shifts, holidays, uneven 24x7 demand, backlog dispatch order (tester; every figure tallied independently)

| ID | Severity (my verdict) | Finding | Effect on the planner | Evidence |
|---|---|---|---|---|
| HC-20 (upgrade) | **major — was a question; now measured** | 24x7 with Min-coverage OFF: the simulation lets agents work at any hour, so the recommendation assumes a perfectly flexible roster. Flat demand: fine (phase 1). **Uneven demand: under-states.** 70% of demand at night: recommended 20; on a real even three-shift roster N=20 gives SLA 67.5% (needs 22, +10%). 90% at night: recommended 20; even roster 45.9% (needs 28, **+40%**); even a demand-matched roster needs 23 (+15%). Nothing in the UI says the number assumes agents can work at any hour. | **Yes — under-staffs 24x7 teams** when coverage is OFF and demand is uneven. Together with HC-14 (coverage ON → no answer) this leaves 24x7 + short SLA without a trustworthy number. | scratchpad `q_p3.mts`; `des-engine.ts:953`; `ConfigFlow.tsx:1107-1111` |
| DES-10 (upgrade) | **major — was minor** | The drain window after the horizon is a fixed 14 calendar days. If those days are mostly closed (holidays), cases still **inside** their business-time deadline are cut off and counted as failures. End-loaded demand, 5-business-day SLA, 8 holidays after the horizon: recommended HC 12 vs 8 without the holidays (+50%); 6 vs 4; 4 vs 3. All 184 failures at the no-holiday HC were not-yet-due cases. Flat demand: no effect. | **Yes — over-staffs** around holiday periods with multi-day SLAs and month-end peaks. | `des-engine.ts:829`, `:1954`; scratchpad `q_p2b2.mts` |
| DES-7 (upgrade) | **major — owner design call** | Opening-backlog cases with remaining work below the category AHT are treated as "parked" and served before every new case regardless of deadline. Manual backlog defaults to 30 min remaining while default AHTs are 35/45/60 — so **default backlog is always "partly worked"**. Measured: new-case SLA 86.7% vs 93.3% (−6.6 points); with a 30-case backlog the recommendation is 2 heads vs 1. Docs state "parked cases first" (`docs/wfm/06-simulation-des.md:43-44`) but not that opening backlog counts as parked or outranks tighter deadlines. | Yes — lower SLA for new work, sometimes +1 head. A departure from pure EDF (frozen decision 2) that is only half documented. | `des-engine.ts:187-189`; scratchpad `q_p4.mts` |
| P2-B1 | minor | Wall-clock SLA + "arrival" clock start: every case arriving on a closed day fails by construction (Sat 08:15 → due Sat 14:15, first worked Mon 08:00), so the search reports infeasible. No wrong number produced. | Infeasible flag; planner needs "next open" policy. | scratchpad `q_p2c.out` |

Clean (staggered non-24x7, 40 seeds, pooled + siloed, my own tally from the agent timeline): 0 work before shift start, **0 work past shift end**, 0 budget overruns, 0 overlaps, 0 off-hours work, 0 conservation failures, 0 avoidable park→resume waits (the midnight-wait defect DES-8 is 24x7-only), coverage figure 40/40 equal. Holidays inside the horizon: working days, `N_min`, zero work on the holiday, 32/32 business-time deadlines all match a hand recompute.

### P2-7 — agent analytics, exports, run snapshot, defaults, samples, types (investigator; figures recomputed on pooled and siloed runs)

| ID | Severity (my verdict) | Finding | Effect on the planner | Evidence |
|---|---|---|---|---|
| UI-1 | **major** | **Results go stale silently when opening backlog or column mapping is edited after a run.** The run snapshot holds settings only (calendar, labor, SLA, categories, sim params) — not demand intervals, opening backlog or mapping. Editing/deleting/importing backlog neither clears the results nor shows the "Settings changed" banner; headline HC, SLA and case list still describe the old backlog. PRD FR-9.0 says "every Results figure" uses the snapshot. | Planner reads a headcount that no longer matches the data on screen, with no warning. Normal UI use. | `run-inputs.ts:14-20`, `:35-41`; `App.tsx:262`; `DemandFlow.tsx:268`, `:314`, `:318`, `:460`, `:487`, `:514`; D53 tests cover settings only |
| UI-2 | **major** | **Agent Analytics with a category filter on a pooled run shows wrong occupancy, available, scheduled and utilisation.** Busy time is filtered to the category but idle time is not, so the other category's busy minutes vanish from "available". Support sample, HC 12, filter `Billing_Support`: occupancy 89.5%, available 23,101 — true unfiltered 95.1% and 49,591. Code comment says "keep available/scheduled as recorded"; the code does not. | Wrong numbers in the table, team row, chart and CSV export. Normal UI use. | `agent-analytics.ts:395-399`, `:438-454`; scratchpad `r_analytics.mts`; AA.18 checks only that busy drops |
| UI-3 | **major (labels + wrong PRD text)** | Same agent, same screen, one label, two numbers: Results Fairness table "Occupancy %" = 74.9 (busy ÷ shift window) while Agent summary and Agent Analytics "Occupancy" = 95.2 (busy ÷ (busy + idle)); Fairness "Available" 5,250 min vs Analytics "Available" 4,127. The Fairness figures are numerically the Analytics "Utilisation" and "Scheduled". PRD §5.9 states the opposite relationship. | Misleading labels; no number is miscomputed. Default settings. | `ResultsFlow.tsx:348-351`, `:1853`, `:1865`; `des-engine.ts:2057-2066`; `PRD.md:608-610`; `wfm.ts:111` |
| UI-4 | minor | A category with 0% SLA is displayed as 100% and marked passed (`primaryPct || 100`). Same in the Sensitivity tab. Only when the final result has a 0% category (very low max HC / infeasible). | Wrong, reassuring figure in a failure case. | `ResultsFlow.tsx:1090`; `SensitivityFlow.tsx:353` |
| UI-5 | minor (documented in the panel) | Agent Analytics includes post-horizon drain work: support pooled HC 12 shows 95.1% occupancy while headline occupancy is 174.7% (43% of busy minutes are after the horizon) — an undersized team looks fine in this panel. | Misreadable; the panel does say it is a different measure. | `AgentAnalyticsPanel.tsx:35` |
| UI-6 | minor | Sensitivity tab runs on live settings and data with no stale marker — its base cell can disagree with the Results headline after an edit. Run snapshot is a shared reference, not a deep copy (safe today: no in-place mutation found). | Inconsistent screens after an edit. | `SensitivityFlow.tsx:76-98`; `App.tsx:262`, `:667-678` |
| UI-7 | minor | Support and healthcare built-in samples run entirely on fallback AHT 30 min / shrinkage 20% (names do not match the default categories) and carry 28.6% / 20% weekend volume the cards do not mention; claims card says "~1,200 cases", actual 1,380. Separate from backlog item P2-3. | Samples look tuned but are not. | `DemandFlow.tsx:399`, `:410`, `:421`; `csv-parser.ts:715-727` |
| UI-8 | minor (dead code) | Zero readers: `LaborConfig.shifts`, `ShiftWindow` type, `SAMPLE_TEMPLATES`, `generate30MinInflowCSV`. | No. | `wfm.ts:27-35`, `:55`; `sample-data.ts:8-119` |

Reconciled exactly (pooled HC 12 and siloed HC 21): total busy = engine `totalHandlingMinutes` (47,160); finished cases 1,572; work-share credits sum to 1,572; available, team occupancy and utilisation all equal a hand recompute. No NaN/Infinity/>100%. Results identical under UTC, UTC+4 and London. Exports match the screen (units, rounding, local-time stamps) and read the run's own results. All defaults match the PRD and every fallback literal in the code (no mismatch found).

### P2-8 — final challenger on phase 2 — PASS with corrections (all accepted)

| Challenge | Ruling |
|---|---|
| CSV-13 "blocker" overstated: needs a real old backlog date (default arrival = first interval start, `DemandFlow.tsx:234-235`, `:298-299`); default-SLA effect is −12%, the −44% needs a multi-day SLA | **Accepted.** Re-rated **major — top priority** (under-staffing, passes data quality, core feature). |
| CSV-13 and CSV-14 are one root cause (`computeIntervalHorizon`) | **Accepted.** Merged into one item. |
| Fix must NOT clamp backlog arrival — arrival also drives backlog deadlines (`des-engine.ts:557`) | **Accepted.** Fix = split "deadline clock start" from "capacity horizon" (horizon from demand intervals only) + a date-span guard. |
| HC-20 is a model/expectation gap, not an engine error (headcount for an ideal roster) | **Accepted in part.** Stays major for the missing planner-facing note; engine not described as wrong. |
| P2-A1 category priority is a documented feature (PRD FR-6.3) | **Accepted.** Downgraded to docs item. |
| UI-1: a new demand file and mapping changes DO clear results (`App.tsx:179`, `:210`, `:237`, `:295`, `:303`) | **Accepted.** Narrowed to backlog edits/imports only. |
| DES-7 is a documentation gap, not a frozen-decision change | **Accepted.** Stays major only for the default-backlog consequence. |
| DES-10 realism | Kept **major (seasonal)**: year-end / Eid closures after a month-end peak are ordinary; direction is over-staff. |
| TEST-4 plausible: the deadline comparison is reachable (`des-engine.ts:191-194`); no fixture has two SLA windows where a later arrival is due earlier | **Upheld.** |
| CSV-5/6/7 and CSV-8 rated inconsistently | Fixed below: CSV-5/6/7 minor (blocked or unusual); CSV-8 merged into CSV-4 as major. |

## Final ranked list (phase 2)

| Rank | ID | Severity | What the planner experiences | Product or internal? |
|---|---|---|---|---|
| 1 | CSV-13 + CSV-14 | **major — top priority** | A dated backlog case (or one typo date) stretches the planning horizon; empty days count as capacity; recommendation −12% at default SLA, up to −44% with multi-day SLA; occupancy shown as 0.1–40%; data quality "passed" | Product — under-staffs |
| 2 | P2-A2 (+ HC-14) | major | Minimal coverage-repair roster drives wait time: ASA gate ON → heavy over-staffing or "infeasible at any HC" on ordinary business-hours calendars | Product |
| 3 | CSV-4 + CSV-8 | major | Comma-decimal and dirty volume cells read silently wrong (`12,5` → 125) | Product — wrong input |
| 4 | CSV-1 | major | `Z`/offset timestamps land on different hours/days depending on the PC timezone | Product — wrong input |
| 5 | CSV-16, CSV-17 | major | Case/space category variants split into phantom categories; categories on fallback AHT 30 / 20% never flagged | Product — wrong input |
| 6 | CSV-2, CSV-3 | major | Ragged rows, duplicate headers, unterminated quote: data mangled or lost with no warning | Product — wrong input |
| 7 | UI-1 | major | Results stay on screen, unflagged, after backlog is edited | Product — stale output |
| 8 | UI-2 | major | Agent Analytics category filter (pooled) shows wrong occupancy/available | Product — wrong display |
| 9 | HC-20 | major (missing note) | 24x7 + coverage OFF + uneven demand: number assumes any-hour scheduling; real fixed shifts need +10–40% | Product — expectation |
| 10 | DES-10 | major (seasonal) | Holidays after the horizon turn not-yet-due cases into failures: up to +50% HC | Product — over-staffs |
| 11 | DES-7 | major (design call) | Default opening backlog always outranks new cases: −6.6 SLA points, sometimes +1 head | Product |
| 12 | CSV-15 | major (PRD promise unmet) | 30-minute interval rule can never fire; hourly/15-min data accepted silently | Product — wrong input shape |
| 13 | P2-A3, HC-16, UI-3 | major (display) | Wrong binding-constraint label under ASA; N−1 evidence from a different roster; one label, two occupancy numbers | Display |
| 14 | TEST-1, TEST-4..7 | major (tests) | Frozen decisions 2 (EDF), 8 (CI gate), 9 (CRN), the Gross HC total, and the SLA denominator can be broken with all 916 checks green; trusted-source suite not in `npm test` | Internal |
| 15 | OFF-1, OFF-2, OFF-3 | major (guards) | Artifact gate is time-based only; `dependencies` rule unenforced; suite D9 thinner than documented | Internal |
| — | CSV-5..7, CSV-9..12, CSV-18..22, UI-4..8, OFF-4..6, TEST-2/3/8, P2-A1, P2-A4, P2-B1, P2-N1 | minor / docs | See tables above | Mostly internal |

Clean and proven in phase 2: workload floor never breached (18 runs, sync = async); siloed seats, isolation, per-category SLA, `N_occ`, occupancy, ASA all equal hand recomputes; staggered non-24x7 shifts (40 seeds, 0 violations incl. shift-end); holidays inside the horizon; offline contract in `src/` and in the shipped HTML; defaults vs PRD; exports vs screen; analytics totals.

## Not audited (carry to phase 3)

- All UI components line by line (`ResultsFlow.tsx`, `ConfigFlow.tsx`, `DemandFlow.tsx`, `RunFlow.tsx`, panels, modals) and the shipped `BoWFM.html` driven in a real browser.
- Backlog (WIP) import with a date column against realistic file shapes; Excel-serial / `Z` dates through the UI path.
- Whether the UI can produce degenerate calendars (CAL-2) or duplicate categories.
- Staggered mode stale-event fuzz; Probe 1 on 24x7 and with 3+ categories.
- `UAT_BO.xlsx`, `test_breaks.xlsx` (no loader). `test_complaint.csv` contents not checked for personal data.
- Phase 4: docs vs code line by line.

## Usage

Weekly meter: 9% at phase 2 start → 15% after P2-8. Cap 20% respected.

---

# Phase 3 — UI and the shipped file

Weekly meter at start: 15%. Hard stop 20%; no new audit agent at or above 17%.

### P3-1 — shipped `BoWFM.html` driven in a real headless browser from `file:///` (tester; every number checked against a direct engine run and a hand calculation) — PASS

| ID | Severity (my verdict) | Finding | Effect on the planner | Evidence |
|---|---|---|---|---|
| P3-T3 | **major** | An empty file and a header-only file give no message at all. Empty file: page stays on Upload, no error. Header-only: jumps to Column Map with empty dropdowns, no explanation. Data quality keeps its generic "Upload and map…" text. | Planner cannot tell why nothing happened. Product — input handling (fix with G4). | scratchpad `p3/d_empty.csv`, `p3/e_header.csv`; zero console errors, no error text on screen |
| P3-T2 | minor | Pooled run: Agent Browser category dropdown returns "No agents match" for every real category, because pooled agents carry the category "Pooled", which that dropdown does not offer. Same control as UI-2, different symptom. | Filter looks broken. Product — display (fix with G7). | support sample, default run, Agent Browser → Billing_Support |
| P3-T1 | minor | Healthcare sample card says "4 Segs … 10-day horizon"; the data has 3 categories and data quality shows 8 working days. | Wrong card text only (add to UI-7). | data-quality screen after loading healthcare |

Confirmed in the browser (known items, no new ID): UI-1 (added an opening-backlog case after the claims run; Results still Net 31 / Gross 40, no banner); UI-2; CSV-4 (`12,5`, `10,5`, `8,25` read as 125, 105, 825 — true total 31.25 shown as 1,055, "PASSED DQ GATE", 0 issues); CSV-5 (title row becomes the only column header, no error); CSV-6/7 (`.xlsx` shows raw binary text in the mapping dropdowns, no error).

Clean and proven:
- Loads from disk; zero console errors through every step; zero requests to any non-file origin; only identifier URLs in the file.
- Screen = direct engine = hand calculation on all three samples:

| Sample | Recommended | Gross | N_min | SLA | Occupancy (hand check) |
|---|---|---|---|---|---|
| Claims | 31 | 40 | 30 | 100% | 99.1% (69,125 / 69,750) |
| Support | 27 | 34 | 20 | 88.7% | 77.6% (47,160 / 60,750) |
| Healthcare | 31 | 39 | 18 | 86.7% | 58.9% (65,700 / 111,600) |

- Claims per-category net 4.16 / 9.48 / 17.36 and gross 5.2 / 11.86 / 23.14 match the engine; harmonic shrinkage 22.9%.
- Reset-confirm modal, progress modal, "View Results", sidebar READY badge all work. No crash, NaN, Infinity or undefined seen.

### P3-2 — `ResultsFlow.tsx:1-1200` line by line (investigator) — 2 majors, display only; no wrong computed number

IDs renamed from the agent's R1..R7 to UI-9..UI-15.

| ID | Severity (my verdict) | Finding | Effect on the planner | Evidence |
|---|---|---|---|---|
| UI-9 | **major (display)** | Search-history "Primary SLA" cell is coloured by `median >= policy target`, while the engine passes/fails on the confidence-interval lower bound against the slack-aware floor. The bounds are on each history row (`primaryCiLow`) but never read. Example: target 95, median 96.0, CI low 94.1 → green "96%" beside a red Fail. With slack ON: median 92, CI low 90.5, floor 90 → red "92%" beside PASS. | Row colour contradicts the pass/fail next to it; the planner cannot see why a headcount was rejected or accepted. | `ResultsFlow.tsx:775`; `hc-search.ts:2917`, `:3725`, `:1927-1928`; `wfm.ts:622-623` |
| UI-10 | **major (display)** | Headline "Primary SLA Achieved" card and per-category rows show ONE representative run but are coloured as if that were the gate. The engine writes a warning for exactly this case ("Representative run fell slightly below target… CI remains satisfied") — **no component renders it** (I confirmed: the two fields appear only in `wfm.ts` and `hc-search.ts`). Example: target 95, CI low 95.2 (passes), representative run 94.7 → "COMPLETE / Verified" banner above a red 94.7% card and red category row, unexplained. | A valid recommendation looks failed, with the explanation the engine prepared thrown away. | `ResultsFlow.tsx:965`, `:972`, `:1086-1111`; `hc-search.ts:2838-2849`, `:3647-3657`, `:1999-2008`; `wfm.ts:615-616` |
| UI-11 | minor | Agent tab and its CSV use `labor.adherencePct || 1.0` for the daily budget; the engine's `resolveEffectiveAdherence` treats 0 as 0.1. Only differs at adherence 0. | Budget column / violation flag wrong in an extreme setting. | `ResultsFlow.tsx:297`, `:427`; `des-engine.ts:666-678` |
| UI-12 | minor | "Invariants" panel always shows green ticks: M1 prints "10h ≤ 8h. Passed" without comparing (data quality warns on the same input); M2 is `round(x) = x`; M3 is a hard-coded tick. | A check that cannot fail. Misleading reassurance. | `ResultsFlow.tsx:1154-1172`; `csv-parser.ts:1031` |
| UI-13 | minor | Infeasible run: "SLA on-duty HC" stays green, "Hire after same shrink" and "Agents Required" show the search-cap headcount as if it were a recommendation. Only the top banner and one tile say "Fails SLA". | Cap value can be read as an answer. | `ResultsFlow.tsx:593`, `:612`, `:618`, `:856-858`; `hc-search.ts:2675`, `:2776` |
| UI-14 | minor | "Held at the workload floor" banner tests `HC === N_min`; the real floor is the search start (`max(N_min, N_occ)`). When held at N_occ > N_min no banner shows; text always names N_min. | Missing explanation. | `ResultsFlow.tsx:911-919`; `hc-search.ts:2880-2884` |
| UI-15 | minor | Reassuring fallbacks: "Evaluated up to N = 500" when the value is missing (500 is not the configured cap); ASA "0m" when the category has no stats; zero-demand data shows workload "1h". | Wrong figure in edge cases only. | `ResultsFlow.tsx:523`, `:1119`, `:1128`; `hc-search.ts:1568` |

Clean in this slice: every headline figure traced to its engine field with the right unit and rounding (Net HC, Gross HC single round, OFF %, uplift, shares, shrinkage, CI block, occupancy raw vs capped, coverage, per-category targets); CI-low colour uses the same floor as the gate; all settings read from the run snapshot (no live reads in 1-1200); crash guards present; no `fetch`, storage, console, `Math.random`, `Date.now` anywhere in the file.

### P3-3 — `ResultsFlow.tsx:1200-2387`, export handlers, `export-rows.ts` (investigator) — 2 majors, rest minor; no wrong computed number

IDs renamed from the agent's S1..S12 to UI-16..UI-27.

| ID | Severity (my verdict) | Finding | Effect on the planner | Evidence |
|---|---|---|---|---|
| UI-16 | **major (security hygiene, low likelihood)** | Every CSV export writes cells that start with `=`, `+`, `-`, `@` unchanged (quoted, but Excel still runs them). A category name or case ID like `=HYPERLINK(...)` from a file or imported settings the planner did not write is executed when the export is opened in Excel. I confirmed `csvCell` has no guard. | Exported file can run a formula from someone else's data. Product — exports. | `csv-parser.ts:1072-1076`; `export-rows.ts:19-20`, `:40-41`, `:56-60`; `ResultsFlow.tsx:481-494` |
| UI-17 | **major (siloed runs)** | Agent Summary gives agents with **no work** a category by round-robin (`categories[i % n]`) instead of the engine's real assignment. Example: agents A,B,C,A,A; idle Agent-5 (really A) is listed under B, appears in B's filter and CSV, missing from A. Idle agents are exactly what a planner reads to spot an over-staffed category. The Fairness table uses the real mapping. | Wrong category on screen and in the Summary CSV for idle agents. | `ResultsFlow.tsx:323`, `:339-341`, `:484`; `des-engine.ts:2060`; correct source `des.agentFairness.perAgent[i].category` |
| UI-18 | minor | Agent Summary and Slice tables share one search/filter state without saying so; category + "IDLE only" always gives an empty table (idle slices carry no category); a hidden selected agent still filters slices. | Confusing filters. | `ResultsFlow.tsx:399`, `:1677-1700`, `:1933-1971` |
| UI-19 | minor | Audit tab "Breach samples at N−1" and the "At N−1 SLA was X%… stepping up achieved Y%" text come from one run, while the search decided on R runs and the CI bound; with the workload floor ON, N−1 may never have been a candidate. Can show "no breaches at lower headcount" for a headcount the search rejected. Extends HC-16. | Rationale text can contradict the decision. | `hc-search.ts:2851-2859`, `:2957`; `ResultsFlow.tsx:2211` |
| UI-20 | minor | "Occupancy Proof" badge is green when the numbers reconcile, not when occupancy is within the cap — a 130% run shows a green "130%". | Green reads as "OK". | `ResultsFlow.tsx:441`, `:1489` |
| UI-21 | minor | Step 3 prints `replications || 30` — claims 30 replications if the value is missing. | Edge case. | `ResultsFlow.tsx:1268` |
| UI-22 | minor (wording) | "EXISTING / NEW ADDED" agent labels and the export "Source" column: the app has no existing-headcount input. Agents 1..N_min are called Existing; in siloed runs the ID order is a category split, so the label is meaningless. | Invented meaning on screen and in two CSVs. | `ResultsFlow.tsx:1606`, `:1694`, `:1761-1766`, `:2005`; `export-rows.ts:54` |
| UI-23 | minor | Case Browser shows "Showing 1 - 0 of 0 cases" with no empty-state row. | Cosmetic. | `ResultsFlow.tsx:1450` |
| UI-24 | minor | Exports: ignore active filters without saying so; slices CSV not sorted like the screen; unstarted case `-` on screen vs `UNSTARTED` in CSV; AHT/ASA unrounded; empty export does nothing silently; Results JSON uses the same file-name pattern as the Config export (`wfm_config_snapshot_*`); the "run snapshot" JSON includes the **live** column mapping. | Export vs screen inconsistencies. | `ResultsFlow.tsx:453-497`; `export-rows.ts:24-33`; `csv-parser.ts:1108`; `App.tsx:386`, `:399` |
| UI-25 | minor | Assumptions tab mixes `adherence_pct: 0.85` (fraction) with `confidence_level_pct: 95%`; titled "Full parameter state snapshot" but lists about 20 parameters (no AHT, shrinkage, volume, replications). | Misleading title/units. | `ResultsFlow.tsx:2349` |
| UI-26 | minor | Numbers formatted with the PC locale: on a German/French PC `1,234 min` shows as `1.234 min` and can be read as 1.2. One figure can print 3 decimals. | Misread risk, no calculation error. | `ResultsFlow.tsx:1345`, `:1501-1513`, `:1622`, `:1814`, `:1898`, `:2231` |
| UI-27 | minor | Queue/backlog table and Agent Summary are not paginated (a long horizon is thousands of rows). | Slow screen on large runs. | `ResultsFlow.tsx:2130` |

For the UI-1 fix: no export inside `ResultsFlow.tsx` reads live demand or backlog (they use the run's own results). Remaining live reads: `App.tsx:659-660` (props never used by Results), `App.tsx:386` (column mapping in the JSON), `App.tsx:410`, `:655-661` (fall back to live settings only when no snapshot exists).

Clean in this slice: the five "how we got here" formulas on screen equal the engine code (N_min floor, max with search result, OFF adjustment, per-category gross-up → sum → one round); pass/breach flags and breach reasons equal the CSV; timestamps on screen and in CSV use the same local formatter; fairness percentages not double-multiplied; sorts explicit; no empty-array or divide-by-zero crash path; CSV escaping of commas, quotes and newlines correct.

### P3-4 — `DemandFlow.tsx` all 1227 lines (investigator; code reading, D1/D2 lines re-read by me) — 2 majors, both in the backlog file import

IDs renamed from the agent's D1..D12 to UI-28..UI-39. `DataTable.tsx` is not used by this screen (not read).

| ID | Severity (my verdict) | Finding | Effect on the planner | Evidence |
|---|---|---|---|---|
| UI-28 | **major** | Backlog import: a row whose category is not recognised is given the fallback category's **name** but not its handling time or priority — it gets an invented 30 min, priority 1. Example: categories `[Billing AHT 12, prio 2]`, row "Foo" with blank remaining work → stored Billing, 30 min, prio 1. The warning says only "map to fallback category". Blank category cell or unmapped category column: same, with **no warning at all**. | Wrong minutes enter the sizing. Product — wrong input. | `DemandFlow.tsx:195-204`, `:207`, `:214`, `:1080` |
| UI-29 | **major** | Backlog import: remaining-work cell read with `parseFloat` — takes the leading digits and ignores the rest, silently. `7,5` → 7; `1:30` → 1; `2h` → 2 minutes; `12abc` → 12. Negative, `N/A`, text → category AHT or 30 with no count and no warning. `1e9`, `Infinity` accepted. | Wrong minutes enter the sizing, unflagged. Same family as CSV-4. | `DemandFlow.tsx:215-220`, `:208-211` |
| UI-30 | minor | Backlog import column auto-pick: `Due Date, Created Date` picks Due Date as arrival; one column can fill two roles; with no match, category falls back to the first column and date to the second (often the case ID → every row "unmatched"). | Wrong mapping proposed; planner can correct it. | `DemandFlow.tsx:130-154` |
| UI-31 | minor (wrong input, silent) | Backlog import: a blank date cell or unmapped date column silently becomes "arrived at the start of the data". Only unparseable non-empty dates are counted as skipped. | 500 undated rows import with no notice. | `DemandFlow.tsx:227-238` |
| UI-32 | minor | A backlog case added before any demand file is loaded gets the PC's current time as its arrival (not repeatable; feeds CSV-13). Not verified reachable in the UI. | Edge case. | `DemandFlow.tsx:237`, `:296-301` |
| UI-33 | minor | Manual backlog "remaining minutes" field: typing 0 or clearing it snaps to 30 mid-edit; decimals truncated; −5 shows −5 but stores the category AHT; no upper limit. | Field shows one value, stores another. | `DemandFlow.tsx:813`, `:286` |
| UI-34 | minor | Manual backlog: empty/unparseable arrival silently defaults; a category chosen before loading a different file stays selected invisibly and is stored (data quality then blocks it without saying why). | Confusing block. | `DemandFlow.tsx:289-302`, `:78`, `:284` |
| UI-35 | minor | Backlog import text says "mm/dd is rejected" but `03/04/2026` is read as 3 April silently (only day > 12 is rejected); colliding IDs regenerated silently; Append button enabled with 0 cases. | Misleading message. | `DemandFlow.tsx:1073`, `:241-245`, `:1137` |
| UI-36 | minor | Backlog import re-parses the whole file on every dropdown change with a per-row full scan — a 20k-row file would freeze the screen. | Slow on large backlog files. | `DemandFlow.tsx:915`, `:242-244` |
| UI-37 | minor (root of P3-T3) | File reading: empty file dropped silently (`if (text)`); no error handler for an unreadable/locked file; non-UTF-8 files (Windows-1252) turn accented category names into `�` with no warning; no size limit. Header-only file: screen moves to mapping anyway. | Exact lines for the P3-T3 fix. | `DemandFlow.tsx:118-127`, `:170-183`; `App.tsx:189` |
| UI-38 | minor | Dropping a file outside the drop box makes the browser open it — **all in-memory work is lost** (no page-level drop guard found). Picking the same file twice does nothing. Two quick uploads can finish out of order. | Lost work on a mis-drop. | `DemandFlow.tsx:346`, `:373-378`, `:877` |
| UI-39 | minor | Data-quality tab says "Upload and map…" when a file is loaded but a required column is unmapped — no hint which. Backlog total uses `|| 0`, hiding a bad value. | Unhelpful message. | `DemandFlow.tsx:714`, `:1170-1174`; `App.tsx:131`, `:152` |

Clean: re-upload goes through the reset dialog and clears backlog; mapping changes recompute intervals and data quality (no stale data); every data-quality issue is listed with the right colour and count; totals come straight from the parser (no second formula); backlog IDs unique, delete by ID; manual date-time entry is local-time consistent; invalid calendar dates rejected; no offline-contract breach in the file.

### P3-5 — `ConfigFlow.tsx`, `CalendarConfigPanel.tsx`, `ParamsPanel.tsx` all lines (investigator; code reading only) — 2 majors

IDs renamed from the agent's C1..C9 to UI-40..UI-48.

| ID | Severity (my verdict) | Finding | Effect on the planner | Evidence |
|---|---|---|---|---|
| UI-40 | **major (dead control)** | Per-category "BO ASA Target" inputs do nothing. The screen offers an editable wait-time target per category, help text says each category "has its own … BO ASA target", and "Apply Template to All" copies it — but the engine reads only the global target. `cat.boAsaTarget` has no reader in `src/utils`. Example: Claims_Auto set to 15 min, global 60 → engine enforces 60. | Planner believes a target is enforced when it is not. Headcount unaffected. | `ConfigFlow.tsx:642-643`, `:738`, `:844-878`; `hc-search.ts:1966-1968`; `des-engine.ts:2116-2117` |
| UI-41 | **major — from code, needs a browser confirmation** | Three percentage fields clamp on every keystroke with a minimum above the first digit, so typing a value stores a different one. Occupancy cap (min 50): select the field, type `85` → "8" becomes 50, then "505" becomes **100**. Adherence (min 10): `85` → **100%**. Confidence level (min 50): `95` → **99.9%**. I re-read the occupancy handler: it is as described. Arrow keys and paste work. | **Changes the headcount**: the gate the planner meant to set is silently weaker or stricter. The wrong number is visible in the field but nothing says the clamp fired. | `ConfigFlow.tsx:154`, `:921-924`, `:1071` |
| UI-42 | minor | Many fields snap back to a default the moment they are cleared (`|| default`): productive hours 7.5, days/week 5, SLA 80 / 6, ASA 60, confidence 95, slack 5, cap 85, priority 1, AHT 1. AHT below 1 minute cannot be entered. | Awkward editing; no wrong value reaches the engine. | `ConfigFlow.tsx:130`, `:176`, `:667`, `:680`, `:710`, `:787`, `:923`, `:974`, `:1024`, `:1071`, `:1221`, `:1253` |
| UI-43 | minor | Daily productive hours has no clamp: a pasted negative is stored, passes the Run gate (`allGatesPassed` omits the `> 0` check), `N_min` drops to 1 and the simulation uses it unclamped. | Wrong headcount only if a negative is pasted. | `ConfigFlow.tsx:129-131`; `RunFlow.tsx:75`, `:89-95`; `hc-search.ts:131`; `des-engine.ts:795` |
| UI-44 | minor | Adherence and shrinkage show a rounded percent but store the exact value: type 12.5 → field shows 13, engine uses 12.5. | Screen differs from value used. | `ConfigFlow.tsx:152`, `:1236` |
| UI-45 | minor (answers the phase 2 open question) | **Yes, the UI can build broken calendars, and the Calendar tab warns about none**: all weekdays unticked (engine then throws "No open working window found"; nothing checks it); close ≤ open or open = close (window shown as "0 hours/day" in neutral colour; run is blocked later by an unrelated-looking message on the Run screen); nothing checks holidays covering the whole horizon. | Crash or a blocked run with the message far from the cause. No wrong headcount. | `CalendarConfigPanel.tsx:35-45`, `:69`, `:79`; `calendar.ts:117-132`; `RunFlow.tsx:75` |
| UI-46 | minor | "Productive hours fit inside the daily window" is shown on the Labor tab and enforced only at Run — nothing on the Calendar tab. | Late feedback. | `ConfigFlow.tsx:64`, `:207-223`; `CalendarConfigPanel.tsx:369` |
| UI-47 | minor | Per-category SLA window display: a category holding minutes only is shown as minutes/60 with the global unit label (360 min shows as "6 days" when the global unit is days); global window truncates decimals, per-category accepts them. Engine uses its own fields — no headcount effect. | Wrong label in one case. | `ConfigFlow.tsx:680`, `:763`, `:804`, `:1201`; `des-engine.ts:561-563` |
| UI-48 | minor | Changing the global SLA baseline changes nothing until "Apply Template to All" is clicked; categories are not marked out of sync. Partly disclosed in help text. | Planner edits the baseline and sees no effect. | `ConfigFlow.tsx:628`, `:633-646` |

Not in these files (so not assessed here): replications / seed / max HC controls (in `RunFlow.tsx` — the "R = 1 without a warning" question stays open), shift-offset controls, pooled/siloed switch. No category add / rename / delete exists in the UI, so duplicate names cannot be created there.

Clean: shrinkage clamped 0–99% (gross-up can never divide by zero); AHT ≥ 1; occupancy cap, min coverage, slack, confidence all re-clamped by the engine; toggles OFF really switch the dependent value off, no silent stale value; **Workload Floor defaults ON with its explanation always visible**; 24x7 saves/restores the weekday set and bypasses holidays as labelled; holiday dates never parsed through `new Date(string)` (no timezone off-by-one); the daily-window figure uses the engine's own function; no offline-contract breach.

---

## Phase 3 — final ranked list

No final challenger was run (meter reached the 17% soft line). Severities below are my verdicts on single-agent reports; items marked "from code" were not exercised in a browser.

| Rank | ID | Severity | What the planner experiences | Product or internal? |
|---|---|---|---|---|
| 1 | UI-41 | major (from code) | Typing 85 into occupancy cap / adherence, or 95 into confidence, stores 100 / 100 / 99.9 | Product — changes headcount |
| 2 | UI-28 + UI-29 (+ UI-31) | major | Backlog file import invents 30 min / priority 1 for unrecognised or blank categories, reads `7,5` as 7 and `2h` as 2 min, defaults blank dates — mostly with no warning | Product — wrong input |
| 3 | UI-10 + UI-9 | major (display) | A passing recommendation can show a red headline SLA card and red rows; the engine's own explanation is never displayed; history-row colours contradict the Pass/Fail beside them | Display |
| 4 | UI-40 | major (dead control) | Per-category wait-time targets are editable but ignored | Display / expectation |
| 5 | UI-17 | major (siloed) | Idle agents listed under the wrong category on screen and in CSV | Display + export |
| 6 | P3-T3 (+ UI-37) | major | Empty or header-only file: nothing happens, no message | Product — input handling |
| 7 | UI-16 | major (security hygiene, low likelihood) | CSV exports can carry a formula from someone else's data into Excel | Export |
| — | UI-11..15, UI-18..27, UI-30, UI-32..36, UI-38, UI-39, UI-42..48, P3-T1, P3-T2 | minor | See tables | Mostly display |

Proven clean in phase 3: the shipped file loads from disk with no errors and no network traffic; headline numbers on screen equal a direct engine run and a hand calculation on all three samples; every headline figure on Results traces to the right engine field with the right unit and rounding; exports equal the screen; Workload Floor default ON with warning; shrinkage/AHT/cap inputs cannot produce a divide-by-zero.

## Not audited (carry to phase 4 or a phase 3b)

- **P3-6 not reached**: `App.tsx`, `RunFlow.tsx` (replications/seed/max-HC inputs, "R = 1 without a warning", cancel path), `SensitivityFlow.tsx`, `AgentAnalyticsPanel.tsx`, `Sidebar.tsx`, both modals, `NativeCharts.tsx`, `DataTable.tsx`; settings import/export round trip.
- UI-41 keystroke behaviour, UI-38 (drop outside the box) and UI-32 not confirmed in a browser.
- Final challenger on phase 3 findings.
- Still open from earlier phases: staggered-mode stale-event fuzz; `.xlsx` sample files; personal data in `test_complaint.csv`.
- Phase 4: docs vs code line by line.

## Usage

Weekly meter: 15% at phase 3 start → 17% after P3-5. Soft line reached; stopped. Cap 20% respected.

---

# Phase 3b (continued same day, user-approved past the 17% soft line; new rule: no new agent at a meter reading of 19%, hard stop 20%)

### P3-6 — `App.tsx`, `RunFlow.tsx`, `SensitivityFlow.tsx`, `SimulationProgressModal.tsx`, `run-inputs.ts` all lines (investigator; code reading) — 3 majors

IDs renamed from the agent's A1..A12 to UI-49..UI-60. `ResetConfirmModal.tsx` not read.

| ID | Severity (my verdict) | Finding | Effect on the planner | Evidence |
|---|---|---|---|---|
| UI-49 | **major — extends UI-1; corrects a phase 2 ruling** | Changing a column mapping by hand after a run (Demand → Mapping) rebuilds the demand data but neither clears results nor raises the "changed since run" banner — the mapping is not part of the run snapshot. Same when an imported settings file carries a mapping. I confirmed: `App.tsx:593` passes the raw setter; results are cleared only at upload, sample load, run start, reset, cancel, error. **Phase 2's P2-8 ruling "mapping changes do clear results" was right only for the automatic mapping at upload.** | Old headcount shown beside new data, unflagged. | `App.tsx:130-135`, `:452`, `:593`; `run-inputs.ts:14-41` |
| UI-50 | **major (Sensitivity tab)** | The Sensitivity base cell (0%, 0%) can differ from the Results headline with no edit: every cell rounds AHT to whole minutes and per-interval volume to whole cases, even at 0%. AHT 7.5 → base cell runs at 8 (+6.7%). Small values flatten the ±10% cells (AHT 3 at −10% = 3). The cell is labelled "Baseline" and its SLA text hidden. | Sensitivity numbers wrong for decimal or small AHT/volumes; headline unaffected. | `SensitivityFlow.tsx:78`, `:84`, `:277`; `ConfigFlow.tsx:1221` |
| UI-51 | **major (Sensitivity tab)** | Leaving the Sensitivity tab throws the finished matrix away (minutes of computing) and the hidden search keeps running (up to 25 full searches) with no cancel on leave. | Lost work, slow app. | `SensitivityFlow.tsx:45`, `:51-125`; `App.tsx:667` |
| UI-52 | minor | Sensitivity Stop / engine error: no error handling — the grid stops silently with no message; Stop re-enables Compute at once and a second Compute un-cancels the first loop, so two loops race. | Confusing state. | `SensitivityFlow.tsx:53-129` |
| UI-53 | minor | Infeasible Sensitivity cells show Gross HC computed at the search cap with no "infeasible" mark (the `passed` flag is stored, never read). | Cap value can be read as an answer (same family as UI-13). | `SensitivityFlow.tsx:110`, `:260`, `:351`; `hc-search.ts:2962` |
| UI-54 | minor | Run-screen fields (replications, search ceiling, seed) snap back to the default when emptied, so retyping appends: clear "500", type 80 → "5008" (above the stated max 5000, accepted). Seed 0 becomes 12345. No upper limit (100000 replications would hang). No "85 → 100" style corruption here (minimums are 1). | Awkward typing; wrong value if not noticed. Fix with H1. | `RunFlow.tsx:318-323`, `:342-347`, `:363-368` |
| UI-55 | minor (UI side of HC-9) | Replications = 1 is allowed with **no warning**, while labels still say "≥30 replications" and "computes the CI". Search ceiling below `N_min` has no pre-run message. | Planner can run without the confidence gate unknowingly. | `RunFlow.tsx:276`, `:312`, `:328` |
| UI-56 | minor | Settings import: a foreign file (`{}`) reports "Configuration successfully loaded" with nothing applied; no version field; calendar/labor replaced wholesale — a partial file without `holidays` then crashes the calendar code, and **no error boundary exists** (white screen until reload); imported search ceiling 0 shows 500 on screen while the engine runs with 1. Concrete consequences of HC-4. | Crash or misleading success message on a bad settings file. | `App.tsx:414-467`, `:273`; `calendar.ts:56-64`; `RunFlow.tsx:342` |
| UI-57 | minor | Run lifecycle: Cancel only sets a flag; starting a new run resets the flag before the cancelled run sees it, so both finish and the last one wins; the old run's cleanup re-enables the Run button mid-run. No re-entry guard beyond the disabled button. | Rare race; result still internally consistent. | `App.tsx:230-320` |
| UI-58 | minor | Header chip "Net HC / Gross HC" shows on every screen with no stale marker (banner is on Results only). Run snapshot holds references, not a copy (safe only while no code mutates in place). | Stale number in the header after an edit. | `App.tsx:262`, `:517-526`, `:662` |
| UI-59 | minor | Run gates: no gate for zero open days, close ≤ open, zero categories; `workingDaysPerWeek > 0` shown but not enforced; open = close = 0 with 0 productive hours counts as valid; gate 3 counts all configured categories, not those in the data. | Missing early checks (engine error is caught — see clean list). | `RunFlow.tsx:75`, `:89-106` |
| UI-60 | minor | Progress modal says "binary search" (engine comments describe a step-up search — not confirmed); floor label shown even with the Workload Floor off; no "leave page" guard — a refresh loses all work. | Wording; lost work on refresh. | `SimulationProgressModal.tsx:156-161`, `:279` |

Clean: engine errors during a run are caught and shown (no white screen or stuck modal) — this closes the UI-45 question for the Run path; progress modal repaints; blocking data-quality errors are enforced twice; seed comes only from the settings (no clock, no random); Sensitivity uses the same seed, replications and cap as the main run; exported settings contain no dates needing revival; no offline-contract breach in these files.

### P3-7 — browser confirmation of code-read findings (tester; real key presses on the shipped `BoWFM.html`)

| Check | Result | What happened |
|---|---|---|
| UI-41 occupancy cap | **CONFIRMED** | Select all, type `8`,`5` → field 50, then 100. `7`,`0` → 50, then 100. |
| UI-41 adherence | **CONFIRMED** | `8`,`5` → 10, then 100. |
| UI-41 confidence level | **CONFIRMED** | `9`,`5` → 50, then 99.9. |
| UI-41 size of effect | **CONFIRMED — large** | Claims sample, adherence meant to be 85%: typed → field 100 → recommended **31**, gross **40**, `N_min` 30. Pasted 85 → recommended **37**, gross **48**, `N_min` 36. Typing under-sizes by 6 heads (−16%) / 8 gross (−17%). |
| UI-54 search ceiling | **CONFIRMED** | From 500: Backspace ×3 → 50, 5, 500 (snaps back); then `8`,`0` → 5008, 50080 (stated max 5000). |
| UI-49 mapping change after run | **CONFIRMED (date dropdown; category dropdown not tested)** | Support run 27 / 34; changed a mapping dropdown; Results still show 27 / 34 beside "DQ GATE BLOCKED", no "changed since run" banner. |
| UI-45 no working days | **No crash** | All 7 days unticked: data-quality header still "CLEARED", Run enabled; pressing Run shows a red error panel "No open working window found in calendar configuration within 1830 days… check … the Data Quality gate" — which shows no issue. Dismissable; no console error. |
| UI-38 drop outside the box | not tested | Not reliable headless. |

**UI-41 is upgraded to the top finding of phase 3: major, confirmed, changes the headcount (under-staffs by about 16% in the tested case) through ordinary typing.**

### P3-8 — final challenger on phase 3 + 3b — PASS with corrections (all accepted)

| Challenge | Ruling |
|---|---|
| UI-41 upheld. Framing: default adherence is 100% and correct (`default-config.ts:26`); the fault is clamping on every keystroke. The only cue is help text "Default 100%" — a planner seeing 100 may read it as the default | **Accepted.** Stays top finding. |
| UI-28, UI-29 upheld; nothing downstream catches the rows (the unknown category is renamed before the orphan check). Priority parse (`DemandFlow.tsx:209-210`) has the same fault | **Accepted.** Priority parse added to UI-29. |
| UI-9, UI-10 upheld (display only) | Kept major (display). |
| UI-49 upheld (browser-confirmed) | Kept major. |
| UI-50: the **volume half is wrong** — the engine also rounds per-interval volume (`des-engine.ts:602`). Only the AHT rounding is a real difference | **Accepted.** Narrowed to AHT; downgraded to minor (Sensitivity tab only). |
| UI-16 overstated for an offline single-user tool | **Accepted.** Minor (cheap fix, keep in plan). |
| UI-51, P3-T3 overstated — annoyance, no wrong number | **Accepted.** Minor. |
| UI-40 dead control, no headcount effect — high minor | **Accepted in part.** Kept as major (expectation): the screen states a target is enforced that is not. |
| UI-17: index alignment of `perAgent[i]` and "idle siloed agent exists" not confirmed | **Accepted.** Marked "from code — confirm before fixing"; low major. |
| Under-rated: UI-56 (bad settings file → white screen, no error boundary, work lost) | **Accepted.** Upgraded to major. |
| Under-rated: UI-55 (replications = 1, no warning, labels still claim a confidence interval) | **Accepted.** Upgraded to major (missing warning). |
| Theme: lost work — refresh (UI-60), mis-drop (UI-38), leaving Sensitivity (UI-51), bad settings file (UI-56) | Noted as one theme in the fix plan. |

## Final ranked list (phase 3, after challenge) — replaces the earlier phase 3 list

| Rank | ID | Severity | What the planner experiences | Product or internal? |
|---|---|---|---|---|
| 1 | UI-41 | **major — confirmed in browser** | Typing 85 into adherence or occupancy cap stores 100; 95 into confidence stores 99.9. Tested: recommended 31 instead of 37 (−16%) | Product — changes headcount (under-staffs) |
| 2 | UI-28 + UI-29 (+ UI-31) | major | Backlog file import invents 30 min / priority 1 for unknown or blank categories; `7,5` → 7, `2h` → 2 min; blank dates defaulted; mostly no warning | Product — wrong input |
| 3 | UI-49 (with UI-1) | major — confirmed in browser | Changing a column mapping after a run leaves the old headcount on screen, unflagged | Product — stale output |
| 4 | UI-10 + UI-9 | major (display) | A passing recommendation can show a red SLA card; the engine's explanation is never shown; history colours contradict Pass/Fail | Display |
| 5 | UI-56 | major | A partial or foreign settings file: white screen (no recovery but reload) or a false "successfully loaded" | Product — crash / lost work |
| 6 | UI-55 | major (missing warning) | Replications = 1 runs with no confidence check and no warning; labels still say "≥30" | Product — expectation |
| 7 | UI-40 | major (expectation) | Per-category wait-time targets editable but ignored | Display |
| 8 | UI-17 | low major (from code) | Idle agents under the wrong category in siloed runs | Display + export |
| — | P3-T1..T3, UI-11..16, UI-18..27, UI-30, UI-32..39, UI-42..48, UI-50..54, UI-57..60 | minor | See tables | Mostly display / convenience |

## Not audited (carry to phase 4)

- `AgentAnalyticsPanel.tsx`, `NativeCharts.tsx`, `Sidebar.tsx`, `ResetConfirmModal.tsx`, `DataTable.tsx` line by line.
- UI-49 with the Category dropdown specifically; UI-38 (drop outside the box); UI-32; UI-17 index alignment.
- Earlier leftovers: staggered-mode stale-event fuzz; `.xlsx` sample files; personal data in `test_complaint.csv`.
- Phase 4: docs vs code line by line.

## Usage

Weekly meter: 17% at phase 3b start → see final reading in the report. Cap 20% respected.

---

# Phase 4 — docs vs code

Weekly meter at start: 17%. No new agent at a reading of 19%; hard stop 20%.

### P4-1 — `PRD.md` lines 1-684 (sections 1–5) vs code (investigator; about 120 statements checked) — minors only

| ID | Severity | PRD says | Code does | Fix side | Evidence |
|---|---|---|---|---|---|
| DOC-1 | minor | FR-11.2 (line 664): slice export has "local and ISO timestamps" | Only `From` / `To` in local time; FR-9.3a (line 579) already says ISO columns were removed — the PRD contradicts itself | doc | `export-rows.ts:52-67` |
| DOC-2 | minor | FR-5.12 (line 328): min agents per interval "0–operationalHC" | Input accepts 0–999 typed and beyond; engine caps it later | doc | `ConfigFlow.tsx:1113-1120`; `des-engine.ts:717` |
| DOC-3 | minor | FR-8.2 / FR-8.3 (lines 498-499): replications 1–100, search ceiling 1–5000 | Only the lower bound is enforced; 99999 is accepted (same as UI-54) | **code** (doc is the intended contract) | `RunFlow.tsx:316-322`, `:340-346` |
| DOC-4 | minor | FR-11.5 (line 667): settings import restores keys "defensively" | Only `sla` is sanitised; calendar, labor, categories, sim params, mapping taken as-is (HC-4, UI-56) | doc now, code with H10 | `App.tsx:419-455` |
| DOC-5 | minor | §5.11 (lines 661-666) | Undocumented: the JSON carries `exportedAt`; file name uses epoch milliseconds | doc | `App.tsx:386`, `:399` |
| DOC-6 | minor | Lines 668-669 | Two different rows both numbered FR-11.6 | doc | `PRD.md:668-669` |

Verified matching: all 18 data-quality checks and their blocking/warning severities; parsing rules (delimiters, file types, date pivots, default 30-minute end); **every default** (calendar, labor, SLA, sim params, seeded categories); documented clamps; navigation, tab names, the six pre-run checks; Results filters and page sizes; CSV file names and columns; sensitivity grid steps. Note: the PRD's "productive hours 1–24" matches the HTML limits only — typed/pasted values bypass them (UI-43).

### P4-2 — `PRD.md` lines 684-1465 (sections 6–12) vs code (investigator; about 70 statements checked) — 2 majors (doc side)

| ID | Severity | PRD says | Code does | Fix side | Evidence |
|---|---|---|---|---|---|
| DOC-20 | **major (doc)** | §9.1 (lines 1115, 1124): "856 checks (174 + 518 + 164 trusted-source)", "Run with `npm test`" | `npm test` runs 174 + 518 + 60 (agent analytics, missing from the PRD table) = 752 and does **not** run the 164 trusted-source checks. The PRD implies the hand-traced ground-truth suite runs on every test. Same root as TEST-1. | doc now; code with G12 (add the suite to `npm test`) | `package.json:14`, `:17` |
| DOC-21 | **major (doc)** | §9 and backlog P0-1 (lines 1157-1160, 1197-1199): invariants panel "renders four statically-passing cards… M1–M4" | Panel is titled "M1–M3", three cards, interpolating live values with an unconditional "Passed" (UI-12). The described state no longer exists; the underlying problem (nothing is evaluated) remains. | doc | `ResultsFlow.tsx:1143-1175` |
| DOC-22 | minor | Line 1078: file is "~513 KB" | `BoWFM.html` is 627,984 bytes (~613 KB) | doc | file size |
| DOC-23 | minor | Lines 1317-1318: unused `DataTable.tsx` 308 lines, `NativeCharts.tsx` 363 | 309 and 372; both still unreferenced (dead code confirmed) | doc | `wc -l`, grep |
| DOC-24 | minor | Line 726: "probes at 5 replications, confirmed at full 30"; "leap in doubling steps" | 5 and 30 are defaults (`min(R, 5)`, R configurable); step doubles only after a failure | doc (one word) | `hc-search.ts:3460-3482` |
| DOC-25 | minor | Stage 2 formula | Omits that `N_min` is floored at 1 | doc | `hc-search.ts:131` |
| DOC-26 | not confirmed | Backlog P2-4 (Summary grid) | May be stale: grid shows 4 cards in a 4-column layout | check | `ResultsFlow.tsx:958` |

**Does the PRD's limitations / backlog list (§10, §11) already tell the reader about the audit's main findings?**

| Audit finding | Listed in PRD? |
|---|---|
| Old backlog date / stray date stretches the horizon (CSV-13/14) | **No** |
| 24x7 + coverage ON + short SLA gives no answer (HC-14); 24x7 coverage OFF assumes any-hour scheduling (HC-20) | **No** |
| 24x7 parked case resumes only at midnight (DES-8) | **No** |
| 14-day drain window; holidays after the horizon inflate HC (DES-10) | **No** (glossary defines the window, no length) |
| Opening backlog treated as part-worked, served first (DES-7) | **No** (stated as the model, not as a limitation) |
| Comma decimals misread (CSV-4); `Z` timestamps depend on PC timezone (CSV-1) | **No** |
| 30-minute rule cannot fire (CSV-15) | **No** — L8 states the rule as working |
| Replications = 1 removes the confidence gate (HC-9) | **No** |
| Sync / async search duplication | Yes — P2-7 (line 1343) |
| Trusted-source suite not in `npm test`; EDF / CI gate / CRN barely tested | **No** — line 1124 implies the opposite (DOC-20) |
| Build tools under `dependencies`; freshness gate time-based only | **No** — NFR-2.2 (line 1072) says devDependency-only, which is false today |
| Results not flagged after backlog / mapping edits (UI-1, UI-49) | **No** |
| Gross HC `.5` tie float noise (HC-1) | **No** |

**12 of 13 are absent.** Whatever is not fixed must be added to §10 (limitations) or §11 (backlog) so the "as-built" PRD stops overstating.

Verified matching: Stage 2 `N_min` and `N_occ` formulas; Stage 4 integer OFF floor and single `round`; confidence clamp; search start from `resolveSearchBounds`; limitations L1, L5, L8 (as written), L9; backlog items P1-1, P1-2, P1-3, P1-5, P2-3, P2-5 still true; the seven `docs/wfm` files and audit scripts exist.

### P4-3 — `project_context.md` + `CLAUDE.md` vs code (investigator; about 45 statements checked; DOC-40 re-checked by me) — 3 majors (doc side)

| ID | Severity | Doc says | Code does | Fix side | Evidence |
|---|---|---|---|---|---|
| DOC-40 | **major (doc) — and it corrects a phase 2 finding, see below** | `CLAUDE.md` decision 2 and the Code Conventions bullet: "`CaseMinHeap.compare` (real dispatch) and `pickNextCase`/`compareByUrgency` (test harnesses only)". `project_context.md` §6.2 (line 515) and §12 (line 1091) say the same. | **The reverse.** Real dispatch calls `pickNextCase` (`des-engine.ts:1334`), which scans the queue with `compareByUrgency` (`:247`, `:272`, `:275`). `CaseMinHeap.compare` only keeps the heap array ordered and does not decide who is served. `project_context.md` §5 (line 297) and §11 (lines 1029-1035, "corrected, D16") already say this — the file contradicts itself. | doc | `des-engine.ts:185`, `:247`, `:258`, `:1334` |
| DOC-41 | **major (doc)** | `project_context.md` gives three different test totals: "251 checks" (lines 56, 78), "613 checks" (line 849), tree "156 + 95" (lines 173-175) | Actual `npm test` = 174 + 518 + 60 = 752, plus 164 trusted-source run separately | doc | `package.json:14` |
| DOC-42 | **major (doc)** | Lines 139-141: "There is no git repository… no `.git` anywhere" | A git repository exists, with history and a GitHub remote; a Stop hook auto-pushes to `auto/agent-updates` | doc | `.git/HEAD`; `.claude/hooks/auto-push.mjs` |
| DOC-43 | minor | "No console output in `src/`… enforced by suite D9"; network ban enforced | D9.3 scans `src/utils` only — a `console.log` in a component or `App.tsx` passes; D9.1 covers six network names, not remote `import()`, fonts, images | doc, or widen the scan (with G13) | `verify-sizing-fixes.mts:652-684`, `:705-715` |
| DOC-44 | minor | "Never use `Date.now()` for anything affecting a computed result" | `csv-parser.ts:716` builds category IDs from `Date.now()` — IDs differ per run; not checked whether any result depends on the ID | check, then code or doc | `csv-parser.ts:716` |
| DOC-45 | minor (stale) | Lines 906-907, 1098: defaults live in `App.tsx` (`DEFAULT_*`) | They live in `src/utils/default-config.ts` | doc | `default-config.ts:15-98` |
| DOC-46 | minor | "Ten frozen decisions" (lines 324, 504) | Eleven (6.11 added 2026-09-29) | doc | `project_context.md:725` |
| DOC-47 | minor | Line 73: "The four commands that matter" | Table lists five | doc | — |
| DOC-48 | minor (stale) | Line 974: "Net Op = ceil(N×(1+extraOff/7))" | `floor(N × openDays / coverageDays)`; §5 and §6.4a of the same file are correct | doc | `hc-search.ts:1587` |
| DOC-49 | minor (stale) | Lines 997, 1024: line references to deleted / moved code | Off-hours warning now at `csv-parser.ts:848` | doc | — |
| DOC-50 | minor | Scripts tree lists 5 scripts | Also present: `verify-trusted-source.mts`, `audit-compare.mts`, `audit-sample-hc.mts`, `test-harness.mts`, `ci-*.mts` | doc | `scripts/` |

Doc lines made false by earlier findings: "dependencies is closed / build tooling devDependency-only" (OFF-2); "Suite D9 enforces this" for dependencies and `Math.random`/`Date.now` (OFF-3); "check:artifact fails if older" is time-only (OFF-1); "never duplicate an algorithm" vs three horizon copies (CSV-13/14).

Verified matching: all `package.json` commands; every named engine function exists with the stated role (apportionment, presence, search bounds, CRN case sets, roster helpers); Stage 4 code equals decision 7; `BUG-OCC-ROOT` asserts the planned-horizon denominator; no `console.log`, `fetch`, storage or `process.env` anywhere in `src`; decisions 10 and 11 match the code.

### CORRECTION to phase 2 finding TEST-4 (my error in judging, found through DOC-40)

- Phase 2 mutation **B1 (EDF → FIFO)** and **B1b (reversed deadlines)** changed the text inside `CaseMinHeap.compare` — I checked the mutation script (`scratchpad/mut.mjs:7`): it replaces the first match, which is the heap method, not `compareByUrgency`.
- Since the heap comparator does not decide dispatch, those two mutations surviving all 916 checks proves **nothing** about dispatch-order testing. The claim "switching EDF to FIFO changes no result" is **withdrawn as unproven**.
- Still valid: B2 (`latestSafeStart` by wall-clock) survived — that value is computed outside the comparator. TEST-5, TEST-6, TEST-7 are unaffected.
- **Required before G12 is scoped:** re-run B1/B1b against `compareByUrgency` (`des-engine.ts:247`). If killed → dispatch order is tested and TEST-4 shrinks to B2 only. If it survives → TEST-4 stands.
- Side finding **DES-15 (minor, internal):** `CaseMinHeap.compare` is a second copy of the urgency ordering that no longer drives anything, and `pickNextCase` scans the whole queue on every dispatch (linear, not heap-fast). Duplicate-algorithm hazard named in `CLAUDE.md`; candidate for removal.

---

## Phase 4 — final ranked list

No final challenger for phase 4 (meter at 18%; reserve kept for write-up). Majors DOC-40 re-checked by me in the code.

| Rank | ID | Severity | Who is misled | Product or internal? |
|---|---|---|---|---|
| 1 | PRD §10/§11 gap | **major (doc)** | 12 of the audit's 13 main findings are absent from the "as-built" limitations and backlog; three PRD lines state the opposite (30-minute rule works; build tools devDependency-only; trusted-source runs in `npm test`) | Docs — planner and owner expectations |
| 2 | DOC-40 | major (doc) | The guardrail file names the wrong function as "real dispatch" for frozen decision 2 — a developer or AI agent would protect or test the wrong code (it already misled this audit's mutation test) | Docs — safety rule |
| 3 | DOC-20, DOC-41 | major (doc) | Test totals wrong in both documents (856, 613, 251 vs real 752 + 164 separate); PRD implies the ground-truth suite runs on every test | Docs — what is tested |
| 4 | DOC-21 | major (doc) | Backlog item P0-1 describes an invariants panel that no longer exists in that form | Docs |
| 5 | DOC-42 | major (doc) | "No git repository" — false; there is one, with an auto-push hook to GitHub | Docs — developer safety |
| — | DOC-1..6, DOC-22..26, DOC-43..50, DES-15 | minor | Counts, stale line references, wording | Docs / internal |

The code-facing content of both documents is otherwise accurate: every default, all 18 data-quality rules, the sizing formulas, gate directions and the named engine functions match the code.

## Not audited (end of audit)

- `docs/wfm/*.md` (1,742 lines) against the code.
- `AgentAnalyticsPanel.tsx`, `NativeCharts.tsx` (dead), `DataTable.tsx` (dead), `Sidebar.tsx`, `ResetConfirmModal.tsx` line by line.
- Re-run of mutations B1/B1b on `compareByUrgency` (see correction above).
- UI-17 index alignment; UI-49 with the Category dropdown; UI-38; UI-32; DOC-26; DOC-44 consequence.
- Staggered-mode stale-event fuzz; `.xlsx` sample files; personal data in `test_complaint.csv`.
- PRD measured figures (roster results, "0 of 18", "533 of 540") were not re-measured.

## Usage

Weekly meter: 17% at phase 4 start → 18% after P4-3. Cap 20% respected across all four phases (6% → 18%).

---

# FIX H1 — number fields keep the typed value — BUILT, awaiting owner approval (2026-10-06)

Branch `fix/h1-number-fields`, commit `990833a` (checkpoint `2970f19`). Closes UI-41, UI-42, UI-43, UI-44, UI-54, UI-33, DOC-3.

| Reviewer | Verdict | Evidence |
|---|---|---|
| Plan challenger | fail, then all points accepted | commit rule changed to commit-when-valid plus blur, Enter and unmount; units, seed, scope clarified |
| Tester (real browser, real key presses) | **pass**, 17 of 17 criteria | adherence, cap, confidence keep 85 / 85 / 95; claims with adherence 85 gives recommended 37, gross 48, N_min 36, equal to a direct engine run; defaults still 31/40, 27/34, 31/39; Run without Tab uses the typed value; zero console errors, zero network requests |
| Auditor (diff vs plan) | **pass** | all 26 inputs field-by-field equivalent; scope exact; no test weakened; docs accurate |
| Final challenger | **pass** | no crash on intermediate values (calendar window clamps at 0); no destructive effect per keystroke |

Gates: lint clean; `npm test` 174 + 541 + 60 green (new suite D54, 23 checks); trusted-source 164 green; `BoWFM.html` rebuilt; `check:artifact` fresh. `PRD.md` (v1.15.0) and `project_context.md` updated.

Backlog from the reviews (all minor, none blocking):
- H1-a: typing more decimals than a field allows (92.55) flips the display to 92.6 mid-typing; clamps on leave give no hint to the planner.
- H1-b: unmount commit uses the last-rendered handler; with a pending draft and an unmount that has no blur first it could write an old settings object over a newer one. No trigger found in normal use; harden by skipping the commit when the stored value changed since the draft was typed.
- H1-c: seed field has no upper bound (values beyond the safe-integer range accepted).
- H1-d: D54 covers the helpers and a source guard; `NumberField` behaviour itself is proven only in the browser.
- H1-e: adherence and shrinkage arrow-key step is now 0.1 (was 1).

---

# J0 + FIX G12 — protective tests — BUILT, awaiting owner approval (2026-10-06)

Branch `fix/g12-tests` (on top of `fix/h1-number-fields`), commit `61ba65f` (checkpoint `52315fe`).

**J0 (correction of TEST-4):** mutations applied to the real dispatch functions show EDF order IS protected by `npm test` (FIFO and reversed deadlines both fail). Open gaps found instead: priority tie-break untested (TEST-9), business-calendar `latestSafeStart` untested, parked-first rule protected by one check only.

**G12:** 48 new checks (suites D55-D61) in `scripts/verify-sizing-fixes.mts`; `computeStatisticalEvaluation` exported (keyword only); `npm test` now also runs the 164 trusted-source checks. Totals: 174 + 589 + 60 + 164 = 987, all green; lint clean; `check:artifact` fresh. No product behaviour changed.

| Broken rule (mutation) | Caught by a new check? (independent tester, full suite) |
|---|---|
| Priority tie-break removed | Yes: D55.1a, 1b, 4 |
| EDF to FIFO | Yes: D55.1-4 (now direct, not only digests) |
| Parked-first removed / inverted | Yes: D55.3a, 3b |
| `latestSafeStart` by wall clock (backlog site, demand site, both) | Yes: D56.1b, 1c, 2b |
| Primary gate on mean / on upper bound | Yes: D57.1c-e |
| Category / occupancy / ASA gate on mean | Yes: D57.3, D57.4, D57.5 |
| Normal 1.96 instead of the t-value | Yes: D57.1b, 2a |
| Common Random Numbers broken | Yes: D58.1, 2 |
| Unfinished cases dropped from the SLA denominator | Yes: D59.2, 3 |
| Gross HC by arithmetic blend / arithmetic effective shrinkage | Yes: D60.4 / D60.5 |
| Volume round to floor | Yes: D61.1 |

Closes TEST-1, TEST-4 (remaining part), TEST-5, TEST-6, TEST-7, TEST-8 (volume part), TEST-9, DOC-20, DOC-41. New tests pass under New York and UTC timezones; no tautologies found.

Open after G12:
- **G12-a (owner decision):** `scripts/verify-trusted-source.mts:75-83` aborts unless the PC timezone is `Asia/Dubai`. Now that it is part of `npm test`, `npm test` fails on any machine in another timezone (and the freshness gate after it never runs). Green on this PC (Dubai). Options: keep (team is all in Dubai), or relax the guard to a warning / force the timezone inside the script.
- G12-b (minor): a CI lower bound exactly equal to the target (`>=` vs `>`) is not pinned by any test.
- G12-c (minor): `CaseMinHeap.compare` ordering is untested and does not decide dispatch (DES-15); docs still name it as real dispatch (DOC-40, fix J1).
- Stale doc lines left: `PRD.md:9` file size; `project_context.md:887`, `:938` "both suites".

---

# FIX G1 — planning horizon from demand data only — BUILT, awaiting owner approval (2026-10-06)

Branch `fix/g1-horizon` (stacked on `fix/g12-tests`), commit `920f3fd` (checkpoint `6f6b001`). Also on `fix/g12-tests`: `4f6a2a7` trusted-source timezone lock relaxed to a warning (164/164 green in 6 timezones). Closes CSV-13, CSV-14 (isolated stray date), and the three-copy horizon duplication. Weekly cap raised by the owner to 30%.

Owner decisions applied: stray isolated date blocks the run; backlog already overdue at the plan start is excluded from the SLA % and wait-time checks and reported separately.

| Scenario (Mon-Fri week, 540 cases, AHT 30) | Before: days / N_min / recommended | After |
|---|---|---|
| No backlog | 5 / 7 / 8 | 5 / 7 / 8 |
| + 1 backlog case 14 days old, 6 h SLA | 15 / 2 / 7 | 5 / 7 / 8 |
| + 1 backlog case 14 days old, 3-day SLA | 15 / 2 / 5 | 5 / 7 / 8 |
| + 50 old backlog cases | 15 / 2 / 7 | 5 / 7 / 8 (workload +25 h, all worked) |
| + 40 backlog cases overdue at start (2 h SLA) | n/a | 40 flagged, all completed, SLA 532/540 over the rest, recommended 10 |

| Reviewer | Verdict | Evidence |
|---|---|---|
| Plan challenger | fail, then plan revised | found the overdue-at-start problem before any code was written |
| Builder gates | green | red-first: 34 new checks failed on the old engine; lint clean; `npm test` 174 + 643 + 60 + 164 = 1,041; `test:audit` 24/24 sample headcounts identical; artifact fresh; no existing test expectation changed |
| Tester (own scripts + browser) | **pass**, 12 of 12 | numbers recomputed by hand; sync = async; zero work before the horizon; note, badge and blocking message seen on screen; samples 31/40, 27/34, 31/39; zero console errors |
| Auditor | **pass** | scope exact; exclusion applied consistently; frozen decisions untouched; sync and async edits identical |
| Final challenger | **pass**, with dissent | see open items |

Open after G1:
- **G1-a (major, recommended next):** a stray date within 30 days of the data (e.g. a month typo) still stretches the horizon with only a warning: probe N_min 7 to 3, recommended 8 to 7. Proposed rule: block when the smaller side is isolated (no more than 1% of rows) and the gap exceeds max(14 calendar days, length of the main data span).
- G1-b (minor): excluded backlog has no completion requirement in the gate; EDF works it first and the tester saw all completed, but add a warning when any overdue-at-start case is left unfinished.
- G1-c (accepted consequence of the owner rule): a backlog case just inside its deadline is scored, one a few minutes older is excluded, so older backlog can give a slightly lower headcount. Bounded: excluded cases still add workload and are worked first.
- G1-d (minor): one day of demand plus a week of attainable dated backlog now packs all workload into one capacity day (over-sizes, no note).
- G1-e (minor): wait time for attainable old backlog is measured from the plan start; label it. Case CSV still shows FAIL for a late flagged case next to the new column; per-case wait is still listed for flagged cases.
- G1-f (minor): data-quality check swallows an engine error silently when counting overdue backlog on a broken calendar; hand-rolled day arithmetic in `csv-parser.ts` (message and block decision only, DST-safe).
- Correction to my brief: a Friday 15:00 backlog case with a 6-business-hour SLA is NOT overdue on Monday under the default 08:00-18:00 calendar (due Monday 11:00); the engine handled it correctly.

---

# FIX G1-a — tighter stray-date rule — BUILT, awaiting owner approval (2026-10-06)

Branch `fix/g1a-stray-date` (stacked on `fix/g1-horizon`), commit `64c3acd` (checkpoint `555a10c`). Weekly cap raised by the owner to 35%.

Rule: an isolated date (no more than 1% of rows, 1 to 20 rows) separated from the rest of the data by more than 7 empty calendar days blocks the run (was more than 30). Closes G1-a.

| Check | Result |
|---|---|
| Builder gates | red-first (5 new checks failed on the old rule); lint clean; `npm test` 174 + 652 + 60 + 164 = 1,050; sample audit 24/24 identical; artifact fresh. Two existing expectations changed, both stating the old 30-day rule (D62.42, D62.44) — necessary consequence, accepted. |
| Supervisor diff read | one condition (`+32` days to `+9`), message text, and a guard keeping the separate long-gap warning at more than 30 days. Nothing else. |
| Tester (own script + browser) | **pass** 10/10: stray row 10 days after, 9 days before, and a month typo all block with the date, row count, range and empty-day count; exactly 7 empty days does not block, 8 does; consecutive weeks, a 9-day closure with data both sides, and small two-day files do not block; three samples unaffected; blocking message and disabled Run seen on screen; claims still 31 / 40. |

Residual (minor, by design): a stray block of more than 20 rows, or a stray row within 7 empty days, still only warns (probe: 30 stray rows 10 days out stretch 5 working days to 11).

Usage: weekly meter 30% after the build.

---

# FIX F2 — 24x7 parked work resumes when capacity exists — BUILT, awaiting owner approval (2026-10-06)

Branch `fix/f2-24x7-resume` (from `main`), commit `de1a7c3` (checkpoint `819d592`). Closes DES-8. Engine change: two `is24x7` midnight-resume branches in `des-engine.ts` (`CasePark`, dead copy in `DayClose`) replaced by the same `nextOpen` call every other calendar uses. Hand-rolled date maths removed with them.

| Check | Result |
|---|---|
| Plan challenger | pass: no livelock (a budget park uses the whole remaining budget; agents with no budget are skipped) |
| Builder gates | red-first: 5 new checks failed on the old engine; lint clean; `npm test` 174 + 671 + 60 + 164 = 1,069; sample audit 24/24 identical; artifact fresh. One existing expectation re-pinned: D43.14 digest (24x7, budget parks; SLA 100% before and after, parks 12 to 9). No business-hours or trusted-source value changed. |
| Supervisor diff read | engine diff is exactly the two branch removals |
| Tester (own tally + browser) | **pass**: avoidable waits 4 to 0 (one shift) and 5 to 0 (staggered, 4,132 avoidable minutes to 0); CASE-000002 now resumes Mon 08:00 on the next cohort, was Tue 00:00; legitimate waits kept (single agent exhausted resumes at the midnight reset); 0 over-budget, 0 out-of-shift, 0 overlap, work conserved 3,840 = 3,840; SLA now non-decreasing in headcount (16 agents 100%, was 98%); deterministic; re-adding the branch fails D64.1, .2, .5, .6, .11 and D43.14; page loads clean, claims 31 / 40. |

Not run: final challenger (meter 32-33%, cap 35%). Builder skipped test (i) (zero budget everywhere cannot be built: adherence is clamped at 0.1); covered by the single-agent exhausted case.

Unchanged and still open (known HC-14, fix F1/G8): the claims sample switched to 24x7 with Min-coverage ON (the default) returns "search infeasible" at the 500 cap (coverage: 0 agents on shift in an open interval). This is the documented single-shift-cannot-cover-24-hours limit, present before F2; F2 does not address it.

---

# FIX F3 — statistics describe the adopted roster — BUILT, awaiting owner approval (2026-10-07)

Branch `fix/f3-post-polish-stats` (from `main`), commit `c062491` (checkpoint `630b697`). Closes HC-15. Weekly cap raised by the owner to 40% (assumed +5 step). Only runs with shift placement ON (default OFF) and an adopted polished roster are affected.

| Check | Result |
|---|---|
| Plan challenger | fail on test design, plan revised (headline-vs-block agreement redefined; full list of fields that may change) |
| Builder gates | red-first on 3 pooled seeds and 1 siloed fixture; lint clean; `npm test` 174 + 722 + 60 + 164 = 1,120; sample audit 24/24 identical; artifact fresh; no existing expectation changed |
| Supervisor diff read | one key helper, one lookup helper, parallel edits in sync and async; no extra simulations |
| Tester | **pass**: seeds 42 / 7 / 99: confidence block and history row for N now 100, CI [100, 100], equal to an independent evaluation of the adopted roster (were 94.3, [94.1, 94.5]); recommended N, adopted roster and polish status unchanged; headline equals the representative run; sync = async; three samples 31/40, 27/34, 31/39; removing the assignment fails 12 checks, removing it in async only fails the 4 sync = async checks; page runs clean with placement ON |

Before / after on the polish fixture (seed 42, N = 9): block 94.3 [94.1, 94.5] to 100 [100, 100]; history row wait time 29.9 to 5.9 min; headline wait time 7.7 to 5.9 min; N-1 evidence wait time 14.8 to 14.2 min. Siloed fixture (N = 19): block 99.9 [99.9, 100] to 99.5 [99.5, 99.6], headline 99.6 to 99.5 — the old block was optimistic there.

Open (not F3):
- F3-a (minor, to investigate): with placement OFF the search reports 94.3 at N = 9 on this fixture while a direct evaluation with no roster gives 100 — same before F3. Probable cause: the default pre-polish roster is the min-coverage repair roster, not a uniform one (related to P2-A2 / F1). Not confirmed.
- Final challenger not run (meter 34-35%). Browser evidence is weak for this fix (claims sample shows 100 to 100); the engine-level checks carry the proof.

---

# Input safety part 1 (G2 + H2) — verification, 2026-10-07

- Build: commit on `fix/input-safety-1`; `npm test` 1,161 green (174 + 763 + 60 + 164), lint clean, artifact fresh. New suite D66 (41 checks).
- Tester: PASS. Semicolon file `12,5 / 7,25 / 11,5` totals 31.25 (old reader 1,055). Quoted `1,234` in comma file still 1234. `2h`, `abc`, `12..5`, `1e9` block the run with the row named. Ambiguous-only column blocked with both readings; mixed formats blocked. Backlog fallback uses the category AHT and priority (20 / 3, not 30 / 1). Samples identical to the old reader (300/1380, 280/1572, 600/2190); browser gross 40 / 34 / 39, zero console errors. Tick-box gate works for Append and Replace. Mutation (`parseFloat`) fails 10 D66 checks.
- Auditor: PASS, no blocker or major. Scope clean, engine files untouched.
- Deviations accepted: tick-box also gates Replace; whitespace-only volume cell treated as blank; message prefixes used to classify issues; date-default count only when a date column is mapped.
- Deviation needing owner yes (IS1-a): backlog remaining minutes of exactly 0 now fall back to the category AHT (plan said keep zero). Supervisor brief error, not builder error.
- Open minors: IS1-b leading plus sign (`+5`) and trailing or doubled currency symbol now blocked (were read before; fails loudly). IS1-c `project_context.md:201` still says 14 data-quality rules (PRD says 24). IS1-d `PRD.md:1151` suite list stops at D64. IS1-e docs/wfm/07 entry lost a backslash in a quoted pattern. IS1-f preview label for blank remaining minutes does not match what is counted; unmatched-category fact shown twice. IS1-g fractional warning does not show an example of the rounding. IS1-h no test for `+5`, `.5`, `5.`, zero-numeric column. IS1-i tester saw 0 as typed / 10 adjusted on a file with 5 unknown categories; auditor says the count is per row and other fallbacks explain it; per-reason lines not re-read.
- Final challenger not run (budget).

---

# Input safety part 2 (G3 option B + G5) — verification, 2026-10-07

- Owner chose G3 option B: keep conversion to the PC timezone, add a warning.
- Build: commit on `fix/input-safety-2`; `npm test` 1,191 green (174 + 793 + 60 + 164), lint clean, artifact fresh. New suite D67 (30 checks). PRD v1.19.0, data-quality rules 26.
- Tester: PASS, 13 of 13 checks run. Date reader returns identical instants before and after for 9 inputs under Dubai, UTC and New York. Marker warning shows count, markers and PC offset; not blocking. `Billing` / `billing ` / `BILLING` → one category, volume equals hand sum (21); variant file and clean file give identical intervals and categories (old build: 4 categories). Re-sync keeps id, AHT 12, shrinkage 10% and renames the stored backlog case. Samples unchanged (300/1380, 280/1572, 600/2190; gross 40 / 34 / 39), zero console errors. Mutations: no lower-casing → 12+ D67 failures; marker detection off → 6 D67 failures. Scope: exactly the 10 allowed files, test file additions only.
- Auditor and final challenger NOT run (meter 39% of 40% cap).
- Builder deviations (accepted): backlog rename derived from interval spelling by key, not from the returned rename list (same result, avoids stale state on reset + upload); tests written after code (no red run) — covered by tester mutations; two optional fields added to `StandardInterval` in `types/wfm.ts`.
- Open minors: IS2-a starting-values note (needs an edited marker in Settings). IS2-b two existing categories with the same key: the dropped one is reported by the function but not shown on screen. IS2-c spacing-only rename (`Bill  ing` → `Bill ing`) gets no note. IS2-d row count in the merge note counts only rows whose spelling changed. IS2-e re-upload with backlog loaded cannot be reached in the UI (second upload forces a full reset, same as before) so the rename path is proven at engine level only. IS2-f settings-file import is not remapped until the next sync.
- Auditor (run after the note above): PASS, no blocker or major. Date reader refactor is text-identical apart from the shared pattern; backlog rename returns the same list when nothing changes (no loop); every interval category has a matching category; new optional interval fields are not read outside `csv-parser.ts`. Minors: IS2-g marker count includes rows whose date is invalid on the demand path; IS2-h epoch detection differs from the reader for a whitespace-only time cell (warning text only).

---

# Input safety part 3, Build A (G4 + H6 reader rules) — verification, 2026-10-07

- Plan failed its first challenge (bad file on a loaded session would wipe it; short rows blocked; empty file unreachable; encoding; state location) → redesigned: files with an error are refused at pick time, session untouched. Split into Build A (this) and Build B (upload traps + naming the unmapped column; NOT built yet).
- Build: first builder cut off by a login error after finishing the code; second builder verified and wrote the docs. New suite D68 (43 checks after rework). PRD v1.20.0, data-quality rules 27.
- Tester: PASS. Each rule checked with own fixtures in the engine and the browser: binary / NUL, empty, header-only, unclosed quote (row named), extra cell (row named), title row → refused with a plain message, loaded sample untouched, no reset prompt. Short row and duplicate header accepted with a warning. Pipe file with comma decimals totals 17 (hand sum). Samples and clean comma / semicolon / tab files identical to the old reader; gross 40 / 34 / 39; zero console errors. Backlog binary file refused, good file imports afterwards. Mutations: unclosed-quote check off → 3 D68 failures; extra-cell check off → 2.
- Auditor: FAIL on one major, fixed in rework round 1: the binary check refused any CSV whose first two characters are `PK` (e.g. header `PK,Start,Volume`). Now matches the real zip signature only; two new checks (D68.14a/b). Doc rule counts aligned at 27 in three places. After rework: sizing suite 836 / 0, lint clean, artifact fresh. Full `npm test` last run before the rework: 1,232 green. Auditor not re-run on the two-line fix (budget).
- Open minors: IS3-a balanced mid-cell quotes still merge cells (owner decision). IS3-b a footer line such as `Total,5000` is accepted with a warning but its 5,000 is counted until the invalid-date check blocks the run; the date message numbers data rows, not file rows. IS3-c a title row containing a comma is refused as "more columns than the header" (hint mentions the title row). IS3-d a title row containing only a pipe now selects pipe as delimiter (still refused). IS3-e Latin-1 files only warn. IS3-f Build B outstanding: same file picked twice, drop outside the box, out-of-order reads, unmapped column not named.

---

# Input safety part 3, Build B (UI-38, UI-39) — verification, 2026-10-07

- Build: commit on `fix/input-safety-3b`; `npm test` 1,239 green (174 + 841 + 60 + 164), lint clean, artifact fresh. Suite D69 (5 checks). PRD patch version bump.
- Tester: PASS, no blocker or major. Same file re-picked after editing on disk → new total shown (40 → 200). Drop and dragover on the page body are cancelled, data intact; drop on the drop box still loads. Pick A then B with the prompt open → B loads. Refused pick closes the prompt, session intact. Data Quality tab reads "Choose the column for: Volume." when unmapped. Samples gross 40 / 34 / 39, zero console errors. Scope: 8 allowed files; test diff = additions plus one edited import line.
- Auditor and final challenger not run (Tier 2 UI change, budget).
- Open minors: IS3B-a backlog path only partly browser-tested (input clears, preview shows; re-read, sequence guard and drop guard on the backlog box read in code only). IS3B-b PRD has no prose on the upload behaviour (version, inventory and D69 only). IS3B-c drop-box comparison with the old build not run.

---

# Stale results after data edits (G6 + H9: UI-1, UI-49, UI-58) — verification, 2026-10-07

- Plan challenge: PASS with majors, accepted (no header chip exists → new "Outdated" marker in the navigation; mapping not stored, interval fingerprint covers it; fingerprints by category name, captured at run start).
- Build: commit on `fix/stale-results`; `npm test` 1,256 green (174 + 858 + 60 + 164), lint clean, artifact fresh. Suite D70 (17 checks). PRD v1.20.2.
- Tester: PASS, no blocker or major, zero console errors. Samples 31/40, 27/34, 31/39 with no banner after a run. Backlog case added → banner "Data changed since this run (opening backlog)…" and navigation OUTDATED; same case deleted → cleared. Backlog import → banner; re-run → cleared. Volume mapping switched → banner (demand data); switched back → cleared. Settings change → existing banner; settings + backlog → both named. Tab visits → no false flag. Fingerprints: equal for separately built equal data, independent of ids, 100,000 intervals in 146 ms. Mutations: volume ignored → 2 D70 failures; diff always empty → 11.
- Sensitivity builds its own scenarios from live data; Agent Analytics reads run output only — neither mixes old results with new data (SR-b closed).
- Auditor and final challenger not run (budget; owner asked to stop after this fix).
- Open minors: SR-a exports carry no stale note. SR-c banner says "run again" without naming the Run tab. SR-d category-column mapping swap and SLA change-and-revert not browser-tested (volume swap and adherence revert were). SR-e re-run with a backlog big enough to move the headcount not shown. SR-f missing space in an import line in `run-inputs.ts` (cosmetic).

---

# FINDINGS — Agent Analytics: Scheduled (min) capped at the agent's own shift (2026-10-07)

Plan: last section of `PLAN.md`. Checkpoint `d56809d`; build `a8e1d28`; rework 1 `617f516`. Tier 3.

## Plan challenge (before build)

| ID | Severity | Finding | Verdict |
|---|---|---|---|
| PC-1 | major | Cap used the category-filtered `avail`, so the 300 min/day phantom tail survived under a category filter (ran: Gold, Agent-1 = avail + 9,300) | Accepted — `busyAll` + AA.38 + A3b added to plan |
| PC-2 | major | A3 understated what moves on screen (team row, utilisation CV / Jain, insight line, bars) | Accepted — A3 widened |
| PC-3 | minor | Non-staggered long-day runs still read ~50% | Stated limit, PRD L20 |

## Review round 1 (after build)

| ID | Reviewer | Severity | Finding | Evidence | Verdict |
|---|---|---|---|---|---|
| R1-1 | challenger | major | `DEFINITIONS` said occupancy = utilisation whenever budget not exhausted; false with shift placement off (ran: occ 53.8 / util 49.4, no budget exhausted) | AgentAnalyticsPanel.tsx:33 (at a8e1d28) | Rework 1 — fixed, text scoped to shift placement on |
| R1-2 | user-side | major | Off-mode warning buried in hover; did not say "expected, not an error" | AgentAnalyticsPanel.tsx:283-286 (at a8e1d28) | Rework 1 — now in visible paragraph |
| R1-3 | user-side | major | Did not say equal columns are normal with shift placement on; "budget" jargon; hard-to-parse Scheduled definition; "whole business day" vs "to close" | same | Rework 1 — fixed |
| R1-4 | user-side | major | Export has no legend for `Scheduled (min)` / `On-Shift Days`; the 300-min part-day (32nd on-shift day) is unexplained in the CSV | agent-analytics.ts export builder | NOT reworked — outside approved scope (export structure, AA.27). User decision |
| R1-5 | user-side | major | Panel does not show which mode (shift placement on/off) the run used | AgentAnalyticsPanel.tsx help paragraph | NOT reworked — needs panel logic, outside approved text-only scope. User decision |
| R1-6 | challenger | minor | Drain day (1 Nov): early cohort scheduled 300 = available, not 540. Never above 540 (0 of 1,489 agent-days at adherence 1.0 / 0.9 / 0.8) | SP/atk.mts | Backlog; documented PRD L20 |
| R1-7 | challenger | minor | Utilisation under a category filter on pooled agents is "share of shift spent on that category", not additive (24.9 + 70.1 + 40.9). Pre-existing (FINDINGS UI-2), not worsened | SP/atk.mts | Backlog |
| R1-8 | challenger | minor | Unpinned: exact scheduledMin at adherence 0.8, team row, export column, drain-day shape | verify-agent-analytics.mts | Backlog |
| R1-9 | tester / auditor | minor | AA.36b and AA.39 are controls (pass on old code); AA.33–38 + AA.32b fail on old code (63/7 reproduced independently by both) | old-code suite run | No action |
| R1-10 | auditor | minor | `project_context.md` ~line 877 lists sizing suite as 834; suite prints 858. Pre-existing, untouched | project_context.md:877 | Backlog |
| R1-11 | tester | minor | Browser walk did not open Data Quality / Opening WIP sub-tabs | — | Noted |

Passed with evidence: tester A2, A3 (all 47 rows + team + fairness + insights + export diffed old vs new; only allowed fields moved), A3b, A4 (non-staggered byte-identical, 8 combinations + real file), A5–A9; real browser run recommended N = 47, Agent-1 Scheduled 17,040 / Utilisation 77.3%, Agent-33 16,740 / 77.1%, zero console errors. Auditor: scope lock held, A1 / A9 / A10 / A11 pass. Challenger: analytics utilisation = engine `agentFairness.utilPct` for all 47 agents (max diff 0.00); scheduled additive across date ranges.

## Rework 1 recheck (user-side)

Verdict pass. All six wording points resolved. Minors left: `Available (min)` header hover still says "in queue" (AgentAnalyticsPanel.tsx:374, outside the three allowed text spots); visible paragraph ~90 words; text does not say "do not size from this column".

## Backlog (minor)

- Export legend / notes for `Scheduled (min)` and `On-Shift Days`, incl. the part-day after the data ends (R1-4).
- On-screen "Shift placement: on/off" note for the run shown (R1-5).
- `Available (min)` tooltip "in queue" wording.
- R1-6, R1-7, R1-8, R1-10.

---

# FINDINGS — Agent Analytics follow-ups: backlog closed (2026-10-07)

Plan: `~/.claude/plans/plan-for-fixing-this-precious-thunder.md`. Base `5338acc`. PRD 1.20.4.

| Backlog item | Status |
|---|---|
| R1-4 export legend | Closed — third CSV section "Notes - how to read this file" |
| R1-5 mode shown on panel | Closed — pill "Shifts: fixed length" / "Shifts: open until close" + mode line (amber when open and the business day is longer than the productive hours) |
| Non-fixed-shift runs read ~50% | Explained on screen and in export; number unchanged. Engine change logged as PRD §11 P2-9 (needs approval) |
| `Available (min)` tooltip "in queue" | Closed |
| R1-6 part-day after data ends | Closed — date named on the status line and in the export; minutes stay as actually worked |
| R1-7 category filter on a shared pool | Closed — note shown only when that filter is active |
| R1-8 unpinned figures | Closed — AA.45 group |
| R1-10 stale test counts | Closed — 174 + 858 + 87 + 164 = 1,283 |

## Verification (investigator, ran it)

- No number moved: old vs new `computeAgentAnalytics`, insights and export sections 0–1 identical on the real file in six cases (fixed / open shifts × unfiltered / Gold filter / end date 31 Oct). Only the three new fields and the third export section differ.
- Real page, real file: HC 47; Agent-1 17,040 / 77.3%; part-day sentence names 2026-11-01 and disappears with end date 31 Oct; category note appears with a filter and clears on reset; export has the Notes section; zero console errors; all Results tabs render.
- Open-shift run (shift placement off and minimum coverage off): HC 46, amber line shown, Agent-1 occupancy 55.4% / utilisation 50.4%.

## Findings raised and fixed in rework

| ID | Severity | Finding | Fix |
|---|---|---|---|
| F-1 | major | Category note said Available is the agent's whole time on shift; it is filtered busy + all idle (Agent-1: 6,230.9 filtered vs 17,040 unfiltered). The wrong wording came from the plan, not the builder | Note rewritten; AA.44d tightened; AA.44f pins the numbers |
| F-2 | major | Pill said "Shift placement: on" with the switch off, because minimum coverage still staggers starts (`hc-search.ts` ~2567, coverage repair is unconditional) | Label and notes now describe the run ("fixed length" / "open until close"), and say when shifts are fixed |
| F-3 | minor | Part-day note said "some agents"; with open shifts it is all agents | Reworded |

Not re-run after the rework: the full sizing run in the browser. The rework changed strings only; page load, lint and the full suite (1,283, 0 failed) were re-run and the new labels are present in `BoWFM.html`.

---

# FINDINGS — Engine shift end for runs without placed starts (P2-9) — review round 1 (2026-10-08)

Checkpoint `c59dd89`; build `e2a6dda` (PRD 1.21.0). Tier 3. Rework NOT yet done — stopped at usage limit.

Passed with evidence: tester (all criteria; planner file 47 with coverage on, 48 with coverage off; equal-length day, 24x7 and explicit rosters identical; sync = async; real page clean; 1,331 checks, 0 failed). Auditor: 12 approved pins changed exactly as approved; engine diff limited to flag, lookup, result field, invariants; no frozen decision touched.

| ID | Reviewer | Severity | Finding | Status |
|---|---|---|---|---|
| E-1 | challenger | major | Coverage OFF + Shift Placement ON on the planner's file recommends 48, but 47 passes every gate with placed starts (32@0/15@300, CI low 80.8). The placement builder in `hc-search.ts:556-612` never tries that roster and the walk stops at the first fail. Search weakness, not physics; PRD wording that explains the rise as "evening unstaffed" is wrong for placement-ON runs. Fix is in `hc-search.ts` (outside approved scope) | OPEN — user decision |
| E-2 | challenger + user-side | major | When no headcount can reach the SLA with a single shift, Results says "Increase userMaxHC", which cannot help (`hc-search.ts:2788`, `3561`; `ResultsFlow.tsx:535-540`). No Results text explains a higher coverage-off number or the remedy | OPEN |
| E-3 | auditor | major | `npm run test:audit` now fails on the 4 infeasible WA cells (slaPct 46→32.6, 45.4→30.2, 45.3→29.9, 45.4→29.8); baseline not regenerated and no doc says so | OPEN — regenerate baseline or record |
| E-4 | user-side | major | Nothing on screen says results from earlier versions differ with coverage off | OPEN |
| E-5 | user-side | major | Coverage-floor warning is last in small grey text; "floor" also names the Workload Floor | OPEN |
| E-6 | minors | minor | ConfigFlow sentences lack a 24x7 qualifier; "byte-for-byte unchanged" line; off-state note mentions the repair stagger when coverage is off; D71.7c CI-gate test is a constructed case; stale history lines PRD:1308, project_context:1007; boundary rationale does not name the failing category | Backlog |

## P2-9 rework rounds 1 and 2 (2026-10-08) — builds `c0db0d5` and the following commit

| ID | Status |
|---|---|
| E-1 search recommends 48 where 47 passes with placed starts (coverage OFF + Shift Placement ON) | OPEN — recorded as PRD L23 and backlog P1-6; needs owner approval (search change) |
| E-2 Results gave no reason / told the planner to raise the cap | Fixed — amber note on feasible single-shift results; on infeasible ones the "raising the cap will not help" line leads and the "Increase userMaxHC" sentence is stripped at render time. Tester ran feasible (48), infeasible (97% in 2 h, cap 80) and 24x7 cases in the browser |
| E-3 audit baseline differs in 4 WA cells | Recorded in PRD §9.1, project_context, docs/audit/sample-hc-audit.md; baseline NOT regenerated — owner decision |
| E-4 earlier-version results differ | Fixed — sentence in the Results amber note |
| E-5 coverage-off warning easy to miss; two "floors" | Fixed — amber note under the switch while off, names the Workload Floor as a different switch; 24x7 variant |
| E-6 minors | Fixed: 24x7 qualifiers, "byte-for-byte", repair-stagger clause, "DES" label (ConfigFlow and ParamsPanel), stale history pointers. Left: D71.7c is a constructed CI-gate case; boundary rationale does not name the failing category |

Round 1 recheck: tester pass (8/8, zero console errors, 47 and 48 unchanged); user-side fail on one major (banner contradiction) → fixed in round 2 with floor-dependent remedy wording. Round 2 verified by gates (lint, 1,331 checks, artifact fresh) and page load; no further browser run of the infeasible banner after round 2. Rework cap (2) reached.

---

# FINDINGS — Search rescue ladder for Shift Placement (P1-6 / L23) (2026-10-08)

Checkpoint `7ad848f`; build `23973f6` (PRD 1.22.0). Reviewers this round: tester + auditor (user-side and final challenger skipped at the planner's request to speed up; the plan itself was challenged before build).

Plan challenge (before build): fail → amended. Major: a rescued headcount could be a one-seed hairline pass (support sample 27: 7 of 21 fresh seeds) → confirmation block added. Major: ~45 pins would lose their scenario → replacement suite D73 required.

Tester: pass, all criteria ran. Planner's own config 47, full result identical (0 differing fields). Coverage OFF + placement ON 48 → 47, roster `0:35 300:12`, passes 20/20 fresh seeds (pre-change 48 roster: 3/20). Nothing passes at 46 on any rung on three blocks. Shift Placement OFF: 6 results identical. D33 22 → 21; support stays 27 / 28. sync ≡ async; repeat run identical. Real page: both runs clean, zero console errors.
Auditor: pass. Only the 45 approved assertions changed; D73 covers all four polish paths; sync and async loops differ only in await/cancel/progress; acceptance always full R on both blocks with the unmodified gate; no frozen decision touched; lint, 1,493 checks, artifact fresh.

| ID | Severity | Finding | Status |
|---|---|---|---|
| S-1 | minor | Run cost when the ladder finds nothing: support sample coverage OFF 327 → 677 simulations (+107%); planner +8% / +14% | Accepted; help text says runs can take longer |
| S-2 | minor | No cancel-mid-ladder test (safe by inspection) | Backlog |
| S-3 | minor | Code comments cite "PRD P1-6 / L23", now removed from the PRD (still resolvable via docs/wfm/07) | Backlog |
| S-4 | minor | "Phase 3: Roster Coverage Polish" message static ~50 s in the page; not touched by this change, not compared with the old page | Backlog |
| S-5 | info | Existing weaknesses logged as PRD L24 / P1-7 (polish hairline margin) and L25 / P1-8 (thin-category gate) | Open, owner decision |
| S-6 | info | `npm run test:audit` still differs in the 4 WA cells (from P2-9); PON cells identical; baseline not regenerated | Open, owner decision |

---

# 2026-10-11 — three small items inside the last 6% of the weekly limit

- Step 1: the other session finished "Utilisation % hidden" change (PRD 1.22.1) verified and committed (`c80268b`): lint clean, `npm test` green, test counts corrected to 1,498.
- Step 2 (J1 + part of J4, docs only, `a1596df`): `CLAUDE.md` decision 2 and the Code Conventions bullet now name `pickNextCase` / `compareByUrgency` as real dispatch; `project_context.md` §3.2 (git repository exists, local commits only), §6 heading (eleven decisions), §6.2 and the troubleshooting row. Left open: PRD §7 still lists ten decisions (the eleventh, min-coverage presence, is not in the PRD); `project_context.md:346` still says "ten frozen decisions"; rest of the J4 sweep; J2.
- Step 3 (H3: UI-9, UI-10) on `fix/h3-results-truth`: search-history Primary SLA cell coloured by the confidence lower bound against the engine floor (`historyPrimaryPasses`, `src/utils/results-display.ts`) with a "CI low" line; the engine note `infeasibleAdjacentWarning` is shown under the headline SLA card ("Why this card is below target: …") and the card / category figure turn amber instead of red in that case. Suite D74 (6 checks). `npm test` 1,504 green (174 + 1,069 + 97 + 164). PRD v1.22.2.
- Tester: PASS, no blocker or major. Samples 31/40, 27/34, 31/39 unchanged, zero console errors. Every history row of the three samples: colour agrees with the primary gate (green beside "Fail" only where another gate failed, e.g. a category at 79.5%). Helper cases correct incl. equality and fallback. Mutation (median always) → D74.1, D74.2, D74.4 fail. Scope: 7 allowed files, no engine file.
- Open minors: H3-a the below-target note was not reproduced in the browser (no sample triggers it); its text and amber styling are checked by code-text test only. H3-b history layout with the extra line checked through the page structure, not by eye. H3-c amber is keyed on the presence of the warning only. Auditor and challenger not run (budget).

---

# H5 + H11 display fixes — verification, 2026-10-11

- Build on `fix/h5-h11-display`: idle agent in a separated-queue run shows the engine-assigned category (`des.agentFairness.perAgent[].category`) or "No cases handled"; replication note on the Run screen at 1 and at 2–29. Suite D75 (10 checks). `npm test` 1,514 green (174 + 1,079 + 97 + 164). PRD v1.22.3.
- Tester: PASS. Samples 31/40, 27/34, 31/39; zero console errors; notes appear at 10 and 1, gone at 30; run at 10 completes; helper cases correct; mutation → D75.1–3 fail; scope 8 allowed files, no engine file.
- Open minors: H5-a idle-agent label not seen on screen (no idle agent produced in the browser); logic covered by helper checks only. Auditor and challenger not run (Tier 1, budget).

# Decision framing — thin SLA margins (investigator, read-only, 2026-10-11)

- Correction: the record says 7 of 20 fresh seeds PASS at N=27 on the support sample (13 fail), not 7 fail. L24 sample recorded inconsistently (3 of 6 in PRD, 3 of 20 in project_context).
- P1-7 / L24: polish evaluates every step on the SAME case sets the search used (`hc-search.ts:3090-3130` sync, `:3908-3939` async); the confirmation block (`createConfirmationBlock` `:740`, built `:2828` / `:3535`, used by `createRescueSearch` `:914`) is never passed to it. Headcount unaffected (polish runs at fixed N).
- P1-8 / L25: per-category gate uses the same CI rule on few cases → verdict flips with the seed; headcount can be 1 low or 1 high by chance.
- L26: rescue ladder gives every queue the same late share; can only make headcount too HIGH; no measurement recorded.
- OWNER DECISIONS 2026-10-11: P1-7 → **confirm each polish step** on the confirmation block. P1-8 → owner asked for the best option → supervisor recommendation adopted: **flag thin categories in Results now (display only); stricter fresh-days check later after measurement**. L26 → leave as is until measured.

---

# P1-7 / L24 roster polish confirmed on fresh days — verification, 2026-10-11

- Plan failed its challenge (absolute rule would reject every polish when the headcount itself is marginal; per-queue verdicts; monotonicity; leakage into statistics) → RELATIVE rule: polish adopted only if not worse than the unpolished roster on the confirmation block.
- Build on `fix/p1-7-polish-confirm`: helpers `polishNotWorseOnConfirmation`, `polishConfirmPasses`, `pooledPolishFallbackOrder`, `mergePolishConfirmation`, `summarizePolishConfirmation` shared by both searches; optional result field `polishConfirmation { baselinePasses, adoptedPasses, evaluations }`. Suite D76 (32 checks). `npm test` 1,546 green (174 + 1,111 + 97 + 164). PRD v1.23.0; L24 and P1-7 removed; new open item P1-7-a.
- Tester: PASS. OLD vs NEW engine, three samples, Shift Placement OFF and ON: recommended / gross identical (31/40, 27/34, 31/39), adopted rosters identical, no measurable slowdown (2 extra evaluations). Sync = async; deterministic. Fresh days (10 seeds): adopted 10/10, unpolished 10/10 on claims and healthcare. Mutation (rule always true) → D76.1a, 1b, 1f, 1g, 1i fail. Browser: zero console errors. Scope: 7 allowed files.
- Auditor: PASS, no blocker or major. Rule equals the plan; sync and async call the same helpers; pooled fallback deterministic; confirmation results separate from displayed statistics; headcount path untouched.
- Open minors: P1-7-a headcount marginal when the unpolished roster itself fails on fresh days (not changed here). P1-7-b no REAL case found where the rule rejects a polish (builder and tester both looked) — reject branches proven on constructed cases only; real-fixture checks stay green under the mutation. P1-7-c cap detection (ASA / occupancy / coverage) in the baseline-fails branch matches message prefixes and fails OPEN if a message is reworded; `passesCoverage` boolean exists and should be used; pin the prefixes with a test. P1-7-d `adoptedPasses` falls back to the baseline verdict if the adopted vector has no confirmation evaluation (field not displayed). P1-7-e siloed fresh-day comparison not run. P1-7-f healthcare: adopted roster mean SLA on fresh days 86.2% vs unpolished 86.7% (both pass 10/10) — polish optimises coverage, not SLA. P1-7-g an accidental edit of the RESULTS line in the test file was restored by the supervisor (space after the colon).
- Final challenger not run (limit).

- P1-7-c CLOSED 2026-10-11 (`fix/p1-7c-cap-signal`): the polish rule reads explicit booleans (`passesCoverage`, `passesBoAsaCap`, `passesOccupancyCap`, set where the matching failure message is pushed) instead of message prefixes. Suite D77 (11 checks). One existing check edited with reason: D76.1i fed a bare reason string, which the new rule correctly ignores; it now passes the flag. Full `npm test` 1,556 green (174 + 1,121 + 97 + 164), lint clean, artifact fresh. No reviewer run (limit); supervisor ran the full suite. Remaining prefix reader: `hc-search.ts:~1030` coverage-only repair check (fails closed) — open item P1-7-h.
- NEXT after the weekly reset (owner decisions already given): thin-category flag in Results (display only; threshold to be measured first), then 24x7 minimum coverage (F1 + G8, owner design decision), H4, H10 / H8, G7 numbers (confirm with owner), F4–F7, G9, G10, J2, rest of J4, G13, F9, minor backlog, never-audited areas.

---

# Item 1 (spread layout, F1 + G8 / HC-14) — re-check on today code, 2026-10-11 (investigator, probes in scratch `f1/`)

- **HC-14 still reproduces.** 24x7, 7 days, 6 cases per 30 min, AHT 30, SLA 80% in 6 h, 5 replications, max 80: Minimum Coverage ON → no recommendation (infeasible), with Shift Placement OFF and ON alike; Minimum Coverage OFF → 20 (N_min 19). Settings: `sla.minCoverageEnabled`, `labor.shiftPlacementEnabled`.
- **New fact to explain BEFORE designing:** the failure message at N=80 says coverage was as low as 0 agents on shift in an open interval. With 80 agents that should not happen if one agent sits on each extra start. Cause not verified — possibly how presence is counted on 24x7 after the 8 Oct shift-end change (P2-9: 24x7 without placed starts keeps agents around the clock; with a repair roster agents have fixed shifts) or across midnight. If presence is wrong, a spread layout alone will NOT fix HC-14. First build step = dump the repair roster and per-interval presence at N=24 and N=80.
- Rescue ladder returns no rungs on 24x7 (`hc-search.ts:~801`) and needs Shift Placement ON, so it never helps this case.
- **G8 example not reproduced:** `AJM_Only.csv`, answer-time target 60 min, non-24x7: coverage ON 28, coverage OFF 29 (audit said 46 vs about 34 for the "support sample"; `project_context.md:532` says support coverage OFF stays 28). The audit figure may be stale or from another file; re-measure on the built-in support sample before promising a reduction to the owner.
- Where layouts are chosen (sync `evaluateN`): `planCoverageRepair` `~2919` (defined `~976-999`), repair-first `~2934-2938`, uniform then repair `~2940-2955`, analytic placement `~2961-2990`, rescue ladder `~2994-3011`; async twin near `~3788`. Repair builder `buildCoverageRepairDistribution` `~650-701` (surplus at offset 0 at `~677-679`). Shared helpers already exist: `planCoverageRepair`, `coverageRepairReasons`, `resolveCoverageBinding`.
- D33 (docs/wfm/07 `~426-441`): repair moves the fewest agents to later starts, rest at offset 0. Tests pinning it: D33.1–D33.8, D36, D37, D42.15.
- Suggested design (to be challenged): `buildSpreadDistribution` beside the repair builder (same cover starts, seats split as evenly as possible, floor of the minimum per start); `planCoverageRepair` also returns it; both searches try it only AFTER repair fails, through the same gate; binding label must not blame coverage when the spread passes. Risk: none of today passing results may change; extra evaluation at every failing N; D33 / D36 / D37 and the audit baseline may move.
- Status: investigation only; no code changed. Weekly limit reached (98%). Resume here after the reset: (1) explain the zero-coverage reading, (2) re-measure G8 on the support sample, (3) plan → challenger → build.

- **Zero-coverage reading explained (investigator, probes `f1/b.mts`, `f1/c.mts`), 2026-10-11:** it is NOT a presence or counting fault. Shift = 7.5 h (`dailyProductiveHours` default), cover starts 0, 450, 900, 990 min; repair roster at N=80 is `{0:77, 450:1, 900:1, 990:1}` and never drops below 1 on shift (`minCoverageObserved = 1`). The "as few as 0 agents" text comes from the UNIFORM candidate (everyone at offset 0, nobody on shift for 16.5 h), which on 24x7 is evaluated first and whose reasons are shown when the repair then fails (`hc-search.ts:~2919-2957`; async `~3683-3735`). The real blocker is SLA: repair roster gives 47.1% at N=24 and 55.6% at N=80 against 80%, because 77 of 80 agents work 00:00–07:30 only. Frozen decision 11 needs no change.
- So item 1 has TWO parts: (a) spread layout tried after the repair layout fails (the owner decision) — an even split across the same four cover starts is expected to pass near the coverage-OFF headcount (20); not yet tested; (b) message: when repair was tried and failed, show the repair reasons (SLA), never the uniform zero-coverage line; drop the "increase max HC" advice.
- Status at stop (weekly limit ~99%): investigation complete, no code changed. Resume after the reset with: quick test of an even split at N=20..24 (probe), re-measure G8 on the built-in support sample, then plan → challenger → build.

- **Even split confirmed as the fix (probe `f1/d.mts`, 5 replications, seed 42), 2026-10-11:** the same 24x7 scenario with agents split evenly across the EXISTING four cover starts (0 / 450 / 900 / 990 min) passes the unmodified gate at N=20 (SLA 100%, minimum coverage 5) — equal to the coverage-OFF headcount; N=19 fails on the occupancy cap (101.1%), not coverage. A three-start split (0 / 450 / 900) never passes: 22:30–24:00 is uncovered. So the cover starts are fine; only the placement of the surplus must change. Not yet tested: whether one seed / 5 replications holds at 30; peaky overnight demand; the search actually reaching this layout.

# Item 1 build — before/after measurements (2026-10-14)

Before = checkpoint 7f18f7a (`src` copy). After = Item 1 build (spread layout tried when the coverage-repair roster fails; confirmed on the second replication block; reported failing roster = spread / repair, A4). Sync search, defaults (`DEFAULT_SLA`, `DEFAULT_LABOR`, `DEFAULT_CALENDAR`, seed and replications from `DEFAULT_SIM_PARAMS`, pooled) unless stated. Runtime = wall clock of one `searchOptimalHC` call, one job at a time, nothing else running; before and after run back to back (before first).

| Case | Recommended HC | Gross HC | Roster (late-start offset : agents) | Binding label | Runtime s (ratio) |
|---|---|---|---|---|---|
| claims, coverage ON | 31 -> 31 | 40 -> 40 | 0:30 150:1 -> same | analytical_baseline -> same | 1.8 -> 1.4 (0.80x) |
| support, coverage ON | 27 -> 27 | 34 -> 34 | 0:26 150:1 -> same | statistical_primary_sla -> same | 4.2 -> 5.1 (1.19x) |
| healthcare, coverage ON | 31 -> 31 | 39 -> 39 | 0:30 150:1 -> same | statistical_primary_sla -> same | 8.2 -> 8.9 (1.09x) |
| claims / support / healthcare, coverage OFF | 31 / 28 / 31 -> same | 40 / 35 / 39 -> same | uniform | unchanged | 1.5 -> 1.1, 3.4 -> 2.7, 7.8 -> 8.0 |
| **support + answer-time 60 min, ON** | **46 -> 43** | **58 -> 54** | **0:45 150:1 -> 0:22 150:21** | statistical_primary_sla -> same | 8.7 -> 16.9 (**1.93x**) |
| support + answer-time 60 min, OFF | 46 -> 46 | 58 -> 58 | uniform | unchanged | 9.1 -> 6.9 (0.76x) |
| AJM_Only, ON | 16 -> 16 | 20 -> 20 | 0:15 150:1 -> same | statistical_primary_sla -> same | 8.1 -> 9.8 (1.21x) |
| AJM_Only, OFF | 17 -> 17 | 21 -> 21 | uniform | unchanged | 6.1 -> 5.8 (0.94x) |
| AJM_Only + answer-time 60, ON | 28 -> 28 | 35 -> 35 | 0:27 150:1 -> same | statistical_primary_sla -> same | 24.2 -> 26.5 (1.09x) |
| AJM_Only + answer-time 60, OFF | 29 -> 29 | 36 -> 36 | uniform | unchanged | 22.2 -> 35.0 (1.57x, see note) |
| AJM_Simu (test_files), ON | 123 -> 123 | 154 -> 154 | 0:122 150:1 -> same | statistical_primary_sla -> same | 149.4 -> 214.6 (**1.44x**) |
| AJM_Simu, OFF | 123 -> 123 | 154 -> 154 | uniform | unchanged | 123.8 -> 137.3 (1.11x) |
| EGS_Only, ON | 100 -> 100 | 125 -> 125 | 0:99 150:1 -> same | statistical_primary_sla -> same | 254.3 -> 352.8 (**1.39x**) |
| EGS_Only, OFF | 100 -> 100 | 125 -> 125 | uniform | unchanged | 340.1 -> 266.5 (0.78x) |
| **D33 fixture (14 h window, 9 h shift), ON** | **22 -> 21** | **24 -> 23** | **0:21 300:1 -> 0:11 300:10** | statistical_primary_sla -> analytical_baseline (Occupancy-Feasible Capacity Floor, N_occ = 21) | 1.2 -> 1.5 (1.24x) |
| D33 fixture, OFF | 28 -> 28 | 31 -> 31 | uniform | unchanged | 1.7 -> 1.4 (0.86x) |
| **HC-14 24x7 (7 days, 6 cases / 30 min, AHT 30, SLA 80 % / 6 h, R=5, max 80), ON** | **infeasible -> 20** | **140 (at the cap) -> 35** | **uniform -> 0:5 450:5 900:5 990:5** | analytical_baseline ("Infeasible at User Cap") -> analytical_baseline (Occupancy-Feasible Capacity Floor, N_occ = 20) | 2.0 -> 0.8 (0.37x) |
| HC-14 24x7, OFF | 20 -> 20 | 35 -> 35 | uniform | unchanged | 0.2 -> 0.2 |

Notes
- Every answer is after <= before. Moved: support + answer-time 60 ON (46 -> 43), D33 ON (22 -> 21), HC-14 ON (no answer -> 20). The three built-in samples at defaults are unchanged (31 / 27 / 31, gross 40 / 34 / 39).
- Coverage ON/OFF gap (A1): with Minimum Coverage OFF the search does not try the spread layout (spread needs a repair roster), so OFF can now exceed ON: support + answer-time 60 ON 43 vs OFF 46; D33 ON 21 vs OFF 28.
- Run time. Coverage-OFF rows run identical code before and after, yet vary 0.76x to 1.57x (AJM_Only + 60 OFF 1.57x): run-to-run noise on this machine is about +/-40 %, so ratios inside that band mean little. Coverage-ON rows above 1.5x: support + answer-time 60 (1.93x, 8.7 s -> 16.9 s): every failing N now evaluates the spread roster and, if it clears the primary block, the confirmation block. AJM_Simu 1.44x and EGS_Only 1.39x are inside the noise band but above 1.3x. HC-14 is faster (0.37x): it now finds an answer at the first candidate instead of walking to the cap.

## Group A re-pins (A11): fixtures whose headcount, gross HC and winning roster must NOT change

Per-fixture diff, checkpoint vs new (sync): recommended HC, gross HC, winning roster, the N / passed flags of the search history, and which result fields differ. A4: the N-1 audit run and the failing N's history rows now describe the coverage-satisfying roster (spread, else repair) instead of the uniform one.

| Fixture (test) | HC | Gross HC | Winning roster | History N / pass flags | Fields that differ |
|---|---|---|---|---|---|
| min, placement OFF, coverage ON (D72.10) | 9 -> 9 | 10 -> 10 | 0:8 240:1 -> same | 8F 9P -> same | boundaryEvidence, searchHistory (failing-N row) |
| smp-support, placement OFF, coverage ON (D72.10) | 27 -> 27 | 34 -> 34 | 0:26 150:1 -> same | 21F 26F 27P 28P -> same | boundaryEvidence, searchHistory |
| D52 siloed, placement ON (D65.4 `others` digest) | 18 -> 18 | 20 -> 20 | A=0:8 240:3, B=0:5 240:2 -> same | 15F 17F 18P 19P 20P 21P 22P -> same | boundaryEvidence, searchHistory |

Moved cases re-pinned with supervisor approval (the headcount moves, so they are NOT group A; old -> new in the table below and in the text): D72.10 d33 (22 -> 21, gross 24 -> 23, the same value as D33.7 / D72.6b; re-pinned with D72.11c, its async twin), D72.10 d50 (9 -> 7, gross 10 -> 8, 0:8 240:1 -> 0:4 240:3), D72.10 d51a (17 -> 13, gross 19 -> 14, A=0:8 240:1 B=0:7 240:1 -> A=0:4 240:3 B=0:3 240:3) and D65.6 (placement OFF, 9 -> 7, gross 10 -> 8). All decreases, by the same spread mechanism.

| Moved case (placement OFF, coverage ON) | HC | Gross HC | Roster | Test |
|---|---|---|---|---|
| d33 | 22 -> 21 | 24 -> 23 | 0:21 300:1 -> 0:11 300:10 | D72.10, D72.11c |
| d50 | 9 -> 7 | 10 -> 8 | 0:8 240:1 -> 0:4 240:3 | D72.10 |
| d51a | 17 -> 13 | 19 -> 14 | A=0:8 240:1, B=0:7 240:1 -> A=0:4 240:3, B=0:3 240:3 | D72.10 |
| D65.6 fixture | 9 -> 7 | 10 -> 8 | 0:8 240:1 -> 0:4 240:3 | D65.6 |

# Item 1 review round 1 (2026-10-14) — supervisor verdicts

- Tester: PASS (13/13). Free gate clean; samples 31/40, 27/34, 31/39; npm test 1,609 green; independent fresh-seed re-simulation: d51a 13, support+60 43, D33 21, HC-14 20 pass 20/20 seeds and 12/12 fresh CI batches (d51a occupancy margin thin: 96.2% vs 100% cap).
- Auditor: PASS. All design points and A1-A11 implemented; one shared state machine; no re-pin increases HC; scope respected.
- User-side: FAIL. Challenger (final): FAIL. Shared major, ACCEPTED -> rework round 1:
  - R1 [major] The answer depends on a staggered start-time roster that Results never shows when Shift Placement is OFF (only source `ResultsFlow.tsx:994` reads `searchOutput.shiftPlacement`, built only with placement ON, `hc-search.ts:3558-3563` / `4516-4520`); the single-shift note (`ResultsFlow.tsx:231`) disappears, so nothing is shown. Planner rostering all at opening would fail SLA.
  - R2 [major] Coverage OFF can be higher than ON (d51a 13 vs 19, D33 21 vs 28, support+60 43 vs 46); on-screen note `ConfigFlow.tsx ~1099` says OFF "does not lower headcount... can go up" without the reason; only PRD L33 explains.
- Minor (backlog): Sensitivity grid cells may assume different rosters without a label (`SensitivityFlow.tsx:87-107`); no monotonicity break found in D33 volume sweep 10-24 x 3 seeds. Runtime 1.4-1.9x on large files with no HC change (support+60 1.93x, AJM_Simu 1.44x, EGS_Only 1.39x) — to owner. No direct end-to-end test for A4 (audit/N-1 roster) — add in rework. Spread helper ignores zero-count starts (harmless). Coverage-failure reason has no remedy text.

# Item 1 review round 2 (2026-10-14) — re-check of A12 display rework (commit 3f3619c)

- User-side FAIL, challenger FAIL. Accepted majors -> rework round 2 (final):
  - [major] "Rostering everyone at opening would not meet the targets" can be false: roster polish (Stage 3b) can replace a passing all-at-opening roster with a staggered one (`hc-search.ts:3307-3311, 3369, 3384-3397`; async `4206, 4296, 4328-4339`).
  - [major] Siloed: categories missing from the roster (repair omits them, `hc-search.ts:687-694`; engine puts them at offset 0, `des-engine.ts:1018`) are not listed; lines sum to less than HC.
  - [major/minor] Spread note guessed from even counts (`results-display.ts:107-117`) — can state a false cause.
  - [minor] Coverage-OFF note repeats itself; Sensitivity roster mixing not recorded in PRD.
- Confirmed fine: displayed roster = the roster the recommended HC passed with (sync/async); infeasible hides block; clock conversion incl. wrap; single open time per calendar.
- User-side claim "user-entered Shift Placement roster" — Shift Placement start times are engine-chosen (analytic placement), not typed; the substance (reason line not established for every path) holds via polish.

# Item 1 review round 3 (2026-10-14) — re-check of A13 (commit b8b63ee)

- User-side PASS; challenger PASS. Tests 1,646 green (174 + 1,211 + 97 + 164), check:artifact fresh, no HC/roster change.
- Builder deviation accepted: D65/D72 digest helpers skip the display-only `winningLayout` key (old digests still pass → nothing else moved).
- Backlog (minor): split Coverage-OFF parenthetical into its own sentence; polish adoption always gets neutral wording (conservative); reason line says "targets" where coverage is the failing one; add a real siloed end-to-end check that listed seats sum to HC; seat counts depend on non-null agent categories (no path found today); Sensitivity grid layout labels (L34); runtime 1.4-1.9x on large files (owner); spread with coverage OFF (owner follow-up).
- Supervisor verdict: ready for owner approval.

# Item 2 build — before/after measurements (2026-10-15)

Idle machine apart from other sessions' light load, one job at a time, sync search (Sensitivity: async, 25 cells), default settings unless stated. Before = HEAD 4dc1c8c, after = working tree with the confirmation rule. Wall time in seconds (CPU time is within 10 % of it).

| Case | HC before -> after | Gross before -> after | Wall before -> after (s) | Ratio | Peak RSS before -> after (MB) |
|---|---|---|---|---|---|
| claims | 31 -> 31 | 40 -> 40 | 2.1 -> 3.7 | 1.8 (tiny run, noise) | 129 -> 148 |
| support | 27 -> **28** | 34 -> **35** | 11.9 -> 8.3 | 0.7 | 131 -> 153 |
| healthcare | 31 -> 31 | 39 -> 39 | 23.9 -> 18.2 | 0.8 | 145 -> 181 |
| support + answer-time 60 | 43 -> 43 | 54 -> 54 | 31.7 -> 25.4 | 0.8 | 164 -> 156 |
| AJM_Only | 16 -> 16 | 20 -> 20 | 17.6 -> 16.9 | 1.0 | 174 -> 221 |
| AJM_Only + answer-time 60 | 28 -> 28 | 35 -> 35 | 62.9 -> 68.6 | 1.1 | 171 -> 226 |
| AJM_Simu | 123 -> 123 | 154 -> 154 | 413 -> 317 | 0.8 | 1,706 -> 2,461 |
| EGS_Only | 100 -> 100 | 125 -> 125 | 441 -> 577 | **1.31** | 1,408 -> 2,419 |
| HC-14 (24x7, coverage ON) | 20 -> 20 | 35 -> 35 | 1.15 -> 1.28 | 1.1 | 121 -> 122 |
| D33 fixture (coverage ON) | 21 -> 21 | 23 -> 23 | 2.5 -> 1.6 | 0.6 | 132 -> 127 |
| Sensitivity grid, support sample, 25 cells | only centre cell 27/34 -> 28/35, 24 others identical | | 219 -> 315 | **1.44** | n/a |

- Worst ratio 1.44 (Sensitivity grid), 1.31 (EGS_Only); none above the 1.5x flag or the 2.0x hard limit. EGS_Only did not run out of memory (peak RSS 2.4 GB vs 1.4 GB before: the confirmation block holds a second set of R case sets). The single-run ratios below 1 are because the higher support answer ends the walk earlier and because other sessions loaded the machine unevenly; treat 0.6-1.1 as noise.
- Only support (and the Sensitivity centre cell, same data) moved, upwards by one agent (rule: HC may rise by the confirmation rule, never drop). No HC dropped anywhere.
- Fresh-seed proof (suite D81.c, 10 seeds independent of the primary and confirmation blocks): support at 28 passes 10/10; the old answer 27 (its coverage-repair roster) passes 5/10 on the same seeds (probe p1.mts earlier: 8/20).
- Mutations (D81 on a scratch copy, one confirmation dropped at a time): uniform sync -> 4 failures, repair sync -> 6, placement sync -> 2, uniform async -> 2, repair async -> 4, placement async -> 1; unmutated copy 37/37.
- Existing pin that moved: D78.e support 27 / 34 -> 28 / 35 (confirmation result: 27 clears the main days at category CI low 80.0 but fails the second set).

# Item 2 review round 1 (2026-10-15) — commit eaa120e

- Tester PASS (free gate 31/40, 28/35, 31/39; B10 row + evidence text agree; fresh seeds N=28 20/20, N=27 6/20; sync = async; cap 27 infeasible / cap 28 → 28; deterministic).
- Auditor PASS (shared pure state machine, layouts confirmed once, re-pins only up, scope, docs).
- User-side PASS with 2 majors; challenger FAIL on memory. Accepted for rework round 1:
  - C1 [major] Confirmation block held for the whole search (`hc-search.ts:918-937` closure `built`), now built on every run → EGS_Only peak 1.4 → 2.4 GB (Node, no browser measurement); browser heap limit ~2 GB on an 8 GB laptop → tab crash risk; Sensitivity 25 cells untested on a large file.
  - C2 [major] Results never says the answer must pass two independent sets; a 27 → 28 change is unexplained.
  - C3 [major] Confirmation-failure history row shows green main-days figures + red "Fail"; reason numbers come from the second set without saying so.
  - Minors fixed in the same round: uniform confirmation failure overwrites reportedDist with undefined (`:3243`, async `:4113-4116`); stale "open item P1-7-a" comment `src/types/wfm.ts:691`; PRD date; PRD §10 lines on walk-down bias (confirmation noise can leave the answer one agent higher) and memory.
  - Backlog: mixed repair-confirm-fail + spread-primary-fail test; vocabulary "simulated days" vs "simulated arrivals" in the ConfigFlow blurb; progress bar restart cue.

# Item 2 rework round 1 — build (2026-10-15)

- First attempt (release the resident block after every confirm stage): no memory gain (primary + confirmation sets are both alive during a confirm), AJM_Simu 491 s (2.12x of 4dc1c8c), discarded. Final design: lazy view, replication generated on read and dropped (`createConfirmationBlock`, `generatePrecomputedReplication`). Owner chose it and waived the 2.0x flag.
- Result identity vs eaa120e (`searchOptimalHC` full JSON, `confirmationOnlyFailure` stripped): claims 5,088,244 B, support 6,615,279 B, healthcare 9,151,188 B, AJM_Only 12,192,681 B all byte-identical (sha256 equal, `cmp` equal). `npm test` with no digest re-pinned (D65/D72 digest helpers now skip the display-only `confirmationOnlyFailure` key, as for `winningLayout`).
- Node, back-to-back, one job at a time (4dc1c8c / eaa120e / new), wall s and peak RSS MB:

| Case | 4dc1c8c | eaa120e | new | new / 4dc |
|---|---|---|---|---|
| support | 18.9 s, 143 | 21.8 s, 169 | 15.1 s, 208 | 0.80 |
| healthcare | 16.8 s, 155 | 22.8 s, 192 | 28.2 s, 259 | 1.68 |
| AJM_Only | 16.0 s, 173 | 22.6 s, 221 | 20.7 s, 264 | 1.30 |
| AJM_Simu | 292 s, 1,733 | 405 s, 2,588 | 668 s, 1,821 | **2.28** |
| EGS_Only | 568 s, 1,504 | 799 s, 2,529 | 1,022 s, 1,553 | **1.80** |

- Earlier same-day runs (machine noise 30-50%): EGS_Only 533 / 865 / 1,112 s (2.09x), AJM_Simu 232 / 351 / 420 s (1.81x). Cost source: each confirmation run regenerates 30 sets (8.5 s on EGS_Only) x ~30 runs.
- Browser (headless Chrome, `BoWFM.html` of each commit, EGS_Only.csv uploaded through the file input, normal Run flow, `Runtime.getHeapUsage` every second): 

| Run (headless Chrome, JS heap via `Runtime.getHeapUsage`) | Result | Peak used / total heap | Run time |
|---|---|---|---|
| EGS_Only, 1.24.x (4dc1c8c) | 100 / 125, no crash | 492 / 535 MB | 751 s |
| EGS_Only, 1.25.0 (eaa120e) | 100 / 125, no crash | 1,032 / 1,078 MB | 1,383 s |
| EGS_Only, new | 100 / 125, no crash, "Confirmed on two independent sets..." shown | 679 / 720 MB | 1,424 s |
| Sensitivity 5x5 on AJM_Only, new | 25 cells complete, no crash, centre 16 | 205 / 245 MB | 734 s |

- Browser heap is 38% above 1.24.x (679 vs 492 MB) but 34% below 1.25.0; Node RSS is within 3% of 1.24.x. Browser run times were taken while the test suite ran in parallel, so they are not comparable with the Node timings.
- Tests: first full `npm test` run had one failure, D72.10 (support digest) because the new display flag entered the digest; fixed by skipping the key in the digest helpers (no pinned value changed); D81.k1-k9 passed.

# Item 2 review round 2 (2026-10-15) — rework commit c2b6013

- Tester PASS: free gate 31/40, 28/35, 31/39, 0 errors; confirmed line shown on feasible runs, absent when infeasible; N=27 row amber "Fail – 2nd set" with the second-set prefix, N=21 red Fail; results identical to eaa120e (support, healthcare, siloed, cap 27).
- Challenger PASS: memory major resolved by code reading (lazy view, no retained references, one read per replication); seed formula identical; async same shape.
- Backlog (minor): mixed case (uniform fails confirmation, repair fails main days) — `reportedDist = confirmationFailure.roster ?? reportedDist` can pair uniform figures with the repair roster in the N−1 evidence / final audit runs (display only, untested; `hc-search.ts:3259`, `:4133`); infeasible run's "RECOMMENDED HC" card shows N = cap; browser heap +38 % vs 4dc1c8c (likely uncollected garbage); runtime 1.8–2.3x on large files (owner waived; speed item for the backlog).
- Supervisor verdict: ready for owner approval.

# Item 3 build — measurements (2026-10-15)

Built per PLAN.md "BUILD PLAN — Item 3" + amendments E1-E8 (explicit `boAsaOwn` switch). Base commit 24c21f2. Node, `searchOptimalHC` pooled, default calendar / labor / R = 30 / seed 12345. "Before" = a copy of the tree at 24c21f2 run from a scratch directory; "after" = the worktree. Machine shared with another job, so times vary 10-30%.

Nothing ticked (must be identical):

| Case | Before: HC / gross / ASA mean | After | sha256 of the full result | Time before / after |
|---|---|---|---|---|
| claims (default categories, Claims_Life holds 90), ASA off | 31 / 40 / 32.3 | same | equal (5,088,244 B) | 15.7 s / 14.9 s |
| claims, ASA on 60 | 31 / 40 / 32.3 | same | equal (5,088,245 B) | 19.7 s / 18.4 s |
| support, ASA on 60 | 43 / 54 / 59.5 | same | equal (7,026,784 B) | 156 s / 127 s |
| healthcare, ASA on 60 | 42 / 53 / 59.3 | same | equal (9,752,898 B) | 180 s / 169 s |
| AJM_Only, ASA on 60 | 28 / 35 / 58.1 | same | equal (13,332,165 B) | 265 s / 297 s |
| healthcare ASA off, support ASA off, AJM_Only ASA off | 31 / 39, 28 / 35, 16 / 20 | same | (HC / gross / ASA compared, no hash) | |

Ticked (after only; before the tick is ignored, so the before answer is the unticked row above):

| Case | HC / gross | Binding label | Note |
|---|---|---|---|
| claims, Claims_Life ticked own 90 (global 60) | 31 / 40 | analytical baseline (floor) | unchanged: the floor binds, Life is looser than the global |
| claims, Claims_Life ticked own 30 | 32 / 41 | "Backoffice ASA Target for category 'Claims_Life' (own target ≤ 30 minutes)" | N-1 row: "BO ASA (category 'Claims_Life') 95% CI [31.2m, 32.4m] upper bound > own target 30minutes (30m)" |
| support, ASA 60, Billing_Support ticked own 30 | **62 / 78** (from 43 / 54) | "Backoffice ASA Target (≤ 60 minutes) for the categories without their own target" (after the label extension; the measured run predates it and read the Primary SLA label) | N-1 = 61 fails on the followers: Technical_Escalations alone 62.4 min > 60. Billing_Support left the pool, whose mean (59.5 at 43) was held down by it |

Findings worth the owner's eye:
- A tick on a fast category can RAISE the headcount a lot (support 43 -> 62) because the remaining categories lose the averaging benefit; [WITHDRAWN: the claim that a looser tick can only keep or lower the answer was false and the follower-pool design is replaced, see rework F below]. Written into PRD §6 and L30.
- The existing binding label never named the answer-time gate on N-1 (AJM_Only + 60: N-1 = 27 fails BO ASA, label still "Primary SLA"). Left as is when nothing is ticked (identical output); with a tick the label now names the own category or the sharing categories.

Tests: new suite D82 (52 checks) fails 33 of 51 on the unchanged engine (fail-first run of D82 alone, 18 passed = the "nothing ticked is identical" controls), 52 / 52 after. Mutations (D82 alone, scratch copies): copies treated as own (flag ignored) 16 fail (D82.a1, a1b, a4, b1d-f, b2a/b, b5b, b10, d3, d4, d6 claims / support / healthcare ASA on, e1); own loop skipped 13 fail (b1a-d, b3a, b8, b9, c1, c3, c4, c7a/b, f); followers pooled over all categories 9 fail (b1d/e, b2a, b5b, b6, c4, c6a/b, e1). Full results: see the test totals in the commit message / report.

# Item 3 rework F — every category judged on its own (2026-10-15, after review round 1)

Supersedes the follower-pool design measured in "Item 3 build" above (its ticked rows and the claim that a looser tick can only keep or lower the answer are withdrawn). Base: c218d39 merged into the item 3 branch. Node, default calendar / labor / R = 30 / seed 12345; before = 24c21f2 snapshot (answer-time-ON numbers from the first build's "before" runs on the same snapshot), after = new code.

Answer time ON, nothing ticked (pins may only move UP):

| Case | Before HC / gross | After HC / gross | Category that binds at N-1 | Time after |
|---|---|---|---|---|
| claims, ASA 60 | 31 / 40 | 31 / 40 | none (floor) | 4.5 s |
| healthcare, ASA 60 | 42 / 53 | **52 / 65** | Provider_Inquiries 60.1 min at 51 | 175 s |
| support, ASA 60 | 43 / 54 | **62 / 78** | Technical_Escalations 62.4 at 61 | 101 s |
| AJM_Only, ASA 60 | 28 / 35 | **41 / 51** | Tech HVC 78.2 at 40 | 216 s |

Ticked: claims with Claims_Life 90: 31 / 40 (unchanged). Support + 60 with Billing_Support ticked 30: 62 / 78; ticked 120: 62 / 78 (Technical_Escalations at the global 60 binds in all three).

Answer time OFF (must be byte-identical to 24c21f2): sha256 of the full result equal for claims (5,088,244 B), support (6,615,310 B), healthcare (9,151,188 B), AJM_Only (12,192,681 B).

Mutation (scratch copy, D82 alone): pooled gate restored in place of the per-category gate -> 18 of 55 D82 checks fail (b1a, b1c, b2a, b3a, b5b, b6, b8, b9, b11, c1, c3, c4, c6a-c, c7a/b, c8).

# Item 3 review round 2 (2026-10-16) — rework F commit edf7d9c

- Tester PASS (browser: ASA off 31/40, 28/35, 31/39; support ASA 60 → 62/78, binding Technical_Escalations; own 30 on Billing_Support → 62, column shows own target; independent re-check 61 fails / 62 passes). Challenger PASS. User-side PASS.
- Owner approved 2026-10-16; merged into main (fast-forward).
- Backlog (minor): run-progress text says "Primary-Driven" when an answer-time target binds; upper bound shown in minutes even for hour/day targets; mean vs upper-bound verdict note; stale "follower" comments (hc-search.ts:2468, 2848, 2937; D82 test comments); unused `_sla` parameter; CI bound rounded to 0.1 before comparison (same as before).

# Item 4 build — drain runs until the last deadline (2026-10-16, branch item4-drain)

Change: drain end = min( max(horizon end + 14 calendar days, latest finite `primaryDeadline`), horizon end + 366 days ), one `computeDrainEnd` call per `runBackofficeDES` (same for every candidate N, CRN kept). Drives the day-open/close scheduling, `SimulationEnd` and the unfinished count. `drainCapped: true` on `DESResult` when the cap bit. Occupancy denominator, N_min, N_occ, Gross HC untouched. DES-10 / G9 resolved. Base 5f5029b, node, idle machine except where noted.

## Item 4 measurements

Default settings (before = 5f5029b snapshot, after = item4-drain):

| Case | HC / gross before | HC / gross after | SLA % before / after | Occupancy % before / after | Time before / after | Ratio |
|---|---|---|---|---|---|---|
| Repro vol 20, no holidays | 8 / 10 | 8 / 10 | 94.9 / 94.9 | 73.4 / 73.4 | 2.6 s / 2.3 s | 0.9 |
| Repro vol 20, 8 holidays after horizon | **12 / 15** | **8 / 10** | 81.5 / 94.9 | 39.9 / 69.9 | 3.0 s / 2.9 s | 1.0 |
| claims sample | 31 / 40 | 31 / 40 | 100 / 100 | 99.1 / 99.1 | 4.1 s / 4.8 s | 1.2 |
| support sample | 28 / 35 | 28 / 35 | 89.5 / 89.5 | 74.9 / 74.9 | 12.9 s / 14.3 s | 1.1 |
| healthcare sample | 31 / 39 | 31 / 39 | 86.7 / 86.7 | 58.9 / 58.9 | 54.9 s / 38.1 s | 0.7 |
| AJM_Only.csv | 16 / 20 | 16 / 20 | 90.1 / 90.1 | 59.1 / 59.1 | 26.7 s / 33.5 s | 1.3 |
| EGS_Only.csv | 100 / 125 | 100 / 125 | 92.7 / 92.7 | 53.4 / 53.4 | 1703 s / 1555 s | 0.9 |

The plan's "31 / 27 / 31 HC, gross 40 / 34 / 39" is stale: since Item 2 the support sample is 28 / 35 (D81.a1). Nothing slower than 1.5x. The 1.2-1.3x readings for claims / support / AJM_Only were taken while other tools were running on the machine (the same runs went the other way for healthcare / EGS); no systematic slowdown. The holiday repro now equals the no-holiday answer in headcount, gross and SLA %; its occupancy differs (69.9 vs 73.4) only because 37 cases that are still open at their own deadline are unfinished and do not add handling minutes.

Answer time ON, 60 minutes (item 3 figures: claims 31, healthcare 52, support 62, AJM_Only 41):

| Case | HC / gross before | HC / gross after | ASA mean min before / after | Time before / after | Ratio |
|---|---|---|---|---|---|
| claims | 31 / 40 | 31 / 40 | 32.3 / 32.3 | 7.1 s / 5.5 s | 0.8 |
| support | 62 / 78 | 62 / 78 | 45.7 / 45.7 | 135 s / 108 s | 0.8 |
| healthcare | 52 / 65 | 52 / 65 | 44.1 / 44.1 | 268 s / 226 s | 0.8 |
| AJM_Only | 41 / 51 | 41 / 51 | 38.8 / 38.8 | 364 s / 287 s | 0.8 |

Multi-week answer window (support sample, primary window on every category and the global setting):

| Case | HC / gross before | HC / gross after | Time before / after | Ratio |
|---|---|---|---|---|
| 15 working days | 21 / 26 | 21 / 26 | 18.2 s / 13.8 s | 0.8 |
| 15 working days + ASA 60 | 62 / 78 | 62 / 78 | 243 s / 207 s | 0.9 |
| 30 working days | 21 / 26 | 21 / 26 | 31.0 s / 21.6 s | 0.7 |
| 30 working days + ASA 60 | 62 / 78 | 62 / 78 | 361 s / 311 s | 0.9 |

(Occupancy 99.8 % in the 15 / 30-day rows is the occupancy floor binding, identical before and after.)

- Nothing reached a deadline beyond the 366-day cap: no `drainCapped` on any sample, test fixture or measured run (only the 2030-deadline fixtures D83.i1 / i3 set it).
- Not run: runtime of a deliberately undersized candidate with a very long window beyond what the searches evaluate (the search still ran 15 / 30-day windows without slowdown; lazy day scheduling not added, per G5).
- G3: on all measured runs the final recommended result finishes every case, so answer-time figures and HC are unchanged. The effect shows only in runs that do not finish (undersized): fixture 10 x 1100 min, 1 agent, due Fri 30 Oct, ASA on: censored cases 5 -> 3, ASA mean 1340 -> 2454 min (more cases start, their real wait is counted), completed 4 -> 6, SLA 40 -> 60 %.
- G6 (per-agent figures, same fixture): available minutes (planned-horizon denominator) 480 -> 480; handling minutes 5280 -> 7200, so rawOccupancyPct 1100 % -> 1500 % (the agent keeps working to the later drain end; the overload signal gets stronger, not weaker); agent busy / (busy + idle) 100 % -> 100 %; timeline slices 39 -> 53; `verifyAgentTimelineInvariants` valid before and after. Fixture 10 x 800 min due Fri 20 Nov: raw occupancy 1100 % -> 1667 %, agent utilisation 100 % -> 98 % (the agent runs out of work at the end), invariants valid. AA.41 / AA.45d (Agent Analytics) did not move.
- Sizing effect on real input: only runs whose deadlines fall beyond horizon end + 14 days (long answer windows, post-horizon holidays) can change; all three samples, AJM_Only and EGS_Only did not.

## Tests

`npm test`: 174 + 1,343 + 97 + 164 (trusted-source) = 1,780 checks, 0 failed, artifact fresh (was 1,756; +24 = D83; rework 1 added D83.k1-k2: the cap flag reaches the search output, sync and async). Lint clean. Only D59.1-3 changed (redesign, below); no other existing test moved; every hand-built `precomputedCases` test passed unchanged (9 in verify-sizing-fixes.mts, 2 in verify-fixes.mts, none in verify-agent-analytics.mts).

| Test | Old | New | Reason |
|---|---|---|---|
| D59.1-3 | 10 x 800 min, due Fri 30 Oct: 6 done / 4 unfinished, 60 % | 10 x 1100 min, due Fri 30 Oct: 6 / 4, 60 % | The old deadline (30 Oct) now lies inside the drain (to 30 Oct 17:00 = 15 days x 480 = 7200 min); at 800 min the team would finish 9. At 1100 min the agent is too slow to finish before the new drain end, so the "unfinished stay in the denominator" proof and the 6 / 10 / 60 % numbers are kept. Not a silent re-pin: the fixture changed, the claim did not. |

Fail-first (D83 + redesigned D59 on the 5f5029b engine): 15 failed, 10 passed — D59.1-3, D83.a1, a2, d, b1-b3, g1, g2, h1, i1, i3, j2. After: 25 / 25 pass (D59 3 + D83 22).

Mutations (temporary edit of `des-engine.ts`, D59 + D83 only, source restored with `git checkout` after each):

| Mutation | Result |
|---|---|
| M1 drain end back to horizon + 14 days only | 14 failed incl. D83.a1, a2, b1-b3 |
| M2 max in the day-scheduling loop, SimulationEnd at +14 days | 14 failed (same set) |
| M3 max at SimulationEnd, day-scheduling loop at +14 days | 14 failed (same set) |
| Non-finite deadline not skipped | D83.h2 fails |
| 366-day cap removed | D83.i1, i3 fail |

## Item 4 review (2026-10-16) — supervisor verdicts
- Round 1: tester pass (11/11; samples 31/40, 28/35, 31/39; repro 12→8; drain formula recomputed 10/10), auditor pass, user-side pass with 2 majors (stale "Unfinished by horizon end" label; silent 366-day cap) → fixed in rework 1 (652be8d).
- Final challenger: pass. Major (owner info): long answer windows run slower than short ones (claims: default 6.1 s, 60-day window 39.6 s, 300-day 171 s) — the run now simulates until the last deadline; before the change those runs stopped at 14 days and wrongly failed cases. Builder's before/after on support 15/30-day windows was not slower (18.2→13.8 s, 31.0→21.6 s).
- Backlog (minor): case-row "(deadline missed)" wording is wrong for rows cut by the 366-day cap; export CSV / hc-search reason strings still "Unfinished by horizon end" (export-rows.ts:49, hc-search.ts:3799/:4762); ASA censoring mixes horizon-end and real waits (documented); stale +14 comment fixed; drainCapped sync/async check added (D83.k2).

## Item 5 measurements (2026-10-16) - manual backlog form default (G10 / DES-7)
Probe `r3/q_p4.mts` (VOL=1, 30 backlog cases, N=1, new-case SLA; engine untouched so the numbers match the 2026-10-15 investigation):

| Case | New-case SLA |
|---|---|
| Part-worked (old: every manual row counted as in-progress) | 51.7 % (31/60) |
| Full handling time (new: blank row) | 91.7 % (55/60) |

Through the real form path (`buildManualWipCase`; 30 rows, category handling time 45, new-case handling time 10, 1 agent):

| Stored remaining | New-case SLA | Backlog workload counted |
|---|---|---|
| 30 typed (old form default) | 0.0 % (0/60) | 900 min |
| blank (undefined, new default) | 85.0 % (51/60) | 1350 min (30 x 45) |

Headcount effect (expected, documented in PRD L37): blank rows now count the full handling time, so N_min and the recommendation can rise where handling time is above 30. Browser (headless, file://): Financial Claims sample, blank row shows "full (35m)", typed 10 shows "10m", second category blank shows "full (45m)", Total Pending Work 35 -> 45 -> 90 min; typed 0 clears back to blank; sizing run completed (N = 31) with 0 console errors, 0 failed requests.
Tests: suite D84 (9 checks), fail-first 8 of 9 failed against the old-behaviour stub, 9/9 after.


### Item 5 rework round 1 (2026-10-16)
- K1: the Remaining Work box no longer strips characters ("-5" became 5, "12.5" became 125, "1e2" became 12). It keeps the raw text; `parseRemainingText` (wip-row.ts) reads a plain decimal (comma accepted: "12,5" = 12.5). Blank = not started, not an error. 0, negative, text, "1e2", "12.5.3" show an amber message "Not a valid number of minutes - this row will use the full handling time." and the row is added as blank. Draft cleared after Add.
- K2: hint now says to enter minutes only for part-worked cases, handled before new work. Both tables use `remainingWorkLabel`: "10m (in progress)" below the category handling time, "full (45m)" blank, plain "Nm" at or above.
- K3: typed 0 goes through K1 (message), no silent clearing.
- Tests: D84 now 14 checks (5 added: e1-e4 parsing, f1 label); trimmed run 14/14; D54 trimmed run 23/23 (D54.7 type="number" rule passes). Suite totals 1785 = 174 + 1350 + 97 + 164.
