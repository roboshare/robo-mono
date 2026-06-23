import { eq } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "server-only";
import { getRobomataPostgresSql } from "~~/lib/robomata/server/postgres";

export type PrivySuiWalletBinding = {
  id: string;
  partnerAddress: string;
  privyUserId: string;
  walletId: string;
  suiAddress: string;
  source: "privy_embedded";
  createdAt: string;
  updatedAt: string;
  lastEnsuredAt: string;
};

type PrivyWallet = {
  id: string;
  address: string;
  chain_type: string;
  external_id?: string | null;
  owner_id?: string | null;
  public_key?: string;
};

const bindingsTable = pgTable(
  "robomata_operator_sui_wallet_bindings",
  {
    id: text("id").primaryKey(),
    partnerAddress: text("partner_address").notNull(),
    privyUserId: text("privy_user_id").notNull(),
    walletId: text("wallet_id").notNull(),
    suiAddress: text("sui_address").notNull(),
    payload: jsonb("payload").$type<PrivySuiWalletBinding>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  table => [uniqueIndex("robomata_operator_sui_wallet_bindings_privy_user_id_idx").on(table.privyUserId)],
);

type BindingStore = {
  getByPrivyUserId: (privyUserId: string) => Promise<PrivySuiWalletBinding | null>;
  upsert: (binding: PrivySuiWalletBinding) => Promise<PrivySuiWalletBinding>;
};

let ensuredPostgresTable = false;
let storeSingleton: BindingStore | null = null;
const fileStoreLocks = new Map<string, Promise<void>>();

function nowIsoString(): string {
  return new Date().toISOString();
}

function hasPostgresConfig() {
  return Boolean(process.env.POSTGRES_URL);
}

function canUseFileStore() {
  return process.env.NODE_ENV === "development";
}

function fileStorePath(): string {
  return process.env.ROBOMATA_OPERATOR_SUI_WALLETS_FILE || path.join(os.tmpdir(), "robomata-operator-sui-wallets.json");
}

async function ensurePostgresTable() {
  if (ensuredPostgresTable) return;

  const sql = getRobomataPostgresSql();
  await sql`
    CREATE TABLE IF NOT EXISTS robomata_operator_sui_wallet_bindings (
      id text PRIMARY KEY,
      partner_address text NOT NULL,
      privy_user_id text NOT NULL UNIQUE,
      wallet_id text NOT NULL,
      sui_address text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  ensuredPostgresTable = true;
}

async function readFileStore(filePath: string): Promise<PrivySuiWalletBinding[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) return [];
    return JSON.parse(raw) as PrivySuiWalletBinding[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function createFileStore(): BindingStore {
  const storePath = fileStorePath();

  const writeAll = async (bindings: PrivySuiWalletBinding[]) => {
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify(bindings, null, 2), "utf8");
  };

  const withWriteLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = fileStoreLocks.get(storePath) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = previous.then(() => new Promise<void>(resolve => (release = resolve)));
    fileStoreLocks.set(storePath, current);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (fileStoreLocks.get(storePath) === current) fileStoreLocks.delete(storePath);
    }
  };

  return {
    async getByPrivyUserId(privyUserId) {
      const bindings = await readFileStore(storePath);
      return bindings.find(binding => binding.privyUserId === privyUserId) ?? null;
    },
    async upsert(binding) {
      return withWriteLock(async () => {
        const bindings = await readFileStore(storePath);
        const next = bindings.filter(candidate => candidate.privyUserId !== binding.privyUserId);
        next.unshift(binding);
        await writeAll(next);
        return binding;
      });
    },
  };
}

function createPostgresStore(): BindingStore {
  const sql = getRobomataPostgresSql();
  const db = drizzle(sql);

  return {
    async getByPrivyUserId(privyUserId) {
      await ensurePostgresTable();
      const [row] = await db.select().from(bindingsTable).where(eq(bindingsTable.privyUserId, privyUserId));
      return row?.payload ?? null;
    },
    async upsert(binding) {
      await ensurePostgresTable();
      await db
        .insert(bindingsTable)
        .values({
          id: binding.id,
          partnerAddress: binding.partnerAddress,
          privyUserId: binding.privyUserId,
          walletId: binding.walletId,
          suiAddress: binding.suiAddress,
          payload: binding,
          createdAt: new Date(binding.createdAt),
          updatedAt: new Date(binding.updatedAt),
        })
        .onConflictDoUpdate({
          target: bindingsTable.privyUserId,
          set: {
            partnerAddress: binding.partnerAddress,
            walletId: binding.walletId,
            suiAddress: binding.suiAddress,
            payload: binding,
            updatedAt: new Date(binding.updatedAt),
          },
        });
      return binding;
    },
  };
}

function getBindingStore(): BindingStore {
  if (!storeSingleton) {
    if (!hasPostgresConfig() && !canUseFileStore()) {
      throw new Error("Robomata Privy Sui wallet bindings require POSTGRES_URL outside local development.");
    }
    storeSingleton = hasPostgresConfig() ? createPostgresStore() : createFileStore();
  }
  return storeSingleton;
}

function getPrivyAppId() {
  return process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
}

function getPrivyApiBaseUrl() {
  return process.env.PRIVY_API_BASE_URL ?? "https://api.privy.io";
}

function getPrivyAuthHeaders() {
  const appId = getPrivyAppId();
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Privy app credentials are required to provision Sui wallets.");
  }

  return {
    authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
    "content-type": "application/json",
    "privy-app-id": appId,
  };
}

function bindingId(privyUserId: string) {
  return `privy_sui_${createHash("sha256").update(privyUserId).digest("hex").slice(0, 32)}`;
}

function externalId(privyUserId: string) {
  return `robomata-sui-${createHash("sha256").update(privyUserId).digest("hex").slice(0, 32)}`;
}

function assertPrivyWallet(value: unknown): PrivyWallet {
  if (!value || typeof value !== "object") throw new Error("Privy wallet response was empty.");
  const wallet = value as Partial<PrivyWallet>;
  if (typeof wallet.id !== "string" || !wallet.id.trim()) throw new Error("Privy wallet response is missing id.");
  if (typeof wallet.address !== "string" || !wallet.address.trim()) {
    throw new Error("Privy wallet response is missing address.");
  }
  if (wallet.chain_type !== "sui") throw new Error(`Expected a Sui wallet, got ${wallet.chain_type ?? "unknown"}.`);
  return wallet as PrivyWallet;
}

async function privyRequest<T>(pathName: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getPrivyApiBaseUrl()}${pathName}`, {
    ...init,
    headers: {
      ...getPrivyAuthHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;

  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload ? String(payload.error) : response.statusText;
    throw new Error(`Privy wallet request failed: ${error}`);
  }

  return payload as T;
}

async function findPrivySuiWallet(privyUserId: string): Promise<PrivyWallet | null> {
  const params = new URLSearchParams({
    chain_type: "sui",
    external_id: externalId(privyUserId),
    limit: "1",
  });
  const byExternalId = await privyRequest<{ data?: unknown[] }>(`/v1/wallets?${params.toString()}`, { method: "GET" });
  const externalIdWallet = byExternalId.data?.[0];
  if (externalIdWallet) return assertPrivyWallet(externalIdWallet);

  const fallbackParams = new URLSearchParams({
    chain_type: "sui",
    user_id: privyUserId,
    limit: "1",
  });
  const byUser = await privyRequest<{ data?: unknown[] }>(`/v1/wallets?${fallbackParams.toString()}`, {
    method: "GET",
  });
  const userWallet = byUser.data?.[0];
  return userWallet ? assertPrivyWallet(userWallet) : null;
}

async function createPrivySuiWallet(privyUserId: string): Promise<PrivyWallet> {
  const policyId = process.env.ROBOMATA_PRIVY_SUI_WALLET_POLICY_ID?.trim();
  const payload = {
    chain_type: "sui",
    display_name: "Robomata Sui operator wallet",
    external_id: externalId(privyUserId),
    owner: { user_id: privyUserId },
    ...(policyId ? { policy_ids: [policyId] } : {}),
  };

  const created = await privyRequest<unknown>("/v1/wallets", {
    method: "POST",
    headers: { "privy-idempotency-key": externalId(privyUserId) },
    body: JSON.stringify(payload),
  });
  return assertPrivyWallet(created);
}

function toBinding(input: {
  existing?: PrivySuiWalletBinding | null;
  partnerAddress: string;
  privyUserId: string;
  wallet: PrivyWallet;
}): PrivySuiWalletBinding {
  const timestamp = nowIsoString();
  return {
    id: input.existing?.id ?? bindingId(input.privyUserId),
    partnerAddress: input.partnerAddress.toLowerCase(),
    privyUserId: input.privyUserId,
    walletId: input.wallet.id,
    suiAddress: input.wallet.address,
    source: "privy_embedded",
    createdAt: input.existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastEnsuredAt: timestamp,
  };
}

export async function ensurePrivySuiWalletBinding(input: {
  partnerAddress: string;
  privyUserId: string;
}): Promise<PrivySuiWalletBinding> {
  const store = getBindingStore();
  const existing = await store.getByPrivyUserId(input.privyUserId);

  if (existing?.walletId && existing.suiAddress) {
    const timestamp = nowIsoString();
    return store.upsert({
      ...existing,
      partnerAddress: input.partnerAddress.toLowerCase(),
      updatedAt: timestamp,
      lastEnsuredAt: timestamp,
    });
  }

  let wallet = await findPrivySuiWallet(input.privyUserId);
  wallet ??= await createPrivySuiWallet(input.privyUserId).catch(async error => {
    const racedWallet = await findPrivySuiWallet(input.privyUserId);
    if (racedWallet) return racedWallet;
    throw error;
  });

  return store.upsert(toBinding({ ...input, existing, wallet }));
}

export async function getPrivySuiWalletBinding(privyUserId: string): Promise<PrivySuiWalletBinding | null> {
  return getBindingStore().getByPrivyUserId(privyUserId);
}
