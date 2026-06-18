import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { QueryResult } from "./db.js";

/** Render any SQL value as a string for display / CSV output. */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvEscape(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * Write the FULL, untruncated result set to a CSV file in the public files
 * directory and return its caller-fetchable URL. This is the artifact callers
 * grep against when the inline preview is truncated.
 */
export async function writeCsv(result: QueryResult): Promise<string> {
  await mkdir(config.filesDir, { recursive: true });

  const id = randomUUID();
  const filename = `${id}.csv`;
  const filePath = path.join(config.filesDir, filename);

  const lines: string[] = [];
  lines.push(result.fields.map((f) => csvEscape(f)).join(","));
  for (const row of result.rows) {
    lines.push(row.map((cell) => csvEscape(cellToString(cell))).join(","));
  }
  // Trailing newline so the file ends cleanly.
  await writeFile(filePath, lines.join("\r\n") + "\r\n", "utf8");

  return `${config.publicBaseUrl}/files/${filename}`;
}

export interface Preview {
  columns: string[];
  rows: string[][];
  metadata: {
    database: string;
    totalRows: number;
    returnedRows: number;
    truncatedColumns: string[];
    cellsTruncated: boolean;
    rowsOmitted: boolean;
    // Only set when the inline preview is incomplete; null when the full result
    // is shown inline (no CSV file is written in that case).
    csvUrl: string | null;
    note: string;
  };
}

/**
 * Build an inline preview that:
 *  - truncates every cell to `maxCellChars`,
 *  - includes only as many leading rows as fit under `maxOutputChars`,
 *  - reports total row count and which columns were truncated.
 *
 * A CSV export of the full, untruncated result is written and linked ONLY when
 * the preview is incomplete (rows omitted or cells truncated). When everything
 * is shown inline there is nothing the CSV would add, so none is created.
 */
export async function buildPreview(result: QueryResult, dbName: string): Promise<Preview> {
  const { fields, rows } = result;
  const truncatedColumns = new Set<string>();

  // Truncate each cell, tracking which columns lost data.
  const truncatedRows: string[][] = rows.map((row) =>
    row.map((cell, col) => {
      const full = cellToString(cell);
      if (full.length > config.maxCellChars) {
        truncatedColumns.add(fields[col]);
        return full.slice(0, config.maxCellChars) + "…";
      }
      return full;
    }),
  );

  // Add rows one at a time until the serialized payload would exceed the cap.
  const preview: Preview = {
    columns: fields,
    rows: [],
    metadata: {
      database: dbName,
      totalRows: rows.length,
      returnedRows: 0,
      truncatedColumns: [...truncatedColumns],
      cellsTruncated: truncatedColumns.size > 0,
      rowsOmitted: false,
      csvUrl: null,
      note: "",
    },
  };

  for (const row of truncatedRows) {
    preview.rows.push(row);
    preview.metadata.returnedRows = preview.rows.length;
    if (JSON.stringify(preview).length > config.maxOutputChars) {
      // This row pushed us over — drop it back out.
      preview.rows.pop();
      preview.metadata.returnedRows = preview.rows.length;
      break;
    }
  }

  preview.metadata.rowsOmitted = preview.metadata.returnedRows < rows.length;

  // The result is shown in full only when no rows were dropped and no cell was
  // capped. Otherwise write the CSV and point the caller at it.
  const complete = !preview.metadata.rowsOmitted && !preview.metadata.cellsTruncated;
  if (complete) {
    preview.metadata.note = "Complete result shown.";
    return preview;
  }

  const csvUrl = await writeCsv(result);
  preview.metadata.csvUrl = csvUrl;

  const reasons: string[] = [];
  if (preview.metadata.rowsOmitted) {
    reasons.push(`showing first ${preview.metadata.returnedRows} of ${rows.length} rows`);
  }
  if (preview.metadata.cellsTruncated) {
    reasons.push(`some cells truncated to ${config.maxCellChars} chars`);
  }
  preview.metadata.note = `Result not shown in full (${reasons.join("; ")}). The complete, untruncated result is at ${csvUrl}. This server has no tool to return that file — download it yourself with an HTTP-capable tool (e.g. run \`curl -s "${csvUrl}"\` via your shell).`;

  return preview;
}
