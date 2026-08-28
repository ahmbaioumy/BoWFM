/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { RotateCcw, AlertTriangle, X, Database, Sliders, PlayCircle, BarChart3 } from 'lucide-react';

interface ResetConfirmModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ResetConfirmModal({
  isOpen,
  onConfirm,
  onCancel,
}: ResetConfirmModalProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        onCancel();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      id="reset-confirm-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        id="reset-confirm-modal-dialog"
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col animate-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="bg-slate-900 text-white p-4.5 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400">
              <RotateCcw className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white">Reset All Data & Parameters</h3>
              <p className="text-[11px] text-slate-400 font-medium">Revert entire workspace to default state</p>
            </div>
          </div>
          <button
            id="reset-modal-close-btn"
            onClick={onCancel}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            title="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body Content */}
        <div className="p-5 space-y-4">
          <div className="flex items-start gap-3 p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-900">
            <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div className="text-xs space-y-1">
              <p className="font-bold">Are you sure you want to reset everything?</p>
              <p className="text-rose-800 font-normal leading-relaxed">
                This action will restore all settings and purge uploaded records. Any unsaved sizing runs and interval tables will be permanently removed.
              </p>
            </div>
          </div>

          <div className="space-y-2 text-xs">
            <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              Items to be reset:
            </div>
            <div className="grid grid-cols-2 gap-2 text-slate-700 font-medium">
              <div className="flex items-center gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200/80">
                <Database className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span>Uploaded demand & column maps</span>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200/80">
                <Database className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span>Opening WIP / backlog cases</span>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200/80">
                <Sliders className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span>Labor, shifts & calendar config</span>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200/80">
                <Sliders className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span>SLA thresholds & categories</span>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200/80">
                <PlayCircle className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span>Simulation parameters & seeds</span>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200/80">
                <BarChart3 className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span>Simulation sizing results & audit</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="bg-slate-50 border-t border-slate-200 px-5 py-3.5 flex items-center justify-end gap-2.5">
          <button
            id="reset-modal-cancel-btn"
            type="button"
            onClick={onCancel}
            className="px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 transition shadow-2xs"
          >
            Cancel
          </button>
          <button
            id="reset-modal-confirm-btn"
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-xs font-bold rounded-lg bg-rose-600 hover:bg-rose-700 text-white transition shadow-sm flex items-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Yes, Reset Everything</span>
          </button>
        </div>
      </div>
    </div>
  );
}
