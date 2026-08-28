# 01 — Glossary and Metrics

Precise definitions for the quantities this engine computes. Terms here are routinely
conflated in practice; conflating them produces a plausible-looking number that is wrong.

---

## The hours taxonomy (read this first)

Most workforce-planning arithmetic errors are double-counts caused by two variables that
both look like "hours per agent per day" but mean different things. Fix the ladder in your
head before touching any formula:

| Level | What it is | Reduced by |
|---|---|---|
| **Paid hours** | What the employer pays for | — |
| **Contracted hours** | What the contract commits the employee to | unpaid breaks |
| **Scheduled hours** | Hours the agent is rostered to be at work | leave, training, absence (**out-of-chair shrinkage**) |
| **Productive hours** | Rostered hours available for case work | breaks, meetings, coaching (**in-chair shrinkage**) |
| **Delivered hours** | Productive hours actually spent on cases | adherence loss |

Two rules follow, and they are the whole game:

1. **Shrinkage converts *rostered* headcount to *available* headcount.** It belongs in the
   operational→gross conversion, never in the capacity baseline.
2. **Adherence converts *scheduled productive* time to *delivered* time.** It belongs in
   per-agent capacity, never in the gross-up.

Apply either factor twice and you overstate the requirement. Apply neither and you
understate it. If a factor appears in both the numerator and denominator of the same ratio
it *cancels* — arithmetically fine, but fragile, because someone will later "fix" one side
and silently break the identity. Document such cancellations explicitly.

**In this codebase:** `labor.dailyProductiveHours` is *productive* hours (e.g. 7.5 of an
8-hour shift). `labor.adherencePct` scales it to delivered hours in the DES.
`category.shrinkagePct` operates one level up, on rostered headcount, in Stage 4.

---

## Volume, AHT, Workload

- **Volume** — number of transactions (cases, tickets, claims, emails) arriving in a period.
- **AHT (Average Handle Time)** — average time to fully process one transaction. For
  backoffice this is touch time, and it may be split across sessions if a case is parked
  and resumed. It excludes queue/wait time.
- **Workload** — the fundamental capacity quantity:
  ```
  Workload_hours = Volume × AHT / 60      (AHT in minutes)
  ```
  Everything in capacity planning starts here. Workload is *demand expressed in hours*,
  independent of how many people you have.

---

## Service metrics

### Real-time (voice, chat)
- **Service Level (SL)** — % of contacts answered within a threshold, e.g. "80/20" = 80%
  answered within 20 seconds. Interval-based.
- **ASA (Average Speed of Answer)** — mean wait before answer.
- **Abandonment** — % of contacts that leave the queue before being served.

### Deferred / backoffice (what this engine models)
- **Turnaround Time (TAT)** — elapsed time from receipt to completion. The primary
  backoffice service metric.
- **TAT attainment / "Primary SLA %"** — % of cases completed within the committed window
  ("90% of claims closed within 2 business days"). This is the engine's `primaryAchievedPct`.
- **Backoffice ASA** — here, time from SLA clock start to *first touch*. Distinct from
  TAT, which runs to *completion*. A case can be picked up quickly and still breach TAT.
- **Backlog / WIP age** — distribution of how long open items have been waiting. The
  metric TAT attainment alone hides: attainment can look fine while a tail of very old
  cases quietly accumulates.

**Why the distinction matters:** abandonment does not exist in deferred work — nobody
hangs up on an email. Work queues legitimately, sometimes for days. This is precisely why
Erlang-C (which is built around real-time queueing and abandonment) is the wrong tool, and
why this engine simulates individual cases ageing against their own deadlines instead.

### SLA clock subtleties
- **Clock basis** — does the SLA clock run on *business time* (pauses overnight and at
  weekends) or *wall-clock* time (runs continuously)? "2 business days" and "48 hours" are
  very different commitments.
- **Clock start policy** — does the clock start on *arrival*, or at the *next open* of the
  business window? For an operation receiving significant out-of-hours volume this choice
  materially changes measured attainment.
- **Latest Safe Start (LSS)** — the last moment work can begin and still meet the deadline:
  `LSS = deadline − remaining AHT`, computed *backwards through the business calendar*.
  Sorting the queue by LSS is Earliest-Deadline-First scheduling.

---

## Efficiency metrics

### Occupancy
```
Occupancy = handling time / time available to handle
```
The share of available time actually spent on work. **Critically, "available" can mean two
different denominators:**

| Denominator | Question it answers | Use |
|---|---|---|
| **Planned capacity** (HC × working days × productive hours) | "Do I have enough people?" | Capacity sizing — can exceed 100% to show overload magnitude |
| **Actual on-duty minutes** | "How hard did the people I had work?" | Realised utilisation reporting — capped at 100% by construction |

This engine deliberately uses **planned capacity** for the sizing constraint, so
`rawOccupancyPct` above 100% is a meaningful overload signal ("you need 43% more
capacity"), not a bug. `ResultsFlow.tsx` separately reports the per-agent realised figure.
Both are correct; they are not interchangeable.

**Sustainable ceiling:** roughly **85%** for backoffice. Above that, small demand variances
turn into large backlogs, and quality and attrition degrade. An occupancy cap alongside the
TAT target is what stops a sizing model recommending a headcount that hits service only by
running people into the ground.

### Utilisation / Productivity
- **Utilisation** — productive time ÷ paid time. A cost metric, broader than occupancy.
- **Adherence** — % of scheduled time the agent was where the schedule said, doing what it
  said. Measures *timing* compliance.
- **Conformance** — whether the agent worked the right *total* hours, ignoring timing. An
  agent who works a full shift an hour late has good conformance, poor adherence.

### Shrinkage
```
Shrinkage = 1 − (productive hours / scheduled hours)
```
Everything that stops a rostered person doing the work:
- **Out-of-chair** — annual leave, sickness, training, unplanned absence
- **In-chair** — breaks, meetings, coaching, system downtime, admin

Typically 25–35% combined. **Gross-up:**
```
Rostered HC = Operational HC / (1 − shrinkage)
```
At 30% shrinkage you need ~1.43 rostered heads per operational head.

**Blending shrinkage across categories requires the harmonic mean, not the arithmetic
mean** — see `04-capacity-planning-and-sizing.md` for the derivation. This is the single
most common shrinkage error.

---

## Headcount and FTE

Four distinct quantities, frequently conflated:

- **Operational HC** — bodies actively working the queue. What the simulation sizes.
- **Rostered / Gross HC** — bodies you must employ so that Operational HC are available
  after shrinkage. **What you actually hire.**
- **FTE (Full-Time Equivalent)** — headcount normalised to a standard contract. Two
  half-time staff = 1 FTE. Headcount and FTE differ whenever part-time staff exist.
- **Required HC** — the deliverable: the minimum Operational HC meeting every constraint,
  and its Gross HC / FTE conversions.

```
FTE = required hours / contractual hours per FTE
```

**In this codebase:** `fteNet` equals `operationalHC` exactly when contractual hours are
derived from the horizon (the default) — the two sides of the ratio cancel. It only carries
independent information when `contractualProductiveHoursOverride` is set. This is a known,
documented identity, pinned by test D7.5; do not "fix" it into something else.

---

## Quality and cost

- **Accuracy / Quality score** — % of transactions processed correctly. Sizing that
  ignores quality is incomplete: rework is real workload, and squeezing occupancy or AHT
  usually shows up as an accuracy drop before it shows up anywhere else.
- **Rework rate** — % requiring correction. Feeds back into effective volume.
- **Cost per transaction** — fully loaded cost ÷ volume.
