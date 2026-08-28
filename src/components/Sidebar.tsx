/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Sliders,
  Database,
  PlayCircle,
  BarChart3,
  TrendingUp,
  RotateCcw,
  Download,
  Upload,
  Layers,
} from 'lucide-react';

export type MainFlow = 'demand' | 'config' | 'run' | 'results' | 'sensitivity';

interface SidebarProps {
  currentFlow: MainFlow;
  currentTab: string;
  onSelectFlow: (flow: MainFlow, defaultTab?: string) => void;
  onSelectTab: (tab: string) => void;
  onResetAll: () => void;
  onExportParams: () => void;
  onImportParams: (e: React.ChangeEvent<HTMLInputElement>) => void;
  hasResults: boolean;
  dqPassed: boolean;
  paramsPanelOpen: boolean;
  onToggleParamsPanel: () => void;
}

export const FLOW_TABS: Record<MainFlow, { id: string; label: string }[]> = {
  demand: [
    { id: 'upload', label: 'Upload' },
    { id: 'mapping', label: 'Column Map' },
    { id: 'calendar', label: 'Business Calendar' },
    { id: 'dq', label: 'Data Quality (DQ)' },
    { id: 'opening_wip', label: 'Opening WIP' },
  ],
  config: [
    { id: 'labor', label: 'Labor & Productive Hours' },
    { id: 'sla', label: 'SLA Defaults' },
    { id: 'categories', label: 'Categories' },
  ],
  run: [
    { id: 'preflight', label: 'Pre-flight' },
    { id: 'simulate', label: 'Simulate' },
  ],
  results: [
    { id: 'summary', label: 'Summary' },
    { id: 'staffing_path', label: 'Staffing Path' },
    { id: 'cases', label: 'Case Browser' },
    { id: 'agents', label: 'Agent Browser' },
    { id: 'queue_wip', label: 'Queue / WIP' },
    { id: 'audit', label: 'Audit Drill' },
    { id: 'assumptions', label: 'Assumptions' },
  ],
  sensitivity: [
    { id: 'scenarios', label: 'Scenarios Matrix' },
    { id: 'compare', label: 'Compare Scenarios' },
  ],
};

export function Sidebar({
  currentFlow,
  currentTab,
  onSelectFlow,
  onSelectTab,
  onResetAll,
  onExportParams,
  onImportParams,
  hasResults,
  dqPassed,
  paramsPanelOpen,
  onToggleParamsPanel,
}: SidebarProps) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const flows = [
    { id: 'demand', label: '1. Demand & Inflow', icon: Database, badge: dqPassed ? 'DQ OK' : null },
    { id: 'config', label: '2. Labor & Config', icon: Sliders, badge: null },
    { id: 'run', label: '3. Run Sizing', icon: PlayCircle, badge: null },
    { id: 'results', label: '4. Results & Audit', icon: BarChart3, badge: hasResults ? 'Ready' : null },
    { id: 'sensitivity', label: '5. Sensitivity', icon: TrendingUp, badge: null },
  ] as const;

  return (
    <aside className="w-64 bg-slate-900 text-slate-200 flex flex-col justify-between shrink-0 self-stretch select-none border-r border-slate-800">
      {/* Top Header */}
      <div className="p-4 border-b border-slate-800/80">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white font-black shadow-md shadow-emerald-900/30 text-sm">
            BO
          </div>
          <div>
            <h1 className="text-xs font-black tracking-wider uppercase text-white leading-tight">
              Backoffice WFM Sizing
            </h1>
            <p className="text-[10px] text-slate-400 font-medium">Discrete Event Simulation</p>
          </div>
        </div>
      </div>

      {/* Navigation Flows */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <div>
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest px-2 block mb-2">
            Sizing Workflow
          </span>
          <div className="space-y-1">
            {flows.map((f) => {
              const Icon = f.icon;
              const isActive = currentFlow === f.id;

              return (
                <div key={f.id} className="space-y-0.5">
                  <button
                    id={`sidebar-flow-${f.id}`}
                    onClick={() => {
                      const firstTab = FLOW_TABS[f.id][0].id;
                      onSelectFlow(f.id, firstTab);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition ${
                      isActive
                        ? 'bg-slate-800 text-white shadow-xs'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Icon className={`w-4 h-4 ${isActive ? 'text-emerald-400' : 'text-slate-500'}`} />
                      <span>{f.label}</span>
                    </div>

                    {f.badge && (
                      <span
                        className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-tight ${
                          f.badge === 'DQ OK' || f.badge === 'Ready'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-slate-700 text-slate-300'
                        }`}
                      >
                        {f.badge}
                      </span>
                    )}
                  </button>

                  {/* Sub-tabs if flow is active */}
                  {isActive && (
                    <div className="pl-8 pr-1 py-1 space-y-0.5 border-l-2 border-slate-700 ml-4">
                      {FLOW_TABS[f.id].map((tab) => {
                        const isTabActive = currentTab === tab.id;
                        return (
                          <button
                            key={tab.id}
                            id={`sidebar-tab-${tab.id}`}
                            onClick={() => onSelectTab(tab.id)}
                            className={`w-full text-left px-2.5 py-1 rounded text-[11px] font-medium transition ${
                              isTabActive
                                ? 'bg-emerald-500/15 text-emerald-300 font-semibold'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                            }`}
                          >
                            {tab.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Global Inspector Toggle */}
        <div className="pt-2 border-t border-slate-800/70">
          <button
            id="sidebar-toggle-params-btn"
            onClick={onToggleParamsPanel}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition ${
              paramsPanelOpen
                ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-blue-400" />
              <span>Params & Logic Inspector</span>
            </div>
            <span className="text-[10px] font-mono">{paramsPanelOpen ? 'OPEN' : 'HIDE'}</span>
          </button>
        </div>
      </div>

      {/* Footer System Actions */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/50 space-y-2">
        <div className="grid grid-cols-2 gap-1.5">
          <button
            id="sidebar-export-params-btn"
            onClick={onExportParams}
            className="flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-semibold rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            title="Export parameter configuration to JSON file"
          >
            <Download className="w-3 h-3" />
            <span>Export JSON</span>
          </button>

          <button
            id="sidebar-import-params-btn"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-semibold rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            title="Import parameter configuration from JSON file"
          >
            <Upload className="w-3 h-3" />
            <span>Import JSON</span>
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={onImportParams}
            accept=".json"
            className="hidden"
          />
        </div>

        <button
          id="sidebar-reset-all-btn"
          onClick={onResetAll}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded text-rose-400 hover:bg-rose-950/40 hover:text-rose-300 transition border border-rose-900/30"
          title="Reset all inputs, uploads, and sizing results"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Reset All Data & Params</span>
        </button>

        <div className="text-[10px] text-slate-500 text-center font-mono pt-1">
          Zero-Dependency Offline HTML
        </div>
      </div>
    </aside>
  );
}
