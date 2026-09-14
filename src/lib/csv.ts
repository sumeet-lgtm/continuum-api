// Shared CSV parser — replaces 6 near-identical hand-rolled versions that
// used to live one per import/migrate/list/batch-send page. All 6 split the
// text into lines with /\r?\n/ BEFORE doing any quote-aware parsing, so none
// of them actually supported a quoted field containing a real embedded
// newline (one file's own comment claimed otherwise). This version parses
// the whole text as one character stream, so a newline inside quotes is
// correctly kept as part of the field instead of splitting the row early.

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export interface ParseCsvOptions {
  /** Lowercase every header before using it as a row key. Default: false — headers are kept as written, since some callers (e.g. batch-send's {{merge_vars}}) match the CSV's exact original casing. */
  lowercaseHeaders?: boolean;
  /** Cap how many data rows are returned (headers are still read from the full file). Default: no cap. */
  maxRows?: number;
}

// Low-level: the whole file -> an array of records, each an array of raw
// (already-unescaped, not yet trimmed) field strings. Handles quoted fields,
// escaped "" quotes, commas/newlines inside quotes, \r\n and \n line
// endings, and a leading UTF-8 BOM.
function parseCsvRecords(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // Final field/record if the file doesn't end on a line break.
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  // Drop fully-blank lines (a record that parsed to a single empty field) —
  // every original parser did this via its line-filter step.
  return records.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

export function parseCsv(text: string, options: ParseCsvOptions = {}): ParsedCsv {
  const records = parseCsvRecords(text);
  if (records.length === 0) return { headers: [], rows: [] };

  const rawHeaders = records[0].map((h) => h.trim());
  const headers = options.lowercaseHeaders ? rawHeaders.map((h) => h.toLowerCase()) : rawHeaders;

  let dataRecords = records.slice(1);
  if (options.maxRows !== undefined) dataRecords = dataRecords.slice(0, options.maxRows);

  const rows = dataRecords.map((values) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (values[i] ?? "").trim();
    });
    return row;
  });

  return { headers, rows };
}
