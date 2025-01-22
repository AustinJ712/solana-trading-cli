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
import { createAndSendV0Tx } from "./execute-txns";

// Token mint constants
const SOL_MINT_STR = "So11111111111111111111111111111111111111112";
const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8g4wEGGkZwyTDt1v";
const TARGET_MINT_STR = "yEBo3JaFCZLjq958gdnM1bpKYeRLB1yPpj96piDuoKH";

export const DYNAMIC_AMM_PROGRAM_ID = new PublicKey(
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"
);

// The first 8 bytes of sha256("global:initialize_dynamic_pool")
const POOL_CREATION_DISCRIMINATOR = "6a8e0502e3ecb8a1";

// Keypair setup
const sniperKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.SWAP_PRIVATE_KEY!)
);

// Updated settings with USDC swap amount
const SETTINGS = {
  swapAmountInSOL: process.env.SNIPER_AMOUNT_SOL
    ? parseFloat(process.env.SNIPER_AMOUNT_SOL)
    : 0.1,
  swapAmountInUSDC: process.env.SWAP_AMOUNT_USDC
    ? parseFloat(process.env.SWAP_AMOUNT_USDC)
    : 10,
  minLiquidityInSOL: process.env.MIN_LIQUIDITY_SOL
    ? parseFloat(process.env.MIN_LIQUIDITY_SOL)
    : 0.5,
  maxPriceImpact: process.env.MAX_PRICE_IMPACT
    ? parseFloat(process.env.MAX_PRICE_IMPACT)
    : 50,
  slippageBps: process.env.SLIPPAGE_BPS
    ? parseInt(process.env.SLIPPAGE_BPS)
    : 10_000,
};

/**
 * Main entry point
 */
export function meteoraSuperSniper() {
  if (!process.env.HELIUS_API_KEY) {
    console.error("❌ Error: HELIUS_API_KEY not found.");
    process.exit(1);
  }

  console.log("\nStarting TARGET-token sniper bot:");
  console.log("- Monitoring for TARGET/SOL and TARGET/USDC pools");
  console.log(`Swap amount (SOL pools): ${SETTINGS.swapAmountInSOL} SOL`);
  console.log(`Swap amount (USDC pools): ${SETTINGS.swapAmountInUSDC} USDC`);
  console.log(`Min liquidity: ${SETTINGS.minLiquidityInSOL} SOL eq`);
  console.log(`Max price impact: ${SETTINGS.maxPriceImpact}%`);
  console.log(`Slippage: ${SETTINGS.slippageBps / 100}%`);
  console.log("Wallet:", sniperKeypair.publicKey.toBase58());

  const socketUrl = `wss://atlas-mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  console.log("Connecting to Helius WS at:", socketUrl.replace(process.env.HELIUS_API_KEY!, "HIDDEN"));
  const ws = new WebSocket(socketUrl);

  // Connection timeout
  const connectionTimeout = setTimeout(() => {
    console.error("❌ WebSocket timed out after 5 seconds");
    ws.close();
    process.exit(1);
  }, 5000);

  ws.on("open", () => {
    clearTimeout(connectionTimeout);
    console.log("✅ WebSocket open");

    // Subscribe to dynamic-amm
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
    console.log("Listening for dynamic-amm transactions...");
  });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString("utf8"));

      // Subscription confirm
      if (msg.result && typeof msg.result === "number") {
        console.log("✅ Subscription confirmed ID:", msg.result);
        return;
      }

      // Transaction notifications
      if (
        msg.method === "transactionNotification" &&
        msg.params?.result?.signature
      ) {
        const { signature, slot } = msg.params.result;
        console.log(`\n🔍 Slot ${slot} - New tx: ${signature}`);

        const txDetails = await connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!txDetails) {
          console.log("No transaction details yet. Skipping...");
          return;
        }

        await analyzeTransaction(signature, txDetails);
      } else {
        console.log("⚠️ Unhandled message type", msg);
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
    console.log("WebSocket closed. Exiting...");
    process.exit(0);
  });
}

/**
 * 1) Check for presence of the "pool creation" instruction (discriminator).
 * 2) If found, rummage for brand-new accounts whose preBalance = 0.
 */
async function analyzeTransaction(
  signature: string,
  txn: VersionedTransactionResponse
) {
  if (!txn.meta || txn.meta.err) {
    console.log("❌ Transaction failed:", signature);
    return;
  }

  const { compiledInstructions } = txn.transaction.message;
  const { staticAccountKeys } = txn.transaction.message;

  // Filter for dynamic-amm instructions
  const meteoraIxs = compiledInstructions.filter((ix: MessageCompiledInstruction) =>
    staticAccountKeys[ix.programIdIndex].equals(DYNAMIC_AMM_PROGRAM_ID)
  );

  if (!meteoraIxs.length) {
    console.log("❌ No meteora instructions found");
    return;
  }

  // Check if any of those instructions match the creation discriminator
  const isPoolCreation = meteoraIxs.some((ix) => {
    const data = ix.data; // Uint8Array
    const disc = Buffer.from(data.slice(0, 8)).toString("hex");
    return disc === POOL_CREATION_DISCRIMINATOR;
  });
  if (!isPoolCreation) {
    console.log("❌ Not a pool creation transaction");
    return;
  }
  console.log("✨ Found pool creation instruction in transaction!");

  // Find newly created accounts with preBalance=0
  const preBalances = txn.meta.preBalances;
  const acctKeys = staticAccountKeys;

  let foundPool = false;

  for (let i = 0; i < acctKeys.length; i++) {
    if (preBalances[i] !== 0) {
      continue;
    }
    try {
      const key = acctKeys[i];
      const pool = await DynamicAmm.create(connection, key);
      if (pool.poolInfo) {
        console.log("\n🏦 Found brand-new dynamic-amm pool:", key.toBase58());
        foundPool = true;
        await analyzePool(pool);
      }
    } catch {
      // Not a valid pool
    }
  }

  if (!foundPool) {
    console.log("No newly created pool found in rummage step");
  }
}

/**
 * Validate pool composition and liquidity requirements
 */
async function analyzePool(dynamicPool: any) {
  const { tokenAMint, tokenBMint, poolInfo } = dynamicPool;
  const mintA = tokenAMint.address.toBase58();
  const mintB = tokenBMint.address.toBase58();

  console.log("\n📊 Checking pool composition:");
  console.log(`- Token A: ${mintA}`);
  console.log(`- Token B: ${mintB}`);

  // Check for TARGET-SOL or TARGET-USDC pair
  const isTargetPool = 
    (mintA === TARGET_MINT_STR && [SOL_MINT_STR, USDC_MINT_STR].includes(mintB)) ||
    (mintB === TARGET_MINT_STR && [SOL_MINT_STR, USDC_MINT_STR].includes(mintA));

  if (!isTargetPool) {
    console.log("❌ Not a TARGET-SOL/USDC pool - skipping");
    return;
  }

  // Check liquidity
  const decA = tokenAMint.decimals;
  const decB = tokenBMint.decimals;
  const humA = poolInfo.tokenAAmount.toNumber() / 10 ** decA;
  const humB = poolInfo.tokenBAmount.toNumber() / 10 ** decB;

  console.log(
    `💰 Liquidity: ${humA.toFixed(6)} (${tokenAMint.symbol}) / ${humB.toFixed(6)} (${tokenBMint.symbol})`
  );

  // Calculate SOL equivalent value
  let solEq = 0;
  if (mintA === SOL_MINT_STR || mintB === SOL_MINT_STR) {
    solEq = mintA === SOL_MINT_STR ? humA : humB;
  } else {
    const usdcSide = mintA === USDC_MINT_STR ? humA : humB;
    solEq = usdcSide / 0.000000001; // Simple conversion assuming $20 SOL price
  }

  if (solEq < SETTINGS.minLiquidityInSOL) {
    console.log(
      `❌ Insufficient liquidity: ${solEq.toFixed(0.0001)} < ${SETTINGS.minLiquidityInSOL} SOL eq`
    );
    return;
  }

  console.log("\n🎯 Valid pool detected. Initiating swap...");
  await snipePool(dynamicPool);
}

/**
 * Execute swap to buy TARGET token
 */
async function snipePool(dynamicPool: any) {
  try {
    const { tokenAMint, tokenBMint } = dynamicPool;
    const mintA = tokenAMint.address.toBase58();
    const mintB = tokenBMint.address.toBase58();

    // Determine swap direction
    let inMint: string, outMint: string;
    if (mintA === TARGET_MINT_STR) {
      outMint = mintA;
      inMint = mintB;
    } else {
      outMint = mintB;
      inMint = mintA;
    }

    // Calculate input amount based on pool type
    let inputAmount: typeof BN.prototype;
    if (inMint === SOL_MINT_STR) {
      inputAmount = new BN(SETTINGS.swapAmountInSOL * LAMPORTS_PER_SOL);
    } else if (inMint === USDC_MINT_STR) {
      inputAmount = new BN(SETTINGS.swapAmountInUSDC * 10 ** 6); // USDC has 6 decimals
    } else {
      throw new Error("Invalid input token for swap");
    }

    // Get swap quote
    const quote = dynamicPool.getSwapQuote(
      new PublicKey(inMint),
      inputAmount,
      SETTINGS.slippageBps
    );

    // Price impact validation
    const pi = Number(quote.priceImpact) || 0;
    if (pi > SETTINGS.maxPriceImpact) {
      console.log(`❌ Price impact too high: ${pi}% > ${SETTINGS.maxPriceImpact}%`);
      return;
    }

    // Prepare swap transaction
    const minOut = quote.minSwapOutAmount.gte(new BN(0))
      ? quote.minSwapOutAmount
      : new BN(0);

    console.log("\n⚡ Swap Parameters:");
    console.log(`- Buying: ${outMint === TARGET_MINT_STR ? "TARGET" : "UNKNOWN"}`);
    console.log(`- Spending: ${inMint === SOL_MINT_STR 
      ? `${SETTINGS.swapAmountInSOL} SOL` 
      : `${SETTINGS.swapAmountInUSDC} USDC`}`);
    console.log(`- Minimum received: ${minOut.toString()}`);
    console.log(`- Price impact: ${pi.toFixed(2)}%`);

    // Execute swap
    const swapTx = await dynamicPool.swap(
      sniperKeypair.publicKey,
      new PublicKey(inMint),
      inputAmount,
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

    console.log("✅ Successfully acquired TARGET tokens!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Swap execution failed:", err);
  }
}

if (require.main === module) {
  loadEnv();
  meteoraSuperSniper();
}