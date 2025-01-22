import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { getDeployerKeyPairs } from "./fund-deployers";
import { loadEnv } from "./load-env";
import { createAndSendV0Tx, getOrCreateAtaInstructions, getTokenBalance } from "../raydium/execute-txns";
import { Config } from "../config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { createCloseAccountInstruction, createTransferInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import Bottleneck from "bottleneck";
import retry from "async-retry";
import { BN } from "bn.js";

loadEnv();
const connection = new Connection(process.env.RPC_URL!, Config.rpcCommitment);
const keypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));

export async function washTokens(batchSize: number = 12, startHop: number = 0, numHops: number = 1, rps: number = 100) {
    const deployerKeypairs = getDeployerKeyPairs().slice(startHop * batchSize, (startHop + numHops + 1) * batchSize);
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 1000 / rps });
    const tokenBalances = await Promise.all(deployerKeypairs.slice(0, batchSize).map(k => limiter.schedule(() => getTokenBalance(connection, k.publicKey, Config.Token.mint))));


    for (let i = 0; i < numHops; i++) {
        for (let j = 0; j < batchSize; j++) {
            if (tokenBalances[j].eq(new BN(0))) {
                console.log(`Skipping ${deployerKeypairs[(i * batchSize + j) % deployerKeypairs.length].publicKey.toBase58()} as it has no tokens`);
                continue;
            }
            const from = deployerKeypairs[(i * batchSize + j) % deployerKeypairs.length];
            const to = deployerKeypairs[((i + 1) * batchSize + j) % deployerKeypairs.length];
            console.log(`🛁 Washing ${from.publicKey.toBase58()} -> ${to.publicKey.toBase58()}, ${BigInt(tokenBalances[j].toString())}`);
            const ownerAta = await getAssociatedTokenAddress(Config.Token.mint, from.publicKey, false, Config.Token.programId);
            const { ataAddress: ata, instructions: ataIx } = await getOrCreateAtaInstructions(connection, keypair, Config.Token.mint, to.publicKey, false, Config.Token.programId);
            const transferIx = createTransferInstruction(ownerAta, ata, from.publicKey, BigInt(tokenBalances[j].toString()), undefined, Config.Token.programId);
            const closeAtaIx = createCloseAccountInstruction(ownerAta, keypair.publicKey, from.publicKey);
            const ix = [...ataIx, transferIx, closeAtaIx];
            await retry(() => limiter.schedule(() => createAndSendV0Tx({ connection, ix, signers: [keypair, from] })), { 
                retries: 3, minTimeout: 100, onRetry: (e, attempt) => console.log(`Attempt #${attempt} failed: ${e}`)
            });
        }
    }
}

if (require.main === module) {
    washTokens(12, 0, 1).catch(console.error);
}