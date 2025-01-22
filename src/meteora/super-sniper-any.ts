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

// Constants for token mints we're interested in
const SOL_MINT_STR = "So11111111111111111111111111111111111111112";
const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8g4wEGGkZwyTDt1v";

export const DYNAMIC_AMM_PROGRAM_ID = new PublicKey(
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"
);

// The first 8 bytes of sha256("global:initialize_dynamic_pool")
const POOL_CREATION_DISCRIMINATOR = "6a8e0502e3ecb8a1";

// Sniper settings
const sniperKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.SWAP_PRIVATE_KEY!)
);

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

  console.log("\nStarting super-sniper with BOTH steps:");
  console.log("- Checking for pool creation discriminator");
  console.log("- Checking preBalance == 0 rummaging");
  console.log(`Swap amount: ${SETTINGS.swapAmountInSOL} SOL`);
  console.log(`Min liquidity: ${SETTINGS.minLiquidityInSOL} SOL`);
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

  // 1) Check for "initialize_dynamic_pool" instruction
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

  // 2) Now rummage for brand-new accounts with preBalance=0 that form a valid dynamic-amm pool
  const preBalances = txn.meta.preBalances;
  const acctKeys = staticAccountKeys;

  let foundPool = false;

  for (let i = 0; i < acctKeys.length; i++) {
    if (preBalances[i] !== 0) {
      // not newly created in this tx
      continue;
    }
    try {
      // Attempt to create dynamic-amm instance
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
 * If pool has SOL or USDC and enough liquidity, attempt snipe
 */
async function analyzePool(dynamicPool: any) {
  const { tokenAMint, tokenBMint, poolInfo } = dynamicPool;
  const mintA = tokenAMint.address.toBase58();
  const mintB = tokenBMint.address.toBase58();

  console.log("\n📊 Checking pool minted with:");
  console.log(`- Token A: ${mintA}`);
  console.log(`- Token B: ${mintB}`);

  const hasSol = mintA === SOL_MINT_STR || mintB === SOL_MINT_STR;
  const hasUsdc = mintA === USDC_MINT_STR || mintB === USDC_MINT_STR;

  if (!hasSol && !hasUsdc) {
    console.log("❌ Pool does not contain SOL or USDC - skipping");
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

  // Rough sol eq
  let solEq = 0;
  if (hasSol) {
    solEq = mintA === SOL_MINT_STR ? humA : humB;
  } else {
    // We have USDC
    const usdcSide = mintA === USDC_MINT_STR ? humA : humB;
    // example ratio
    solEq = usdcSide / 2;
  }

  if (solEq < SETTINGS.minLiquidityInSOL) {
    console.log(
      `❌ Insufficient liquidity: ${solEq.toFixed(2)} < ${SETTINGS.minLiquidityInSOL} SOL eq`
    );
    return;
  }

  console.log("\n🎯 Pool meets criteria. Sniping now...");
  await snipePool(dynamicPool);
}

/**
 * Attempt the swap
 */
async function snipePool(dynamicPool: any) {
  try {
    const { tokenAMint, tokenBMint } = dynamicPool;
    const mintA = tokenAMint.address.toBase58();
    const mintB = tokenBMint.address.toBase58();

    // direction
    let inMint = mintA;
    let outMint = mintB;
    if (mintA === SOL_MINT_STR || mintA === USDC_MINT_STR) {
      inMint = mintA;
      outMint = mintB;
    } else {
      inMint = mintB;
      outMint = mintA;
    }

    // Build swap
    const buyLamports = new BN(SETTINGS.swapAmountInSOL * LAMPORTS_PER_SOL);
    const quote = dynamicPool.getSwapQuote(
      new PublicKey(inMint),
      buyLamports,
      SETTINGS.slippageBps
    );

    // Price impact check
    const pi = Number(quote.priceImpact) || 0;
    if (pi > SETTINGS.maxPriceImpact) {
      console.log(`❌ Price impact too high: ${pi}% > ${SETTINGS.maxPriceImpact}%`);
      return;
    }

    // If minSwapOut is negative, clamp to zero
    const minOut = quote.minSwapOutAmount.gte(new BN(0))
      ? quote.minSwapOutAmount
      : new BN(0);

    console.log("\n📊 Snipe details:");
    console.log(`- Input: ${SETTINGS.swapAmountInSOL} SOL`);
    console.log(`- minOut: ${minOut.toString()}`);
    console.log(`- priceImpact: ${pi}%`);
    console.log(`- slippage: ${SETTINGS.slippageBps / 100}%`);

    // do it
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