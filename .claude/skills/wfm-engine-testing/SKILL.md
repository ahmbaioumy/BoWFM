---
name: wfm-engine-testing
description: Fail-first testing protocol for the sizing/simulation engine (src/utils, src/types, scripts) — write a failing test before any behavioral fix, plus the DES-specific checklist (seed determinism, CI-gate correctness, monotonicity sweeps). Use before making any behavioral change to hc-search.ts, des-engine.ts, calendar.ts, or their tests.
---

# WFM Engine Testing Protocol

## Two suites, both must be green

```bash
npm test              # runs both
npm run test:sizing   # sizing-chain suite alone (fast)
```

- `scripts/verify-fixes.mts` — legacy regression suite (138 tests). **Treat as
  append-only.** If a change makes one of these fail, the default assumption is the change
  is wrong, not the test — several tests encode deliberate design decisions (e.g.
  `BUG-OCC-ROOT` pins the planned-horizon occupancy denominator).
- `scripts/verify-sizing-fixes.mts` — sizing-chain suite covering the Required-HC audit (D1
  calendar, D3 apportionment, D7 staffing chain, D9 offline integrity).

No test framework may be added — it would breach the zero-dependency rule (see `CLAUDE.md`).
Both suites use a plain `assert(condition, name, detail)` helper and exit non-zero on
failure.

## Fail-first is mandatory

For any behavioural fix:

1. **Write the test first.**
2. **Run it and capture the failure output.** A test that has never failed proves nothing —
   it may be asserting something already true, or nothing at all.
3. Apply the fix.
4. Re-run: the new test passes **and** both suites stay green.
5. Report the fail-before output as evidence.

Include a **control case** alongside each defect test — a near-identical scenario that
should pass both before and after. If the control also fails before the fix, the test is
measuring the wrong thing.

## What a good engine test pins

- **Closed-form expectations**, not "whatever the code currently returns." Compute the
  expected value by hand in a comment (see `D7.10`, which pins the harmonic shrinkage blend
  against its algebraic form).
- **Invariants over a swept range**, not one lucky input. `D3.1` sweeps N=1..200 to prove
  monotonicity — a single N would have missed all 14 real violations found in agent
  apportionment.
- **Degenerate inputs**: zero headcount, zero workload, inverted horizon, more categories
  than agents, a category present in data but absent from config.
- **Determinism**: identical seed and input must give an identical recommendation.

## DES / simulation-search checklist

Any change touching `des-engine.ts`, `hc-search.ts`'s search loop, or agent apportionment
needs these three properties checked, each pinned by an existing test to pattern-match
against (see the `wfm-sizing-simulation` skill for the underlying mechanics):

1. **Seed determinism.** Identical seed + input → byte-identical recommendation, every
   field. A same-seed drift is an ordering/tie-break bug (`EVENT_TYPE_ORDER`,
   `CaseMinHeap.compare`), not tolerable "noise."
2. **CI-gate correctness.** A candidate must pass on the *bound* — lower bound for
   "higher is better" constraints (SLA attainment), upper bound for "lower is better" caps
   (occupancy/ASA) — never on the raw mean. Test that a candidate whose mean clears the
   target but whose bound doesn't is correctly rejected.
3. **Monotonicity sweep, not a single N.** The walk-down search is only valid if
   `passesAllConstraints(N)` is monotone in N. Any change to apportionment, dispatch order,
   or the pass/fail predicate needs a swept range (pattern: `D3.1`), not a spot check. For
   pinning a closed-form value (e.g. CI-gate math or apportionment shares) against its
   algebraic derivation, follow the `D7.10` pattern.

## Stochastic code

The DES is seeded and deterministic for a given seed. Never write a test that depends on an
unseeded run. When asserting on simulation output, either fix the seed or assert on an
invariant that must hold for every seed.
