/**
 * CSV/TSV parser — encoding sniff, delimiter sniff, header detection.
 * CSV/TSV 解析器 — 编码嗅探、分隔符嗅探、表头检测。
 */
import fs from 'node:fs';
import iconv from 'iconv-lite';
import type { RawImportRow, ColumnMapping } from './scheduleImportTypes.ts';
import { COLUMN_ALIASES } from './scheduleImportTypes.ts';

export interface CsvParseResult {
  rows: RawImportRow[];
  headers: string[];
  encoding: string;
  delimiter: string;
  autoMapping: ColumnMapping;
}

/**
 * Parse a CSV/TSV file with automatic encoding and delimiter detection.
 */
export function parseCsvFile(filePath: string): CsvParseResult {
  const buffer = fs.readFileSync(filePath);

  // Detect encoding
  const encoding = detectEncoding(buffer);
  const text = iconv.decode(buffer, encoding);

  // Detect delimiter
  const delimiter = detectDelimiter(text);

  // Parse rows
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) {
    return { rows: [], headers: [], encoding, delimiter, autoMapping: {} };
  }

  // Parse header
  const headers = parseCsvLine(lines[0], delimiter);

  // Parse data rows
  const rows: RawImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i], delimiter);
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = cells[j] ?? '';
    }
    rows.push({ rowIndex: i, cells: record });
  }

  // Auto-detect column mapping
  const autoMapping = autoDetectMapping(headers);

  return { rows, headers, encoding, delimiter, autoMapping };
}

/**
 * Detect file encoding from BOM or content analysis.
 */
function detectEncoding(buffer: Buffer): string {
  // UTF-8 BOM
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return 'utf-8';
  // UTF-16 LE BOM
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) return 'utf-16le';
  // UTF-16 BE BOM
  if (buffer[0] === 0xFE && buffer[1] === 0xFF) return 'utf-16be';

  // Try UTF-8 first
  const utf8Text = buffer.toString('utf-8');
  const hasReplacement = utf8Text.includes('�');

  if (!hasReplacement) return 'utf-8';

  // Fallback to GBK (common for Chinese education system exports)
  return 'gbk';
}

/**
 * Detect delimiter by sampling the first few lines.
 */
function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = 0;

  for (const delim of candidates) {
    const count = (sample.match(new RegExp(`\\${delim === '|' ? '\\|' : delim === '\t' ? '\\t' : delim}`, 'g')) ?? []).length;
    if (count > bestScore) {
      bestScore = count;
      best = delim;
    }
  }

  return best;
}

/**
 * Parse a single CSV line respecting quoted fields.
 */
function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
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