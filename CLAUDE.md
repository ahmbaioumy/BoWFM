# BoWFM — Project Guardrails

This is a **workforce-planning (WFM) sizing engine for contact-centre backoffice /
deferrable-transaction work** (email, cases, tickets — turnaround-SLA-driven, not
real-time voice/chat). It ships as **one self-contained HTML file** (`BoWFM.html`) that a
planner opens directly from disk (`file://`), often offline. Everything in this file is a
hard constraint on how you work in this repo, not a style preference.

For deeper domain workflows (sizing/simulation reasoning, the fail-first testing protocol,
WFM vocabulary lookups), invoke the matching skill — `wfm-sizing-simulation`,
`wfm-engine-testing`, `wfm-domain-guide` — described at the bottom of this file.

## Offline / Zero-Dependency Contract

**Never introduce into `src/`:**
- Network primitives: `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `navigator.sendBeacon`, `importScripts(`, dynamic `import()` of a remote URL, any
  analytics/telemetry/"phone home" call.
- External assets: CDN `<script>`/`<link>` tags, remote stylesheets, web fonts (Google
  Fonts included), remote images, remote source maps.
- Ambient environment reads (they imply infrastructure that won't exist at runtime):
  `process.env`, `import.meta.env`, `localStorage`, `sessionStorage`, `indexedDB`,
  `document.cookie`.

If a feature seems to need one of these, it needs a different design — say so rather than
adding the dependency.

**`dependencies` in `package.json` is closed.** Implement new capability in plain
TypeScript in-repo instead. Adding a runtime dependency requires explicit human approval
and a stated reason it can't be written in-repo. Build/test tooling (`vite`, `tsx`,
`typescript`, `tailwindcss`, `esbuild`) is devDependency-only and is fine — it never
reaches the artifact.

**The build guards are load-bearing.** `scripts/build-standalone.mts` throws if the built
HTML still references remote CSS, remote JS, or a CDN host. Never weaken, bypass, or
comment out these guards to make a build pass. Absolute URLs that are *identifiers rather
than fetches* are fine (W3C SVG namespace URIs, React's error-doc URL string, the Tailwind
attribution comment) — nothing else.

**Verify after any change touching dependencies, assets, or the build:**
```bash
npm run lint && npm test && npm run build:standalone
```
Suite D9 in `scripts/verify-sizing-fixes.mts` enforces this. Change it deliberately, never
silently.

## The Required-HC Chain — frozen decisions

This engine sizes deferrable-transaction backoffice work: non-real-time case/ticket
processing against a turnaround SLA, where backlog legitimately queues across days. **It is
not a real-time voice/chat queueing model** — see the `wfm-sizing-simulation` skill for why
that distinction rules out Erlang-C here.

Four stages: **Demand → Workload** (`hc-search.ts`) → **Workload → analytical baseline
`N_min`** (shrinkage deliberately absent; applied later) → **`N_min` → recommended
operational HC** via DES search (`searchOptimalHC`/`searchOptimalHCAsync`, CI-gated, R
replications under Common Random Numbers) → **operational HC → Gross HC** (per-category
shrinkage gross-up, harmonic blend, sum, then a single `round`).

**The following are deliberate and require explicit human approval to change:**

1. **DES, not Erlang-C.** Deferred backoffice work is deadline-based with legitimate
   multi-day queueing; Erlang-C models real-time queueing with abandonment. No Erlang
   formula exists in this codebase and that is intentional.
2. **Earliest-Deadline-First dispatch** (`CaseMinHeap.compare`, `des-engine.ts`), ordered by
   `latestSafeStart` walked *backwards* through the business calendar, not wall-clock
   subtraction.
3. **Occupancy is demand ÷ planned-capacity, not realised utilisation.** Denominator is the
   planned horizon, so `rawOccupancyPct` can exceed 100% to express overload magnitude.
   Widening the denominator across the drain window would make an undersized team look
   adequately utilised. See `BUG-OCC-ROOT` in `scripts/verify-fixes.mts`. (The per-agent
   `busy/(busy+idle)` figure in `ResultsFlow.tsx` is a different, legitimate metric.)
4. **`N_min` is a hard floor for the search** — guards against a headcount "passing" only by
   exploiting the finite-horizon drain-window edge effect.
5. **Shrinkage excluded from Stage 2, applied only in Stage 4** — applying it in both is the
   classic WFM double-count.
6. **Harmonic (not arithmetic) effective-shrinkage blend.**
7. **Per-category gross-up, then sum, then a single `round`** — not blended-then-grossed, not
   per-category rounding (systematic drift). (Corrected 2026-08-28: this decision previously
   said `ceil`; the shipped code and all three UI labels have always used `round` — the
   wording was stale, not the behavior. See `trusted-source-validation.json`'s
   `GROSS-HC-ROUND-VS-CEIL` entry.)
8. **CI-gated acceptance, not single-run** — 95% CI bound must clear the target (lower bound
   for SLA attainment, upper bound for occupancy/ASA caps).
9. **Common Random Numbers** — `precomputedCaseSets` deliberately reuses identical arrival
   realisations across candidate N values. Variance reduction, not redundancy.
10. **House-monotone agent apportionment** (`allocateAgentsToCategories`, divisor/
    Webster–Sainte-Laguë method). Never replace with largest-remainder/Hamilton — that
    reintroduces the apportionment Alabama paradox (measured: 14 reversals over N=1..200,
    including a silo dropping to zero agents).

| Concern | File |
|---|---|
| DES event loop, dispatch, occupancy, agent apportionment | `src/utils/des-engine.ts` |
| Baseline `N_min`, CI search, shrinkage/FTE staffing math | `src/utils/hc-search.ts` |
| All business-time / calendar arithmetic | `src/utils/calendar.ts` |
| CSV ingestion + data-quality validation | `src/utils/csv-parser.ts` |
| Domain types | `src/types/wfm.ts` |
| Domain reference | `docs/wfm/` |

## Code Conventions

- **No console output in `src/`.** `console.log`/`debug`/`info` are banned (enforced by
  suite D9). `console.warn`/`console.error` for genuine user-facing faults are fine — debug
  tracing is not.
- **Never duplicate an algorithm.** `searchOptimalHC` and `searchOptimalHCAsync` are ~500
  lines of near-identical logic and have already drifted once (the `sla.clockStartPolicy`
  off-hours-volume rewrite that used to exist only in sync — defect D8, resolved
  2026-08-28 by deleting the mitigation from `searchOptimalHC` rather than porting it to
  async; neither function rewrites `clockStartPolicy` today). That root cause — the
  duplication itself (D11) — is still open. Don't add a third copy, and don't fix a bug
  in one without the other; the correct resolution is one shared implementation the
  async variant wraps with
  progress callbacks. Same hazard between `CaseMinHeap.compare` (real dispatch) and
  `pickNextCase`/`compareByUrgency` (test harnesses only).
- **All time math goes through `calendar.ts`.** Never hand-roll `Date` arithmetic in engine
  code — use `addWorkingTime`, `subtractWorkingTime`, `workingDuration`, `isWorking`,
  `nextOpen`, `getCalendarWorkingDaysInHorizon` (note: half-open `[start, end)` — an
  inclusive bound double-counts a trailing zero-demand day for whole-day/24x7 data).
- **Round only at the presentation boundary.** Keep full precision through the calculation
  chain. Compare floats with a tolerance, never `===`.
- **Determinism.** Sort explicitly wherever `Map`/`Set` iteration order could affect a
  result. Never use `Math.random()` — use the seeded `createPrng` in `des-engine.ts`. Never
  use `Date.now()`/`new Date()` for anything affecting a computed result.

## Definition of Done — Docs & Artifact Sync

An implementation is **incomplete** until as-built docs and the shipped artifact match the
code. Do this after code + tests, before claiming done — same turn as the code change, not
a follow-up the user must request. Applies to any change affecting product behavior, UI,
engine logic, types, build scripts, defaults, DQ rules, or tests that change expected
behavior — **UI-only JSX reorders count too** if they ship in the bundle.

1. **Code + tests** (offline contract, frozen HC chain, testing protocol all still apply).
2. **Update `PRD.md`** — as-built, not aspirational: behavior/UI/requirements → §1–§10; new
   limitation → §10; new/resolved backlog item → §11 (same P0/P1/P2/G ID style, remove
   resolved); bump Version/Date when product behavior changes.
3. **Update `project_context.md`** — architecture/getting-started/commands → §2–§4;
   engine/search behavior → §5; new frozen decision → §6; conventions/testing → §8–§9; new
   common workflow → §10; drift risks/open items/recently fixed → §11.
4. **Rebuild the deliverable** whenever `src/`, `scripts/build-standalone.mts`, Vite/
   Tailwind/build config, or anything reaching the bundle changed:
   ```bash
   npm run build:standalone
   ```
   Confirm `BoWFM.html` at the app root has an mtime ≥ newest watched source. Never weaken
   the offline guards in `scripts/build-standalone.mts` to make the build pass.
5. **Gate:** `npm run check:artifact` (also runs at the end of `npm test`).

Skip only for: pure doc/rule edits with no code/build impact (update docs only, no
rebuild); questions/exploration with no implementation (no doc/artifact churn).

Before finishing, state which of `PRD.md` / `project_context.md` / `BoWFM.html` were
updated, or why the rebuild was skipped, and confirm `npm run check:artifact` passed if you
rebuilt.

## Available skills

- **`wfm-sizing-simulation`** — backoffice/email deferrable-transaction sizing model + DES
  simulator mechanics (EDF dispatch, CRN, CI-gated search, apportionment). Invoke for any
  sizing/simulation/apportionment change, or "why doesn't this use Erlang-C" questions.
- **`wfm-domain-guide`** — WFM vocabulary/metrics (hours taxonomy, occupancy vs
  utilisation, shrinkage vs adherence, headcount vs FTE) and which `docs/wfm/0X` file
  answers which question. Invoke for forecasting/SLA/scheduling questions outside the core
  sizing chain.
- **`wfm-engine-testing`** — fail-first TDD workflow for engine changes, including the
  DES-specific test checklist (seed determinism, CI-gate correctness, monotonicity sweep).
  Invoke before writing any behavioral fix in `src/utils/**`.
