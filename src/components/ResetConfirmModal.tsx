/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import { RotateCcw, AlertTriangle, X, Database, Sliders, PlayCircle, BarChart3 } from 'lucide-react';

/** What opened the dialog: the Sidebar Reset button, or a file upload / sample load on top of loaded data. */
export type ResetTrigger = 'reset' | 'upload' | 'sample';

export interface ResetDialogContent {
  title: string;
  subtitle: string;
  question: string;
  body: string;
  /** Everything the confirm clears (one chip each). */
  items: string[];
  /** Reminder that Export JSON does not save data or results. */
  exportNote: string;
  /** Upload/sample only: says the new file or sample loads after confirming. null for a plain reset. */
  afterNote: string | null;
  confirmLabel: string;
}

const RESET_ITEMS = [
  'Uploaded demand & column maps',
  'Opening WIP / backlog cases (including a staged backlog file)',
  'Labor, shifts & calendar config',
  'SLA thresholds & categories',
  'Simulation parameters & seeds',
  'Simulation sizing results & audit',
  'Sensitivity matrix',
];
const ITEM_ICONS = [Database, Database, Sliders, Sliders, PlayCircle, BarChart3, BarChart3];

const EXPORT_NOTE =
  'Export JSON saves settings only, not data or results. Export it first if you want to keep your settings.';

/** Pure wording for the dialog by trigger (tested in suite D89). */
export function getResetDialogContent(trigger: ResetTrigger): ResetDialogContent {
  if (trigger === 'reset') {
    return {
      title: 'Reset All Data & Parameters',
      subtitle: 'Revert entire workspace to default state',
      question: 'Are you sure you want to reset everything?',
      body: 'This restores all settings to defaults and removes the uploaded demand, backlog, sizing results and Sensitivity matrix. They cannot be recovered.',
      items: RESET_ITEMS,
      exportNote: EXPORT_NOTE,
      afterNote: null,
      confirmLabel: 'Yes, Reset Everything',
    };
  }
  const what = trigger === 'upload' ? 'file' : 'sample';
  return {
    title: 'Load new data — this replaces everything',
    subtitle: 'Current work is cleared before the new ' + what + ' loads',
    question: 'Replace your current work with the new ' + what + '?',
    body: 'Loading new data replaces everything: the current demand, backlog, settings, sizing results and Sensitivity matrix are removed and cannot be recovered.',
    items: RESET_ITEMS,
    exportNote: EXPORT_NOTE,
    afterNote:
      trigger === 'upload'
        ? 'The new file loads after you confirm. Cancel keeps your current work and drops the file you just picked.'
        : 'The sample dataset loads after you confirm. Cancel keeps your current work and drops the sample request.',
    confirmLabel: trigger === 'upload' ? 'Yes, Replace and Load File' : 'Yes, Replace and Load Sample',
  };
}

interface ResetConfirmModalProps {
  isOpen: boolean;
  trigger?: ResetTrigger;
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ResetConfirmModal({
  isOpen,
  trigger = 'reset',
  onConfirm,
  onCancel,
}: ResetConfirmModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Remember what had focus when the dialog opened, move focus to Cancel (the safe choice),
  // and give focus back when the dialog closes (if that element still exists).
  useEffect(() => {
    if (!isOpen) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelBtnRef.current?.focus();
    return () => {
      const el = returnFocusRef.current;
      returnFocusRef.current = null;
      if (el && el.isConnected) el.focus();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      // Trap: Tab / Shift+Tab cycle inside the dialog only.
      const nodes: HTMLElement[] = dialogRef.current ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const inside = !!dialogRef.current && dialogRef.current.contains(active);
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;
  const c = getResetDialogContent(trigger);

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
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="reset-modal-title"
        aria-describedby="reset-modal-desc"
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col animate-in zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="bg-slate-900 text-white p-4.5 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400">
              <RotateCcw className="w-5 h-5" />
            </div>
            <div>
              <h3 id="reset-modal-title" className="font-bold text-sm text-white">{c.title}</h3>
              <p className="text-[11px] text-slate-400 font-medium">{c.subtitle}</p>
            </div>
          </div>
          <button
            id="reset-modal-close-btn"
            type="button"
            onClick={onCancel}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            title="Cancel"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body Content */}
        <div className="p-5 space-y-4">
          <div className="flex items-start gap-3 p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-900">
            <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div id="reset-modal-desc" className="text-xs space-y-1">
              <p className="font-bold">{c.question}</p>
              <p className="text-rose-800 font-normal leading-relaxed">{c.body}</p>
              {c.afterNote && <p className="text-rose-900 font-semibold leading-relaxed">{c.afterNote}</p>}
            </div>
          </div>

          <div className="space-y-2 text-xs">
            <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              Items to be reset:
            </div>
            <div className="grid grid-cols-2 gap-2 text-slate-700 font-medium">
              {c.items.map((item, i) => {
                const Icon = ITEM_ICONS[i] ?? Database;
                return (
                  <div key={item} className="flex items-center gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200/80">
                    <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    <span>{item}</span>
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-600 leading-relaxed pt-1">{c.exportNote}</p>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="bg-slate-50 border-t border-slate-200 px-5 py-3.5 flex items-center justify-end gap-2.5">
          <button
            id="reset-modal-cancel-btn"
            ref={cancelBtnRef}
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
            <span>{c.confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
