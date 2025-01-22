/**
 * find-usdc-pools.ts
 *
 * 1) Queries Meteora's DLMM API for any pools containing both TARGET_TOKEN + USDC
 * 2) Scans on-chain for Dynamic Pools (program = 'Eo7WjKq...'), checking if the
 *    pool is valid and contains TARGET_TOKEN + USDC.
 *
 * Usage:
 *   ts-node find-usdc-pools.ts
 */

import fetch from "cross-fetch";
import {
  Connection,
  PublicKey,
  AccountInfo,
} from "@solana/web3.js";
import DynamicAmm from "@mercurial-finance/dynamic-amm-sdk";  // npm install @mercurial-finance/dynamic-amm-sdk

// -------------------- Configuration --------------------

// The mint address for USDC on Solana
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8g4wEGGkZwyTDt1v";

// The target token you want to find pools for
const TARGET_TOKEN = "C9KDEUqxYkFdgzT4T2T2NFPUfENWWJdLN1qXUJXg7dtF";

// DLMM pool listing endpoint
// (You can tweak query params like sort_key, order_by, etc.)
const DLMM_API_URL = (searchTerm: string) =>
  `https://dlmm-api.meteora.ag/pair/all_by_groups?sort_key=tvl&order_by=desc&search_term=${searchTerm}&include_unknown=false`;

// Program ID for dynamic-amm
const DYNAMIC_AMM_PROGRAM_ID = new PublicKey(
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"
);

// Choose a connection endpoint (e.g. mainnet-beta)
const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=e7a0fa4f-35a0-44b0-abcc-67b82875b2df";
const connection = new Connection(RPC_ENDPOINT, "confirmed");

// -------------------------------------------------------

interface DlmmApiResponse {
  groups: Array<{
    pairs: Array<{
      address: string;
      tokenXMint: string;
      tokenYMint: string;
      name?: string;
    }>;
  }>;
}

/**
 * 1) Find any DLMM pools from the public API that contain both USDC and TARGET_TOKEN.
 */
async function findDlmmPoolsWithUsdc(): Promise<any[]> {
  const url = DLMM_API_URL(TARGET_TOKEN);
  console.log(`\n[DLMM] Requesting: ${url}`);

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`DLMM API HTTP Error ${resp.status}`);
  }

  const data = await resp.json() as DlmmApiResponse;
  const groups = data.groups || [];
  if (!groups.length) {
    return [];
  }

  const results: any[] = [];
  for (const g of groups) {
    const pairs = g.pairs || [];
    for (const pair of pairs) {
      const setOfMints = new Set([pair.tokenXMint, pair.tokenYMint]);
      if (setOfMints.has(USDC_MINT) && setOfMints.has(TARGET_TOKEN)) {
        results.push(pair);
      }
    }
  }
  return results;
}

/**
 * 2) Enumerate all accounts owned by the Dynamic AMM program. 
 *    Try to parse each as a valid dynamic pool; if it has both USDC & TARGET_TOKEN, record it.
 *
 *    - This can be time-consuming if the program has many accounts.
 *    - Adjust filters or concurrency as needed.
 */
async function findDynamicPoolsWithUsdc(): Promise<PublicKey[]> {
  console.log(`\n[Dynamic] Scanning on-chain for program = ${DYNAMIC_AMM_PROGRAM_ID.toBase58()}`);

  // Optionally, we can do a getProgramAccounts with a dataSize filter if we know the expected account size.
  // For demonstration, we do no filters. Large calls can be slow! 
  // If you know the exact size or prefix, you can do something like:
  //   { dataSize: 736 } // (example only)
  const accounts = await connection.getProgramAccounts(DYNAMIC_AMM_PROGRAM_ID);
  console.log(`[Dynamic] Found ${accounts.length} accounts under the dynamic-amm program`);

  const matchingPools: PublicKey[] = [];

  for (const acct of accounts) {
    const poolPubkey = acct.pubkey;
    try {
      // Attempt to parse a dynamic-amm pool
      const dynamicPool = await DynamicAmm.create(connection, poolPubkey);
      const poolInfo = dynamicPool.poolInfo;
      // If no poolInfo, skip
      if (!poolInfo) {
        continue;
      }
      // Check if pool has both USDC and TARGET_TOKEN
      const mintA = dynamicPool.tokenAMint.address.toString();
      const mintB = dynamicPool.tokenBMint.address.toString();

      const hasUsdc = (mintA === USDC_MINT || mintB === USDC_MINT);
      const hasTarget = (mintA === TARGET_TOKEN || mintB === TARGET_TOKEN);

      if (hasUsdc && hasTarget) {
        matchingPools.push(poolPubkey);
      }
    } catch (err) {
      // Not a valid pool or parse error
      // console.log(`Skipping ${poolPubkey.toBase58()}`, err);
      continue;
    }
  }

  return matchingPools;
}

// Main
(async () => {
  try {
    // 1) Check DLMM
    const dlmmResults = await findDlmmPoolsWithUsdc();
    if (dlmmResults.length) {
      console.log(`[DLMM] Found ${dlmmResults.length} pool(s) with USDC + ${TARGET_TOKEN}:`);
      for (const p of dlmmResults) {
        console.log(` - Pair Address: ${p.address}, name: ${p.name || "N/A"}`);
      }
    } else {
      console.log(`[DLMM] No USDC pools found for token: ${TARGET_TOKEN}`);
    }

    // 2) Check dynamic pools on-chain
    const dynamicMatches = await findDynamicPoolsWithUsdc();
    if (dynamicMatches.length) {
      console.log(`[Dynamic] Found ${dynamicMatches.length} pool(s) containing USDC + ${TARGET_TOKEN}:`);
      for (const pubkey of dynamicMatches) {
        console.log(` - Pool Account: ${pubkey.toBase58()}`);
      }
    } else {
      console.log(`[Dynamic] No USDC pools found on-chain for token: ${TARGET_TOKEN}`);
    }

  } catch (err) {
    console.error("Error:", err);
  }
})();
