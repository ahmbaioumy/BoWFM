# 03 — Forecasting for Deferred Work

The engine consumes a forecast; it does not produce one. This document defines what a
*good* input looks like, because sizing quality is bounded by forecast quality.

---

## Arrival forecasting vs workload forecasting

Two distinct steps, and conflating them hides error:

1. **Arrival forecast** — how many transactions arrive, by interval and category.
2. **Workload forecast** — `Volume × AHT`, converting arrivals into hours of work.

AHT is forecast too, and it drifts: process changes, system changes, new products, agent
tenure mix. A volume forecast that is spot-on paired with a stale AHT produces exactly the
same sizing error as a bad volume forecast. Review both.

**Forecast AHT per category, not in aggregate.** A shifting *mix* between a 10-minute
category and a 60-minute category changes total workload substantially while total volume
looks flat.

## Structure of demand

- **Trend** — sustained growth/decline in the base.
- **Seasonality** — repeating patterns at multiple scales: annual (tax year, holidays),
  monthly (billing cycles, month-end), weekly (Monday peaks), intraday.
- **Special events** — campaigns, outages, regulatory deadlines, price changes. These are
  *known* and should be added explicitly, not left for the model to discover.
- **Noise** — irreducible random variation. This is what the DES replications sample.

### Deferred demand differs from real-time demand

- **Arrival timing matters less within a day.** For a 2-day TAT commitment, whether a case
  arrives at 09:00 or 16:00 barely affects feasibility. For a 20-second SL target, it is
  everything. Deferred forecasts can therefore be usefully coarser intraday — but *daily*
  totals must be right, because backlog carries day to day.
- **Out-of-hours arrivals are normal.** Email and portal submissions arrive overnight and
  at weekends. How the SLA clock treats them (start on arrival vs at next open) materially
  changes measured attainment. Decide deliberately.
- **Backlog is part of the demand picture.** The opening WIP position is as much an input
  as the arrival forecast. Sizing from arrivals alone, starting from an implied empty
  queue, systematically undersizes.

## Accuracy measurement

```
Error_t  = Actual_t − Forecast_t
APE_t    = |Error_t| / Actual_t
MAPE     = mean(APE_t)
WAPE     = Σ|Error_t| / ΣActual_t        # volume-weighted
Bias     = Σ(Forecast_t − Actual_t) / ΣActual_t
```

**Use WAPE, not MAPE, for capacity work.** MAPE weights every interval equally, so a 50%
miss on a quiet interval of 4 cases counts as much as a 5% miss on a peak interval of 400.
WAPE weights by volume and reflects capacity impact.

**Bias is the metric that matters most.** Random error averages out across a planning
horizon; bias does not. A consistent 5% under-forecast compounds into a growing backlog
that no amount of intraday management recovers. A forecast with ±15% dispersion and zero
bias is *safer for capacity purposes* than one with ±5% dispersion and 5% bias. Always
report bias separately — a good MAPE can conceal a badly biased forecast.

**Measure at planning granularity.** Correct monthly totals distributed wrongly across days
still produce a bad plan, because backlog dynamics are driven by the daily profile.

## Feeding this engine

The CSV ingestion (`src/utils/csv-parser.ts`) expects interval records with a timestamp,
volume, and optionally a category, and runs data-quality validation. Watch for:

- **Category names must match the configured categories.** A category present in the data
  but absent from config previously had its workload counted in the total while receiving
  no headcount allocation — understating the requirement by up to ~46% in a two-category
  case. Now handled with defaults (AHT 30 min, shrinkage 20%), but **those defaults are
  almost certainly wrong for your operation.** Configure every category explicitly.
- **Interval end times.** Absent an explicit end column, intervals default to 30 minutes.
  This determines `horizonEnd`, which drives the working-day count and hence the capacity
  denominator.
- **Unparseable rows.** These are excluded from the horizon but historically still
  contributed volume to the workload sum — inflating required capacity against a shorter
  horizon. Clean the data upstream.
- **Coverage.** A horizon shorter than the SLA window cannot meaningfully test attainment:
  a 5-day horizon with a 5-business-day TAT gives almost every case until the end to
  complete, so attainment is near-vacuously high.

## Sensitivity, not point estimates

A single-point forecast produces a single-point headcount and false confidence. The app's
sensitivity view sweeps volume and AHT deltas; use it. The useful output is not "we need
23" but "we need 23 at forecast, 26 if volume runs 10% hot, and 21 if it runs 10% cold" —
which is what actually informs a hiring decision under uncertainty.
