#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webDir, "..");
const port = process.env.ROBOMATA_TOKENIZATION_API_TEST_PORT ?? "3221";
const baseUrl = `http://127.0.0.1:${port}`;
const serverTimeoutMs = Number.parseInt(process.env.ROBOMATA_TOKENIZATION_API_TEST_SERVER_TIMEOUT_MS ?? "90000", 10);
const requestTimeoutMs = Number.parseInt(process.env.ROBOMATA_TOKENIZATION_API_TEST_REQUEST_TIMEOUT_MS ?? "45000", 10);
const chainId = "31337";
const rootDigest = "0x1111111111111111111111111111111111111111111111111111111111111111";
const fakeRegistryAddress = "0x2222222222222222222222222222222222222222";
const fakeTxHash = "0x3333333333333333333333333333333333333333333333333333333333333333";

let serverProcess;
let tempDir;

function nowIso() {
  return new Date().toISOString();
}

function createAccount() {
  return privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
}

async function assertPortAvailable() {
  const numericPort = Number.parseInt(port, 10);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`ROBOMATA_TOKENIZATION_API_TEST_PORT must be a valid port, got ${port}.`);
  }

  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", error => {
      if (error?.code === "EADDRINUSE") {
        reject(new Error(`ROBOMATA_TOKENIZATION_API_TEST_PORT ${port} is already in use.`));
        return;
      }
      reject(error);
    });
    probe.listen(numericPort, "127.0.0.1", () => {
      probe.close(resolve);
    });
  });
}

async function waitForServer() {
  const deadline = Date.now() + serverTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/robomata/submissions`);
      if (response.ok) return;
    } catch {
      // Keep polling until the local dev server is ready.
    }

    if (serverProcess.exitCode !== null) {
      throw new Error(`Tokenization API test server exited early with code ${serverProcess.exitCode}.`);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for tokenization API test server on ${baseUrl}.`);
}

async function startServer(env) {
  await assertPortAvailable();
  serverProcess = spawn("yarn", ["start"], {
    cwd: repoRoot,
    detached: true,
    env,
    stdio: "ignore",
  });
  await waitForServer();
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const pid = serverProcess.pid;
  if (!pid) return;
  const exited = new Promise(resolve => serverProcess.once("exit", resolve));
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    serverProcess.kill("SIGTERM");
  }
  const cleanExit = await Promise.race([
    exited.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5000)),
  ]);
  if (cleanExit) return;

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    serverProcess.kill("SIGKILL");
  }
  await exited;
}

function authHeaderBuilder({ account, partnerAddress }) {
  return async function authHeaders(method, requestPath, extra = {}) {
    const timestamp = Date.now().toString();
    const signerAddress = account.address;
    const message = [
      "Robomata FacilitySubmission API access",
      `Method: ${method}`,
      `Path: ${requestPath}`,
      `Chain: ${chainId}`,
      `Partner: ${partnerAddress.toLowerCase()}`,
      `Signer: ${signerAddress.toLowerCase()}`,
      `Timestamp: ${timestamp}`,
    ].join("\n");
    const signature = await account.signMessage({ message });

    return {
      ...extra,
      "x-robomata-chain-id": chainId,
      "x-robomata-auth-method": method,
      "x-robomata-auth-path": requestPath,
      "x-robomata-partner-address": partnerAddress,
      "x-robomata-signer-address": signerAddress,
      "x-robomata-auth-signature": signature,
      "x-robomata-auth-timestamp": timestamp,
    };
  };
}

async function fetchJsonResponse(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const payload = text.trim() ? JSON.parse(text) : {};
    return { payload, response };
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson({ authHeaders, requestPath, body = {} }) {
  const { payload, response } = await fetchJsonResponse(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: await authHeaders("POST", requestPath, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${requestPath} failed ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function expectPostJsonError({ authHeaders, requestPath, body = {}, status, message }) {
  const { payload, response } = await fetchJsonResponse(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: await authHeaders("POST", requestPath, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (response.status !== status) {
    throw new Error(`${requestPath} expected ${status}, got ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (message && !String(payload.error ?? "").includes(message)) {
    throw new Error(`${requestPath} expected error containing "${message}", got ${JSON.stringify(payload)}`);
  }
  return payload;
}

function baseSubmission({ id, partnerAddress, committed, openException }) {
  const timestamp = nowIso();
  const evidenceCommit = committed
    ? {
        status: "committed",
        evidenceRoot: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rootDigest,
        txDigest: "B7Vf7jkxUFe9TQ2i3aXzkSZ3oJHhQaq2fLaoN1zreTQa",
        facilityObjectId: "0xfacility",
        facilityOperatorAddress: "0xsuioperator",
        modulePath: "protocols/sui::robomata_overflow::facility::commit_evidence",
        commitMode: "configured",
      }
    : {
        status: "ready",
        evidenceRoot: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rootDigest,
        modulePath: "protocols/sui::robomata_overflow::facility::commit_evidence",
        commitMode: "configured",
      };

  return {
    id,
    partnerAddress,
    operatorName: "Private Operator Name",
    facilityName: "Tokenization API Facility",
    asOfDate: "2026-06-10",
    status: committed ? "committed" : "ready_for_lender",
    receivables: [
      {
        id: "AR-SECRET-1",
        obligor: "Secret Borrower LLC",
        vehicleCount: 3,
        outstandingCents: 12500000,
        daysPastDue: 0,
        utilizationPct: 80,
        insured: true,
        titleClear: true,
        lockboxMatched: true,
        excluded: false,
        sourceRow: 2,
      },
    ],
    evidence: [
      {
        id: "ev_secret",
        filename: "private-evidence.pdf",
        contentType: "application/pdf",
        sizeBytes: 12,
        uploadedAt: timestamp,
        scope: "Receivables",
        linkedReceivableIds: ["AR-SECRET-1"],
        storageBackend: "walrus-mock",
        encryptionBackend: "none",
        walrusBlobId: "mock-blob",
        digest: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        plaintextDigest: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    ],
    exceptions: openException
      ? [
          {
            id: "exc_open",
            kind: "submission",
            itemId: "AR-SECRET-1",
            severity: "high",
            title: "Open blocker",
            message: "Resolve before tokenization.",
            nextAction: "Resolve blocker",
            actionStatus: "open",
          },
        ]
      : [],
    computation: {
      computedAt: timestamp,
      borrowingBase: {
        grossReceivablesCents: 12500000,
        eligibleReceivablesCents: 12500000,
        availableBorrowingBaseCents: 10000000,
        exceptionCount: openException ? 1 : 0,
        portfolio: { advanceRateBps: 8000 },
      },
      agentReview: {},
      lenderPacket: {},
      evidenceAnchor: {},
      evidenceRail: {},
    },
    evidenceCommit,
    tokenization: {
      status: "not_started",
      anchors: {},
      terms: {},
      evm: {},
    },
    auditEvents: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function seedStore({ storeFile, partnerAddress }) {
  const submissions = [
    baseSubmission({ id: "sub_tokenization_eligible", partnerAddress, committed: true, openException: false }),
    baseSubmission({ id: "sub_tokenization_not_committed", partnerAddress, committed: false, openException: false }),
    baseSubmission({ id: "sub_tokenization_open_exception", partnerAddress, committed: true, openException: true }),
  ];
  await writeFile(storeFile, JSON.stringify(submissions, null, 2), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runTokenizationApiAssertions({ authHeaders, otherAuthHeaders }) {
  await expectPostJsonError({
    authHeaders,
    requestPath: "/api/robomata/submissions/sub_tokenization_not_committed/tokenization/draft",
    status: 409,
    message: "Commit evidence",
  });
  await expectPostJsonError({
    authHeaders,
    requestPath: "/api/robomata/submissions/sub_tokenization_open_exception/tokenization/draft",
    status: 409,
    message: "Resolve open exceptions",
  });
  await expectPostJsonError({
    authHeaders: otherAuthHeaders,
    requestPath: "/api/robomata/submissions/sub_tokenization_eligible/tokenization/draft",
    status: 404,
    message: "Submission not found",
  });

  const draft = await postJson({
    authHeaders,
    requestPath: "/api/robomata/submissions/sub_tokenization_eligible/tokenization/draft",
  });
  assert(draft.submission.tokenization.status === "draft", "Draft endpoint did not persist draft status.");
  assert(
    draft.submission.tokenization.terms.offeringLimitCents === 10000000,
    "Draft endpoint did not default offering limit to available borrowing base.",
  );

  const terms = await postJson({
    authHeaders,
    requestPath: "/api/robomata/submissions/sub_tokenization_eligible/tokenization/terms",
    body: { offeringLimitCents: 999999999, tokenPrice: 1, maturityMonths: 24 },
  });
  assert(terms.capped === true, "Terms endpoint did not report capping.");
  assert(
    terms.submission.tokenization.terms.offeringLimitCents === 10000000,
    "Terms endpoint did not cap offering limit at available borrowing base.",
  );

  const prepared = await postJson({
    authHeaders,
    requestPath: "/api/robomata/submissions/sub_tokenization_eligible/tokenization/prepare",
  });
  assert(prepared.submission.tokenization.status === "ready_to_sign", "Prepare did not persist ready_to_sign.");
  assert(prepared.assetMetadataUri?.startsWith("ipfs://mock-tokenization-"), "Prepare did not use mock IPFS URI.");
  assert(
    prepared.revenueTokenMetadataUri?.startsWith("ipfs://mock-tokenization-"),
    "Prepare did not use mock IPFS URI.",
  );
  const publicMetadata = JSON.stringify({
    assetMetadata: prepared.assetMetadata,
    revenueTokenMetadata: prepared.revenueTokenMetadata,
  });
  assert(!publicMetadata.includes("Secret Borrower LLC"), "Prepared metadata leaked raw receivable obligor data.");
  assert(!publicMetadata.includes("private-evidence.pdf"), "Prepared metadata leaked private evidence filename.");
  assert(
    prepared.evmCall.functionName === "registerAssetAndCreateRevenueTokenPool",
    "Prepare returned wrong EVM call.",
  );

  await expectPostJsonError({
    authHeaders,
    requestPath: "/api/robomata/submissions/sub_tokenization_eligible/tokenization/complete",
    status: 500,
    message: "revenueTokenId",
    body: {
      registryAddress: fakeRegistryAddress,
      assetId: "41",
      txHash: fakeTxHash,
      assetMetadataUri: prepared.assetMetadataUri,
      revenueTokenMetadataUri: prepared.revenueTokenMetadataUri,
    },
  });

  const completed = await postJson({
    authHeaders,
    requestPath: "/api/robomata/submissions/sub_tokenization_eligible/tokenization/complete",
    body: {
      registryAddress: fakeRegistryAddress,
      assetId: "41",
      revenueTokenId: "42",
      txHash: fakeTxHash,
      assetMetadataUri: prepared.assetMetadataUri,
      revenueTokenMetadataUri: prepared.revenueTokenMetadataUri,
    },
  });
  assert(
    completed.submission.tokenization.status === "offering_created",
    "Complete did not persist offering_created status.",
  );
  assert(completed.submission.tokenization.evm.assetId === "41", "Complete did not persist asset id.");
  assert(completed.submission.tokenization.evm.revenueTokenId === "42", "Complete did not persist revenue token id.");
  assert(completed.submission.tokenization.evm.txHash === fakeTxHash, "Complete did not persist tx hash.");

  await expectPostJsonError({
    authHeaders,
    requestPath: "/api/robomata/submissions/sub_tokenization_eligible/tokenization/draft",
    status: 409,
    message: "already completed",
  });

  return {
    draftStatus: draft.submission.tokenization.status,
    preparedStatus: prepared.submission.tokenization.status,
    completedStatus: completed.submission.tokenization.status,
    assetId: completed.submission.tokenization.evm.assetId,
    revenueTokenId: completed.submission.tokenization.evm.revenueTokenId,
  };
}

async function main() {
  const partnerAccount = createAccount();
  const otherAccount = createAccount();
  tempDir = await mkdtemp(path.join(tmpdir(), "robomata-tokenization-api-test-"));
  const storeFile = path.join(tempDir, "submissions.json");
  await seedStore({ storeFile, partnerAddress: partnerAccount.address });

  const baseEnv = {
    ...process.env,
    POSTGRES_URL: "",
    POSTGRES_URL_NON_POOLING: "",
    DATABASE_URL: "",
    PORT: port,
    NEXT_PUBLIC_ENABLE_ROBOMATA_WORKFLOW: "true",
    ROBOMATA_WORKFLOW_ENABLED: "true",
    ROBOMATA_WORKFLOW_MUTATIONS_ENABLED: "true",
    ROBOMATA_TOKENIZATION_ENABLED: "true",
    NEXT_PUBLIC_ROBOMATA_TOKENIZATION_ENABLED: "true",
    ROBOMATA_TOKENIZATION_MOCK_COMPLETION_VERIFICATION_ENABLED: "true",
    ROBOMATA_TOKENIZATION_MOCK_METADATA_ENABLED: "true",
    ROBOMATA_TOKENIZATION_MOCK_REGISTRY_ADDRESS: fakeRegistryAddress,
    ROBOMATA_AUTHORIZED_PARTNER_ADDRESSES: `${partnerAccount.address},${otherAccount.address}`,
    ROBOMATA_SUBMISSIONS_FILE: storeFile,
  };

  await startServer(baseEnv);
  const result = await runTokenizationApiAssertions({
    authHeaders: authHeaderBuilder({ account: partnerAccount, partnerAddress: partnerAccount.address }),
    otherAuthHeaders: authHeaderBuilder({ account: otherAccount, partnerAddress: otherAccount.address }),
  });

  const savedSubmissions = JSON.parse(await readFile(storeFile, "utf8"));
  const completedSubmission = savedSubmissions.find(submission => submission.id === "sub_tokenization_eligible");
  assert(
    completedSubmission?.tokenization?.status === "offering_created",
    "File store did not persist completed tokenization status.",
  );

  console.log(JSON.stringify({ ...result, storeFile }, null, 2));
}

try {
  await main();
} finally {
  await stopServer();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}
