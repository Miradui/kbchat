import type { TableSource } from '../types/api';

export function tableSourceLabel(table?: TableSource): string {
  if (!table || !Number.isInteger(table.rowStart) || !Number.isInteger(table.rowEnd) || table.rowStart < 1 || table.rowEnd < table.rowStart) return '';
  return `${table.sheetName ? `${table.sheetName} · ` : ''}第 ${table.rowStart}${table.rowEnd > table.rowStart ? `–${table.rowEnd}` : ''} 行`;
}
