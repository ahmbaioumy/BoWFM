# 05 — Scheduling

Sizing answers *how many*. Scheduling answers *when*. This engine primarily does the first —
full rostering (shift patterns, contractual limits, fairness, statutory rules; see below) is
still out of scope. It does now cross the line for one narrow, deliberate reason: **when**
determines whether *how many* is even achievable at all, not just whether it's comfortable.

If every agent starts one uniform shift at business open and `dailyProductiveHours` is
shorter than the business window, a persistent backlog exhausts every agent's daily budget
in lockstep — leaving the tail of the window with **zero available agents**, every day,
*regardless of headcount*. No amount of "how many" fixes a "when" problem. The opt-in
**deadline-coverage shift placement** (`labor.shiftPlacementEnabled`, off by default — see
PRD §6 Stage 3a and `project_context.md` §5) exists specifically to close that gap: it lets
the search also try staggered shift-start times, analytically (zero extra simulation runs),
before concluding a candidate headcount fails. It is a targeted fix for one structural
failure mode, not a rostering engine — everything below about shift structures, contractual
limits, skills, fairness, and statutory rules remains genuinely unmodelled.

---

## Sizing number ≠ roster

The engine returns an Operational HC that satisfies the constraints given the modelled
daily capacity. Turning that into a roster introduces constraints it does not model:

- **Shift structures** — fixed vs rotating, full vs part-time, shift-length rules
- **Contractual limits** — max consecutive days, minimum rest, weekly hour caps
- **Skills** — who can work which categories (partly modelled via the siloed architecture)
- **Preferences and fairness** — bidding, seniority, weekend rotation
- **Statutory rules** — jurisdiction-specific working-time regulation

A roster that cannot cover the requirement curve makes the sizing number academic. If
scheduling repeatedly cannot realise the recommended headcount, the sizing assumptions
(daily productive hours, adherence, operating window) are the thing to revisit.

## Coverage vs requirement

Classic WFM compares two curves over time:
- **Requirement** — staff needed per interval to hit the target
- **Coverage** — staff actually scheduled

Gaps mean missed service; surpluses mean cost. For real-time work these must match
*interval by interval*.

**Deferred work relaxes this considerably.** Because work can wait, coverage needs to match
requirement over the *SLA window*, not per interval. With a 2-day TAT, a Monday-morning
under-cover is recoverable on Monday afternoon or Tuesday. This is precisely why deferred
sizing needs a deadline-aware simulation rather than interval-by-interval Erlang staffing —
and why the DES here schedules against per-case `latestSafeStart` rather than balancing
each interval.

The freedom is not unlimited: work deferred too long breaches, and the drain window is
finite. The simulation is what determines where that boundary actually sits.

## Backoffice-specific scheduling levers

- **Deferability** — the core lever. Deliberately queueing low-urgency work to protect
  deadline-critical work is legitimate and is what EDF dispatch does automatically.
- **Skill pooling vs siloing** — the `pooled` / `siloed` choice. Pooled queues are more
  efficient (any agent takes any case, so no silo idles while another is swamped). Siloed
  reflects real skill boundaries but strands capacity. Pooled is the better default unless
  skills genuinely do not transfer. See the apportionment note in
  `06-simulation-des.md` for why siloed allocation is non-trivial.
- **Blending with real-time work** — using backoffice work as filler between calls. Real,
  common, and *not modelled here*: it makes effective backoffice capacity a residual of
  voice demand, which this engine's fixed daily budget does not represent.
- **Overtime and flexing** — the usual response to backlog. Sizing should assume the
  steady-state roster, not habitual overtime; treating overtime as baseline capacity hides
  a permanent under-staffing.

## Adherence and its effect on capacity

Adherence scales scheduled productive time into delivered time
(`dailyProductiveHours × adherencePct`). Two cautions:

- **Do not double-count against shrinkage.** Adherence loss is *within* the scheduled
  productive window; shrinkage removes people from that window entirely. Different levels
  of the hours ladder — see `01-glossary-and-metrics.md`.
- **Adherence is a management outcome, not a constant.** Sizing at 85% adherence bakes in
  today's performance. If it is improvable, the cheaper fix may be improving it rather than
  hiring against it — worth flagging to the planner.

## Parking and resumption

The simulation parks a case when an agent's daily budget or the business window runs out,
and resumes it at the next open. This models reality (case work spans days) and carries a
real cost: **resumption overhead** — re-reading context, reloading state. The engine
currently assumes zero resumption cost, so a heavily-parked scenario is modelled slightly
optimistically. If your operation has significant context-switching cost, inflate AHT to
compensate, and record that you did.
