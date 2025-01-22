import { PublicKey } from "@solana/web3.js";
import { connection } from "../helpers/config";
import DynamicAmm from "@mercurial-finance/dynamic-amm-sdk";

// Known working pools from Meteora
const KNOWN_POOLS = [
  {
    address: "6SWtsTzXrurtVWZdEHvnQdE9oM8tTtyg8rfEo3b4nM93",
    name: "SOL-USDC (Known working)"
  },
  {
    address: "5cuy7pMhTPhVZN9xuhgSbykRb986siGJb6vnEtkuBrSU",
    name: "JLP-USDC (Known working)"
  }
];

async function findTestPool() {
  console.log("Testing known working pools...");

  for (const pool of KNOWN_POOLS) {
    console.log(`\nTrying pool: ${pool.address}`);
    console.log("Pool name:", pool.name);
    
    try {
      const dynamicPool = await DynamicAmm.create(connection, new PublicKey(pool.address));
      const poolInfo = dynamicPool.poolInfo;
      
      console.log("\nPool verified! Details:");
      console.log("Token A:", dynamicPool.tokenAMint.address.toString());
      console.log("Token B:", dynamicPool.tokenBMint.address.toString());
      console.log(
        "Token A Amount:",
        poolInfo.tokenAAmount.toNumber() / Math.pow(10, dynamicPool.tokenAMint.decimals)
      );
      console.log(
        "Token B Amount:",
        poolInfo.tokenBAmount.toNumber() / Math.pow(10, dynamicPool.tokenBMint.decimals)
      );
      
      console.log("\n✅ Success! Add this to your .env file:");
      console.log(`TEST_POOL_ADDRESS=${pool.address}`);
      return;
    } catch (e: any) {
      console.log("Error accessing pool:", e?.message || "Unknown error");
      continue;
    }
  }

  console.log("\n❌ No working pools found. Please try again later or contact support.");
}

if (require.main === module) {
  findTestPool();
} 