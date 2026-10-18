/**
 * Excel parser — reads .xlsx files via exceljs.
 * Excel 解析器 — 通过 exceljs 读取 .xlsx 文件。
 */
import ExcelJS from 'exceljs';
import type { RawImportRow, ColumnMapping } from './scheduleImportTypes.ts';
import { COLUMN_ALIASES } from './scheduleImportTypes.ts';

export interface ExcelParseResult {
  rows: RawImportRow[];
  headers: string[];
  sheetName: string;
  autoMapping: ColumnMapping;
}

/**
 * Parse an Excel (.xlsx) file. Only reads the first worksheet.
 */
export async function parseExcelFile(filePath: string): Promise<ExcelParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    return { rows: [], headers: [], sheetName: '', autoMapping: {} };
  }

  // Extract headers from first row
  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value ?? '').trim();
  });

  // Extract data rows
  const rows: RawImportRow[] = [];
  for (let rowNum = 2; rowNum <= worksheet.rowCount; rowNum++) {
    const row = worksheet.getRow(rowNum);
    if (row.cellCount === 0) continue;

    const cells: Record<string, string> = {};
    let hasContent = false;

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber - 1];
      if (header) {
        const value = formatCellValue(cell.value);
        cells[header] = value;
        if (value) hasContent = true;
      }
    });

    if (hasContent) {
      rows.push({ rowIndex: rowNum - 1, cells });
    }
  }

  // Auto-detect column mapping
  const autoMapping = autoDetectMapping(headers);

  return { rows, headers, sheetName: worksheet.name, autoMapping };
}

/**
 * Format a cell value to string.
 */
function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'object' && 'text' in value) {
    return String((value as { text: string }).text).trim();
  }
  return String(value).trim();
}

/**
 * Auto-detect column mapping from header names.
 */
function autoDetectMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const header of headers) {
    const normalized = header.trim().toLowerCase();
    mapping[header] = COLUMN_ALIASES[normalized] ?? COLUMN_ALIASES[header.trim()] ?? '';
  }
  return mapping;
}