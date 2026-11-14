import { exportCsv } from '@splitter/core';
import type { GroupStore } from './store';

/** Built locally from the synced data, so it also works offline. */
export function exportCsvFile(store: GroupStore) {
  const csv = '﻿' + exportCsv(store.state);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${store.group.name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'group'}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
