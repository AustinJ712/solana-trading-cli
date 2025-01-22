import { Connection } from "@solana/web3.js";
import { executeUnwrapSol } from "../raydium/execute-txns";
import { getDeployerKeyPairs } from "./fund-deployers";
import { loadEnv } from "./load-env";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { Token } from "@raydium-io/raydium-sdk";
import { Config } from "../config";

loadEnv();
const rpcUrl = process.env.RPC_URL!;
const connection = new Connection(rpcUrl, Config.rpcCommitment);

export async function unwrapAllDeployers() {

    const deployers = getDeployerKeyPairs();
    for (const deployer of deployers) {
        const account = await getAssociatedTokenAddress(Token.WSOL.mint, deployer.publicKey);
        try {
            const balance = await connection.getTokenAccountBalance(account);
            if (Number(balance.value.amount) > 0) {
                await executeUnwrapSol(connection, deployer);
            } else {
                console.log(`No balance to unwrap for ${deployer.publicKey.toBase58()}, skipping...`);
            }
        } catch (error) {
            console.log(`Error unwrapping ${deployer.publicKey.toBase58()}: ${error}, skipping...`);
        }
    }

    console.log(`Unwrapped all deployers`);
}

if (require.main === module) {
    unwrapAllDeployers().catch(console.error);
}