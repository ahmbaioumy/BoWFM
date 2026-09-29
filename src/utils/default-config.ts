/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CalendarConfig,
  CategoryConfig,
  LaborConfig,
  SimulationParams,
  SLAPolicyConfig,
} from '../types/wfm';

// Initial defaults for a fresh session (the app and the sample-dataset regression tests share these).
export const DEFAULT_CALENDAR: CalendarConfig = {
  workingDays: [1, 2, 3, 4, 5], // Mon-Fri
  dailyOpenHour: 8,
  dailyOpenMinute: 0,
  dailyCloseHour: 18,
  dailyCloseMinute: 0,
  holidays: [],
};

export const DEFAULT_LABOR: LaborConfig = {
  dailyProductiveHours: 7.5,
  adherencePct: 1.0,
  workingDaysPerWeek: 5,
  offDaysPerWeek: 2,
  contractualHoursSource: 'derived',
  contractualProductiveHoursOverride: 0,
  shifts: [],
};

export const DEFAULT_SLA: SLAPolicyConfig = {
  primaryPct: 80,
  primaryWindow: 6,
  primaryUnit: 'hours',
  boAsaEnabled: false,
  boAsaTarget: 60,
  boAsaUnit: 'minutes',
  asaClockBasis: 'business_window',
  clockBasis: 'business_time',
  clockStartPolicy: 'arrival',
  occupancyCapEnabled: false,
  occupancyCapPct: 85,
  confidenceLevelPct: 95,
  slaAcceptanceSlackEnabled: false,
  slaAcceptanceSlackPct: 5,
  workloadReductionEnabled: false,
  workloadReductionPct: 5,
  minCoverageEnabled: true,
  minAgentsPerInterval: 1,
};

export const DEFAULT_CATEGORIES: CategoryConfig[] = [
  {
    id: 'cat_claims_auto',
    name: 'Claims_Auto',
    ahtMinutes: 35,
    shrinkagePct: 0.20,
    priority: 1,
    primaryPct: 80,
    primaryWindow: 6,
    primaryUnit: 'hours',
    primaryWindowMinutes: 360,
    boAsaTarget: 60,
    boAsaUnit: 'minutes',
  },
  {
    id: 'cat_claims_home',
    name: 'Claims_Home',
    ahtMinutes: 45,
    shrinkagePct: 0.20,
    priority: 2,
    primaryPct: 80,
    primaryWindow: 6,
    primaryUnit: 'hours',
    primaryWindowMinutes: 360,
    boAsaTarget: 60,
    boAsaUnit: 'minutes',
  },
  {
    id: 'cat_claims_life',
    name: 'Claims_Life',
    ahtMinutes: 60,
    shrinkagePct: 0.25,
    priority: 3,
    primaryPct: 80,
    primaryWindow: 8,
    primaryUnit: 'hours',
    primaryWindowMinutes: 480,
    boAsaTarget: 90,
    boAsaUnit: 'minutes',
  },
];

export const DEFAULT_SIM_PARAMS: SimulationParams = {
  seed: 12345,
  maxHCSearch: 500,
  replications: 30,
  queueArchitecture: 'pooled',
};
