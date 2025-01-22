import { PublicKey } from "@solana/web3.js";
import DynamicAmm, { AmmImpl } from "@mercurial-finance/dynamic-amm-sdk";
import { connection } from "../helpers/config";
import { loadEnv } from "../utils/load-env";

loadEnv();

// Get target token from env or command line
const TARGET_TOKEN_ADDRESS = process.env.TARGET_TOKEN_ADDRESS || "";
if (!TARGET_TOKEN_ADDRESS) {
  console.error("❌ Please set TARGET_TOKEN_ADDRESS in .env");
  process.exit(1);
}

// Constants for SOL and USDC
const SOL_MINT_STR = "So11111111111111111111111111111111111111112";
const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8g4wEGGkZwyTDt1v";

async function findTokenPools() {
  console.log(`🔍 Searching for pools containing token: ${TARGET_TOKEN_ADDRESS}`);
  
  try {
    // Get all pools containing our target token
    const accounts = await connection.getProgramAccounts(new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"));
    const pools = await Promise.all(
      accounts.map(async (acct) => {
        try {
          return await DynamicAmm.create(connection, acct.pubkey);
        } catch {
          return null;
        }
      })
    );
    const validPools = pools.filter((pool): pool is AmmImpl => 
      pool !== null && (pool.tokenAMint.address.toBase58() === TARGET_TOKEN_ADDRESS || 
               pool.tokenBMint.address.toBase58() === TARGET_TOKEN_ADDRESS)
    );
    
    if (validPools.length === 0) {
      console.log("\n❌ No pools found containing the target token");
      return;
    }

    console.log(`\n✅ Found ${validPools.length} pool(s) containing the target token`);
    
    for (const pool of validPools) {
      const { tokenAMint, tokenBMint, poolInfo } = pool;
      const mintA = tokenAMint.address.toBase58();
      const mintB = tokenBMint.address.toBase58();
      
      console.log("\n🏦 Pool Details:");
      console.log("Pool address:", pool.address.toBase58());
      console.log("Token A:", mintA, mintA === SOL_MINT_STR ? "(SOL)" : mintA === USDC_MINT_STR ? "(USDC)" : "");
      console.log("Token B:", mintB, mintB === SOL_MINT_STR ? "(SOL)" : mintB === USDC_MINT_STR ? "(USDC)" : "");
      
      // Show liquidity
      const tokenAAmount = poolInfo.tokenAAmount.toString();
      const tokenBAmount = poolInfo.tokenBAmount.toString();
      const tokenADecimals = tokenAMint.decimals;
      const tokenBDecimals = tokenBMint.decimals;
      
      const tokenAHuman = Number(tokenAAmount) / Math.pow(10, tokenADecimals);
      const tokenBHuman = Number(tokenBAmount) / Math.pow(10, tokenBDecimals);
      
      console.log("\nPool Liquidity:");
      console.log(`- Token A: ${tokenAHuman.toFixed(6)}`);
      console.log(`- Token B: ${tokenBHuman.toFixed(6)}`);
    }
    
  } catch (err: any) {
    console.error("Error searching for pools:", err.message);
  }
}

if (require.main === module) {
  findTokenPools().catch(console.error);
} 