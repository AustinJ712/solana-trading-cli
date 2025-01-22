import { PublicKey } from "@solana/web3.js";
import DynamicAmm, { AmmImpl } from "@mercurial-finance/dynamic-amm-sdk";
import { connection } from "../../helpers/config";

/**
 * Example function that tries to find a meteora pool address
 * via your REST API or data aggregator. For demonstration
 * we assume you do a fetch to "https://dlmm-api.meteora.ag/…"
 */
export async function fetchDLMMPoolId(tokenAddress: string): Promise<string> {
  const url = `https://dlmm-api.meteora.ag/pair/all_by_groups?sort_key=tvl&order_by=desc&search_term=${tokenAddress}&include_unknown=false`;
  const response = await fetch(url).then((r) => r.json());

  const listOfGroups = response.groups || [];
  for (const group of listOfGroups) {
    const name = group.name || "";
    // e.g. only pick something that pairs with "SOL"
    if (name.startsWith("SOL") || name.endsWith("SOL")) {
      const pair = group.pairs[0];
      return pair?.address || "";
    }
  }
  throw new Error(`No meteora pool found for token: ${tokenAddress}`);
}

/**
 * Creates a dynamic amm pool object for a given token address
 */
export async function fetchDynamicAmmPool(
  tokenAddress: string
): Promise<AmmImpl> {
  const poolId = await fetchDLMMPoolId(tokenAddress);
  if (!poolId) {
    throw new Error("No pool ID found!");
  }
  console.log("Pool ID for token", tokenAddress, ":", poolId);

  const dynamicPool = await DynamicAmm.create(connection, new PublicKey(poolId));
  return dynamicPool;
}
