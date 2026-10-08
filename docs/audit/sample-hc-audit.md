# Sample-file required-HC audit — before vs after (2026-09-30)

Changes audited: Workload Floor toggle (FR-5.13), clock-start derivation (FR-5.2), roster polish
(Stage 3b). Inputs: `test_files/*.csv`, app defaults (pooled, 08:00–18:00 Mon–Fri, 7.5h shift,
6h / 80% SLA, seed 12345, R=30). Before = frozen snapshot of `main` @ 50d2745
(`sample-hc-baseline-2026-09-30.jsonl`); after = this branch (`sample-hc-after-2026-09-30.jsonl`).
Regenerate: `npx tsx scripts/audit-sample-hc.mts <out.jsonl> <csv> BA,BN,WA,WN,PON,FOFF`.
Guard: `npm run test:audit` re-runs all 24 cells and fails on any difference from the after file
(options `--jobs`, `--files`, `--cells`); suite D49 in `npm test` pins AJM_Only on every run.
Known difference (2026-10-08, 1.21.0, P2-9): since 1.21.0 the baseline `docs/audit/sample-hc-after-2026-09-30.jsonl` differs in the 4 infeasible Wall Clock + Arrival (WA) cells, `slaPct` only (AJM_Only 46 -> 32.6, AJM_Simu 45.4 -> 30.2, EGS_Only - With Reduction 45.3 -> 29.9, EGS_Only 45.4 -> 29.8), because the failing uniform audit run now has a shift end. The baseline has not been regenerated pending owner approval, so `npm run test:audit` exits 1 on those 4 cells; no recommended headcount differs. Re-run 2026-10-08 after 1.22.0 (P1-6, rescue ladder): the same 4 WA cells differ by the same `slaPct` values and nothing else; all 4 Shift-Placement-ON (PON) cells are identical to the baseline (AJM_Only 16 kept_current_failed_gate, AJM_Simu 123 / EGS_Only - With Reduction 80 / EGS_Only 100 adopted_partial, same SLA and tail), i.e. the ladder moved no audit cell (20/24 identical, exit 1 from the 4 WA cells only; about 1 h with 6 parallel jobs).

Cells: BA/BN = Business Time + Arrival / Next Open · WA/WN = Wall Clock + Arrival / Next Open ·
PON = placement ON · FOFF = Workload Floor OFF (compared with BA). "Tail" = agents on shift in
the last half-hour (17:30).

## Verdict
- **Default settings: zero change** — every field (N_min, N_occ, Req HC, Gross HC, binding, SLA,
  occupancy, min coverage) identical in all 16 non-placement cells.
- **Clock wiring:** Business + Arrival = Business + Next Open on every file (now forced to Next Open);
  Wall Clock cells unchanged (Arrival infeasible on all four files; Next Open 22/178/140/111).
- **Workload Floor OFF:** HC unchanged on all four files — HC here is set by the SLA gate
  (16 vs N_min 9, 123 vs 62, 100 vs 53, 80 vs 42), not by the floor.
- **Placement ON:** HC and Gross HC unchanged on all four files; late-day coverage 1 → 17 / 14 / 14
  agents on three files (SLA −0.1 to −0.2 pt, still passing the CI gate); AJM_Only kept as is —
  moving one agent later drops category Tech HVC below its 80% CI target.

## Detail

| File | Cell | Req HC | Gross HC | SLA % | Tail | Roster polish | Fields changed |
|---|---|---|---|---|---|---|---|
| AJM_Only.csv | BA | 16 → 16 | 20 → 20 | 90.1 → 90.1 | 1 → 1 |  | none |
| AJM_Only.csv | BN | 16 → 16 | 20 → 20 | 90.1 → 90.1 | 1 → 1 |  | none |
| AJM_Only.csv | FOFF | 16 → 16 | 20 → 20 | 90.1 → 90.1 | 1 → 1 |  | none |
| AJM_Only.csv | PON | 16 → 16 | 20 → 20 | 90.1 → 90.1 | 1 → 1 | kept_current_failed_gate | none |
| AJM_Only.csv | WA | None → None | 625 → 625 | 46 → 46 | - → - |  | none |
| AJM_Only.csv | WN | 22 → 22 | 28 → 28 | 85 → 85 | 1 → 1 |  | none |
| AJM_Simu.csv | BA | 123 → 123 | 154 → 154 | 94.2 → 94.2 | 1 → 1 |  | none |
| AJM_Simu.csv | BN | 123 → 123 | 154 → 154 | 94.2 → 94.2 | 1 → 1 |  | none |
| AJM_Simu.csv | FOFF | 123 → 123 | 154 → 154 | 94.2 → 94.2 | 1 → 1 |  | none |
| AJM_Simu.csv | PON | 123 → 123 | 154 → 154 | 94.2 → 94.1 | 1 → 17 | adopted_partial | slaPct, minCoverage |
| AJM_Simu.csv | WA | None → None | 625 → 625 | 45.4 → 45.4 | - → - |  | none |
| AJM_Simu.csv | WN | 178 → 178 | 223 → 223 | 83.2 → 83.2 | 1 → 1 |  | none |
| EGS_Only - With Reduction.csv | BA | 80 → 80 | 100 → 100 | 92.8 → 92.8 | 1 → 1 |  | none |
| EGS_Only - With Reduction.csv | BN | 80 → 80 | 100 → 100 | 92.8 → 92.8 | 1 → 1 |  | none |
| EGS_Only - With Reduction.csv | FOFF | 80 → 80 | 100 → 100 | 92.8 → 92.8 | 1 → 1 |  | none |
| EGS_Only - With Reduction.csv | PON | 80 → 80 | 100 → 100 | 92.8 → 92.6 | 1 → 14 | adopted_partial | slaPct, minCoverage |
| EGS_Only - With Reduction.csv | WA | None → None | 625 → 625 | 45.3 → 45.3 | - → - |  | none |
| EGS_Only - With Reduction.csv | WN | 111 → 111 | 139 → 139 | 82.4 → 82.4 | 1 → 1 |  | none |
| EGS_Only.csv | BA | 100 → 100 | 125 → 125 | 92.7 → 92.7 | 1 → 1 |  | none |
| EGS_Only.csv | BN | 100 → 100 | 125 → 125 | 92.7 → 92.7 | 1 → 1 |  | none |
| EGS_Only.csv | FOFF | 100 → 100 | 125 → 125 | 92.7 → 92.7 | 1 → 1 |  | none |
| EGS_Only.csv | PON | 100 → 100 | 125 → 125 | 92.7 → 92.5 | 1 → 14 | adopted_partial | slaPct, minCoverage |
| EGS_Only.csv | WA | None → None | 625 → 625 | 45.4 → 45.4 | - → - |  | none |
| EGS_Only.csv | WN | 140 → 140 | 175 → 175 | 82 → 82 | 1 → 1 |  | none |
