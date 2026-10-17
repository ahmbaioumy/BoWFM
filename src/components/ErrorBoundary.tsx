/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * 'page' (outer, in main.tsx): last resort; the whole page is replaced and the only way out is a full reload.
   * 'content' (inner, in App.tsx around the flow content): the sidebar stays usable (Export JSON, Reset),
   * and the boundary resets itself when its `key` changes (the app keys it by the current flow).
   */
  level?: 'page' | 'content';
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Crash screen: a render error below this component shows a plain message instead of a blank white page.
 * Only errors thrown while rendering are caught (not event handlers or async code).
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // The project has no React type package installed, so the base class is untyped: declare what we use.
  declare readonly props: Readonly<ErrorBoundaryProps>;
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const isPage = (this.props.level ?? 'page') === 'page';
    return (
      <div
        role="alert"
        data-testid="crash-screen"
        className={`${isPage ? 'min-h-screen' : 'min-h-64'} flex items-center justify-center bg-slate-100 p-6 font-sans text-slate-900`}
      >
        <div className="max-w-xl w-full bg-white border border-rose-300 rounded-xl p-6 shadow-sm space-y-3">
          <h2 className="text-base font-black text-rose-900">{isPage ? 'BoWFM stopped working' : 'Something went wrong on this screen'}</h2>
          <p className="text-xs text-slate-700 leading-relaxed">
            {isPage
              ? 'The page hit an unexpected error and cannot continue. Reloading starts a fresh session; anything not exported (settings JSON, result CSVs) is lost.'
              : 'This screen hit an unexpected error. The left menu still works: you can export your settings JSON, switch to another screen, or reload the page.'}
          </p>
          <pre className="text-[11px] bg-rose-50 border border-rose-200 rounded-lg p-3 text-rose-900 whitespace-pre-wrap break-words">
            {error.message || String(error)}
          </pre>
          <p className="text-xs text-slate-600">If this keeps happening, note the message in the box.</p>
          {!isPage && (
            <p className="text-xs text-slate-600">Before reloading, use Export JSON in the left menu to save your settings.</p>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold hover:bg-slate-700 transition"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
