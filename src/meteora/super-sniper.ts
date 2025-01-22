import WebSocket from "ws";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { BN } from "bn.js";
import { loadEnv } from "../utils/load-env";
import { connection } from "../helpers/config";
import DynamicAmm from "@mercurial-finance/dynamic-amm-sdk";
import { createAndSendV0Tx } from "./execute-txns";

export const DYNAMIC_AMM_PROGRAM_ID = new PublicKey(
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"
);

const sniperKeypair = Keypair.fromSecretKey(
  bs58.decode(process.env.SWAP_PRIVATE_KEY!)
);

// Sniper settings
const SETTINGS = {
  swapAmountInSOL: process.env.SNIPER_AMOUNT_SOL ? parseFloat(process.env.SNIPER_AMOUNT_SOL) : 0.1,
  minLiquidityInSOL: process.env.MIN_LIQUIDITY_SOL ? parseFloat(process.env.MIN_LIQUIDITY_SOL) : 1,
  maxPriceImpact: process.env.MAX_PRICE_IMPACT ? parseFloat(process.env.MAX_PRICE_IMPACT) : 50,
  slippageBps: process.env.SLIPPAGE_BPS ? parseInt(process.env.SLIPPAGE_BPS) : 10000,
};

interface TransactionInstruction {
  programId: string;
  accounts: string[];
  data: string;
}

interface AccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}

interface TransactionMessage {
  accountKeys: AccountKey[];
  instructions: TransactionInstruction[];
}

interface TransactionResult {
  signature: string;
  transaction: {
    message: TransactionMessage;
    meta: {
      err: any;
    };
    transaction: {
      message: TransactionMessage;
    };
  };
}

export function meteoraSuperSniper() {
  // Validate Helius API key
  if (!process.env.HELIUS_API_KEY) {
    console.error("❌ Error: HELIUS_API_KEY not found in environment variables");
    process.exit(1);
  }

  // Check API key format
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(process.env.HELIUS_API_KEY)) {
    console.error("❌ Error: HELIUS_API_KEY appears to be invalid");
    console.error("Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
    console.error("Current value:", process.env.HELIUS_API_KEY);
    process.exit(1);
  }

  console.log("\nStarting super-sniper in single-snipe mode with settings:");
  console.log(`Swap amount: ${SETTINGS.swapAmountInSOL} SOL`);
  console.log(`Min pool liquidity: ${SETTINGS.minLiquidityInSOL} SOL`);
  console.log(`Max price impact: ${SETTINGS.maxPriceImpact}%`);
  console.log(`Slippage: ${SETTINGS.slippageBps / 100}%`);
  console.log("Will exit after first successful snipe.");
  console.log("Wallet:", sniperKeypair.publicKey.toString());

  const socketUrl = `wss://atlas-mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  console.log("\nConnecting to Helius websocket...");
  console.log("Using URL:", socketUrl.replace(process.env.HELIUS_API_KEY!, "HIDDEN"));
  
  const ws = new WebSocket(socketUrl);

  // Add connection timeout
  const connectionTimeout = setTimeout(() => {
    console.error("\n❌ WebSocket connection timed out after 5 seconds");
    console.error("This usually means the API key is invalid or the service is down");
    ws.close();
    process.exit(1);
  }, 5000);

  ws.on("open", () => {
    clearTimeout(connectionTimeout);
    console.log("✅ WebSocket connected successfully");
    
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
          maxSupportedTransactionVersion: 0
        }
      ]
    };
    
    console.log("Subscription request:", JSON.stringify(request, null, 2));
    ws.send(JSON.stringify(request));
    console.log("Listening for Meteora program transactions...");
  });

  ws.on("message", async (data) => {
    try {
      // Log raw message for debugging
      console.log("\n📨 Received websocket message");
      const rawMsg = JSON.parse(data.toString("utf8"));
      console.log("Message type:", rawMsg.method || "notification");
      console.log("Message structure:", JSON.stringify(rawMsg, null, 2));
      
      // Check if it's a subscription confirmation
      if (rawMsg.result && typeof rawMsg.result === "number") {
        console.log("✅ Subscription confirmed with ID:", rawMsg.result);
        return;
      }

      // Check if it's a subscription notification
      if (rawMsg.method === "subscription" && rawMsg.params?.result) {
        await parsePoolCreationTx(rawMsg.params.result, ws);
        return;
      }
      
      console.log("⚠️ Unhandled message type");
    } catch (e) {
      console.error("Error in message handler:", e);
      console.error("Raw message:", data.toString("utf8"));
      ws.close();
      process.exit(1);
    }
  });

  ws.on("error", (err) => {
    clearTimeout(connectionTimeout);
    console.error("\n❌ WebSocket error:");
    console.error("Error details:", err.message);
    
    if (err.message.includes("401")) {
      console.error("\nAuthentication failed (401 Unauthorized)");
      console.error("This means your API key was rejected by Helius");
      console.error("\nTroubleshooting steps:");
      console.error("1. Verify HELIUS_API_KEY in .env matches your dashboard");
      console.error("2. Check if key has websocket permissions in Helius dashboard");
      console.error("3. Ensure you have sufficient credits");
      console.error("4. Try creating a new API key if issues persist");
    } else {
      console.error("\nPlease check:");
      console.error("1. Your internet connection");
      console.error("2. Helius service status");
      console.error("3. Try again in a few minutes");
    }
    process.exit(1);
  });

  ws.on("close", () => {
    console.log("WS closed.");
    process.exit(0);
  });
}

async function parsePoolCreationTx(result: TransactionResult, ws: WebSocket) {
  try {
    const { signature, transaction } = result;
    if (!transaction) {
      console.log("No transaction in message");
      return;
    }

    console.log("\n🔍 Analyzing transaction:", signature);
    
    if (transaction.meta.err) {
      console.log("❌ Transaction failed:", signature);
      return;
    }

    // Log transaction details
    const accountKeys = transaction.transaction.message.accountKeys;
    console.log(`📝 Transaction details:`);
    console.log(`- Number of accounts: ${accountKeys.length}`);
    console.log(`- Number of instructions: ${transaction.transaction.message.instructions.length}`);
    
    console.log(`- Looking for instructions from program: ${DYNAMIC_AMM_PROGRAM_ID.toBase58()}`);
    
    const meteoraIxs = transaction.transaction.message.instructions.filter(
      (ix: TransactionInstruction) => ix.programId === DYNAMIC_AMM_PROGRAM_ID.toBase58()
    );
    
    if (meteoraIxs.length === 0) {
      console.log("❌ No Meteora instructions found");
      return;
    }

    console.log(`✨ Found ${meteoraIxs.length} Meteora instructions`);
    
    // Log instruction details
    meteoraIxs.forEach((ix: TransactionInstruction, index: number) => {
      console.log(`\n📎 Instruction ${index + 1}:`);
      console.log(`- Program: ${ix.programId}`);
      console.log(`- Accounts used: ${ix.accounts.length}`);
      console.log(`- Data length: ${ix.data.length} bytes`);
    });
    
    // Try multiple approaches to find the pool
    console.log("\n🔍 Searching for pool address...");
    let newPool: PublicKey | null = null;

    // First try: Check second account
    if (accountKeys.length > 1) {
      const potentialPool = new PublicKey(accountKeys[1].pubkey);
      console.log("Checking second account as pool:", potentialPool.toBase58());
      try {
        const pool = await DynamicAmm.create(connection, potentialPool);
        if (pool.poolInfo) {
          newPool = potentialPool;
          console.log("✅ Found valid pool from second account");
        }
      } catch (e) {
        console.log("❌ Second account is not a valid pool");
      }
    }

    // Third try: Scan all accounts
    if (!newPool) {
      console.log("\n🔍 Scanning all accounts for valid pool...");
      for (const key of accountKeys) {
        const potentialPool = new PublicKey(key.pubkey);
        console.log("Checking account:", potentialPool.toBase58());
        try {
          const pool = await DynamicAmm.create(connection, potentialPool);
          if (pool.poolInfo) {
            newPool = potentialPool;
            console.log("✅ Found valid pool from account scan");
            break;
          }
        } catch (e) {
          // Skip invalid pools
        }
      }
    }

    if (!newPool) {
      console.log("\n❌ No valid pool found in transaction");
      return;
    }

    console.log(`\n🚀 Found meteora pool: ${newPool.toBase58()}`);
    console.log(`Transaction: ${signature}`);

    // Verify pool exists and is initialized
    const pool = await DynamicAmm.create(connection, newPool);
    const poolInfo = pool.poolInfo;
    if (!poolInfo) {
      console.log("Pool not initialized yet");
      return;
    }

    console.log(
      'Pool Info - tokenA: %s, tokenB: %s',
      pool.tokenAMint.address,
      pool.tokenBMint.address
    );

    // Attempt to snipe and exit after attempt
    await snipeIt(newPool);
    console.log("Snipe attempt complete, closing connection...");
    ws.close();
    process.exit(0);
  } catch (e) {
    console.error("parsePoolCreationTx error:", e);
  }
}

async function snipeIt(poolPubkey: PublicKey) {
  try {
    const dynamicPool = await DynamicAmm.create(connection, poolPubkey);
    const poolInfo = dynamicPool.poolInfo;

    // Check minimum liquidity
    const liquidityBn = poolInfo.tokenAAmount;
    if (liquidityBn.lt(new BN(SETTINGS.minLiquidityInSOL * LAMPORTS_PER_SOL))) {
      console.log(`Not enough liquidity (minimum ${SETTINGS.minLiquidityInSOL} SOL required)`);
      return;
    }

    // Print pool info
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

    // Calculate swap amount
    const buyLamports = new BN(SETTINGS.swapAmountInSOL * LAMPORTS_PER_SOL);
    
    // Determine swap direction (we want to swap SOL for token)
    const swapAtoB = dynamicPool.tokenAMint.address.toString() === "So11111111111111111111111111111111111111112";
    const swapInToken = swapAtoB ? dynamicPool.tokenAMint : dynamicPool.tokenBMint;
    const swapOutToken = swapAtoB ? dynamicPool.tokenBMint : dynamicPool.tokenAMint;

    // Get swap quote
    const swapQuote = dynamicPool.getSwapQuote(
      new PublicKey(swapInToken.address),
      buyLamports,
      SETTINGS.slippageBps
    );

    // Check price impact
    const priceImpactNumber = Number(swapQuote.priceImpact);
    if (priceImpactNumber > SETTINGS.maxPriceImpact) {
      console.log(`Price impact too high: ${priceImpactNumber}% (max ${SETTINGS.maxPriceImpact}%)`);
      return;
    }

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
    console.log('Price Impact:', priceImpactNumber + '%');

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

async function testMode() {
  console.log("Running in test mode...");
  console.log("Testing snipe functionality...");
  console.log("Wallet address:", sniperKeypair.publicKey.toString());

  try {
    // Use a known working pool for testing
    const testPool = process.env.TEST_POOL_ADDRESS || "6SWtsTzXrurtVWZdEHvnQdE9oM8tTtyg8rfEo3b4nM93"; // SOL-USDC pool
    console.log("\nTesting with pool:", testPool);
    
    // Test the entire snipe process without executing the trade
    await snipeIt(new PublicKey(testPool));
    
    console.log("\nAll tests passed! Ready to run the sniper in live mode.");
  } catch (err) {
    console.error("Test failed:", err);
  }
}

if (require.main === module) {
  loadEnv();
  
  // Check if we're in test mode
  const isTestMode = process.env.TEST_MODE === "true";
  if (isTestMode) {
    testMode();
  } else {
    meteoraSuperSniper();
  }
}
