/**
 * A small streaming CSV reader.
 *
 * nflverse ships season files of 10-30MB. Buffering one into a string
 * and splitting it is fine locally but wasteful in a serverless function
 * with a memory cap, so this parses row by row off the fetch stream.
 *
 * Handles the parts of RFC 4180 the nflverse files actually use: quoted
 * fields, embedded commas, doubled quotes, and CRLF.
 */

export type CsvRow = Record<string, string>;

/** Splits one CSV line, respecting quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      out.push(field);
      field = "";
    } else {
      field += char;
    }
  }

  out.push(field);
  return out;
}

/**
 * Streams a CSV from a URL, yielding one object per data row.
 *
 * Returns nothing at all for a 404 -- nflverse only publishes a season
 * file once that season starts, so "not there yet" is an expected state
 * in August, not an error worth throwing over.
 */
export async function* streamCsv(
  url: string,
  signal?: AbortSignal,
): AsyncGenerator<CsvRow> {
  const response = await fetch(url, {
    signal,
    headers: { accept: "text/csv" },
    // These files change a few times a week at most.
    cache: "no-store",
  });

  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  if (!response.body) throw new Error(`No response body for ${url}`);

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .getReader();

  let buffer = "";
  let header: string[] | null = null;

  const emit = function* (line: string): Generator<CsvRow> {
    if (line === "") return;
    const fields = splitCsvLine(line);

    if (header === null) {
      header = fields;
      return;
    }

    const row: CsvRow = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]] = fields[i] ?? "";
    }
    yield row;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += value;
    let newlineAt: number;
    while ((newlineAt = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineAt).replace(/\r$/, "");
      buffer = buffer.slice(newlineAt + 1);
      yield* emit(line);
    }
  }

  // Whatever is left after the last newline.
  yield* emit(buffer.replace(/\r$/, ""));
}

/** A CSV cell as a number. Blank, "NA" and unparseable all read as 0. */
export function n(row: CsvRow, key: string): number {
  const raw = row[key];
  if (raw === undefined || raw === "" || raw === "NA") return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/** A CSV cell as a string, with nflverse's "NA" mapped to null. */
export function s(row: CsvRow, key: string): string | null {
  const raw = row[key];
  if (raw === undefined || raw === "" || raw === "NA") return null;
  return raw;
}
