import { generateWallet, generateNewAccount } from "@stacks/wallet-sdk";
import {
  makeContractCall,
  boolCV,
  stringUtf8CV,
  uintCV,
  privateKeyToAddress,
} from "@stacks/transactions";
import type { ClarityValue } from "@stacks/transactions";
import { createNetwork } from "@stacks/network";
import dotenv from "dotenv";

dotenv.config();

const STACKS_API_URL =
  process.env.STACKS_API_URL || "https://api.mainnet.hiro.so";
const DEPLOYER_ADDRESS =
  process.env.DEPLOYER_ADDRESS || "SP2X9XZZHGXMCV14WZ6FCNPH6JMR0NMASQGA3GAB1";
const TX_FEE_MICROSTX = Number(process.env.TX_FEE_MICROSTX || 800);
const HIRO_API_KEY =
  process.env.HIRO_API_KEY?.trim() || "056f204e0e3f3ca7cb60e57c123c8e24";
const HAS_HIRO_API_KEY = Boolean(HIRO_API_KEY);
const HIRO_RPM_LIMIT = Math.max(
  1,
  Number(process.env.HIRO_RPM_LIMIT || (HAS_HIRO_API_KEY ? 900 : 50)),
);
const HIRO_TARGET_UTILIZATION = Math.min(
  1,
  Math.max(0.1, Number(process.env.HIRO_TARGET_UTILIZATION || 0.8)),
);
const EFFECTIVE_RPM_BUDGET = Math.max(
  1,
  Math.floor(HIRO_RPM_LIMIT * HIRO_TARGET_UTILIZATION),
);
const MIN_DELAY_PER_REQUEST_MS = Math.ceil(60000 / EFFECTIVE_RPM_BUDGET);

const NONCE_BATCH_DELAY_MS = Math.max(
  0,
  Number(process.env.NONCE_BATCH_DELAY_MS || MIN_DELAY_PER_REQUEST_MS),
);
const BROADCAST_BATCH_DELAY_MS = Math.max(
  0,
  Number(process.env.BROADCAST_BATCH_DELAY_MS || MIN_DELAY_PER_REQUEST_MS),
);

const derivedNonceBatchSize = Math.max(
  1,
  Math.floor((EFFECTIVE_RPM_BUDGET * NONCE_BATCH_DELAY_MS) / 60000),
);
const derivedBroadcastBatchSize = Math.max(
  1,
  Math.floor((EFFECTIVE_RPM_BUDGET * BROADCAST_BATCH_DELAY_MS) / 60000),
);

const NONCE_BATCH_SIZE = Math.max(
  1,
  Number(process.env.NONCE_BATCH_SIZE || derivedNonceBatchSize),
);
const BROADCAST_BATCH_SIZE = Math.max(
  1,
  Number(process.env.BROADCAST_BATCH_SIZE || derivedBroadcastBatchSize),
);
const BROADCAST_RETRIES = Math.max(
  0,
  Number(process.env.BROADCAST_RETRIES || 3),
);
const BROADCAST_RETRY_BASE_DELAY_MS = Math.max(
  100,
  Number(process.env.BROADCAST_RETRY_BASE_DELAY_MS || 1000),
);

const network = createNetwork({
  network: "mainnet",
  client: { baseUrl: STACKS_API_URL },
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runInBatches<T, U>(
  items: T[],
  batchSize: number,
  batchDelayMs: number,
  label: string,
  handler: (item: T) => Promise<U>,
): Promise<Array<PromiseSettledResult<U>>> {
  const settled: Array<PromiseSettledResult<U>> = [];
  const totalBatches = Math.ceil(items.length / batchSize);

  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batchNumber = Math.floor(offset / batchSize) + 1;
    const batch = items.slice(offset, offset + batchSize);
    console.log(
      `${label}: batch ${batchNumber}/${totalBatches} (size ${batch.length})`,
    );

    const results = await Promise.allSettled(batch.map((item) => handler(item)));
    settled.push(...results);

    if (batchNumber < totalBatches && batchDelayMs > 0) {
      await delay(batchDelayMs);
    }
  }

  return settled;
}

async function fetchNonce(address: string): Promise<bigint> {
  const url = `${STACKS_API_URL}/extended/v1/address/${address}/nonces`;
  const response = await fetch(url, {
    headers: HAS_HIRO_API_KEY
      ? {
          "x-api-key": HIRO_API_KEY,
        }
      : undefined,
  });

  if (response.status === 404) return 0n;
  if (!response.ok) {
    const body = ((await response.text()) || "<none>").slice(0, 300);
    throw new Error(
      `Failed to fetch nonce for ${address}: ${response.status} ${response.statusText} ${body}`,
    );
  }

  const data = (await response.json()) as {
    nonce?: string | number;
    possible_next_nonce?: string | number;
  };
  if (data.possible_next_nonce !== undefined) return BigInt(data.possible_next_nonce);
  if (data.nonce !== undefined) return BigInt(data.nonce);

  throw new Error(`Unexpected nonce response for ${address}`);
}

type BroadcastResponse =
  | {
      txid: string;
    }
  | {
      error: string;
      reason: string;
    };

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const sec = Number(value);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return Math.floor(sec * 1000);
}

async function broadcastWithRetry(
  transaction: Awaited<ReturnType<typeof makeContractCall>>,
): Promise<BroadcastResponse> {
  const url = `${STACKS_API_URL}/v2/transactions`;
  let attempt = 0;
  let nextDelayMs = BROADCAST_RETRY_BASE_DELAY_MS;

  const serialized = transaction.serialize() as string | Uint8Array;
  const transactionBody =
    typeof serialized === "string"
      ? Buffer.from(serialized.replace(/^0x/i, ""), "hex")
      : Buffer.from(serialized);

  while (attempt <= BROADCAST_RETRIES) {
    attempt += 1;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          ...(HAS_HIRO_API_KEY ? { "x-api-key": HIRO_API_KEY } : {}),
        },
        body: transactionBody,
      });

      const bodyText = await response.text();

      if (response.ok) {
        let txid = bodyText.trim();
        try {
          const parsed = JSON.parse(bodyText) as { txid?: string; tx_id?: string };
          txid = parsed.txid || parsed.tx_id || txid;
        } catch {
          // keep raw text
        }
        txid = txid.replace(/^"|"$/g, "");
        return { txid };
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));

      let reason = `${response.status} ${response.statusText} ${bodyText}`
        .trim()
        .slice(0, 500);
      try {
        const parsed = JSON.parse(bodyText) as {
          error?: string;
          reason?: string;
          message?: string;
        };
        reason = String(parsed.reason || parsed.message || reason).slice(0, 500);
      } catch {
        // keep derived reason
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt <= BROADCAST_RETRIES) {
        await delay(retryAfterMs ?? nextDelayMs);
        nextDelayMs *= 2;
        continue;
      }

      return {
        error: "transaction rejected",
        reason,
      };
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
      if (attempt <= BROADCAST_RETRIES) {
        await delay(nextDelayMs);
        nextDelayMs *= 2;
        continue;
      }

      return {
        error: "broadcast exception",
        reason: message,
      };
    }
  }

  return {
    error: "broadcast exception",
    reason: "Retries exhausted",
  };
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result.trim() || "sample";
}

interface Interaction {
  contract: string;
  func: string;
  argsGen: () => ClarityValue[];
}

const CONTRACTS: { [key: string]: Omit<Interaction, "contract">[] } = {
  "community-guestbook": [
    {
      func: "create-community",
      argsGen: () => [
        stringUtf8CV(`Community ${randomString(10)}`),
        stringUtf8CV(`Description ${randomString(30)}`),
        uintCV(randomInt(1, 20)),
      ],
    },
    {
      func: "sign-guestbook",
      argsGen: () => [uintCV(randomInt(1, 30)), stringUtf8CV(`Hello ${randomString(20)}`)],
    },
    {
      func: "set-community-active",
      argsGen: () => [uintCV(randomInt(1, 30)), boolCV(Math.random() > 0.5)],
    },
    {
      func: "set-rate-limit",
      argsGen: () => [uintCV(randomInt(1, 30)), uintCV(randomInt(1, 60))],
    },
  ],
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: npx tsx script.ts <start_index> <end_index>");
    process.exit(1);
  }

  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    console.error("Missing MNEMONIC in .env");
    process.exit(1);
  }

  const startIndex = parseInt(args[0], 10);
  const endIndex = parseInt(args[1], 10);
  if (Number.isNaN(startIndex) || Number.isNaN(endIndex) || startIndex > endIndex) {
    console.error("Invalid wallet index range.");
    process.exit(1);
  }

  const walletCount = endIndex - startIndex + 1;

  console.log("Interacting with Community Guestbook (Burst Mode)...");
  console.log(`Deployer: ${DEPLOYER_ADDRESS}`);
  console.log(`Wallets: ${startIndex} - ${endIndex}`);
  console.log(`Transactions to sign: ${walletCount}`);
  console.log(`Fee per transaction: ${TX_FEE_MICROSTX} uSTX`);
  console.log(
    `Hiro quota mode: ${HAS_HIRO_API_KEY ? "authenticated" : "unauthenticated"} (${HIRO_RPM_LIMIT} RPM cap)`,
  );
  console.log(
    `Target utilization: ${Math.round(HIRO_TARGET_UTILIZATION * 100)}% (${EFFECTIVE_RPM_BUDGET} RPM)`,
  );
  console.log(`Nonce batching: size=${NONCE_BATCH_SIZE}, delay=${NONCE_BATCH_DELAY_MS}ms`);
  console.log(
    `Broadcast batching: size=${BROADCAST_BATCH_SIZE}, delay=${BROADCAST_BATCH_DELAY_MS}ms`,
  );
  console.log(`Broadcast retries: ${BROADCAST_RETRIES}`);
  console.log(`Network: ${STACKS_API_URL}`);

  const wallet = await generateWallet({
    secretKey: mnemonic,
    password: "",
  });

  let currentCount = wallet.accounts.length;
  while (currentCount <= endIndex) {
    const newWallet = await generateNewAccount(wallet);
    Object.assign(wallet, newWallet);
    currentCount = wallet.accounts.length;
  }

  const walletIndexes = Array.from({ length: walletCount }, (_, offset) => startIndex + offset);
  const selectedInteractions = walletIndexes.map((walletIndex) => {
    const account = wallet.accounts[walletIndex];
    const address = privateKeyToAddress(account.stxPrivateKey, "mainnet");

    const potentialFunctions = CONTRACTS["community-guestbook"] as Array<Omit<
      Interaction,
      "contract"
    >>;
    const randomFuncDef = potentialFunctions[randomInt(0, potentialFunctions.length - 1)] as Omit<
      Interaction,
      "contract"
    >;

    return {
      walletIndex,
      account,
      address,
      contractName: "community-guestbook",
      functionName: randomFuncDef.func,
      functionArgs: randomFuncDef.argsGen(),
    };
  });

  console.log(`Prepared ${selectedInteractions.length} transaction intents.`);
  console.log("Fetching nonces in controlled batches...");

  const noncesByWalletIndex = new Map<number, bigint>();

  const nonceResults = await runInBatches(
    selectedInteractions,
    NONCE_BATCH_SIZE,
    NONCE_BATCH_DELAY_MS,
    "Nonce fetch",
    async ({ walletIndex, address }) => {
      const nonce = await fetchNonce(address);
      noncesByWalletIndex.set(walletIndex, nonce);
    },
  );

  const nonceFailures = nonceResults.filter((result) => result.status === "rejected").length;

  const signTargets = selectedInteractions.filter(({ walletIndex }) => noncesByWalletIndex.has(walletIndex));

  console.log(`Signing ${signTargets.length} transaction(s)...`);

  const signedResults = await Promise.allSettled(
    signTargets.map(async (target) => {
      const transaction = await makeContractCall({
        contractAddress: DEPLOYER_ADDRESS,
        contractName: target.contractName,
        functionName: target.functionName,
        functionArgs: target.functionArgs,
        senderKey: target.account.stxPrivateKey,
        network,
        nonce: noncesByWalletIndex.get(target.walletIndex) as bigint,
        fee: TX_FEE_MICROSTX,
      });

      return {
        ...target,
        transaction,
      };
    }),
  );

  const signedPayloads = signedResults
    .filter((result): result is PromiseFulfilledResult<(typeof signTargets)[number] & { transaction: Awaited<ReturnType<typeof makeContractCall>> }> => result.status === "fulfilled")
    .map((result) => result.value);

  const signFailures = signedResults.length - signedPayloads.length;

  console.log(`Broadcasting ${signedPayloads.length} transaction(s) in batches...`);

  const broadcastResults = await runInBatches(
    signedPayloads,
    BROADCAST_BATCH_SIZE,
    BROADCAST_BATCH_DELAY_MS,
    "Broadcast",
    async (payload) => {
      const response = await broadcastWithRetry(payload.transaction);
      return {
        ...payload,
        response,
      };
    },
  );

  let successCount = 0;
  let broadcastFailureCount = 0;

  for (const result of broadcastResults) {
    if (result.status === "rejected") {
      broadcastFailureCount += 1;
      console.error(`BROADCAST ERROR: ${String(result.reason)}`);
      continue;
    }

    const { walletIndex, contractName, functionName, response } = result.value;
    if ("error" in response) {
      broadcastFailureCount += 1;
      console.error(
        `[${walletIndex}] ${contractName}.${functionName} FAILED: ${response.error} - ${response.reason}`,
      );
      continue;
    }

    successCount += 1;
    console.log(`[${walletIndex}] ${contractName}.${functionName} SUCCESS: ${response.txid}`);
  }

  console.log("Burst complete.");
  console.log(`Requested: ${walletCount}`);
  console.log(`Signed: ${signedPayloads.length}`);
  console.log(`Broadcast success: ${successCount}`);
  console.log(
    `Failures: nonce=${nonceFailures}, sign=${signFailures}, broadcast=${broadcastFailureCount}`,
  );
}

main().catch(console.error);
