import type { SubmissionReceivable } from "~~/lib/robomata/submissions";

type CsvHeader =
  | "id"
  | "obligor"
  | "vehicleCount"
  | "outstanding"
  | "outstandingCents"
  | "daysPastDue"
  | "utilizationPct"
  | "insured"
  | "titleClear"
  | "lockboxMatched";

const headerAliases: Record<string, CsvHeader> = {
  receivable: "id",
  receivableid: "id",
  id: "id",
  obligor: "obligor",
  customer: "obligor",
  vehicles: "vehicleCount",
  vehiclecount: "vehicleCount",
  outstanding: "outstanding",
  outstandingusd: "outstanding",
  outstandingcents: "outstandingCents",
  dpd: "daysPastDue",
  dayspastdue: "daysPastDue",
  utilization: "utilizationPct",
  utilizationpct: "utilizationPct",
  insured: "insured",
  titleclear: "titleClear",
  title: "titleClear",
  lockboxmatched: "lockboxMatched",
  lockbox: "lockboxMatched",
};

function normalizeHeader(value: string): CsvHeader | null {
  return headerAliases[value.replace(/[^a-z0-9]/gi, "").toLowerCase()] ?? null;
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "y" || normalized === "1";
}

function parseAmountToCents(value: string): number {
  const normalized = value.replace(/[$,\s]/g, "");
  if (!normalized) return NaN;
  if (normalized.includes(".")) return Math.round(Number(normalized) * 100);
  return Number(normalized) * 100;
}

function parseRequiredNumber(value: string | undefined, column: CsvHeader, rowNumber: number): number {
  const normalized = (value ?? "").replace(/[,\s]/g, "");
  const parsed = Number(normalized);

  if (!normalized || !Number.isFinite(parsed)) {
    throw new Error(`Receivables CSV row ${rowNumber} has invalid numeric value for ${column}.`);
  }

  return parsed;
}

function parseRequiredAmountToCents(value: string | undefined, column: CsvHeader, rowNumber: number): number {
  const cents = parseAmountToCents(value ?? "");

  if (!Number.isFinite(cents)) {
    throw new Error(`Receivables CSV row ${rowNumber} has invalid numeric value for ${column}.`);
  }

  return cents;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells.map(cell => cell.trim());
}

export function importReceivablesCsv(csvText: string): SubmissionReceivable[] {
  const lines = csvText
    .split(/\r?\n/g)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length < 2) throw new Error("Receivables CSV must include a header row and at least one data row.");

  const rawHeaders = parseCsvLine(lines[0]);
  const headers = rawHeaders.map(header => normalizeHeader(header));

  const requiredHeaders: CsvHeader[] = [
    "id",
    "obligor",
    "vehicleCount",
    "daysPastDue",
    "utilizationPct",
    "insured",
    "titleClear",
    "lockboxMatched",
  ];

  for (const requiredHeader of requiredHeaders) {
    if (!headers.includes(requiredHeader)) {
      throw new Error(`Missing required receivables CSV column: ${requiredHeader}`);
    }
  }

  if (!headers.includes("outstanding") && !headers.includes("outstandingCents")) {
    throw new Error("Receivables CSV must include either `outstanding` or `outstandingCents`.");
  }

  const seenIds = new Set<string>();

  return lines.slice(1).map((line, index) => {
    const rowNumber = index + 2;
    const values = parseCsvLine(line);
    const row = new Map<CsvHeader, string>();

    headers.forEach((header, headerIndex) => {
      if (header) row.set(header, values[headerIndex] ?? "");
    });

    const id = row.get("id") ?? "";
    const obligor = row.get("obligor") ?? "";

    if (!id || !obligor) {
      throw new Error(`Receivables CSV row ${rowNumber} is missing id or obligor.`);
    }

    if (seenIds.has(id)) {
      throw new Error(`Receivables CSV row ${rowNumber} duplicates receivable id ${id}.`);
    }

    seenIds.add(id);

    return {
      id,
      obligor,
      vehicleCount: parseRequiredNumber(row.get("vehicleCount"), "vehicleCount", rowNumber),
      outstandingCents: row.has("outstandingCents")
        ? parseRequiredNumber(row.get("outstandingCents"), "outstandingCents", rowNumber)
        : parseRequiredAmountToCents(row.get("outstanding"), "outstanding", rowNumber),
      daysPastDue: parseRequiredNumber(row.get("daysPastDue"), "daysPastDue", rowNumber),
      utilizationPct: parseRequiredNumber(row.get("utilizationPct"), "utilizationPct", rowNumber),
      insured: parseBoolean(row.get("insured") ?? ""),
      titleClear: parseBoolean(row.get("titleClear") ?? ""),
      lockboxMatched: parseBoolean(row.get("lockboxMatched") ?? ""),
      excluded: false,
      sourceRow: rowNumber,
    };
  });
}
