import WebSocket from "ws";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransactionResponse,
  MessageCompiledInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { BN } from "bn.js";
import { loadEnv } from "../utils/load-env";
import { connection } from "../helpers/config";
import DynamicAmm from "@mercurial-finance/dynamic-amm-sdk";
import { createAndSendV0Tx } from "./execute-txns2";

// Constants for token mints we're interested in
const SOL_MINT_STR = "So11111111111111111111111111111111111111112";
const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8g4wEGGkZwyTDt1v";
export const DYNAMIC_AMM_PROGRAM_ID = new PublicKey(
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"
);

// Sniper key
const sniperKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.SWAP_PRIVATE_KEY!)
);

// Settings
const SETTINGS = {
  swapAmountInSOL: process.env.SNIPER_AMOUNT_SOL
    ? parseFloat(process.env.SNIPER_AMOUNT_SOL)
    : 0.1,
  minLiquidityInSOL: process.env.MIN_LIQUIDITY_SOL
    ? parseFloat(process.env.MIN_LIQUIDITY_SOL)
    : 0.5,
  maxPriceImpact: process.env.MAX_PRICE_IMPACT
    ? parseFloat(process.env.MAX_PRICE_IMPACT)
    : 50,
  slippageBps: process.env.SLIPPAGE_BPS
    ? parseInt(process.env.SLIPPAGE_BPS)
    : 10000,
};

/**
 * Entry point
 */
export function meteoraSuperSniper() {
  // Basic validation
  if (!process.env.HELIUS_API_KEY) {
    console.error("❌ Error: HELIUS_API_KEY not found");
    process.exit(1);
  }

  console.log("\nStarting super-sniper with rummaging approach, settings:");
  console.log(`Swap amount: ${SETTINGS.swapAmountInSOL} SOL`);
  console.log(`Min liquidity: ${SETTINGS.minLiquidityInSOL} SOL`);
  console.log(`Max price impact: ${SETTINGS.maxPriceImpact}%`);
  console.log(`Slippage: ${SETTINGS.slippageBps / 100}%`);
  console.log("Wallet:", sniperKeypair.publicKey.toBase58());

  const socketUrl = `wss://atlas-mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  console.log("Connecting to Helius WebSocket at:", socketUrl.replace(process.env.HELIUS_API_KEY!, "HIDDEN"));

  const ws = new WebSocket(socketUrl);

  // Timeout after 5s if no connection
  const connectionTimeout = setTimeout(() => {
    console.error("❌ WebSocket connection timed out (5s)");
    ws.close();
    process.exit(1);
  }, 5000);

  ws.on("open", () => {
    clearTimeout(connectionTimeout);
    console.log("✅ WebSocket connected");

    // Subscribe
    const request = {
      jsonrpc: "2.0",
      id: "meteora-sub",
      method: "transactionSubscribe",
      params: [
        {
          accountInclude: [DYNAMIC_AMM_PROGRAM_ID.toBase58()],
          type: "program",
          commitment: "confirmed",
          encoding: "jsonParsed",
          transactionDetails: "full",
          showRewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
    };

    ws.send(JSON.stringify(request));
    console.log("Listening for dynamic-amm program transactions...");
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString("utf8"));

      // Confirm subscription ID
      if (msg.result && typeof msg.result === "number") {
        console.log("✅ Subscription confirmed, ID:", msg.result);
        return;
      }

      // If transaction notification
      if (
        msg.method === "transactionNotification" &&
        msg.params?.result?.signature
      ) {
        const { signature, slot } = msg.params.result;
        console.log(`\n🔍 Slot ${slot} - New transaction: ${signature}`);

        // Fetch from RPC
        const txDetails = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!txDetails) {
          console.log("No transaction details (still processing). Skipping...");
          return;
        }

        // Only rummage if the transaction itself created brand new accounts
        // We'll check each dynamic-amm candidate pool to see if its preBalance == 0
        await rummageForPools(signature, txDetails);
      } else {
        console.log("⚠️ Unhandled message", msg);
      }
    } catch (err) {
      console.error("Error in message handler:", err);
    }
  });

  ws.on("error", (err) => {
    clearTimeout(connectionTimeout);
    console.error("❌ WebSocket error:", err);
    process.exit(1);
  });

  ws.on("close", () => {
    console.log("WebSocket closed.");
    process.exit(0);
  });
}

/**
 * Check each static account in the transaction to see if it's a newly created dynamic-amm pool.
 */
async function rummageForPools(
  signature: string,
  txn: VersionedTransactionResponse
) {
  if (!txn.meta || txn.meta.err) {
    console.log("❌ Transaction failed or missing meta:", signature);
    return;
  }

  const acctKeys = txn.transaction.message.staticAccountKeys;
  console.log(`📝 Tx ${signature} has ${acctKeys.length} account keys.`);

  let foundPool = false;

  for (let i = 0; i < acctKeys.length; i++) {
    const key = acctKeys[i];
    try {
      // Check if preBalances[i] was zero => brand new account in this tx
      if (txn.meta.preBalances[i] !== 0) {
        // This account wasn't newly created, skip it
        continue;
      }

      // Attempt to create a dynamic-amm instance
      const maybePool = await DynamicAmm.create(connection, key);
      if (maybePool?.poolInfo) {
        console.log("\n🏦 Found dynamic-amm pool (brand new):", key.toBase58());
        foundPool = true;
        await analyzePool(maybePool);
      }
    } catch {
      // not a valid pool
    }
  }

  if (!foundPool) {
    console.log("No valid dynamic-amm pools found in tx");
  }
}

/**
 * If the newly found pool has SOL or USDC and meets liquidity thresholds,
 * attempt the snipe.
 */
async function analyzePool(dynamicPool: any) {
  const { tokenAMint, tokenBMint, poolInfo } = dynamicPool;
  const mintA = tokenAMint.address.toBase58();
  const mintB = tokenBMint.address.toBase58();

  console.log(`\n📊 Checking pool minted with:`);
  console.log(`- Token A: ${mintA}`);
  console.log(`- Token B: ${mintB}`);

  // Must have either SOL or USDC
  const hasSol = mintA === SOL_MINT_STR || mintB === SOL_MINT_STR;
  const hasUsdc = mintA === USDC_MINT_STR || mintB === USDC_MINT_STR;

  if (!hasSol && !hasUsdc) {
    console.log("❌ Pool does not contain SOL or USDC. Skipping");
    return;
  }

  // Check liquidity
  const decA = tokenAMint.decimals;
  const decB = tokenBMint.decimals;
  const humA = poolInfo.tokenAAmount.toNumber() / 10 ** decA;
  const humB = poolInfo.tokenBAmount.toNumber() / 10 ** decB;

  console.log(
    `💰 Liquidity: TokenA = ${humA.toFixed(6)}, TokenB = ${humB.toFixed(6)}`
  );

  // Convert to approximate SOL eq
  let solEq = 0;
  if (hasSol) {
    solEq = mintA === SOL_MINT_STR ? humA : humB;
  } else {
    // USDC side - do a rough 1 USDC = 0.5 SOL, etc.
    const usdcSide = mintA === USDC_MINT_STR ? humA : humB;
    solEq = usdcSide / 2;
  }

  if (solEq < SETTINGS.minLiquidityInSOL) {
    console.log(
      `❌ Not enough liquidity: ${solEq.toFixed(2)} < ${SETTINGS.minLiquidityInSOL} SOL eq`
    );
    return;
  }

  console.log(`\n🎯 Pool has enough liquidity. Attempting snipe...`);
  await snipePool(dynamicPool);
}

async function snipePool(dynamicPool: any) {
  try {
    const { tokenAMint, tokenBMint, poolInfo } = dynamicPool;
    const mintA = tokenAMint.address.toString();
    const mintB = tokenBMint.address.toString();

    // Decide direction (SOL/USDC -> other token)
    let inMint: string;
    let outMint: string;
    if (mintA === SOL_MINT_STR || mintA === USDC_MINT_STR) {
      inMint = mintA;
      outMint = mintB;
    } else {
      inMint = mintB;
      outMint = mintA;
    }

    console.log("\n🔍 Pool Details:");
    console.log(`Token A (${mintA}):`);
    console.log(`- Amount: ${poolInfo.tokenAAmount.toString()}`);
    console.log(`- Decimals: ${tokenAMint.decimals}`);
    console.log(`Token B (${mintB}):`);
    console.log(`- Amount: ${poolInfo.tokenBAmount.toString()}`);
    console.log(`- Decimals: ${tokenBMint.decimals}`);

    // Attempt the swap
    const buyLamports = new BN(SETTINGS.swapAmountInSOL * LAMPORTS_PER_SOL);
    console.log(`\n💱 Attempting swap of ${SETTINGS.swapAmountInSOL} SOL`);

    const swapQuote = dynamicPool.getSwapQuote(
      new PublicKey(inMint),
      buyLamports,
      SETTINGS.slippageBps
    );

    // Clamp negative minOut to 0
    const minOut = swapQuote.minSwapOutAmount.gte(new BN(0))
      ? swapQuote.minSwapOutAmount
      : new BN(0);

    const priceImpactNum = Number(swapQuote.priceImpact) || 0;
    if (priceImpactNum > SETTINGS.maxPriceImpact) {
      console.log(
        `❌ Price impact too high: ${priceImpactNum}% > ${SETTINGS.maxPriceImpact}%`
      );
      return;
    }

    console.log("\n📊 Swap Details:");
    console.log(`- Input: ${SETTINGS.swapAmountInSOL} SOL`);
    console.log(`- Min Output: ${minOut.toString()}`);
    console.log(`- Price Impact: ${priceImpactNum}%`);
    console.log(`- Slippage: ${SETTINGS.slippageBps / 100}%`);

    // Execute the swap
    const swapTx = await dynamicPool.swap(
      sniperKeypair.publicKey,
      new PublicKey(inMint),
      buyLamports,
      minOut
    );

    await createAndSendV0Tx({
      connection,
      ix: swapTx.instructions,
      signers: [sniperKeypair],
      computeUnits: 200_000,
      fixedPriorityFee: true,
      minPriorityFee: 1_000_000,
    });

    console.log("✅ Sniped successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ snipePool error:", err);
  }
}

if (require.main === module) {
  loadEnv();
  meteoraSuperSniper();
}