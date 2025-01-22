/**
 * single-snipe.ts
 * 
 * Purpose:
 *  - Listens for new Meteora DYNAMIC-AMM pool creation transactions
 *  - Checks if the new pool is (TARGET_TOKEN–SOL) or (TARGET_TOKEN–USDC)
 *  - If so, automatically snipe it with a user-defined SOL amount
 */
import WebSocket from "ws";
import { 
  Connection, 
  Keypair, 
  LAMPORTS_PER_SOL, 
  PublicKey, 
  VersionedTransactionResponse 
} from "@solana/web3.js";
import bs58 from "bs58";
import { BN } from "bn.js";
import DynamicAmm from "@mercurial-finance/dynamic-amm-sdk";
import { createAndSendV0Tx } from "../meteora/execute-txns"; 
// ^ adjust the import path if necessary
import { loadEnv } from "../utils/load-env";
import { connection } from "../helpers/config";

loadEnv();

// Hardcode or read from .env
const TARGET_TOKEN_ADDRESS = process.env.TARGET_TOKEN_ADDRESS || "";
if (!TARGET_TOKEN_ADDRESS) {
  console.error("❌ Please set TARGET_TOKEN_ADDRESS in .env or pass via CLI");
  process.exit(1);
}

// Constants for Meteora, USDC, SOL, etc.
const SOL_MINT_STR = "So11111111111111111111111111111111111111112";
const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8g4wEGGkZwyTDt1v";
const DYNAMIC_AMM_PROGRAM_ID = new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");

// Basic snipe config
const sniperKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.SWAP_PRIVATE_KEY!)
);

const SETTINGS = {
  swapAmountInSOL: 0.1,         // how much SOL to buy with
  swapAmountInUSDC: 10,         // how much USDC to buy with
  minLiquidityInSOL: 0.1,       // skip pool if it has < 0.1 SOL
  maxPriceImpact: 100,          // skip if price impact > 100%
  slippageBps: 10000            // 100% slippage
};

interface HeliusTxNotification {
  signature: string;
  slot: number;
}

interface HeliusNotificationMessage {
  jsonrpc: string;
  method: string;
  params?: {
    subscription: number;
    result: HeliusTxNotification;
  };
  result?: number;
}

export async function singleSnipe() {
  if (!process.env.HELIUS_API_KEY) {
    console.error("❌ Missing HELIUS_API_KEY in .env");
    process.exit(1);
  }

  console.log("🚀 Single-snipe mode for target token:", TARGET_TOKEN_ADDRESS);
  console.log("Wallet:", sniperKeypair.publicKey.toBase58());
  console.log("Will watch for new dynamic-amm pools containing", TARGET_TOKEN_ADDRESS, "paired with SOL or USDC.");

  // Connect to Helius
  const socketUrl = `wss://atlas-mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  console.log("Connecting to:", socketUrl.replace(process.env.HELIUS_API_KEY, "HIDDEN"));
  const ws = new WebSocket(socketUrl);

  // Timeout if no connection after 5s
  const connectionTimeout = setTimeout(() => {
    console.error("❌ WebSocket connection timed out (5s)");
    ws.close();
    process.exit(1);
  }, 5000);

  ws.on("open", () => {
    clearTimeout(connectionTimeout);
    console.log("✅ WebSocket connected");

    // Subscribe to transactions referencing the dynamic-amm program
    const subscriptionReq = {
      jsonrpc: "2.0",
      id: "target-snipe",
      method: "transactionSubscribe",
      params: [
        {
          accountInclude: [DYNAMIC_AMM_PROGRAM_ID.toBase58()],
          type: "any",
          commitment: "confirmed",
          encoding: "jsonParsed",
          transactionDetails: "full",
          showRewards: false,
          maxSupportedTransactionVersion: 0
        }
      ]
    };
    ws.send(JSON.stringify(subscriptionReq));
    console.log("Listening for new dynamic-amm transactions...");
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString("utf8")) as HeliusNotificationMessage;

      // If subscription confirm
      if (msg.result && typeof msg.result === "number") {
        console.log("Subscription confirmed with ID:", msg.result);
        return;
      }

      // If a new "transactionNotification" 
      if (msg.method === "transactionNotification" && msg.params?.result) {
        const { signature, slot } = msg.params.result;
        console.log(`\n🆕 Detected new transaction at slot ${slot}: ${signature}`);

        // Fetch from normal RPC
        const txDetails = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        });
        if (!txDetails) {
          console.log("No tx details found yet. Possibly in progress. Skipping...");
          return;
        }

        await analyzeTx(signature, txDetails);
        return;
      }

      console.log("⚠️ Unhandled message type:", msg);
    } catch (err) {
      console.error("Error handling message:", err);
    }
  });

  ws.on("error", (err) => {
    clearTimeout(connectionTimeout);
    console.error("❌ WebSocket error:", err);
    process.exit(1);
  });

  ws.on("close", () => {
    console.log("❌ WebSocket closed. Exiting...");
    process.exit(0);
  });
}

async function analyzeTx(signature: string, tx: VersionedTransactionResponse) {
  // If tx failed
  if (tx.meta?.err) {
    console.log("❌ Tx failed. Sig=", signature);
    return;
  }

  // Check if it references the dynamic-amm program
  const allIxs = tx.transaction.message.compiledInstructions;
  const programIdIndexes = tx.transaction.message.staticAccountKeys;
  const relevantIxs = allIxs.filter(ix => 
    programIdIndexes[ix.programIdIndex].equals(DYNAMIC_AMM_PROGRAM_ID)
  );

  if (!relevantIxs.length) {
    console.log("No dynamic-amm instructions found in tx");
    return;
  }

  // Let's see if it might be a new pool creation
  // A simpler approach: we just scan all created accounts for a valid pool
  const newPool = await findNewPoolCandidate(tx);
  if (!newPool) {
    console.log("No valid newly created pool found in tx");
    return;
  }

  // Double-check that it is indeed a SOL or USDC + target token
  const dynamicPool = await DynamicAmm.create(connection, newPool);
  const { tokenAMint, tokenBMint, poolInfo } = dynamicPool;

  const mintA = tokenAMint.address.toBase58();
  const mintB = tokenBMint.address.toBase58();

  // We want either:
  //   (mintA === TARGET_TOKEN && mintB === SOL/USDC) OR
  //   (mintA === SOL/USDC && mintB === TARGET_TOKEN)
  const includesTarget = mintA === TARGET_TOKEN_ADDRESS || mintB === TARGET_TOKEN_ADDRESS;
  if (!includesTarget) {
    console.log("New pool does not contain target token:", TARGET_TOKEN_ADDRESS);
    return;
  }
  const includesSolOrUsdc =
    mintA === SOL_MINT_STR || mintB === SOL_MINT_STR ||
    mintA === USDC_MINT_STR || mintB === USDC_MINT_STR;
  if (!includesSolOrUsdc) {
    console.log("New pool does not contain SOL/USDC. Skipping.");
    return;
  }

  // Check basic liquidity
  const tokenAAmount = poolInfo.tokenAAmount;
  const tokenBAmount = poolInfo.tokenBAmount;

  let solEquivalent = 0;
  if (mintA === SOL_MINT_STR) {
    solEquivalent = tokenAAmount.toNumber() / 1e9;
  } else if (mintB === SOL_MINT_STR) {
    solEquivalent = tokenBAmount.toNumber() / 1e9;
  } else {
    // if USDC is the other side, you might convert USDC to SOL with some rough ratio
    const usdcSide = mintA === USDC_MINT_STR ? tokenAAmount : tokenBAmount;
    // do a rough estimate, e.g. 1 USDC ~ 1/20 SOL
    solEquivalent = (usdcSide.toNumber() / 1e6) / 20; 
  }

  if (solEquivalent < SETTINGS.minLiquidityInSOL) {
    console.log(`Pool liquidity < ${SETTINGS.minLiquidityInSOL} SOL eq. Skipping.`);
    return;
  }

  // If we get here, let's attempt the snipe
  console.log(`✅ Found new pool with target token. Attempting snipe of ${SETTINGS.swapAmountInSOL} SOL...`);
  await snipePool(dynamicPool);
}

async function findNewPoolCandidate(tx: VersionedTransactionResponse): Promise<PublicKey | null> {
  // For each account key that was written to in the transaction, 
  // attempt to create a dynamic-amm instance. If it's valid & has .poolInfo, return it.
  const acctKeys = tx.transaction.message.staticAccountKeys;
  // we can also check "postTokenBalances" or "postBalances" for newly created accounts
  // but let's just brute force for demonstration
  for (const key of acctKeys) {
    try {
      const maybePool = await DynamicAmm.create(connection, key);
      if (maybePool?.poolInfo) {
        console.log("Found newly created dynamic-amm pool account:", key.toBase58());
        return key;
      }
    } catch {
      // not a valid pool
    }
  }
  return null;
}

async function snipePool(dynamicPool: any) {
  try {
    const { tokenAMint, tokenBMint, poolInfo } = dynamicPool;
    const mintA = tokenAMint.address.toString();
    const mintB = tokenBMint.address.toString();

    // Decide swap direction 
    let inMint = mintA;
    let outMint = mintB;
    // If the target token is "B", then we do SOL/USDC -> B
    const isSolA = mintA === SOL_MINT_STR;
    const isUsdcA = mintA === USDC_MINT_STR;
    if (isSolA || isUsdcA) {
      // so we do A -> B
      inMint = mintA;
      outMint = mintB;
    } else {
      // B is SOL/USDC, so B -> A
      inMint = mintB;
      outMint = mintA;
    }

    // Calculate buy amount based on whether we're using SOL or USDC
    let buyLamports;
    if (inMint === SOL_MINT_STR) {
      // If using SOL, convert to lamports
      buyLamports = new BN(Math.floor(SETTINGS.swapAmountInSOL * LAMPORTS_PER_SOL));
      console.log(`Using ${SETTINGS.swapAmountInSOL} SOL for swap`);
    } else {
      // If using USDC, convert to USDC decimals (6)
      buyLamports = new BN(Math.floor(SETTINGS.swapAmountInUSDC * 1_000_000));
      console.log(`Using ${SETTINGS.swapAmountInUSDC} USDC for swap`);
    }

    const quote = dynamicPool.getSwapQuote(
      new PublicKey(inMint),
      buyLamports,
      SETTINGS.slippageBps
    );
    const priceImpact = Number(quote.priceImpact) || 0;
    if (priceImpact > SETTINGS.maxPriceImpact) {
      console.log(`Price impact too high: ${priceImpact}% > ${SETTINGS.maxPriceImpact}%`);
      return;
    }

    // build the swap
    const swapTx = await dynamicPool.swap(
      sniperKeypair.publicKey,
      new PublicKey(inMint),
      buyLamports,
      quote.minSwapOutAmount
    );

    // sign & send
    await createAndSendV0Tx({
      connection,
      ix: swapTx.instructions,
      signers: [sniperKeypair],
      computeUnits: 200_000,
      fixedPriorityFee: true,
      minPriorityFee: 1_000_000
    });

    console.log("✅ Snipe transaction success!");
    // if you want to exit after a single snipe, do so:
    process.exit(0);
  } catch (err) {
    console.error("Snipe error:", err);
  }
}

if (require.main === module) {
  singleSnipe();
}
