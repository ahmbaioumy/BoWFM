/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type TimeUnit = 'minutes' | 'hours' | 'days';
export type ClockBasis = 'business_time' | 'wall_clock';
export type ClockStartPolicy = 'arrival' | 'next_open';
export type ContractualHoursSource = 'derived' | 'override';
export type ASAClockBasis = 'business_window' | 'clock_hours';

export interface CategoryConfig {
  id: string;
  name: string;
  ahtMinutes: number; // User-set fixed AHT in minutes
  shrinkagePct: number; // e.g. 0.20 for 20% (in [0, 1))
  priority: number; // Lower = higher priority (default based on name ASC)
  // Per-category SLA definitions
  primaryPct?: number; // e.g. 80 (%)
  primaryWindow?: number; // e.g. 6
  primaryUnit?: TimeUnit; // 'minutes' | 'hours' | 'days'
  primaryWindowMinutes?: number; // In minutes for simulation calculations
  boAsaTarget?: number; // e.g. 60
  boAsaUnit?: TimeUnit; // 'minutes' | 'hours' | 'days'
}

export interface ShiftWindow {
  id: string;
  name: string;
  startHour: number; // 0-23
  startMinute: number; // 0-59
  endHour: number; // 0-23
  endMinute: number; // 0-59
  productiveHours: number; // Must equal daily productive hours
}

export interface CalendarConfig {
  is24x7?: boolean; // When true: 24/7 continuous operation (all 7 days, 00:00 to 24:00, no holiday closures)
  // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  workingDays: number[]; // e.g. [1, 2, 3, 4, 5] for Mon-Fri
  dailyOpenHour: number; // e.g. 8
  dailyOpenMinute: number; // e.g. 0
  dailyCloseHour: number; // e.g. 18
  dailyCloseMinute: number; // e.g. 0
  holidays: string[]; // YYYY-MM-DD
}

export interface LaborConfig {
  dailyProductiveHours: number; // e.g. 7.5
  adherencePct: number; // In (0, 1], default 1.0 (100%). DES present hours = dailyProductiveHours * adherencePct
  workingDaysPerWeek: number; // e.g. 5
  offDaysPerWeek: number; // 7 - workingDaysPerWeek
  contractualHoursSource: ContractualHoursSource; // 'derived' | 'override' — agent hours for N_min
  contractualProductiveHoursOverride?: number; // Default 0; used for N_min only when > 0
  shifts: ShiftWindow[];

  /**
   * Opt-in deadline-coverage shift placement. Default false/undefined = fully disabled,
   * zero behavior change: the search evaluates every candidate N with the uniform
   * everyone-starts-at-open shift model exactly as before. When true, evaluateN also
   * computes a house-monotone shift-start distribution (see computeShiftPlacement in
   * hc-search.ts) and uses it whenever it verifies at least as good as uniform.
   */
  shiftPlacementEnabled?: boolean;
  /** Grid granularity (minutes) for valid shift-start offsets. Default 30 when enabled. */
  shiftSlapMinutes?: number;
}

/** One shift-start offset (minutes from that day's business open) and how many agents start there. */
export interface ShiftSlap {
  startMinutesFromOpen: number; // on the shiftSlapMinutes grid, >= 0
  agentCount: number; // >= 0
}

/** A full shift-start distribution for one category (or the pooled agent block). */
export interface ShiftSlapDistribution {
  slapMinutes: number; // grid granularity this distribution was built on
  slaps: ShiftSlap[]; // sorted ascending by startMinutesFromOpen
}

/** Keyed by category name for siloed queueArchitecture; '__POOLED__' for pooled mode. */
export type ShiftDistributionByCategory = Record<string, ShiftSlapDistribution>;

export interface SLAPolicyConfig {
  primaryPct: number; // Default 80 (editable)
  primaryWindow: number; // e.g. 6
  primaryUnit: TimeUnit; // Default 'hours'
  boAsaEnabled: boolean; // Toggle ON/OFF: show/hide ASA inputs and consider in simulation constraints
  boAsaTarget: number; // e.g. 60
  boAsaUnit: TimeUnit; // 'minutes' | 'hours' | 'days'
  asaClockBasis: ASAClockBasis; // 'business_window' (business hours only) | 'clock_hours' (24/7 elapsed clock hours)
  clockBasis: ClockBasis; // 'business_time' | 'wall_clock'
  clockStartPolicy: ClockStartPolicy; // 'arrival' | 'next_open'
  /**
   * The occupancy ceiling is always in force — this does not switch a ceiling on/off, it
   * selects whether to use a custom target below the 100% (physical-feasibility) default.
   * false (default) = target is 100%. true = target is occupancyCapPct (clamped 50-100).
   * See resolveOccupancyCapPct in des-engine.ts.
   */
  occupancyCapEnabled: boolean; // Default false (== 100% target)
  occupancyCapPct: number; // Default 85; used only when occupancyCapEnabled is true
  confidenceLevelPct: number; // Statistical CI confidence % in [50, 99.9] (default 95)
  /** When true, HC search accepts CI lower bound vs Primary% × (1 − slack%). Default false / omitted = OFF. */
  slaAcceptanceSlackEnabled?: boolean;
  /** Relative slack % in [1, 20]; used only when slaAcceptanceSlackEnabled. Default 5. */
  slaAcceptanceSlackPct?: number;
  /** When true, Stage 2 N_min is computed from workload discounted by workloadReductionPct. Default false / omitted = OFF. */
  workloadReductionEnabled?: boolean;
  /** Workload reduction % in [1, 50]; used only when workloadReductionEnabled. Default 5. */
  workloadReductionPct?: number;
  /**
   * Minimum-coverage floor: while the business is open, on-shift agent count must never fall
   * below minAgentsPerInterval. Default true/omitted = ON at the default of 1 (the queue may
   * never be left with zero agents while the business is running). Mirrors the
   * occupancyCapEnabled/occupancyCapPct pattern. Setting false, or minAgentsPerInterval to 0,
   * reproduces pre-2026-08-28 behavior exactly (no coverage floor).
   */
  minCoverageEnabled?: boolean;
  /** Minimum on-shift agents required at every open business interval; clamped [0, N]. Default 1. */
  minAgentsPerInterval?: number;
}

export interface SimulationParams {
  seed: number;
  maxHCSearch: number; // Default 500
  replications: number; // Default 30 (stochastic replications for statistical Primary SLA)
  queueArchitecture?: 'pooled' | 'siloed'; // Default 'pooled'
}

export interface PrimarySLAStatisticalResult {
  requiredHC: number;
  replications: number;
  achievedPctMedian: number;
  achievedPctMean: number;
  ci95Low: number;
  ci95High: number;
  stdDev: number;
  samples: number[];
}

export interface RawIntervalRecord {
  intervalStart: string; // ISO or parseable timestamp
  intervalEnd?: string;
  volume: number;
  category?: string;
  [key: string]: any;
}

export interface ColumnMapping {
  intervalStartCol: string;
  timeCol?: string; // Optional separate time-of-day column (e.g. "time", "HH:MM")
  volumeCol: string;
  categoryCol?: string;
  intervalEndCol?: string;
}

export interface StandardInterval {
  intervalIndex: number;
  start: Date;
  end: Date;
  volume: number;
  category: string;
  volumeParsingIssue?: string;
}

export interface OpeningWIPCase {
  id: string;
  category: string;
  priority: number;
  arrival: Date;
  clockStart: Date;
  remainingWorkMinutes: number;
}

export interface DQIssue {
  severity: 'error' | 'warning';
  field: string;
  message: string;
  details?: string;
}

export interface OperatingHoursBreakdown {
  insideVolume: number;
  insidePct: number;
  weekdayOffVolume: number;
  weekdayOffPct: number;
  weekendVolume: number;
  weekendPct: number;
  totalOutsideVolume: number;
  totalOutsidePct: number;
}

export interface DQResult {
  passed: boolean;
  totalIntervals: number;
  totalVolume: number;
  horizonStart: Date | null;
  horizonEnd: Date | null;
  calendarWorkingDaysInHorizon: number;
  categoriesFound: string[];
  issues: DQIssue[];
  totalWorkloadHours: number;
  operatingHoursBreakdown?: OperatingHoursBreakdown;
}

export interface CaseEntity {
  id: string;
  syntheticId: number;
  category: string;
  priority: number;
  arrival: Date;
  clockStart: Date;
  totalAhtMinutes: number;
  remainingWorkMinutes: number;
  primaryDeadline: Date;
  latestSafeStart: Date;
  firstStartTime: Date | null;
  completeTime: Date | null;
  parkCount: number;
  isOpeningWip: boolean;
}

export type EventType =
  | 'ProcessingComplete'
  | 'CasePark'
  | 'CaseResume'
  | 'AgentAvailable'
  | 'ShiftEnd'
  | 'DayClose'
  | 'SimulationEnd'
  | 'CaseArrival'
  | 'SLAClockStart'
  | 'CaseAssignment'
  | 'ProcessingStart'
  | 'SLARisk'
  | 'SLADeadline'
  | 'SLABreach';

export interface SimEvent {
  timeMs: number;
  priority: number;
  eventType: EventType;
  entityId: string;
  data?: any;
}

export type AgentSliceState = 'busy' | 'idle' | 'off';
export type AgentRosterSource = 'existing' | 'new';

export interface AgentWorkSlice {
  agentId: number;          // 0-based internal id
  agentLabel: string;       // "Agent-1" ... "Agent-N" (agentId+1, no zero-pad, no skill suffix)
  date: string;             // YYYY-MM-DD of the local calendar day of from
  state: AgentSliceState;
  rosterSource: AgentRosterSource; // filled later in Results from nMinAnalytical; engine may leave as 'existing' and UI overwrites
  caseId: string | null;    // required when state==='busy', else null
  category: string | null;  // required when state==='busy', else null
  from: Date;
  to: Date;
  minutes: number;          // (to-from)/60000, > 0
  isResume: boolean;        // true if this busy slice is a parked-case resume (parkCount>0 or remainingWork < totalAHT at assign)
  inBindingWindow: boolean;
}

export interface AgentSummary {
  agentId: number;
  agentLabel: string;
  rosterSource: AgentRosterSource;
  siloCategory: string;
  busyMinutes: number;
  idleMinutes: number;
  offMinutes: number;
  occupancyPct: number;
  casesHandled: number;
  resumeCount: number;
  inBindingWindow: boolean;
  dailyBudgetMinutes: number;
  maxBusyAnyDay: number;
  hasBudgetViolation: boolean;
}

export interface CaseRunResult {
  caseId: string;
  category: string;
  priority: number;
  arrival: Date;
  clockStart: Date;
  ahtMinutes: number;
  primaryDeadline: Date;
  latestSafeStart: Date;
  firstStartTime: Date | null;
  completeTime: Date | null;
  parkCount: number;
  isOpeningWip: boolean;
  
  // Status flags
  isCompleted: boolean;
  primaryEligible: boolean;
  primaryPassed: boolean;
  isHorizonRemainder: boolean;
  
  // ASA metrics
  asaDurationMinutes: number; // If started, working/wall duration from clockStart to firstStartTime; if unfinished, censored to horizonEnd
  asaCensored: boolean;
}

export interface DESResult {
  operationalHC: number;
  horizonStart: Date;
  horizonEnd: Date;
  totalCases: number;
  completedCases: number;
  unfinishedCases: number;
  
  // SLA results
  primaryEligibleCount: number;
  primaryPassCount: number;
  primaryAchievedPct: number;
  
  // Category breakdown
  categoryStats: Record<
    string,
    {
      volume: number;
      workloadHours: number;
      completed: number;
      primaryEligible: number;
      primaryPass: number;
      primaryPct: number;
      asaMeanMinutes: number;
      asaCensoredCount: number;
    }
  >;
  
  // BO ASA
  boAsaMeanMinutes: number; // Censored mean
  boAsaCensoredCount: number;
  
  // Occupancy
  totalHandlingMinutes: number;
  totalAvailableProductiveMinutes: number;
  occupancyPct: number;
  // unclamped — can exceed 100 to show true overload magnitude. occupancyPct remains clamped at 100 for
  // backward compatibility with anything that assumes a percentage ceiling.
  rawOccupancyPct: number;
  
  // Constraints check
  passesPrimarySLA: boolean;
  passesCategorySLA: boolean;
  passesBOASA: boolean;
  passesOccupancyCap: boolean;
  /** Minimum on-shift agent count observed across every open business interval in the horizon.
   * Infinity when operationalHC is 0 or no business-open sampling occurred (degenerate). */
  minCoverageObserved: number;
  passesCoverage: boolean;
  allPassed: boolean;
  
  // Queue intervals timeline
  intervalsTimeline: Array<{
    time: Date;
    label: string;
    queuedWIP: number;
    activeHandling: number;
    parkedWIP: number;
    completedCum: number;
    availableAgents: number;
  }>;
  
  caseResults: CaseRunResult[];
  agentTimeline: AgentWorkSlice[];

  /** Echoes the shiftDistribution passed to runBackofficeDES, when one was supplied. */
  shiftDistributionUsed?: ShiftDistributionByCategory;
}

export interface StaffingRequirement {
  /** Simulator / DES on-duty seats (evalN). Not OFF-adjusted. */
  operationalHC: number;
  /**
   * Net extra OFF display fraction after subtracting calendar-closed days already in DES.
   * offPct = max(0, labor.offDaysPerWeek − calendarClosed) / 7. Never Labor raw offs / 7
   * alone. Display only — NOT the seat-to-roster multiplier; see rosterUpliftPct.
   */
  offPct: number;
  /** Agent off days beyond days the business is already closed. */
  extraOffDays: number;
  /** Calendar open days per week (7 for 24x7). */
  openDaysPerWeek: number;
  /** Days per week one agent actually supplies coverage: openDaysPerWeek − extraOffDays. */
  coverageDays: number;
  /**
   * Seat-to-roster coverage uplift: openDaysPerWeek / coverageDays − 1. Agents only supply
   * capacity on open days, so this — not offPct — is the multiplier applied to DES seats.
   * 0 when rosterInfeasible.
   */
  rosterUpliftPct: number;
  /** True when coverageDays <= 0 — labor off days meet/exceed open days; no roster can cover
   * a full week. operationalHCWithOff is left un-adjusted (= operationalHC) in this case. */
  rosterInfeasible: boolean;
  /** floor(operationalHC × openDaysPerWeek / coverageDays) — Net Operational HC after extra
   * OFF; Stage 4 base. Computed integer-exact, never via a floored fractional multiplier. */
  operationalHCWithOff: number;
  grossHCTotal: number;
  fteGrossHeadline: number;
  fteNet: number;
  effectiveShrinkagePct: number; // Harmonic
  requiredProductiveHoursTotal: number;
  totalWorkloadHours: number;
  contractualProductiveHours: number;
  contractualHoursSource: ContractualHoursSource;
  
  perCategory: Array<{
    category: string;
    workloadHours: number;
    categoryShare: number;
    operationalHC: number;
    requiredProductiveHours: number;
    shrinkagePct: number;
    grossHC: number; // Fractional
    fteGross: number;
  }>;
  
  bindingConstraint: string;
}

export interface BoundaryEvidence {
  recommendedN: number;
  recommendedResult: DESResult;
  failedN?: number;
  failedResult?: DESResult;
  differenceSummary: string;
  breachSamplesAtNMinus1: Array<{
    caseId: string;
    category: string;
    arrival: string;
    deadline: string;
    latestSafeStart: string;
    reason: string;
  }>;
}

export interface SearchProgressState {
  status: 'idle' | 'initializing' | 'searching' | 'verifying_boundary' | 'finalizing' | 'completed' | 'infeasible';
  phase: string;
  currentN?: number;
  nMin?: number;
  maxN?: number;
  percent: number; // 0 to 100
  evaluatedHistory: Array<{
    hc: number;
    primaryPct: number;
    boAsaMinutes: number;
    occupancyPct: number;
    rawOccupancyPct: number;
    passed: boolean;
    failingReasons: string[];
  }>;
  currentMessage: string;
}

export interface HCSearchOutput {
  nMinAnalytical: number;
  nMinBeforeReduction?: number; // N_min as it would have been WITHOUT the reduction — display/audit only, never a search input.
  workloadReductionAppliedPct?: number; // Set only when the reduction was ON for this run; undefined = no reduction applied.
  primaryDrivenHC: number;
  primaryStatistical?: PrimarySLAStatisticalResult;
  queueArchitecture: 'pooled' | 'siloed';
  recommendedHC: number | null;
  isInfeasible: boolean;
  infeasibleReason?: string;
  isInfeasibleAdjacent?: boolean;
  infeasibleAdjacentWarning?: string;
  bindingConstraintType?: 'statistical_primary_sla' | 'bo_asa_cap' | 'occupancy_cap' | 'analytical_baseline' | 'category_aht_exceeds_window';
  bindingConstraintDescription?: string;
  searchHistory: Array<{
    hc: number;
    primaryPct: number;
    primaryCiLow?: number;
    primaryCiHigh?: number;
    boAsaMinutes: number;
    occupancyPct: number;
    rawOccupancyPct: number;
    passed: boolean;
    failingReasons: string[];
  }>;
  finalDESResult?: DESResult;
  staffing?: StaffingRequirement;
  boundaryEvidence?: BoundaryEvidence;

  /**
   * Analytic capacity floors, computed before the search runs (see computeOccupancyFloor /
   * computeShiftPlacement in hc-search.ts). nMinAnalytical remains the search's frozen hard
   * floor unconditionally — these are additional, non-authoritative diagnostics.
   */
  occupancyFeasibleFloor?: number; // N_occ: smallest N whose occupancy can be ≤ cap
  shiftPlacement?: {
    enabledForRun: boolean;
    slapMinutes: number;
    /** Smallest N whose optimal placement clears the SLA gate analytically (N_sla). */
    placementFeasibleFloor?: number;
    /** The distribution actually used for the returned recommendedHC, if placement won. */
    winningDistribution?: ShiftDistributionByCategory;
  };
}

export interface SensitivityScenario {
  volumeDeltaPct: number; // e.g. -20, -10, 0, 10, 20
  ahtDeltaPct: number; // e.g. -20, -10, 0, 10, 20
  operationalHC: number | null;
  grossHCTotal: number | null;
  fteGross: number | null;
  primaryPct: number;
  boAsaMinutes: number;
  passed: boolean;
}
