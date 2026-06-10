import "server-only";
import {
  getRobomataSuiClient,
  getRobomataSuiTimeoutMs,
  parsePositiveInteger,
} from "~~/lib/robomata/server/suiCommitConfig";

const DEFAULT_EVENT_QUERY_LIMIT = 100;
const DEFAULT_EVENT_QUERY_MAX_PAGES = 10;

function normalizeHex(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
}

function digestMatches(value: unknown, expectedDigest: string): boolean {
  const expected = normalizeHex(expectedDigest);
  if (typeof value === "string") {
    if (normalizeHex(value) === expected) return true;

    try {
      return Buffer.from(value, "base64").toString("hex") === expected;
    } catch {
      return false;
    }
  }
  if (Array.isArray(value) && value.every(item => typeof item === "number")) {
    return Buffer.from(value).toString("hex") === expected;
  }
  if (value && typeof value === "object" && "bytes" in value) {
    return digestMatches((value as { bytes: unknown }).bytes, expectedDigest);
  }
  return false;
}

function eventTxDigest(event: Record<string, unknown>): string | undefined {
  const id = event.id;
  if (id && typeof id === "object") {
    const txDigest =
      (id as { txDigest?: unknown; tx_digest?: unknown }).txDigest ?? (id as { tx_digest?: unknown }).tx_digest;
    if (typeof txDigest === "string") return txDigest;
  }
  const digest = event.digest ?? event.txDigest;
  return typeof digest === "string" ? digest : undefined;
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Sui event lookup timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function matchesCommittedEvidenceEvent(input: {
  event: Record<string, unknown>;
  facilityObjectId: string;
  label: string;
  rootDigest: string;
}): boolean {
  const parsedJson = (input.event.parsedJson ?? input.event.parsed_json) as
    | { evidence_digest?: unknown; evidence_kind?: unknown; facility_id?: unknown }
    | undefined;
  return Boolean(
    parsedJson &&
      typeof parsedJson.facility_id === "string" &&
      parsedJson.facility_id.toLowerCase() === input.facilityObjectId.toLowerCase() &&
      parsedJson.evidence_kind === input.label &&
      digestMatches(parsedJson.evidence_digest, input.rootDigest),
  );
}

export async function findCommittedEvidenceEvent(input: {
  facilityObjectId: string;
  label: string;
  rootDigest: string;
}): Promise<string | undefined> {
  const eventType = `${process.env.ROBOMATA_SUI_PACKAGE_ID}::facility::EvidenceCommitted`;
  const limit = parsePositiveInteger(process.env.ROBOMATA_SUI_EVENT_QUERY_LIMIT, DEFAULT_EVENT_QUERY_LIMIT);
  const maxPages = parsePositiveInteger(process.env.ROBOMATA_SUI_EVENT_QUERY_MAX_PAGES, DEFAULT_EVENT_QUERY_MAX_PAGES);
  let cursor: { eventSeq: string; txDigest: string } | null | undefined;
  const client = getRobomataSuiClient();

  for (let page = 0; page < maxPages; page++) {
    const payload = await withTimeout(
      signal =>
        client.queryEvents({
          query: { MoveEventType: eventType },
          cursor,
          limit,
          order: "descending",
          signal,
        }),
      getRobomataSuiTimeoutMs(),
    );
    const events = payload.data as unknown as Record<string, unknown>[];
    const match = events.find(event => matchesCommittedEvidenceEvent({ ...input, event }));
    if (match) return eventTxDigest(match);
    if (!payload.hasNextPage || !payload.nextCursor) return undefined;
    cursor = payload.nextCursor;
  }

  return undefined;
}

export async function findCommittedEvidenceEventInTransaction(input: {
  txDigest: string;
  facilityObjectId: string;
  label: string;
  rootDigest: string;
}): Promise<string | undefined> {
  const client = getRobomataSuiClient();
  const expectedEventType = `${process.env.ROBOMATA_SUI_PACKAGE_ID}::facility::EvidenceCommitted`;
  const response = await withTimeout(
    signal =>
      client
        .getTransactionBlock({
          digest: input.txDigest,
          options: { showEvents: true, showEffects: true },
          signal,
        })
        .catch(() => undefined),
    getRobomataSuiTimeoutMs(),
  );
  if (!response) return undefined;
  const status = response.effects?.status;
  if (status?.status === "failure") {
    throw new Error(
      status.error
        ? `Sui transaction ${input.txDigest} failed: ${status.error}`
        : `Sui transaction ${input.txDigest} failed before emitting EvidenceCommitted.`,
    );
  }
  const events = (response.events ?? []) as unknown as Record<string, unknown>[];
  const match = events.find(event => {
    const eventType = event.type;
    return (
      typeof eventType === "string" &&
      eventType === expectedEventType &&
      matchesCommittedEvidenceEvent({ ...input, event })
    );
  });

  return match ? input.txDigest : undefined;
}

export function isFailedSuiTransactionError(error: unknown): error is Error {
  return error instanceof Error && /^Sui transaction .+ failed/.test(error.message);
}
