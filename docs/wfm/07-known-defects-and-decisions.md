# 07 — Decisions and Defect Log

Living record. **Check here before "fixing" something that may be deliberate; append when
you resolve a defect.**

Origin: a full audit of the Required-HC chain (2026-08-24). Every claim below was verified
by running code, not by reading it — three findings changed once measured.

---

## A. Validated as correct — do not change

Confirmed sound against contact-centre WFM/COPC practice. Also listed in
`.cursor/rules/10-architecture-required-hc-chain.mdc`.

| Decision | Why it is right |
|---|---|
| DES rather than Erlang-C | Erlang-C models real-time queueing with abandonment; deferred work is deadline-based with legitimate multi-day queueing |
| EDF / latest-safe-start dispatch | Optimal for on-time completion. **Caveat (see D17):** the backward walk through the calendar had a real bug for midnight-close configurations, fixed below — the EDF *design* is still correct, the *implementation* was not, for that one calendar shape. |
| Shrinkage excluded from `N_min`, applied only at gross-up | Avoids the classic double-count |
| Harmonic effective-shrinkage blend | Gross-up divides by `(1−shr)`, so `1/(1−shr)` is what adds linearly (see `04`) |
| Per-category gross-up → sum → single `round` | Avoids systematic drift (corrected 2026-08-28: was documented as `ceil`, code/UI have always used `round`) |
| Occupancy cap in the `N_min` denominator | Expresses "size so utilisation stays ≤ cap" |
| `N_min` as a hard search floor (default ON; opt-out approved 2026-09-30, `resolveSearchBounds`) | Prevents a headcount that only passes via the finite-horizon drain edge effect |
| Roster polish at fixed HC (2026-09-30, Stage 3b) | Coverage re-spread only after HC is final and only as far as every CI gate still passes — coverage never buys or costs headcount |
| Clock start derived from clock basis (2026-09-30, `resolveClockStartPolicy`) | Business Time always starts at next open (Arrival vs Next Open is provably HC-neutral there); Wall Clock keeps the planner's choice, default Arrival |
| Opening-WIP carry-in | Mandatory for deferred work; uses remaining minutes, not full AHT |
| CRN + CI-gated acceptance | Correct variance reduction; Bessel-corrected variance, correct bound directions |
| `fteNet == operationalHC` under derived hours | A genuine algebraic identity, not a bug (test `D7.5`) |

---

## B. Fixed

### D1 — Working-day off-by-one *(fixed)*
`getCalendarWorkingDaysInHorizon` used an inclusive `<=` against a midnight-normalised
cursor, counting a trailing day carrying **zero demand time** whenever `horizonEnd` landed
exactly on midnight. Interval ends default to `start + 30min`, so whole-day data ends at
00:00 of the next day — and for 24x7 calendars every day is a working day, so it *always*
triggered.

Measured: 24x7 Mon→next Mon returned **8 days instead of 7**; N_min for a 1000-hour workload
came out **16 instead of 18** (11% understated). Business-hours data ending at 17:00 was
unaffected, which is why the legacy suite never caught it.

**Fix:** horizon treated as half-open `[start, end)`. Partial final days still count as
whole days — a deliberate whole-day capacity approximation, documented in code.
**Tests:** `D1.1`–`D1.10`.

### D3 — Siloed apportionment broke search monotonicity *(fixed)*
Hamilton's largest-remainder allocation is subject to the **Alabama paradox**: adding an
agent can *remove* one from a category. The walk-down search stops at the first failing N,
which is only valid under monotonicity.

Measured over N=1..200: **14 violations, 21 starved silos**. At N=19 category 'D' held 1
agent; at N=20 it held **0** — a queue with work and nobody to drain it, caused by *adding*
an agent.

**Fix:** `allocateAgentsToCategories` now uses Webster/Sainte-Laguë (divisor/highest
averages), house-monotone by construction, with a guarantee that every category holding work
gets one agent before any gets a second. Result: **0 violations, 0 starved silos.**
**Tests:** `D3.1`–`D3.8`. **Never revert to largest-remainder** — see `06-simulation-des.md`.

### D7 — Unconfigured categories understated staffing *(fixed)*
`catWorkloadHours` was seeded from configured categories, but the interval loop auto-created
entries for **any** category in the data and `totalWorkloadHours` summed all of them — while
the gross-up loop iterated only *configured* categories. A data-only category therefore
inflated the share denominator without receiving an allocation.

Measured with one unconfigured category: `Σ share = 0.5` (should be 1), `fteNet = 5`
(should be 10), `grossHCTotal = 7` (should be 13) — **the hiring requirement understated by
46%.**

**Fix:** categories present in demand data but absent from config are folded in with
fallback defaults (AHT 30 min, shrinkage 20%). **Those defaults are unlikely to match your
operation — configure every category explicitly.** **Tests:** `D7.1`–`D7.11`.

### D10 — Debug logging in shipped engine code *(fixed)*
Five `console.log` calls in `hc-search.ts` (sync search path only) reached the shipped
artifact. Removed; now enforced by test `D9.3`.

### Dependency purge *(done)*
`@google/genai`, `express`, `dotenv` and `motion` were declared as runtime dependencies with
**zero imports anywhere in `src/`**. Removed, with `@types/express`.
Result: node_modules **182M → 135M**, top-level packages **153 → 57**. Enforced by `D9.4`.

### T1-1 — CSV thousands separators silently divided demand by ~1000 *(fixed)*
`parseFloat` on the raw volume cell stops at the first non-numeric character, so
`"12,500"` parsed as `12`, `"1,234"` as `1`, and `"$1234"` as `NaN → 0`. Because the result
was always a *valid* number, it never reached the existing DQ error branch, and the
corrupted value fed `N_min` directly — the number that determines the answer in every
run (see `06-simulation-des.md` on how rarely the DES search overrides it).

**Fix:** strip thousands separators, currency symbols and whitespace before parsing
(`csv-parser.ts`, `mapRawRecordsToIntervals`); reject negatives (set to 0, not clamped
silently); attach a `volumeParsingIssue` to any interval whose raw cell needed correcting
or couldn't be parsed. `validateDataQuality` surfaces these as a `Volume Parsing` warning.
**Tests:** `verify-fixes.mts` Suite 33.

### T2-1 — AHT-exceeds-SLA-window infeasibility was expensively discovered and misdiagnosed *(fixed)*
A category whose AHT exceeds its own SLA window can never attain that SLA at any
headcount — no amount of staff makes one transaction finish faster than the time it
takes to work it. There was no precondition check for this: the engine discovered it
only by exhausting the leap-up search to `userMaxHC` (wasted compute — minutes at
`userMaxHC=500`), and the resulting message ("Increase userMaxHC or review SLA/labor
parameters") actively misdirected the user, since no headcount would ever help.

Worse, because `passesCategorySLA` requires *every* category to clear its target, one
impossible category with a small volume share vetoed the whole run even when the
overall SLA was comfortably achievable (e.g. 90% achieved, 10% share impossible, still
reported infeasible with no indication that 90% was the practical ceiling).

**Fix:** `findImpossibleCategories` (`hc-search.ts`) analytically flags any category
with `ahtMinutes > primaryWindowMinutes` before the search runs, in both
`searchOptimalHC` and `searchOptimalHCAsync`. The infeasibility message names the
offending categories and states the achievable overall-SLA ceiling
(`100 × (1 − Σ impossible-category volume share)`) instead of recommending a headcount
increase that cannot help. New `bindingConstraintType: 'category_aht_exceeds_window'`.
**Tests:** `verify-fixes.mts` Suite 34.

### T3-1 — 24x7 midnight budget reset fabricated capacity *(fixed)*
In 24x7 mode, `AgentAvailable` fires every midnight but a case in flight is never
paused (continuous processing is a deliberate requirement — see `BUG-D` in
`verify-fixes.mts`, "24x7 Continuous Processing Across Midnight"). The daily-budget deduction for a task happened in one lump at assignment time,
covering the task's *entire* duration even when it physically ran past midnight — and
the midnight reset then blindly gave every agent, including one still mid-task, a
second full day's budget on top of the portion already spent working into the new day.
Measured: an agent's Day 2 busy minutes reached 738 against a 480-minute daily budget
(53% phantom capacity), caught by the engine's own `verifyAgentTimelineInvariants`.

**An earlier fix attempt tried capping/parking work exactly at the midnight boundary —
that regressed `BUG-D` (24x7 cases must never be artificially interrupted by midnight).
The correct fix is accounting-only,** not a dispatch change: at each midnight,
`AgentAvailable` now computes, for every agent still mid-task, how many minutes of that
task fall within the day just starting (from now to completion, or to the next
midnight) and credits only the *unconsumed remainder* of the daily budget — not a full
reset. Idle/off agents still get a full reset, unchanged. **Tests:** `verify-fixes.mts`
Suite 35 (daily-budget cap under continuous multi-day contention, plus a regression
guard that a case comfortably within budget still never parks at midnight).

### D17 (T3-2) — `subtractWorkingTime` returned `Invalid Date` for midnight-close calendars *(fixed)*
**This contradicted the "validated as correct" claim above about EDF/LSS being correctly
walked backwards — the design was right, this implementation was not, for one calendar
shape.** `calendar.ts`'s backward day-stepping used `getDailyOpenClose` to find the
previous day's close; when close normalizes to hour-24, `setHours(24,0,0,0)` rolls into
the *next* day, so "previous day's close" landed on the *current* day at 00:00 — before
open, consuming zero minutes, looping until `maxDays` exhausted and returning
`new Date(NaN)`. Both `close=00:00` and `close=24:00` are first-class UI presets. Measured
on real case generation with a 2-business-day SLA window: **44.6% of cases got a `NaN`
`latestSafeStart`**, which poisons `CaseMinHeap.compare` (`NaN < 0` is always `false`),
making dispatch ordering arbitrary rather than merely degraded.

**Fix:** explicitly walk to the previous working day, skip non-working days, and detect
when the probed close time has rolled over to the next day's midnight — in that case the
boundary is `nextDayMidnight − 1000ms`, not the rolled-over timestamp itself.
Honest-scope note: this did not change any tested recommended headcount (consistent with
`N_min` binding in effectively all realistic configs — see `06-simulation-des.md`); it
corrupts case-level ordering, fixed-N attainment, and the user-visible `latestSafeStart`
column (rendered `-`, indistinguishable from missing data) instead.

### T3-3 — `getTCrit` df=2 was wrong by exactly √2 *(fixed)*
`hc-search.ts`'s two-sided Student-t closed form for `df=2` used `(2·a)/√(1−a²)`; the
correct coefficient is `√2`, not `2`. Measured: `getTCrit(2, 95)` returned `6.0849`
against the textbook `4.303` (+41.4%), reachable only at `replications: 3`. Direction
was conservative (over-staffing), so no under-sizing risk, but still a real defect.
**Fix:** `2 * a` → `Math.SQRT2 * a`. **Tests:** `verify-fixes.mts` Suite 33b.

### D19 — Occupancy ceiling gate compared the clamped value, never rejecting anything *(fixed)*
Triggered by a run showing "Occupancy 100% (102.4% true)" with status PASS — raised as "is the
simulator letting agents work past their daily hours?" It is not: capacity enforcement
(`agentDailyMinutesRemaining`, `verifyAgentTimelineInvariants`) was re-verified line-by-line and
is sound. The actual defect was two layers up, in the acceptance gate:

```ts
const occupancyPct = Math.min(100, rawOccupancyPct);
const passesOccupancyCap = !sla.occupancyCapEnabled || occupancyPct <= sla.occupancyCapPct;
```
`Math.min(100, raw) <= 100` is `true` for every input, and `occupancyCapPct` is UI-clamped to a
max of 100 — so the gate could never reject a candidate, toggle on or off. The CI-gated
statistical path (`evaluateCandidateStatistical`) had the same defect twice: occupancy samples
were built from the already-clamped value, then the CI upper bound was clamped again, so an
overloaded candidate's confidence interval collapsed to a point at exactly 100 instead of the
true ratio. `occupancyCapEnabled: true` had **zero test coverage** anywhere in the repo.

Fixed via `resolveOccupancyCapPct(sla)` (`des-engine.ts`), a single resolver every gate now
calls: 100 by default (physical feasibility — ρ≥1 is an unstable queue by definition), or the
clamped custom value when the toggle is on. `occupancyCapEnabled` changed meaning from "enable a
ceiling" to "use a custom target instead of the 100% default" — the ceiling is now **always**
evaluated. Gates now compare `rawOccupancyPct` (unclamped), never the display value.

**Deliberately not changed:** the default target stays 100%, not the COPC-aligned ~85%
recommended in `02-copc-standards.md`. This was scoped as a correctness fix, not a policy
change, after explicit discussion — see that file's note on the 85%/100% distinction. The fix is
provably neutral for every already-valid scenario: `Math.min(100, raw) <= 100` and `raw <= 100`
agree everywhere except `raw > 100`, so `N_min`, recommended HC and Gross HC are unchanged
wherever occupancy was already ≤100%. Pinned by `BUG-OCC-CAP` and `BUG-OCC-NEUTRAL` in
`scripts/verify-fixes.mts`.

This is a different defect from **D2** below — re-examined during this investigation and
**upheld**: the occupancy *metric* (planned-horizon denominator, unclamped `rawOccupancyPct`)
was correct the whole time. D19 is that the *gate* consuming that correct metric was broken.

### D16 — dispatch-priority doc entry stated the relationship backwards *(fixed)*
This log (and a matching line in `CLAUDE.md`) previously said `CaseMinHeap.compare`
drives real dispatch while `pickNextCase`/`compareByUrgency` are test-harness-only. This
was backwards. Real dispatch (`dispatchSingleQueue`, `des-engine.ts`) calls
`pickNextCase` directly, which does its own linear scan using `compareByUrgency`
(re-implementing the parked-first tiering separately from `CaseMinHeap.compare`).
`CaseMinHeap.compare` only governs the heap's internal push/pop order — still live (it
determines `.pop()` behaviour and `len === 1` fast-path in `pickNextCase`), but it is
**not** what chooses among 2+ candidates during real dispatch; `compareByUrgency` is.
Corrected here; `CLAUDE.md`'s equivalent line should be corrected by a human maintainer
since it is checked-in guardrail text, not engine code.

### D20 — Zero available agents from mid-afternoon under uniform-start *(fixed, opt-in)*
Reported symptom: `availableAgents: 0` in the interval timeline from ~17:30 onward every
day, in a config with `dailyOpenHour: 8`, `dailyCloseHour: 22` (14h window), and
`dailyProductiveHours: 9`. Root cause: every agent is given one uniform shift starting at
business open, budget `dailyProductiveHours × adherence`, decremented only while processing
(`des-engine.ts`). Under a persistent backlog, every agent is kept continuously busy from
open and exhausts its budget in lockstep at `open + dailyProductiveHours` — here, ~17:00 —
after which the entire remaining window (17:00-22:00) has zero available agents, regardless
of headcount. `labor.shifts` (`ShiftWindow[]`), which could in principle stagger coverage,
was found to be dead code — declared in the type and UI, never read by the engine.

Two false starts before the fix, kept here because they are exactly the traps a future
attempt at this would fall into again:
1. **A per-N iterative search over ~5 heuristic distributions.** Rejected: breaks the
   walk-down search's monotonicity requirement the same way Hamilton apportionment did
   (D3) — a path-dependent heuristic's outcome at N can differ arbitrarily from its outcome
   at N+1 — and costs 3-5x more per candidate. Also unnecessary: **AHT is deterministic**
   and every case's release/deadline is computed by `generateCaseEntities` *before* any
   simulation runs (its only randomness is arrival-time jitter within an interval), so the
   feasibility question is answerable analytically with zero DES calls.
2. **A deadline-only cumulative demand curve** (`W(τ) = work due by τ`, compared against
   cumulative capacity). Mathematically sound as written, but *optimistic*: it implicitly
   assumes a scheduler can bank an agent's capacity early and spend it whenever needed,
   which is not how the DES's real EDF dispatch behaves under a persistent backlog (an idle
   agent's budget is untouched while idle, but a continuously-busy one cannot "save" minutes
   for later). Without gating by *release* time as well as deadline, the model concluded
   every agent starting at business open was always at least as good as any staggered
   alternative — the opposite of the finding it was built to prove. Measured directly on
   synthetic front-loaded-demand fixtures: a naive deadline-only greedy produced
   distributions *worse* than uniform-start.

**Fix**: a release-gated feasibility check — a Hall/Horn-style condition bucketed to the
same grid as valid shift starts (`DemandGrid`, `buildOneDayDemandGrid`,
`computeShiftPlacement`, all in `hc-search.ts`), evaluated as one representative working day
(cases from every day in the horizon fold into within-day time buckets, divided by the
number of distinct days represented — omitting that division was a second measured defect
during development, silently comparing a multi-day demand total against a single day's
capacity and permanently swamping every window with an unresolvable deficit). The greedy
places agents one at a time via an exact one-step lookahead (evaluate the resulting
worst-case deficit for every valid start, commit to whichever minimizes it), preferring a
window where different starts genuinely discriminate over one every start serves
identically (a whole-day-spanning window is offset-invariant and, left unguarded, dominates
the "worst" selection by raw magnitude alone without carrying any placement signal —
measured directly as the cause of the first fix attempt's degenerate "spread everyone
evenly" output). House-monotone by construction (never depends on N, only on what's already
placed), and gated by `pickPlacementOrUniform`: a distribution only replaces the
uniform-start result when it verifiably passes a real DES run at the candidate N, so the
feature can never make a result worse than today's. Opt-in (`labor.shiftPlacementEnabled`,
default `false`) — zero behavior change for existing configs. See PRD §6 Stage 3a and
`project_context.md` §5 for the full writeup, and `scripts/verify-sizing-fixes.mts` suites
D20-D26 for the fail-first tests, including a brute-force optimality check and a positive
control against the failure mechanism above.

**Known scope limit, not a soundness gap**: the demand-coverage model assumes same-day SLA
windows; a deadline landing on a later calendar day than its release is folded in
conservatively as "due by end of the release day" (never under-constrains, not perfectly
tight for genuinely multi-day windows).

**A second, more serious defect found and fixed after the above**: the per-agent eligibility
computation at horizon start, and the idle-pool repopulation when a later slap cohort's
`AgentAvailable` fires, both lived inside code paths gated by `!skipCaseResultsAndTimeline` —
but the CI-gated replications that decide whether a candidate N passes always run WITH that
flag `true` (for speed; it is what the search uses on every candidate). Result: every
replication saw every agent as available from business open regardless of assigned slap
offset, so the CI gate scored a staggered distribution as if it were uniform. Measured: a
distribution the gate scored at ~78.7% attainment actually achieved 52.5% when honestly
simulated (`skipCaseResultsAndTimeline: false`) — a ~25 percentage-point inflation that let
the search recommend a headcount (48) that did not meet the 80% target it was supposed to
guarantee. Fixed by `agentOnShiftToday` (`des-engine.ts`), a per-agent eligibility tracker
maintained identically in both modes, with a second, related fix: a later cohort's
`AgentAvailable` firing mid-day must not re-admit an earlier cohort's still-busy agent into
the idle pool (checked against `activeProcessing`, not the skip-gated `agentState`).

**Honest status on VALUE, established empirically while re-verifying after the eligibility
fix above**: the analytic greedy's raw distribution has not been shown to reliably outperform
uniform-start on realistic continuous DES-driven demand — across many tested shapes (morning-
saturating, evening-heavy, single- and multi-day, tight and loose SLA windows), placement was
consistently no better than, and sometimes worse than, uniform. It demonstrably CAN find a
real, verified-against-brute-force improvement on a demand shape purpose-built to need it
(D22's release-gated construction). What is solid — and what D25 now pins directly, on a
deliberately adversarial demand shape where the raw distribution underperforms — is the
SAFETY property: `pickPlacementOrUniform` only ever lets a placement result replace the
uniform one when it verifiably passes, so the search's recommendation is never worse with the
flag on than with it off, whether or not placement manages to help. Improving the greedy's
average-case value, versus just its worst-case safety, is future work.

**2026-08-28 audit — a customer-reported zero-agent-interval symptom traced two real defects,
one confirmed false alarm, and one narrow but genuine break of the "never worse" claim
above.** A planner reported intervals with zero agents on a 08:00-22:00/9h-shift config with
placement enabled. Investigation, reproduced against the planner's own config snapshot,
forecast CSV, and exported queue timeline:

- **False alarm, but real bug (fixed):** the reported 08:00 zero was NOT the greedy's
  distribution reaching production — reproduction showed `winningDistribution = NONE`
  (uniform kept) on the planner's actual config. The true cause was a day-open telemetry
  off-by-one in the exported timeline (`intervalsTimeline`), unrelated to Stage 3a — see the
  "Day-open queue-timeline telemetry off-by-one" entry in `project_context.md` §11. Fixed.
- **Real, separate defect (not yet fixed):** on-shift coverage genuinely does collapse late
  in the business window under uniform-start when `dailyProductiveHours < businessWindowHours`
  — this is exactly the dead-zone mechanism described above, now confirmed on real
  (non-synthetic) data. There is no coverage floor anywhere in the search's acceptance
  predicate, so a candidate N can legitimately pass while leaving the queue with zero agents
  during open hours. Tracked as PRD §11 P0-4.
- **Root cause of the greedy's weak average-case value, now diagnosed:** the DES never
  enforces a shift END — an agent who starts a shift stays "available" (subject only to
  their remaining daily-minute budget) until business close, regardless of shift length.
  `shiftCapacityWithinDay` (the analytic model) assumes capacity is confined to
  `[offset, offset+shiftLength]`. These two models disagree, and the DES is the one that's
  wrong relative to how a real roster works: no agent stays on the floor for a 14-hour window
  to deliver a 9-hour shift. Measured: 11/16 agents in one run worked past their nominal
  shift end. This is why staggering starts LATER only ever removes early capacity without
  adding real late capacity in the current simulator — the late capacity was already there.
  Tracked as PRD §11 P0-4 (shift-end enforcement + real 24×7 multi-start).
  **Resolved 2026-10-08 (PRD 1.21.0, P2-9) for every non-24×7 run without a start
  distribution:** fixed-shift mode is now on for all non-24×7 runs, so a run with no distribution
  is one cohort at offset 0 whose agents leave `dailyProductiveHours` after open (flag
  `DESResult.fixedShifts`; suite D71). Earlier fixes covered runs that passed a distribution
  (2026-08-28). **Still open for 24×7 without a distribution** (agents stay on around the clock;
  PRD §10 L21).
- **The "never worse" guarantee has a narrow, confirmed exception:** `pickPlacementOrUniform`
  guards the per-N choice, but `placementFeasibleFloor` (N_sla) separately raises the
  search's *starting* N, and when that raised start passes immediately, the walk-down is
  skipped entirely with no `pickPlacementOrUniform` check in that path. A 192-config sweep
  found 27 configs where N_sla exceeds `max(N_min, N_occ)`, and 2 of them recommend a
  strictly higher headcount with the flag on than off (13/14/15 vs 13/14/14, both same-day
  SLA windows, evening-heavy demand). Tracked as PRD §11 P0-4.
- **Adherence/capacity conflation, confirmed but not the main driver:** `shiftCapacityWithinDay`
  is fed `dailyProductiveHours×60` with no adherence applied, while the DES budget applies
  adherence — a measured 25% over-credit at adherence 0.8. Correcting it moved N_sla higher
  (more honest) but did not flip the D25 adversarial scenario from losing to beating uniform,
  so this is a real correctness defect but not why the greedy underperforms.
- **`shiftPlacementMaxAttempts` (`wfm.ts`) is a phantom API** — documented in detail (multiple
  distributions tried per candidate N) but never read anywhere in `src/`, and the function its
  doc comment cites does not exist. Exactly one greedy attempt is tried per N today.

**2026-08-28 follow-up — shift-end enforcement + in-flight handover implemented (non-24×7).**
Root-caused above as the reason staggering could only ever remove early capacity without
adding real late capacity: the DES gave every staggered agent a start but no end. Fixed:

- `des-engine.ts` schedules a real `ShiftEnd` event per staggered cohort per day, at
  `dayOpen + offset + shiftLength`, SKIPPED when that time would coincide with `DayClose`
  (redundant — `getValidSlapStarts` guarantees `offset+shiftLength <= windowLength`, so it
  can only ever equal close, never exceed it). The handler takes currently-idle agents in
  that cohort off the floor; busy agents are left alone — their own termination is already
  computed correctly at assignment time (see next point), so touching them here too would
  race that event.
- `dispatchSingleQueue`'s look-ahead gained a third bound alongside agent budget and business
  close: the agent's own remaining shift minutes (`Infinity` when not staggered — exact
  legacy behavior, unchanged). Whichever bound is soonest determines the case's fate: fits
  entirely → normal completion; cut short by budget/close → existing park-to-next-business-
  day semantics (`CaseResume`), unchanged; cut short specifically by the agent's OWN shift
  ending, with budget and close both still ample → NEW handover semantics
  (`CasePark` event carrying `data.handover: true`): the case returns to the LIVE queue
  immediately, the agent goes straight to `'off'` (bypassing the existing idle-return check,
  which would otherwise incorrectly return them to idle since their budget may not yet be
  exhausted), and `dispatchAll` runs immediately so a still-on-shift colleague can pick it up
  the same day — never deferred overnight.
- Suites D30 (5 assertions: a genuine mid-day cutoff is enforced; a shift ending exactly at
  close is NOT cut off early; full invariant suite incl. #8 still holds) and D31 (3
  assertions: a case demonstrably interrupted mid-processing is completed by a DIFFERENT,
  still-on-shift agent, the same business day) — both necessarily fail-first-meaningful since
  `ShiftEnd` did not exist as a concept in staggeredMode before this change.
- Verified against the FULL existing test corpus, not just the new suites: legacy suite
  174/174 unaffected (uses no staggering — zero blast radius by construction), sizing suite
  170/170 (was 162; +8 new). One real interaction surfaced and fixed during verification:
  D29's fail-first injection technique (splitting an idle slice, shrinking a same-day busy
  slice to compensate for daily-budget accounting) initially broke because the affected
  agent's day was now ONE CONTINUOUS busy run under shift-end enforcement (no natural idle
  boundary to extend) — fixed by inserting a fresh idle slice into the gap directly rather
  than depending on an adjacent slice's state.
- **Scoped to non-24×7.** `calendar.is24x7` still forces `staggeredMode = false` and
  `getValidSlapStarts` still returns `[0]` for 24×7 — those calendars are completely
  unaffected by this change. Real 24×7 multi-start (a circular day grid, shifts wrapping past
  midnight, shift-end/handover logic spanning the day boundary) is tracked as its own
  follow-up increment, deliberately not folded into this one so its blast radius on 24×7
  configs can be verified in isolation.

**2026-08-28 follow-up #2 — minimum-coverage floor (G1) implemented, default ON.**
The stated product goal (workforce-planning sizing) treats "the queue may never be left
unattended while the business is running" as a hard requirement, not a nice-to-have — yet
nothing in the acceptance predicate had ever checked it. A candidate could legitimately
pass every statistical gate while leaving zero agents on shift for hours, whenever the
business window exceeded the shift length under uniform-start.

- `SLAPolicyConfig.minCoverageEnabled`/`minAgentsPerInterval` (default: enabled at 1) mirror
  `occupancyCapEnabled`/`occupancyCapPct`, but with the OPPOSITE default polarity — omission
  means ON, not off, since G1 is meant to be the safe-by-default behavior.
- Detection is mode-independent by necessity: the CI-gated search replications that decide
  pass/fail always run with `skipCaseResultsAndTimeline: true`, so coverage cannot be
  computed from `agentTimeline`/`intervalsTimeline` (both empty in that mode) the way a
  naive implementation would reach for. Built instead from `agentOnShiftToday` and
  `agentDailyMinutesRemaining` — both already maintained in every mode — sampled at
  `AgentAvailable`, `ShiftEnd`, `CasePark`, and `ProcessingComplete` (the only event types
  that can change who's on shift and unexhausted). Aggregated across replications as a hard
  floor: the WORST replication must individually satisfy it, unlike the mean-based CI gate
  Primary SLA/occupancy/ASA use — an average argument does not make sense for "was the
  queue ever left unattended."
- **The design decision that made turning this on by default SAFE**: coverage must be
  satisfiable by redistribution at the SAME N, independent of `shiftPlacementEnabled` —
  otherwise every existing config with a window wider than the shift length would exhaust
  its search to infeasible the moment this floor went live for anyone not already using
  placement. `buildCoverageRepairDistribution` (`hc-search.ts`) computes the minimal
  redistribution via a greedy minimal interval cover (repeatedly pick the largest valid
  start at/before the currently-covered frontier — optimal for equal-length spans on a
  discrete grid), moving the fewest agents off offset 0, and is wired into both search
  entry points UNCONDITIONALLY, running before the existing SLA-driven greedy so a
  coverage-only need never pays for a deficit-minimizing search it doesn't need.
- **Proven, not assumed, to cost nothing on the field-reported config**: measured during
  this session's investigation, moving exactly one agent from an 08:00 start to a 13:00
  start on the reporting planner's real 33-agent, 08:00-22:00/9h-shift config fixed a
  genuine coverage violation at the business close (21:00) with ZERO change in SLA
  attainment (100%→100%). Suite D33's integration test reproduces this class of proof
  generically: full search, `shiftPlacementEnabled` OMITTED, identical recommendation with
  the floor on vs off.
- **A real bug caught by the suite's own fail-first check before merge (D33.4)**: the first
  version of `buildCoverageRepairDistribution` computed `required = nonZero.length ×
  minAgentsPerInterval` and gave offset 0 "whatever's left" — at N exactly matching that
  requirement, offset 0 got ZERO agents, meaning the distribution "covered" the tail while
  leaving the window's OPENING uncovered. The test asserted N=1 should return null (one
  agent cannot cover two disjoint offsets) and instead got back a distribution assigning
  that sole agent entirely to the tail offset. Fixed by requiring
  `(nonZero.length + 1) × minAgentsPerInterval` seats — offset 0 must independently clear
  the floor too, not merely receive the remainder.
- Verified: legacy suite 174/174 unaffected (fixtures don't trip the new default in
  practice — none combine a window wider than the shift with volume high enough to matter),
  D32 (12 assertions: defaults/clamping/genuine detection/exact parity when disabled) and
  D33 (8 assertions, including the caught bug and the full-search integration proof) all
  green, 190/190 total sizing suite. UI: a toggle in SLA Defaults and a results card in
  Results & Audit, both mirroring the occupancy-cap pattern, verified in a live dev-server
  pass with zero console errors.
- **Not yet done**: joint (rather than per-category-independent) coverage optimization for
  siloed queue architecture; 24×7 coverage (moot until 24×7 multi-start itself exists).

**2026-08-28 follow-up #3 — Gap A, Gap B, and Gap G closed.**

**Gap A (never-worse guarantee had a narrow exception, now fixed).**
`pickPlacementOrUniform` (the per-N replace-only-if-passes gate) was never the whole story:
`placementFeasibleFloor` (N_sla) separately fed into `startN`'s `Math.max(...)` in both
`searchOptimalHC` and `searchOptimalHCAsync`. When that raised start passed immediately
(the `if (startEval.passesAllConstraints)` branch), the walk-down loop — the only place
`pickPlacementOrUniform` runs — never executed at all. A 192-config sweep during the
2026-08-28 audit found 27 configs where N_sla exceeded `max(N_min, N_occ)`, 2 of which
recommended a strictly higher N with the flag on (13/14/15 → off=14, on=15, both same-day
SLA windows, evening-heavy demand). Fixed by removing N_sla from `startN` entirely in both
entry points — it remains reported via `HCSearchOutput.shiftPlacement.placementFeasibleFloor`
for diagnostic/UI purposes, never used to seed or gate the search. Suite D34 pins the exact
falsifying config found during the sweep, in both sync and async (the D8/D11 drift hazard).
Verified fail-first: D34.2/D34.4 failed with `off=14 on=15` against the pre-fix code,
confirmed passing with `off=on=14` after.

**Gap B (capacity/adherence conflation, now fixed).**
`shiftCapacityWithinDay` was fed `dailyProductiveHours × 60` (un-adhered) as agent capacity
in `computeCandidatePlacementDistribution` and both search entry points' N_sla computation
— a measured 25% over-credit at adherence 0.8, versus the DES's actual
`dailyProductiveHours × adherence × 60` budget. `getValidSlapStarts`' window-fit test
correctly keeps the un-adhered figure: whether a shift SPAN fits inside the business window
is a presence question (the agent is on the clock for the full shift length regardless of
how much of it is adhered/productive), not a capacity one — this distinction is why the fix
touches only the capacity-facing call sites, not `getValidSlapStarts` itself. Suite D35
closed-form pins the exact discriminating scenario (a window sized to exactly the shift
length, forcing a single valid start so N_sla reduces to pure capacity arithmetic):
totalWork=1300min, target 80%, adhered capacity 432min/agent → N_sla=3 (correct); un-adhered
540min/agent → N_sla=2 (would have understated the true requirement by one agent). D35.5
confirms the production `searchOptimalHC` path reports the corrected value, not the buggy
one, on this scenario.

**Gap G (`shiftPlacementMaxAttempts` — phantom API, removed rather than implemented).**
`LaborConfig.shiftPlacementMaxAttempts` was documented in detail — "Attempt 1 is always the
analytically-optimal greedy... it alone determines pass/fail (see `evaluateNWithPlacement`
in `hc-search.ts`)... Attempts 2..max only refine the reported schedule at an
already-passing N; they can never change accept/reject" — but was never read anywhere in
`src/`, and `evaluateNWithPlacement` did not exist as a function in the codebase. This was
the phantom API the user's original architectural challenge ("the code must try different
distributions before rejecting N") correctly diagnosed as missing. Two implementation paths
were considered:
1. A version that could affect accept/reject at a given N (directly answering the user's
   ask) — rejected for this pass: it requires proving the resulting pass/fail predicate
   stays monotone in N (the walk-down search's correctness assumption, and exactly the class
   of hazard §6.10's frozen apportionment decision warns about), which was not something
   this pass had room to verify rigorously.
2. The narrower, documented version — refine which PASSING schedule is displayed at an
   already-accepted N, never touching accept/reject — is provably safe (accept/reject stays
   byte-identical to today), but was judged not worth the added complexity for a benefit
   that is cosmetic (which schedule is shown) rather than substantive (whether N passes).
Given neither path could be responsibly shipped in this pass, the phantom field and its
doc comment were removed (confirmed via grep that nothing else referenced it) rather than
left as a misleading promise. A real multi-candidate search that safely affects accept/
reject remains valuable, well-scoped future work — see PRD §11 P0-4 — but needs the
monotonicity proof done first, not a field added ahead of the implementation.

Verified together: legacy suite 174/174 (unaffected by any of the three), sizing suite
199/199 (190 prior + D34's 4 + D35's 5), `npm run build:standalone` and
`npm run check:artifact` both pass.

**2026-08-28 follow-up #4 — user challenge caught an inconsistent Gap G justification and a
live 24×7 regression in the work above. Both corrected same day.**

**On Gap G:** the "needs a monotonicity proof" reasoning above does not survive scrutiny.
`evaluateN`/`evaluateAsync` already decide accept/reject for each candidate N via a
three-way disjunction — `uniformPasses(N) OR coverageRepairPasses(N) OR placementPasses(N)`
(the code's own comment at the `pickPlacementOrUniform` call site says exactly this) — with
no monotonicity proof backing it. That was shipped in the coverage-floor work above. Gap G
was then rejected for needing a proof the shipped disjunction itself never had. Further:
**no monotonicity proof exists anywhere in this codebase** for DES pass/fail vs N — the
apportionment "house-monotone" property (§6.10) and the placement greedy's "house-monotone
by construction" comment (`hc-search.ts`, `computeShiftPlacement`) each guarantee only that
one specific *output* (apportionment shares, the placement distribution) grows with N, never
that the DES *pass/fail result* is monotone; `project_context.md` states monotonicity as an
open, undischarged assumption the walk-down search rests on. And the actual failure mode
under non-monotonicity is not unsafe — the walk-down only ever returns an N verified passing
at full replication count (re-confirmed at the point of return); a "hole" just means the
returned N is not minimal. That is a precision concern, not the safety blocker this entry
originally claimed. The genuinely honest reason to not build a full multi-attempt search —
brute-force testing found near-zero benefit and no reject→accept flip — is still on the
table, but every one of those measurements predates the shift-end fix (the earlier session
entry above), which is exactly the mechanism that made staggering unable to help. That
evidence is stale. **Re-measurement under the current model is the immediate next step,
not yet done** — this decision log entry is deliberately left open rather than re-closed
with a guess.

**On 24×7 (the serious one) — this was a live regression the coverage-floor work introduced,
not scoped-out future work.** The default-on floor is enforced for 24×7 (`isWorking()`
never skips a sample there), but `staggeredMode` is unconditionally false for 24×7
(`calendar.is24x7` forces it), so `countAgentsOnShiftNow()` degenerates from "is this agent
scheduled to be here" to "has this agent not yet exhausted their daily minutes" — a capacity
signal wearing a scheduling signal's name. Both repair levers
(`buildCoverageRepairDistribution`, placement) are unconditionally disabled for 24×7 too.
Net effect: turning the floor on by default made the search climb N purely to manufacture
budget slack for agents, with zero relationship to actual staffing need. Measured on a
calibrated scenario (a burst concentrated in hours 0-10 of a 5-day 24×7 horizon, chosen so
occupancy averages low across the whole horizon while the burst itself still exhausts agent
budgets same-day): SLA and occupancy both passed comfortably at N=3; enabling coverage
forced the recommendation to N=11 — a 267% inflation with no connection to demand. An
earlier, uncalibrated attempt at this test scenario accidentally coupled coverage's flip
point to occupancy's, masking the regression (both happened to bind at the same N) — the
final D36 scenario deliberately decouples them via the multi-day-averaging trick above.
Fixed by disabling the GATE (not the diagnostic — `minCoverageObserved` stays honest) for
`is24x7`, in TWO independent places: `runBackofficeDES`'s single-run `passesCoverage`
(`des-engine.ts`) and `computeStatisticalEvaluation`'s replication-aggregated version
(`hc-search.ts`), which recomputes independently from raw `minCoverageObserved` per
replication rather than trusting the per-run flag — the first fix alone would not have
reached the search's actual pass/fail decision. D36 (6 assertions, including a control
proving the guard is 24×7-specific and does not blanket-disable coverage for business-hours
calendars) pins this fail-first: `D36.2` failed with `coverageOn=11 coverageOff=3` before
the fix, passes with `coverageOn=coverageOff=3` after.

**Also corrected: the 24×7 multi-start cost estimate was wrong.** Earlier framing described
it as needing "a circular day grid, shifts wrapping midnight." A 24×7 day is simply a fixed
1440-minute window; the existing `start + shiftLength <= windowLength` rule already permits
non-wrapping shifts to tile it fully (e.g. three 8h starts at 0/480/960, or three 9h starts
at 0/540/900 with overlap). Wrapping shifts are a rostering nicety, not a coverage
requirement. This inflated cost estimate partly drove the original decision to defer 24×7
entirely; the real fix is smaller than stated.

Verified: legacy suite 174/174 (unaffected — the guard is 24×7-specific), sizing suite
205/205 (199 prior + D36's 6).

**2026-08-28 follow-up #5 — real 24×7 multi-start delivered same day, not left as future
work.** Having just fixed the regression above by disabling coverage for 24×7, the honest
next question was whether 24×7 could get an actual repair lever instead of permanently
having no coverage guarantee. It could, and the estimate that blocked it earlier ("a
circular day grid, shifts wrapping midnight") was simply wrong — 24×7 is a fixed 1440-minute
window, and the existing `start + shiftLength <= windowLength` rule already permits
non-wrapping shifts to tile it fully (three 8h starts at 0/480/960; three 9h starts at
0/540/900 with overlap). Implemented:

- `getValidSlapStarts` (`calendar.ts`) no longer special-cases `is24x7` to return `[0]` — it
  runs the same grid-enumeration formula used for business-hours calendars, since
  `getDailyWindowLengthHours` already returns 24 for 24×7 and `getDailyOpenClose` already
  returns midnight-to-next-midnight there.
- `staggeredMode` (`des-engine.ts`) dropped its `!calendar.is24x7` condition.
- The day-open event-scheduling loop's separate `is24x7`-only branch (which scheduled
  nothing but a single system-wide `AgentAvailable`) was merged into the same staggered
  scheduling used for business hours. Two things preserved deliberately: (1) `DayClose` is
  still NEVER scheduled for 24×7 — parking in-flight work at an artificial midnight boundary
  would directly contradict BUG-D's continuous-24×7-processing decision; (2) because there is
  no `DayClose` to make a redundant `ShiftEnd` unnecessary, 24×7 now ALWAYS schedules
  `ShiftEnd` for every cohort (including one whose end coincides exactly with the midnight
  boundary), where business-hours calendars still skip it when it coincides with close.
- The midnight budget-refill branch in `AgentAvailable` (`activeProcessing.size > 0` spillover
  adjustment, added for BUG-D/T3-1) is now explicitly gated `!staggeredMode`. Reasoning: under
  staggering every agent's assignment is already bounded by their own shift end (the 3-way
  min in `dispatchSingleQueue`), so a staggered agent can never be mid-task AT the midnight
  boundary the way an unstaggered 24×7 agent could — a cohort whose shift ends exactly at
  midnight hands over via the normal `ShiftEnd`/handover mechanism before/at that instant,
  converting what would have been "spillover" into an ordinary same-day handover. The
  spillover scenario is therefore specific to the legacy unstaggered path and does not arise
  under staggering. T3-1 (which exercises the unstaggered path) is unaffected — confirmed by
  re-running it after this change.
- The `is24x7` bails in `computeCandidatePlacementDistribution`, `buildCoverageRepairDistribution`,
  and the four `!calendar.is24x7` guards around N_sla/coverage-repair in both search entry
  points were all removed. The Step 1 gate exclusions in `runBackofficeDES` and
  `computeStatisticalEvaluation` were reverted (24×7 now uses the same coverage gate as
  business-hours calendars).

**Two real defects found and fixed while validating this — both caught by the D36/D37 test
scenarios themselves failing in ways that couldn't be explained away:**

1. **Same-timestamp coverage-sampling artifact.** `sampleCoverage` originally fired
   immediately inside each event handler (`AgentAvailable`, `ShiftEnd`, `CasePark`,
   `ProcessingComplete`). A hand-built perfect 3-way 24×7 tiling (agents at offsets 0/480/960,
   continuous handoffs, zero gaps in the actual `agentTimeline`) still reported
   `minCoverageObserved=0`. Traced to: an outgoing cohort's `ShiftEnd` and an incoming
   cohort's `AgentAvailable` land on the IDENTICAL timestamp at every clean handoff; whichever
   fires first samples coverage before the other cohort's `agentOnShiftToday` bit flips,
   producing a transient false zero that a genuinely unbroken handoff should never register.
   This is exactly the class of bug the day-open telemetry fix (Gap H, `logTimelineState`)
   already solved — fixed the same way: removed all inline `sampleCoverage` calls and added
   ONE deferred call at the same point in the main event loop where `logTimelineState` already
   defers (peek the next queued event; only sample once no more events share this exact
   timestamp).
2. **Busy-agent presence undercounted at final budget chunk.** Even after fixing (1), the
   same hand-built tiling still showed a false zero — this time at an ordinary mid-shift
   case-completion boundary, nowhere near a cohort transition. Root cause:
   `agentDailyMinutesRemaining` is decremented at ASSIGNMENT time, not completion time, so an
   agent dispatched their final chunk of the day's budget shows `remaining ≈ 0` from the
   moment they're assigned it — while still actively, genuinely busy working that exact
   chunk. `countAgentsOnShiftNow()`'s `remaining > 0.01` check therefore excluded a
   currently-working agent right when they consumed their last minutes. Fixed by also
   counting any agent present in `activeProcessing` regardless of remaining budget — being
   busy is presence by definition. This is a genuine correctness gap in the ORIGINAL Phase 3
   coverage implementation, not something introduced by 24×7 work — it simply took a
   perfectly-tiled, zero-slack 24×7 scenario to expose it; ordinary business-hours configs
   with any budget slack would rarely land exactly on this edge.

D37 (5 assertions) pins the working mechanism directly: `getValidSlapStarts` tiles a 24h day
for an 8h shift; a staggered 24×7 agent genuinely goes off at their own shift end (not
present indefinitely); `verifyAgentTimelineInvariants` (including the daily-budget check)
holds under staggered 24×7; the D36 burst scenario — which needed N=11 under the interim
guard purely from budget-slack accounting — now finds a genuinely covering N well below that
via real redistribution, and the final audit run genuinely satisfies coverage.

**Known limitation carried forward, not fixed here:** `buildOneDayDemandGrid` still buckets
ALL 24×7 demand into a single whole-day cell regardless of when in the day it actually
arrives — a pre-existing simplification, unrelated to this session's changes, that was
simply never reachable before since placement always bailed on `is24x7`. This means the
SLA-driven placement greedy has little real signal for 24×7 (every offset looks equally
good against a single flattened demand bucket). Coverage repair is unaffected — it is pure
interval-covering geometry and needs no demand data at all — which is why it is the
mechanism that actually delivers the fix here.

Verified: legacy suite 174/174 (fully unaffected — confirms neither the merged scheduling
loop nor the spillover-gating change touched the unstaggered/non-24×7 paths T3-1 and the
rest of the legacy suite exercise), sizing suite 211/211 (205 prior + D37's 6).

**2026-08-28 follow-up #6 — Gap G re-measured under the fixed labor model and CLOSED.**
Follow-up #4 left Gap G deliberately open: every prior brute-force measurement of whether
staggered shift-start distributions could flip a uniform-start SLA reject into an accept
predated the shift-end fix (#3 above), so the "near-zero benefit" evidence was stale — under
the old model agents never left the floor, so staggering could only ever subtract early
capacity, which is exactly why nothing helped. That mechanism no longer exists after #3/#5,
so the question was re-measured rather than assumed.

**Method.** A throwaway probe script (never committed to the repo; lived only in the
scratchpad directory per this session's established convention, deleted after use) called
`evaluateCandidateStatistical`, `buildCoverageRepairDistribution`, and
`computeCandidatePlacementDistribution` directly — the same functions the shipped 3-way
disjunction (`uniformPasses(N) OR coverageRepairPasses(N) OR placementPasses(N)`) uses — on
the classic dead-zone config from D32/D33 (08:00–22:00 window, 9h shift, default minimum-
coverage floor ON). For each candidate N where uniform-start failed, it additionally
brute-forced ~20-30 hand-built 2- and 3-cohort staggered distributions (varying which pair/
triple of the 11 valid shift starts got agents, and the split ratio between them: 30/70,
50/50, 70/30) and checked whether ANY of them passed where uniform, coverage-repair, and the
existing placement greedy all failed. Tested at two scales per the plan: small-N (N=4–9,
coarse per-agent granularity, where one extra agent is a large percentage jump) and large-N
(N=28–38, ~30-40 agents, fine granularity, closer to a realistic sizing scenario).

**Result: no flip found at either scale.**
- Small-N (N=4–9): at N=6, uniform-start alone already achieved 100% primary SLA while every
  staggered candidate scored lower (best brute-force candidate also hit 100% by coincidence
  at that specific N, but never exceeded uniform; at N=4-5 uniform trailed staggering
  slightly but neither passed the coverage gate). By N=7 uniform passes cleanly and the
  question is moot.
- Large-N (N=28–38): uniform-start's primary SLA attainment consistently **beat** every
  staggered candidate tried — e.g. at N=38, uniform reached 97.9% while the best staggered
  candidate found (a 19/19 split across offsets 0 and 300) reached only 84.4%, and neither
  passed the coverage floor (which is the constraint actually binding in this scenario, not
  primary SLA).

**Why staggering doesn't help here, understood mechanistically (not just observed).** The
08:00–22:00 window is deliberately wider than the 9h shift so the queue needs continuous
attendance for the full 14h. Coverage is a *presence* constraint (is at least one agent on
shift at every interval), not a *throughput* one. Splitting N agents across two or three
staggered starts THINS how many are present at any single moment — the opposite of what a
presence floor needs — while simultaneously fragmenting the case-handling continuity that
drives primary SLA attainment (more handovers, more agents each holding a narrower slice of
the day). Coverage-repair (`buildCoverageRepairDistribution`) is the correct lever for the
presence problem because it deliberately places the minimum extra agents needed to close
each specific coverage gap, rather than spreading capacity thin across the whole window; when
even that repair distribution failed to close the gap in this probe, no amount of alternative
staggering did better because staggering was never actually the mechanism coverage needed.

**Decision (per the rule stated in advance in the remediation plan): no multi-attempt search
was built.** The correct closing reason for Gap G is measured near-zero — in fact negative —
benefit even under the shift-end-corrected labor model, not the retracted "needs a
monotonicity proof" reasoning from follow-up #3, and not a guess based on stale pre-fix
evidence as follow-up #4 correctly flagged. `LaborConfig.shiftPlacementMaxAttempts` remains
removed (not reintroduced) — see follow-up #3's phantom-API writeup, now additionally
supported by fresh empirical evidence rather than resting on the withdrawn monotonicity
argument alone. **PRD §11 P0-4 is now closed in full** (24×7 multi-start closed the same day
in follow-up #5; Gap G closes here).

**Also fixed same-day, presentation-only (Step 4 of the same remediation pass):** the
`searchOptimalHCAsync` progress message read `Exact minimum N=... (N-1=... failed)`, which is
not a warranted claim — DES pass/fail monotonicity in N is still an undischarged, open
assumption (unaffected by the Gap G finding above; the two are independent questions). Reworded to
`Lowest verified-passing N=... found (N-1=... failed the gate)` — states exactly what the
search verified (an N that passed, immediately preceded by one that failed) without implying
a minimality proof that doesn't exist. No logic change; pinned by suite D38 (2 assertions,
source-text based — see below for why).

**A side-finding while testing Step 4: the "Exact minimum" message is dead code.** The
post-walk-down re-evaluate call that builds this message (`evaluateAsync(recommendedHC, ...)`
immediately after the walk-down loop) always lands on an `operationalHC` value already
evaluated earlier in the same loop (`lastPass`/`ceilingHigh` are only ever set from a prior
successful `evaluateAsync` call at that exact N). `evaluateAsync`'s `evalCache` returns the
cached result on a hit **before** calling `onProgress`, so this specific progress message can
never actually reach a listener in practice — confirmed empirically via a throwaway scratchpad
probe capturing every `onProgress` message across several walk-down-exercising scenarios; the
literal string never appeared in any of them. D38 is therefore a **source-text** assertion
against the string literal in `hc-search.ts`, not a runtime/`onProgress` behavioral test — the
honest and reliable pin for a presentation-only fix to unreachable code. Left as unreachable
(not deleted) since removing the redundant re-evaluate call is a logic change outside this
step's presentation-only scope; worth a follow-up cleanup someday but not required for
correctness since it is provably a no-op today.

**Also added: an empirical monotonicity sweep (D39).** No prior test checked that DES
pass/fail is actually monotone in N — only that specific outputs (placement distribution,
apportionment shares) grow monotonically. D39 sweeps the **uniform-only** predicate
(`evaluateCandidateStatistical` with no `shiftDistribution`, i.e. what `evaluateN`'s first
disjunct checks) across a representative range of N (1..25) on a straightforward business-hours
config, following the same pattern as D3.1's apportionment sweep. The full 3-way disjunction
was deliberately NOT swept, and `evaluateN`/`evaluateAsync` were NOT refactored into a shared
function for this — the remediation plan's own decision rule reserves that extraction for the
case where Step 3 concludes a multi-attempt search is worth building (it did not; see above),
since only then would the extraction be a shared cost rather than an added risk with no
offsetting benefit. Result: the sweep found no monotonicity violation in the range tested —
consistent with (but not proof of) the assumption the walk-down search rests on. This remains
an open, honestly-labeled assumption, not a closed one; a future, wider sweep (or a sweep of
the full disjunction, which would need the extraction above) remains worthwhile future work.

Verified: legacy suite 174/174 (unaffected — no engine logic changed, only a message string
and two new suites), sizing suite 215/215 (211 prior + D38's 2 wording-pin assertions + D39's
2 monotonicity-sweep assertions).

### D8 — Off-hours mitigation existed only in sync `searchOptimalHC` *(fixed 2026-08-28)*
The off-hours mitigation (silently rewriting `sla.clockStartPolicy` from `'arrival'` to
`'next_open'` when >15% of volume arrives outside business hours, `hc-search.ts:1443–1455`)
existed only in `searchOptimalHC`. `App.tsx` and `SensitivityFlow.tsx` call **only**
`searchOptimalHCAsync`, so the mitigation never ran for a real user — but a trusted-source
benchmark run (`scripts/verify-trusted-source.mts`) exercises the sync path, so the harness
was validating behavior the app doesn't ship. Tracked as PRD P0-2.

**Measured impact of the drift**, on a throwaway 5-day dataset (89% off-hours volume,
`clockBasis: 'wall_clock'`, 1h primary window — chosen because `business_time` clock basis
mostly masks the gap, since `addWorkingTime` internally rebases off-hours starts via
`nextOpen` regardless of `clockStartPolicy`): sync returned `recommendedHC=24`; async
returned `recommendedHC=null, isInfeasible=true` on identical input.

**Resolved by deleting the mitigation from `searchOptimalHC`, not by porting it into async.**
Three reasons this is the right direction, not just the cheaper one:
1. `clockStartPolicy` is a deliberate planner-facing toggle (`ConfigFlow.tsx`). The mitigation
   silently overrode it.
2. The override was unreportable — `HCSearchOutput` has no field for the effective policy, so
   `ResultsFlow.tsx`'s `sla_clockStartPolicy` audit line would have shown the user's original
   choice even while the engine simulated a different one, had this been ported into async.
3. `csv-parser.ts`'s DQ layer already warns at the identical >15% threshold and recommends the
   same remedy ("Set Clock Start Policy to 'Next Open Business Window'") — as a conscious
   planner decision, which is the correct place for this choice to live.

Verified zero effect on shipped behavior: async's result on the reproduction dataset is
identical before and after the fix; sync now agrees with (unchanged) async. Full suite
still 215/215; trusted-source benchmark still 135/135 (only one scenario,
`scenario_T3_R2_invalid_date_interval_asymmetry`, had inputs that triggered the deleted
mitigation, and its sole assertion — `nMinAnalytical`, which never read `clockStartPolicy` —
was unaffected).

D11 (the sync/async duplication that made this possible) remains open — this fixed the one
symptom it produced, not the root cause.

### D40 — `N_min` floor-vs-ceil doc/code mismatch *(resolved 2026-08-28 — code confirmed correct)*
`computeAnalyticalNMin` (`hc-search.ts:89`) uses `Math.floor`; `docs/wfm/04-capacity-planning-and-sizing.md:37`
previously documented `Math.ceil` plus an invariant claiming N_min capacity is always ≥
demand. Measured: `floor(500/28.9)=17` gives 491.3h capacity against 500h demand — below
break-even at that exact headcount.

**Human-confirmed 2026-08-28: `floor` is correct, no further discussion.** `N_min` is a
*starting floor* for the Stage 3 DES search, not itself a standalone feasibility guarantee —
the search evaluates upward from `N_min` under CI-gated SLA/occupancy acceptance, so a
fractional shortfall at the raw analytical ratio is caught there, not asserted away at Stage
2. Frozen decision #4 ("N_min is a hard search floor") describes the drain-window-edge-effect
guard, not a claim that `N_min` alone clears demand.

**Resolved by correcting the documentation to match the code**, not by changing the code:
`docs/wfm/04-capacity-planning-and-sizing.md` now documents `floor` and explains the Stage 3
handoff instead of asserting the stale invariant. Zero effect on shipped output — no code
changed. See `trusted-source-validation.json`'s `NMIN-FLOOR-VS-CEIL` entry for the original
measurement.

### D41 — Extra OFF roster multiplier divided by the calendar week, not the open week *(fixed 2026-08-28)*
Stage 4's extra-OFF adjustment (`computeExtraOffPct`, `hc-search.ts`) computed
`operationalHCWithOff = floor(operationalHC * (1 + extraOffDays/7))` — treating the uplift as
a fraction of the full 7-day calendar week. But agents only ever supply capacity on
calendar-**open** days, so the correct multiplier is the coverage ratio
`openDaysPerWeek / coverageDays` (`coverageDays = openDaysPerWeek - extraOffDays`). The two
formulas agree only when `extraOffDays = 0`, which is why this shipped unnoticed: the default
config (5-day calendar, `offDaysPerWeek: 2`) always lands on `extraOffDays = 0`
(`calendarClosedDays` already absorbs both labor off days), so the defect never triggered
under default settings, and `trusted-source-validation.json` had zero scenarios with
`extraOffDays > 0` to catch it.

**Measured impact of the drift** (all at `operationalHC = 100`):

| Open days | Labor off | extraOffDays | Old (`floor(N×(1+extraOff/7))`) | Correct (`floor(N×open/coverage)`) | Under-statement |
|---|---|---|---|---|---|
| 6 | 2 | 1 | 114 | 120 | −5% |
| 7 | 2 | 2 | 128 | 140 | −8.6% |
| 6 | 3 | 2 | 128 | 150 | −14.7% |
| 7 | 3 | 3 | 142 | 175 | −18.9% |
| 5 | 5 | 3 | 142 | 250 | −43.2% |

The error worsens monotonically with off days and is worst at `openDays = 7` (24×7 calendars)
— which is exactly where the UI's 24/7 checkbox force-sets `offDaysPerWeek: 0`
(`CalendarConfigPanel.tsx`), masking the defect further for the one configuration where it
would have been largest. Two independent defects concealing each other, not one.

**Fixed by computing the coverage ratio integer-exact**, not via a floored fractional
multiplier: `floor((operationalHC * openDaysPerWeek) / coverageDays)`. A naive
`floor(N * (1 + rosterUpliftPct))` reintroduces a *separate* binary-float-precision bug even
with the corrected ratio — e.g. `45 * (1 + 0.4) = 62.999999999999999 → 62` where the true
value is `45*7/5 = 63` — because `openDaysPerWeek/coverageDays` ratios like `7/5` are
non-terminating in binary. Both defects are pinned together in
`scripts/verify-sizing-fixes.mts` Suite D40 (D40.1 sweeps the ratio table above; D40.2
pins the float-exactness cases) and in `trusted-source-validation.json`'s
`scenario_T1_A2c_extraoff_coverage_ratio` (hand-derived, tier `T1_domain_algebra`).

**Also added:** a `rosterInfeasible` guard for `coverageDays <= 0` (labor off days meet or
exceed open days — reachable via `App.tsx`'s unvalidated `handleImportParams`). Previously
this silently produced a misleadingly small multiplier (e.g. `offPct` clamped to at most 2×
via `Math.min(1, ...)`, which also happened to mean the old formula's error was structurally
capped exactly where it would otherwise have been largest); it is now flagged explicitly in
`bindingConstraint` and surfaced in the Results UI rather than silently under-adjusting.

`offPct` (`extraOffDays/7`) is kept as a display-only fraction (shown as "X% OFF" alongside
the new "+Y% roster uplift" figure) — it was never correctly the applied multiplier and still
isn't; only its use as the seat-to-roster multiplier was the bug.

---

### 2026-09-29 (C6) - Coverage presence = the agent's own shift window (supersedes the budget-as-presence entries above)

The coverage entries above describe presence as "has daily budget remaining, or is busy". That was an
implementation proxy, and it was wrong on real data: at adherence 0.98 the daily budget (470.4 min) is
shorter than a 480-min shift, so a saturated late cohort "left" up to 9.6 min before close, coverage
repair never passed, and uniform passed only by hiring enough agents that some kept unused budget until
close. Measured recommended HC (pooled): `AJM_Simu.csv` 104 with SLA alone needing ~61.

Fix (user-confirmed facts: agents work fixed contiguous shifts, no split shifts; the 08:00-22:00 window is
real; adherence only shrinks the productive budget inside the shift; the queue is never unattended in
business hours): an agent is present iff `dayOpen + startOffset <= t < dayOpen + startOffset +
dailyProductiveHours x 60`, regardless of remaining budget or busy state (`countAgentsOnShiftNow`,
`des-engine.ts`). Uniform layouts use offset 0, so a shift shorter than the open day fails coverage for any
N and only staggered starts (coverage repair) can pass. Dispatch eligibility and the work budget are
unchanged. Results (same seeds; N_min identical everywhere): `AJM_Only` 12->7 / 11->7, `AJM_Simu` 104->64 /
96->66, `EGS_Only` 81->49 / 77->50, `EGS_Only` with 20% reduction 52->31 / 52->35 (pooled / siloed); the three
built-in samples unchanged; fair vs legacy assignment identical in all 18 re-measured scenarios (the old
"+1 from fairness" was this artefact). One suite fixture (D33: 9h shift, 14h window) now needs +1 head with
coverage on (22 vs 21): one seat must move to a late cohort, which is the honest cost of fixed shifts.
(Since 2026-10-08, P2-9: with coverage OFF the same fixture rises 21 -> 28, because a run with no start
distribution now also ends each shift after 9h; coverage OFF can therefore exceed coverage ON.)
Side fixes: the binding label reports `min_coverage` when the path that decided N-1 (repair, else uniform)
failed coverage alone; the search evaluates repair first when uniform is structurally unable to pass.
Known caveat: on real files the forced staggered layout costs some SLA, so their label remains the SLA gate.

---

### 2026-10-07 (G3 + G5) — Timezone markers converted silently; category spelling variants split one category *(fixed, warning only for G3)*

**Defect.** (G3) `2026-01-05T08:00:00Z`, `...+04:00` and numeric epoch timestamps are converted to the clock of the PC opening the file (08:00Z = 12:00 in Dubai, 03:00 in New York) with no message. (G5) Category names were matched exactly, so `Billing`, `billing ` and `BILLING` became three categories, each seeded with 30 minutes and 20% shrinkage.

**Decision (owner-approved 2026-10-07: G3 Option B).** Reading the digits as written would be wrong by the offset for a UTC export opened on a PC in the operation's timezone, so the conversion is KEPT (parser unchanged, same Dates for every input) and the planner is told: WARNING "Timezone markers converted" with the count, the distinct markers and the PC offset; backlog import shows the count in its preview. Marker detection shares the parser's single ISO regex (`detectTimezoneMarker`). G5: `categoryKey` = trim, collapse spaces, lower-case; every row takes the first spelling in file order; `discoverAndSyncCategories` matches existing categories by key (id and settings kept, spelling follows the file; two existing categories with one key: first wins, other reported); stored backlog cases follow the rename; backlog import and manual entry match by key; WARNING "Category names merged". Different words (`Bill  ing` vs `Billing`) stay separate. Engine untouched; the three built-in samples are unchanged. Suite D67.

**Open (backlog).** IS2-a: warn when a category is still on the seeded 30 min / 20% values (needs an edited / not-edited marker in Settings). A same-key duplicate among stored categories is reported by the pure function but not yet shown in the UI.

### 2026-10-07 (G2 + H2) — Numbers read from files were silently misread *(fixed)*

**Defect.** Demand volume cells were cleaned with `replace(/[\s$,]/g,'')` then `parseFloat`, and the file delimiter was discarded by `parseCSVRaw`: `12,5` in a semicolon file read as 125, `30 min` as 30, `1e9` accepted. Backlog import used `parseFloat`/`parseInt` (`7,5` -> 7, `2h` -> 2) and gave an unknown category an invented 30 minutes and priority 1.

**Decision (owner-approved 2026-10-07: read it when it is clear, block it when it is not).** `utils/number-cell.ts`: comma-delimited file = dot decimal, comma only as strict thousands (`1,234`); semicolon/tab file = convention decided per column (`12,5` proves comma-decimal, `12.5` proves dot-decimal, mixed = blocking error, `1.234`/`1,234` follow the proven convention, otherwise blocking error showing both readings). New ERROR "Unreadable volume" (up to 5 rows, cell stored 0); warnings for fractional volumes (engine rounds each interval, limitation L1) and volumes above 100,000. `utils/wip-import.ts`: unknown category -> fallback category with its own AHT and priority; unreadable/zero/negative/over-100,000 minutes -> category AHT; bad priority -> category priority; blank date -> default arrival; all counted and shown in the import preview; Replace/Append need a tick when more than 20% or more than 50 rows fell back on category. Engine untouched; clean files parse identically (built-in samples checked against the legacy reader). Suite D66.

### 2026-10-06 (G1) — Planning horizon stretched back to the oldest backlog case (CSV-13, CSV-14) *(fixed)*

**Defect.** `computeIntervalHorizon` (and hand-rolled copies in `searchOptimalHC`, `searchOptimalHCAsync` and the
Config preview) pulled the horizon start back to the oldest opening-backlog arrival. The empty days in between counted
as planned capacity, so the working-day count, `N_min`, `N_occ`, the occupancy denominator and the recommendation all
fell. Every case was also injected at its own arrival, and agents were idle regardless of the clock, so an old backlog
case was worked before the plan began by agents who were not rostered (free capacity). A stray demand date years out did
the same and data quality said "passed". No test asserted the stretching and no document called it deliberate.
Measured (Mon-Fri week, 08:00-17:00, 6 cases per 30-min interval, AHT 30, shrinkage 20%, default config, seed 42, 8
replications): no backlog 5 working days, N_min 7, N_occ 8, recommended 8; one backlog case 14 days old 15 days, N_min 2,
N_occ 3, recommended 7 (6 h SLA) / 5 (3-day SLA); 50 such cases 15 days, 2, 3, 7 / 5; 40 cases due the previous Friday
6 days, 6, 7, 7; one stray row 2 years out 524 days, N_min 1, recommended 7 / 5.

**Decision (owner-approved 2026-10-06).** (1) The horizon is the span of the demand intervals only; backlog never moves
it (backlog-only data: earliest backlog arrival + 7 days). One implementation, `computeIntervalHorizon`. (2) A case that
arrived before the horizon is injected at `max(arrival, horizonStart)`; its arrival, clock start, deadline and latest
safe start are unchanged. (3) Rule D4: opening backlog that arrived before the horizon and cannot meet its deadline even
if work starts at the first working instant (`latestSafeStart < nextOpen(horizonStart)`) is worked and counted as
workload but **excluded from the SLA numerator/denominator and the wait-time mean**, flagged `overdueAtStart` and
reported (`overdueAtStartCount`, Results note, case CSV column, data-quality warning). Without D4, ordinary Friday
carry-over would fail at every headcount and drive the search to its cap. Attainable old backlog is scored against its
original deadline; its wait is measured from `max(clockStart, horizonStart)`. (4) Data quality: an isolated stray date
(an empty run of more than 7 days whose smaller side holds at most 1% of the rows, 1-20 rows) **blocks the run** (threshold tightened from 30 to 7 empty days, same day, owner-approved: G1-a, suite D63); other
empty runs over 30 days extend the coverage-gap warning; backlog arriving more than 30 days before the first interval
and the overdue-at-start count are warnings. Frozen decisions 1-11 are untouched (occupancy stays demand / planned
capacity; the planned horizon is now the demand span).

**After** (same fixtures): no backlog 5 / 7 / 8 / 8; one backlog case 14 days old 5 / 7 / 8 / 8 at both SLA windows;
50 old cases 5 / 7 / 8 / 8 (occupancy 98.3%); 40 Friday cases 5 / 7 / 8 / 8 (occupancy 96.7%, `overdueAtStartCount` 40);
sync and async identical. Suite D62 pins this. The `primaryEligible` field (open item D15) is now live: false for
overdue-at-start cases.

**Residual.** SLA % can look healthy while a large overdue carry-over exists; read the count beside the headline (PRD L19).

---

### DES-8 - 24x7 parked work waited for the next midnight while agents were idle *(fixed 2026-10-06)*
On a 24x7 calendar a case parked because its agent's daily budget ran out was put in `parkedWIP` and resumed at the next
calendar midnight (a hard-coded `is24x7` branch in the `CasePark` budget path, hand-rolled date maths); every other calendar
used `nextOpen(now)`. Other agents with budget stayed idle meanwhile; shift-end parks in staggered mode already handed over at once.
A dead copy of the branch sat in `DayClose` (24x7 never schedules `DayClose`).

**Measured before** (3 agents, probe fixtures): one shift - 4 of 4 parked cases waited needlessly (586 min); staggered 0/8/16 h,
adherence 0.9 - 5 of 8 (4,132 min; one case parked 06:46, resumed 00:00, while another agent was free from 08:01).
Sizing probe (24x7 week, 6/h, AHT 45, adherence 0.9, 24 h SLA): SLA 14 agents 100%, 16 agents 98% - not monotone in headcount.

**After:** both branches deleted; every calendar uses `nextOpen(currTime)`. Avoidable waits 4/4 -> 0 and 5/8 -> 0; SLA at 14..17 agents
100 / 100 / 100 / 100. A case with no capacity anywhere still waits for the next budget reset (legitimate). Budgets, shift-window
presence (frozen decision 11), parked-first, EDF, random draws and the search code are untouched; business-hours results identical.
Suite D64 pins this; D43.14 c247 golden digest re-pinned (HC 8, fairness OFF: SLA 100% -> 100%, parks 12 -> 9).

---

### HC-15 - Confidence block and history row described the roster before polish *(fixed 2026-10-07)*
With shift placement ON, the Stage 3b roster polish evaluates every candidate roster with the full R-replication CI evaluation on the
shared case sets, but kept only {passes, reasons, median}. On adoption only the roster map was updated, so `primaryPassedResult` and
`evalCache[N]` still held the PRE-polish evaluation: `primaryStatistical`, the history row for N, the occupancy/ASA binding branches
and the representative replication index described a roster that is not the recommended one, while the headline simulation ran on the
adopted roster. Display-only: adoption itself already required the adopted roster to pass the full CI evaluation (pooled and siloed).

**Measured before** (D50 fixture: placement ON, mid-day peak, SLA 85% / 3 h, R = 6, max HC 40; N = 9, polish adopted 7/7):
seed 42 block mean 94.3 CI [94.1, 94.5] vs adopted roster 100 CI [100, 100]; seed 7 94.2 [93.8, 94.6] -> 100; seed 99 94.4 [94.1, 94.6] -> 100.
History row for N (seed 42): 94.3 [94.1, 94.5], BO ASA 29.9 min. Headline run showed 100, so block and headline contradicted each other.
Siloed (D52 fixture, N = 19): block 99.9 [99.9, 100], adopted roster 99.5 [99.5, 99.6], headline 99.6 - optimistic, not pessimistic.

**After:** each candidate's full evaluation is kept (pooled keyed by k, siloed by `rosterVectorKey`, the key `createParallelRosterKSearch` uses);
`adoptedPolishEvaluation` returns the one for exactly the adopted roster and both searches assign it to `primaryPassedResult` and
`evalCache[N]` strictly after `finalizeRosterPolish` (`rosterPolish.currentSlaPct` stays the pre-polish median). No extra simulation.
Seed 42: block 100 CI [100, 100], history row 100 [100, 100] BO ASA 5.9 min.

**Fields that can change for placement-ON runs where a roster is adopted** (the representative replication index can change):
`primaryStatistical`; the history row for N; `finalDESResult` (headline run; seed 42 BO ASA 7.7 -> 5.9 min, SLA % 100 -> 100); the N-1 boundary run,
`boundaryEvidence` and its `differenceSummary` (seed 42 N-1 BO ASA 14.8 -> 14.2 min); `isInfeasibleAdjacent` and its warning; and the occupancy/ASA
binding label. The binding label did not change on the pinned fixtures (still "Primary SLA ... Target"). **Unchanged:** recommended HC, gross HC,
the adopted roster, `rosterPolish`, every history row except N, and every result with placement OFF or polish status other than adopted /
adopted_partial (full-result digests pinned). Suite D65 pins this (independent re-evaluation of the adopted roster, sync = async on the full output).

### IS3 - Messy files were read silently or half-read *(fixed 2026-10-07, Build A)*
The file reader had no way to say a file was wrong: empty, zip/Excel, header-only, title-row-above-header, one-column, unclosed-quote and over-wide-row files loaded (or half-loaded) without a clear message, and short rows, duplicate headers and U+FFFD characters changed data silently.
**After:** `parseCSVRaw` returns `problems`. Errors E1-E7 (precedence E1 > E2 > E3 > E7 > E6 > E4 > E5) refuse the file at pick time with a message under the upload box (backlog import area for the backlog file); the current session is untouched. Warnings W1-W3 load the file and appear as the non-blocking DQ rule 27 "File reading". Pipe added as lowest-priority delimiter. Row numbers are 1-based physical lines. Files that loaded before parse identically (suite D68 compares with a legacy copy of the reader). Not changed: quote handling.
**Open item IS3-a:** a balanced quote in the middle of a cell (`ab"c"d`) still merges cells as before; it is not detected.

### IS3-f - Upload traps *(fixed 2026-10-07, Build B)*
Same file picked twice did nothing; a drop outside the box opened the file in the browser; overlapping picks could apply an older file; an unmapped required column was not named. **After:** file inputs (demand, backlog) are cleared after each pick; one page-level guard cancels `dragover`/`drop` outside drop boxes and file inputs; each read carries a sequence number (latest pick wins; a newer pick replaces an open reset prompt, a refused newest pick closes it); Data Quality names the unmapped column ("Choose the column for: Volume."). No parsing, rule or number change. Suite D69 pins the pure helper `missingRequiredMappings`; the rest is browser-verified. **IS3-f closed.**

### SR - Stale results after data edits *(fixed 2026-10-07, G6 + H9)*
Settings edits after a run raised a banner; data edits did not. Editing, deleting or importing opening backlog, or changing a column mapping, left the old headcount beside new data with no warning (browser-confirmed: Support 27 / 34 unchanged after a mapping change).
**After:** the run snapshot keeps two content fingerprint strings (demand intervals: start, end, volume, category name; opening backlog: id, category name, arrival, remaining minutes, priority, in order), captured at run start from the values the search receives. Live fingerprints are memoised on `intervals` and `openingWIP`. The Results banner names settings, demand data and/or opening backlog; the sidebar shows an "Outdated" marker beside Results. Comparison is by content, so change-and-revert clears it; category ids are never used (they contain `Date.now()`). Results are not cleared. No engine change. Suite D70.
**Open item SR-a:** exports from stale results carry no stale note (none exists for settings either).
**SR-b (checked, no change):** Sensitivity builds its own scenarios from live settings and data and shows no run results, so it cannot mix old results with new data. The Results tabs (incl. Agent Browser) render the run output only; the banner sits above every Results tab.

---

## C. Retracted after measurement

### D2 — "Occupancy window mismatch" — **NOT A BUG**
Initially flagged: the simulation drains up to 14 days past the horizon and counts that work
in `totalHandlingMinutes`, while the denominator covers only the planned horizon — so
occupancy looked inflated.

**This is deliberate and correct.** Three independent confirmations:
1. The existing test `BUG-OCC-ROOT` asserts the denominator **stays** at `7×5×480=16800`.
2. `wfm.ts` documents `rawOccupancyPct` as "unclamped — can exceed 100 to show **true
   overload magnitude**".
3. `ResultsFlow.tsx` renders it as "True capacity ratio: X% — demand exceeds capacity".

Occupancy here is a **demand ÷ planned-capacity ratio**, exactly what a capacity planner
needs. The proposed "fix" would have *introduced* a bug: widening the denominator over drain
days makes an undersized team look adequately utilised because it took extra weeks to
finish — inverting the signal.

**Re-examined 2026-08-27, upheld.** A near-identical-looking symptom (PASS at >100% occupancy)
resurfaced and was investigated fresh, without assuming this ruling. Same conclusion: the
metric is correct. The actual defect that time was in the acceptance gate consuming this
metric, not the metric itself — see **D19**.

The per-agent `busy/(busy+idle)` figure in `ResultsFlow.tsx` that was cited as contradictory
evidence is a *different, legitimate* metric (realised per-agent utilisation), not a
competing calculation of the same thing.

**Lesson:** two metrics with the same name and different denominators answer different
questions. Establish which question is being asked before calling one wrong.

---

## D. Open — not yet addressed

| ID | Issue | Impact |
|---|---|---|
| **D9** | Boundary evidence ("why N−1 failed") comes from a fresh **single-seed** run, while N−1 was actually rejected by the **R-replication CI decision** cached in `evalCache`. The two can disagree; the single-seed audit can even show N−1 passing. | Medium — user-facing explanation can contradict the decision |
| **D11** | `searchOptimalHC` / `searchOptimalHCAsync` are ~500 lines of near-duplicate logic. Was the root cause of D8 (now fixed). | Medium — guarantees future drift |
| **D12** | Horizon uses date-validated `validIntervals`; the workload sum iterates **unfiltered** `intervals`. Unparseable rows add volume but no horizon span. | Low |
| **D13** | `BUG-P2-O` (flagged in-code): the "representative" replication for reporting occupancy/ASA is chosen by closeness to median *primary SLA %* — an unrelated metric. | Low — reporting only, decisions use full CI |
| **D14** | Censored ASA for never-started cases measured only to `horizonEnd`, not the true simulation end, understating backlog age for badly undersized candidates. | Low |
| **D15** | *(resolved 2026-10-06 by the G1 fix)* `primaryEligible` is now false for opening backlog already overdue at horizon start (rule D4). | — |
| **D18** | Two priority orderings still exist by design (`CaseMinHeap.compare` governs heap push/pop; `pickNextCase`/`compareByUrgency` governs dispatch selection — see fixed `D16` above, which only corrected which one ships). They independently re-implement the same parked-first tiering — drift risk, not a current bug. | Low — same root cause as D11 |
| **G1** | **No backlog-ageing report** (>24h/48h/72h buckets). COPC-style backoffice reporting expects it alongside TAT attainment; data already exists in `CaseRunResult`. | Gap — worth building |
| **G2** | **Quality/rework not modelled.** Rework is real workload; sizing against clean volume understates. | Gap — inflate input volume meanwhile |
| **G3** | **Resumption overhead assumed zero.** Parked-and-resumed cases pay no context-switching cost. | Gap — inflate AHT meanwhile |

---

## E. Environment notes

- **The project is not under version control.** No `.git`. Changes have no safety net —
  consider `git init`.
- **Platform:** development machine is win32-**arm64**; `node_modules` initially shipped
  only the win32-**x64** esbuild binary, so `tsx` could not run at all. Fixed by installing
  `@esbuild/win32-arm64`. If `tsx` fails with a `TransformError` about platform binaries,
  that is the cause.
- **Node 24** strips TypeScript types natively, but the sources use extensionless relative
  imports and unmarked type imports, so plain `node file.ts` will not run them. Use `tsx`.
