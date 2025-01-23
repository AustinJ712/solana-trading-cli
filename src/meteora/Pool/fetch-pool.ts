import { PublicKey, Keypair } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { connection, wallet } from "../../helpers/config";

interface PoolStats {
  address: string;
  name: string;
  tvl: number;
  volume24h: number;
  apy: number;
}

export async function fetchAllPoolStats(tokenAddress: string): Promise<PoolStats[]> {
  const url = `https://dlmm-api.meteora.ag/pair/all_by_groups?sort_key=tvl&order_by=desc&search_term=${tokenAddress}&include_unknown=true`;
  try {
    const response = await (await fetch(url)).json();
    const listOfGroups = response.groups || [];
    const pools: PoolStats[] = [];

    for (const group of listOfGroups) {
      const name = group.name || 'Unknown';
      // Check if pool contains SOL or USDC
      if (name.includes('SOL') || name.includes('USDC')) {
        const pairs = group.pairs || [];
        for (const pair of pairs) {
          pools.push({
            address: pair.address || 'Unknown',
            name: name,
            tvl: Number(pair.tvl || 0),
            volume24h: Number(pair.volume24h || 0),
            apy: Number(pair.apy || 0)
          });
        }
      }
    }

    if (pools.length === 0) {
      return [];
    }

    return pools;
  } catch (error: any) {
    console.error('Error fetching pool stats:', error);
    return [];
  }
}

export async function fetchDLMMPool(poolAddress: string) {
  if (!poolAddress) {
    throw new Error('Pool address is required');
  }
  try {
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress));
    return dlmmPool;
  } catch (error: any) {
    throw new Error(`Failed to fetch DLMM pool: ${error.message}`);
  }
}

async function main() {
  const tokenAddress = "Eay7MTCbkdSHHRuUERPL6vTY7ChtndL8MtPrNh2aUnjr";
  const pools = await fetchAllPoolStats(tokenAddress);
  
  if (pools.length > 0) {
    // Example: Fetch the first pool's DLMM data
    try {
      const firstPool = await fetchDLMMPool(pools[0].address);
      console.log('\nSuccessfully connected to first pool DLMM contract');
    } catch (error: any) {
      console.error('Error connecting to DLMM contract:', error.message);
    }
  }
}

main();