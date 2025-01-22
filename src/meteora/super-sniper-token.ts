import WebSocket from "ws";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { BN } from "bn.js";
import { loadEnv } from "../utils/load-env";
import { connection } from "../helpers/config";
import DynamicAmm from "@mercurial-finance/dynamic-amm-sdk";
import { createAndSendV0Tx } from "./execute-txns";
import { TransactionNotification } from "./helius-websocket-types";

export const DYNAMIC_AMM_PROGRAM_ID = new PublicKey(
  "Eo7WjKq67rjJQSxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"
);

const sniperKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.SWAP_PRIVATE_KEY!)
);

// Sniper settings
const swapAmountInSOL = 0.1;
const minLiquidityInSOL = 1;
const TARGET_TOKEN_ADDRESS = process.env.TARGET_TOKEN_ADDRESS; // Add this to your .env file

export function meteoraSuperSniper() {
  const socketUrl = `wss://atlas-mainnet.helius-rpc.com?api-key=${process.env.HELIUS_API_KEY}`;
  const ws = new WebSocket(socketUrl);

  ws.on("open", () => {
    console.log("WebSocket open to Helius - super-sniper");
    const request = {
      jsonrpc: "2.0",
      id: 999,
      method: "transactionSubscribe",
      params: [
        {
          accountInclude: [DYNAMIC_AMM_PROGRAM_ID.toBase58()],
          failed: false,
        },
        {
          commitment: "processed",
          encoding: "jsonParsed",
          transactionDetails: "full",
          showRewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
    };
    ws.send(JSON.stringify(request));
  });

  ws.on("message", (data) => parsePoolCreationTx(data));

  ws.on("error", (err) => console.error("WS error:", err));

  ws.on("close", () => {
    console.log("WS closed, reconnecting in 5s...");
    setTimeout(() => meteoraSuperSniper(), 5000);
  });
}

async function parsePoolCreationTx(data: WebSocket.Data) {
  try {
    const msg = JSON.parse(data.toString("utf8")) as TransactionNotification;
    if (!msg.params?.result) return;

    const { signature, transaction } = msg.params.result;
    if (transaction.meta.err) return;

    const ixs = transaction.transaction.message.instructions.filter(
      (ix) => ix.programId === DYNAMIC_AMM_PROGRAM_ID.toBase58() && isPoolCreationIx(ix.data)
    );
    if (ixs.length === 0) return;

    // assume new pool is the second account
    const newPool = new PublicKey(
      transaction.transaction.message.accountKeys[1].pubkey
    );
    console.log(`🚀 Found new meteora pool: ${newPool.toBase58()}, tx = ${signature}`);

    // Verify pool exists and is initialized
    const pool = await DynamicAmm.create(connection, newPool);
    const poolInfo = pool.poolInfo;
    if (!poolInfo) {
      console.log("Pool not initialized yet");
      return;
    }

    console.log(
      'New Pool Info - tokenA: %s, tokenB: %s',
      pool.tokenAMint.address,
      pool.tokenBMint.address
    );

    // Attempt to snipe 0.1 SOL
    await snipeIt(newPool);
  } catch (e) {
    console.error("parsePoolCreationTx error:", e);
  }
}

async function snipeIt(poolPubkey: PublicKey) {
  try {
    const dynamicPool = await DynamicAmm.create(connection, poolPubkey);
    const poolInfo = dynamicPool.poolInfo;

    // If target token is specified, check if this pool contains it
    if (TARGET_TOKEN_ADDRESS) {
      const tokenAAddress = dynamicPool.tokenAMint.address.toString();
      const tokenBAddress = dynamicPool.tokenBMint.address.toString();
      
      if (tokenAAddress !== TARGET_TOKEN_ADDRESS && tokenBAddress !== TARGET_TOKEN_ADDRESS) {
        console.log("Pool does not contain target token, skipping...");
        return;
      }
      console.log(`Found pool with target token ${TARGET_TOKEN_ADDRESS}!`);
    }

    // e.g. check liquidity or other conditions
    const liquidityBn = poolInfo.tokenAAmount;
    if (liquidityBn.lt(new BN(minLiquidityInSOL * LAMPORTS_PER_SOL))) {
      // skip if < minimum SOL
      console.log("Not enough liquidity in new pool");
      return;
    }

    // Print pool info like in the examples
    console.log(
      'tokenA %s Amount: %s',
      dynamicPool.tokenAMint.address,
      poolInfo.tokenAAmount.toNumber() / Math.pow(10, dynamicPool.tokenAMint.decimals)
    );
    console.log(
      'tokenB %s Amount: %s',
      dynamicPool.tokenBMint.address,
      poolInfo.tokenBAmount.toNumber() / Math.pow(10, dynamicPool.tokenBMint.decimals)
    );

    // do a 0.1 SOL buy
    const buyLamports = new BN(swapAmountInSOL * LAMPORTS_PER_SOL);
    
    // Determine swap direction (we want to swap SOL for token)
    const swapAtoB = dynamicPool.tokenAMint.address.toString() === "So11111111111111111111111111111111111111112";
    const swapInToken = swapAtoB ? dynamicPool.tokenAMint : dynamicPool.tokenBMint;
    const swapOutToken = swapAtoB ? dynamicPool.tokenBMint : dynamicPool.tokenAMint;

    // Get swap quote
    const swapQuote = dynamicPool.getSwapQuote(
      new PublicKey(swapInToken.address),
      buyLamports,
      100 // 1% slippage
    );

    console.log(
      'Swap In %s, Amount %s',
      swapInToken.address,
      swapQuote.swapInAmount.toNumber() / Math.pow(10, swapInToken.decimals)
    );
    console.log(
      'Swap Out %s, Amount %s',
      swapOutToken.address,
      swapQuote.swapOutAmount.toNumber() / Math.pow(10, swapOutToken.decimals)
    );

    // Execute swap
    const swapTx = await dynamicPool.swap(
      sniperKeypair.publicKey,
      new PublicKey(swapInToken.address),
      buyLamports,
      swapQuote.minSwapOutAmount
    );

    // sign & send
    await createAndSendV0Tx({
      connection,
      ix: swapTx.instructions,
      signers: [sniperKeypair],
      computeUnits: 200_000,
      fixedPriorityFee: true,
      minPriorityFee: 1_000_000,
    });

    console.log(`✅ Sniped successfully for pool: ${poolPubkey.toBase58()}`);
  } catch (err) {
    console.error("snipeIt error:", err);
  }
}

function isPoolCreationIx(data: string) {
  // decode the data if needed, or just always return true for demonstration
  return true;
}

async function testSnipe(poolAddress: string) {
  console.log("Testing snipe functionality...");
  console.log("Wallet address:", sniperKeypair.publicKey.toString());
  
  try {
    // Test pool connection and data fetching
    console.log("Fetching pool data...");
    const pool = await DynamicAmm.create(connection, new PublicKey(poolAddress));
    const poolInfo = pool.poolInfo;
    
    console.log("\nPool Information:");
    console.log("Token A:", pool.tokenAMint.address.toString());
    console.log("Token B:", pool.tokenBMint.address.toString());
    console.log(
      "Token A Amount:",
      poolInfo.tokenAAmount.toNumber() / Math.pow(10, pool.tokenAMint.decimals)
    );
    console.log(
      "Token B Amount:",
      poolInfo.tokenBAmount.toNumber() / Math.pow(10, pool.tokenBMint.decimals)
    );

    // Test swap quote
    console.log("\nTesting swap quote...");
    const testAmount = new BN(0.01 * LAMPORTS_PER_SOL); // Test with small amount
    const isTokenAWsol = pool.tokenAMint.address.toString() === "So11111111111111111111111111111111111111112";
    const swapInToken = isTokenAWsol ? pool.tokenAMint : pool.tokenBMint;
    
    const quote = pool.getSwapQuote(
      new PublicKey(swapInToken.address),
      testAmount,
      100
    );
    
    console.log("Swap quote received:");
    console.log("Input amount:", testAmount.toString());
    console.log("Expected output:", quote.swapOutAmount.toString());
    console.log("Price impact:", quote.priceImpact);

    console.log("\nAll tests passed! Ready to run the sniper.");
  } catch (err) {
    console.error("Test failed:", err);
  }
}

if (require.main === module) {
  loadEnv();
  
  // Check if we're in test mode
  const testPool = process.env.TEST_POOL_ADDRESS;
  if (testPool) {
    console.log("Running in test mode...");
    testSnipe(testPool);
  } else {
    console.log("Running in live mode...");
    meteoraSuperSniper();
  }

  process.on("SIGINT", () => {
    console.log("Caught interrupt signal");
    process.exit();
  });
}
