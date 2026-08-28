/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { exportToExcelCSV } from '../utils/csv-parser';
import { Download, Search, ChevronLeft, ChevronRight } from 'lucide-react';

export interface ColumnDef<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  align?: 'left' | 'center' | 'right';
}

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
  searchPlaceholder?: string;
  exportFilename?: string;
  pageSizeDefault?: number;
  categoryFilterKey?: keyof T;
  statusFilterKey?: keyof T;
  dateFilterKey?: keyof T;
  id?: string;
}

export function DataTable<T extends Record<string, any>>({
  data,
  columns,
  searchPlaceholder = 'Search records...',
  exportFilename = 'wfm_data.csv',
  pageSizeDefault = 10,
  categoryFilterKey,
  statusFilterKey,
  dateFilterKey,
  id,
}: DataTableProps<T>) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [sortKey, setSortKey] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(pageSizeDefault);

  // Extract unique categories and statuses if filter keys provided
  const categories = categoryFilterKey
    ? Array.from(new Set(data.map((d) => String(d[categoryFilterKey] || '')))).filter(Boolean)
    : [];

  const statuses = statusFilterKey
    ? Array.from(new Set(data.map((d) => String(d[statusFilterKey] || '')))).filter(Boolean)
    : [];

  // Filter
  const filteredData = data.filter((row) => {
    if (selectedCategory !== 'ALL' && categoryFilterKey && String(row[categoryFilterKey]) !== selectedCategory) {
      return false;
    }
    if (selectedStatus !== 'ALL' && statusFilterKey && String(row[statusFilterKey]) !== selectedStatus) {
      return false;
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      const match = Object.values(row).some((val) => {
        if (val === null || val === undefined) return false;
        if (val instanceof Date) return val.toISOString().toLowerCase().includes(q);
        return String(val).toLowerCase().includes(q);
      });
      if (!match) return false;
    }
    return true;
  });

  // Sort
  if (sortKey) {
    filteredData.sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];
      if (valA === valB) return 0;
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;

      if (valA instanceof Date && valB instanceof Date) {
        return sortDir === 'asc' ? valA.getTime() - valB.getTime() : valB.getTime() - valA.getTime();
      }
      if (typeof valA === 'number' && typeof valB === 'number') {
        return sortDir === 'asc' ? valA - valB : valB - valA;
      }
      const strA = String(valA).toLowerCase();
      const strB = String(valB).toLowerCase();
      return sortDir === 'asc' ? strA.localeCompare(strB) : strB.localeCompare(strA);
    });
  }

  // Pagination
  const totalPages = pageSize > 0 ? Math.ceil(filteredData.length / pageSize) : 1;
  const currentPage = Math.min(Math.max(1, page), Math.max(1, totalPages));
  const startIndex = pageSize > 0 ? (currentPage - 1) * pageSize : 0;
  const pageRows = pageSize > 0 ? filteredData.slice(startIndex, startIndex + pageSize) : filteredData;

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function handleExport() {
    // Flatten rows for clean CSV export
    const exportRows = filteredData.map((row) => {
      const r: Record<string, any> = {};
      columns.forEach((col) => {
        const val = row[col.key];
        r[col.header] = val instanceof Date ? val.toISOString() : val;
      });
      return r;
    });
    exportToExcelCSV(exportRows, exportFilename);
  }

  return (
    <div id={id} className="w-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      {/* Controls Bar */}
      <div className="p-3.5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
        <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[280px]">
          {/* Search Box */}
          <div className="relative flex-1 max-w-xs">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              id={id ? `${id}-search` : undefined}
              type="text"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setPage(1);
              }}
              placeholder={searchPlaceholder}
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-400 text-slate-800"
            />
          </div>

          {/* Category Filter */}
          {categories.length > 0 && (
            <select
              id={id ? `${id}-cat-filter` : undefined}
              value={selectedCategory}
              onChange={(e) => {
                setSelectedCategory(e.target.value);
                setPage(1);
              }}
              className="text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              <option value="ALL">All Categories ({categories.length})</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}

          {/* Status Filter */}
          {statuses.length > 0 && (
            <select
              id={id ? `${id}-status-filter` : undefined}
              value={selectedStatus}
              onChange={(e) => {
                setSelectedStatus(e.target.value);
                setPage(1);
              }}
              className="text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              <option value="ALL">All Statuses ({statuses.length})</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 font-medium">
            {filteredData.length} {filteredData.length === 1 ? 'record' : 'records'}
          </span>

          <button
            id={id ? `${id}-export-excel-btn` : undefined}
            onClick={handleExport}
            disabled={filteredData.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
            title="Export filtered records to UTF-8 BOM CSV"
          >
            <Download className="w-3.5 h-3.5" />
            Export to Excel
          </button>
        </div>
      </div>

      {/* Table Container */}
      <div className="overflow-x-auto min-h-[160px]">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="bg-slate-100/80 border-b border-slate-200 text-slate-700 font-semibold select-none">
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => col.sortable !== false && handleSort(col.key)}
                  className={`py-2.5 px-3.5 ${col.sortable !== false ? 'cursor-pointer hover:bg-slate-200/70' : ''} ${
                    col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                  }`}
                >
                  <div className={`inline-flex items-center gap-1 ${col.align === 'right' ? 'justify-end' : ''}`}>
                    <span>{col.header}</span>
                    {sortKey === col.key && (
                      <span className="text-slate-900 font-bold">{sortDir === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-800">
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="text-center py-8 text-slate-400 italic">
                  No records match the current filter criteria.
                </td>
              </tr>
            ) : (
              pageRows.map((row, rIdx) => (
                <tr key={rIdx} className="hover:bg-slate-50/80 transition-colors">
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`py-2 px-3.5 ${
                        col.align === 'right' ? 'text-right font-mono' : col.align === 'center' ? 'text-center' : 'text-left'
                      }`}
                    >
                      {col.render ? col.render(row) : String(row[col.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="p-3 border-t border-slate-100 bg-slate-50/50 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
        <div className="flex items-center gap-2">
          <span>Rows per page:</span>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            className="bg-white border border-slate-200 rounded px-2 py-1 text-xs"
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={0}>All</option>
          </select>
          <span className="text-slate-400">|</span>
          <span>
            Showing {filteredData.length > 0 ? startIndex + 1 : 0} to{' '}
            {pageSize > 0 ? Math.min(startIndex + pageSize, filteredData.length) : filteredData.length} of{' '}
            {filteredData.length}
          </span>
        </div>

        {pageSize > 0 && totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(page - 1)}
              disabled={currentPage <= 1}
              className="p-1 rounded border border-slate-200 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-2 font-medium">
              Page {currentPage} of {totalPages}
            </span>
            <button
              onClick={() => setPage(page + 1)}
              disabled={currentPage >= totalPages}
              className="p-1 rounded border border-slate-200 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
