/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CategoryConfig } from '../types/wfm';

export interface SampleDatasetTemplate {
  id: string;
  name: string;
  description: string;
  categories: CategoryConfig[];
  generateCSV: () => string;
}

export function generate30MinInflowCSV(options: {
  days: number;
  categories: string[];
  startDate?: Date;
  baseVolumePerDay?: number;
}): string {
  const { days = 7, categories = ['Standard'], baseVolumePerDay = 300 } = options;
  const start = options.startDate || new Date(2026, 7, 24, 0, 0, 0); // Monday

  const rows: string[] = ['interval_start,interval_end,category,volume'];

  // Intraday curve for 48 half-hour slots
  // Backoffice demand often peaks in morning & early afternoon, but arrives 24h
  const hourlyFactors = [
    0.1, 0.08, 0.05, 0.05, 0.08, 0.15, // 00:00 - 03:00
    0.3, 0.5, 0.9, 1.4, 1.8, 1.9, // 03:00 - 06:00
    2.0, 1.8, 1.7, 1.9, 1.6, 1.3, // 06:00 - 09:00
    1.1, 0.9, 0.7, 0.5, 0.3, 0.2, // 09:00 - 12:00
  ];

  let current = new Date(start);

  for (let d = 0; d < days; d++) {
    // Day of week multiplier (Mon/Tue higher, Sat/Sun lower but positive)
    const dow = current.getDay();
    const dayFactor = dow === 0 || dow === 6 ? 0.35 : dow === 1 ? 1.25 : 1.0;

    for (let slot = 0; slot < 48; slot++) {
      const slotStart = new Date(current.getTime() + slot * 30 * 60 * 1000);
      const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);

      const hourIdx = Math.floor(slot / 2);
      const slotFactor = hourlyFactors[hourIdx] * dayFactor;

      for (const cat of categories) {
        // Distribute volume per category with realistic variance
        const catMultiplier = cat.includes('High') || cat.includes('Medical') || cat.includes('Wire') ? 0.6 : 0.4;
        const rawVol = (baseVolumePerDay / 48) * slotFactor * catMultiplier;
        const volume = Math.max(0, Math.round(rawVol));

        const pad = (n: number) => String(n).padStart(2, '0');
        const startIso = `${slotStart.getFullYear()}-${pad(slotStart.getMonth() + 1)}-${pad(slotStart.getDate())}T${pad(slotStart.getHours())}:${pad(slotStart.getMinutes())}:00`;
        const endIso = `${slotEnd.getFullYear()}-${pad(slotEnd.getMonth() + 1)}-${pad(slotEnd.getDate())}T${pad(slotEnd.getHours())}:${pad(slotEnd.getMinutes())}:00`;

        rows.push(`${startIso},${endIso},${cat},${volume}`);
      }
    }

    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
  }

  return rows.join('\r\n');
}

export const SAMPLE_TEMPLATES: SampleDatasetTemplate[] = [
  {
    id: 'claims',
    name: 'Insurance Claims Processing',
    description: '1-Week 30-min inflow with Medical Claims, Auto Claims, and Property Claims.',
    categories: [
      { id: 'c1', name: 'Medical Claims', ahtMinutes: 24, shrinkagePct: 0.22, priority: 1 },
      { id: 'c2', name: 'Auto Claims', ahtMinutes: 35, shrinkagePct: 0.25, priority: 2 },
      { id: 'c3', name: 'Property Claims', ahtMinutes: 48, shrinkagePct: 0.28, priority: 3 },
    ],
    generateCSV: () =>
      generate30MinInflowCSV({
        days: 7,
        categories: ['Medical Claims', 'Auto Claims', 'Property Claims'],
        baseVolumePerDay: 450,
      }),
  },
  {
    id: 'banking',
    name: 'Banking & Financial Operations',
    description: 'Wire Transfers, Loan Underwriting, and KYC Document Verification.',
    categories: [
      { id: 'b1', name: 'Wire Transfers', ahtMinutes: 12, shrinkagePct: 0.18, priority: 1 },
      { id: 'b2', name: 'KYC Verification', ahtMinutes: 20, shrinkagePct: 0.20, priority: 2 },
      { id: 'b3', name: 'Loan Underwriting', ahtMinutes: 55, shrinkagePct: 0.26, priority: 3 },
    ],
    generateCSV: () =>
      generate30MinInflowCSV({
        days: 7,
        categories: ['Wire Transfers', 'KYC Verification', 'Loan Underwriting'],
        baseVolumePerDay: 520,
      }),
  },
  {
    id: 'ecommerce',
    name: 'Customer Support Escalations',
    description: 'Billing Disputes, Account Security, and Complex Returns.',
    categories: [
      { id: 'e1', name: 'Billing Disputes', ahtMinutes: 18, shrinkagePct: 0.20, priority: 2 },
      { id: 'e2', name: 'Account Security', ahtMinutes: 15, shrinkagePct: 0.15, priority: 1 },
      { id: 'e3', name: 'Complex Returns', ahtMinutes: 28, shrinkagePct: 0.22, priority: 3 },
    ],
    generateCSV: () =>
      generate30MinInflowCSV({
        days: 7,
        categories: ['Account Security', 'Billing Disputes', 'Complex Returns'],
        baseVolumePerDay: 600,
      }),
  },
];
