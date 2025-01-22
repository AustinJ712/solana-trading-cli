import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Signer, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import * as bs58 from 'bs58';
import { loadEnv } from './load-env';
import { createAndSendV0Tx, getOrCreateTokenAta, getOrCreateWsolAta, wrapSol } from '../raydium/execute-txns';
import fs from 'fs';
import BN from 'bn.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
import { Config } from '../config';
import Bottleneck from 'bottleneck';
import retry from 'async-retry';

// Load environment variables
loadEnv();

const rpcUrl = process.env.RPC_URL!;
const privateKeyBase58 = process.env.PRIVATE_KEY!;
const privateKey = bs58.decode(privateKeyBase58);
const keypair = Keypair.fromSecretKey(privateKey);
const connection = new Connection(rpcUrl, Config.rpcCommitment);
const mintAddress = new PublicKey(process.env.MINT_ADDRESS!);
const devnet = process.env.NETWORK !== "mainnet";

export async function fundDeployerAddresses(solAmount: number) {
    if (!devnet) {
        // Don't fund deployer addresses on mainnet for anonymity
        console.log(`Exiting: cannot fund deployer addresses on mainnet`);
        return;
    }

    const deployerPublicKeys: PublicKey[] = getDeployerKeyPairs().map(k => k.publicKey);
    const transferAmount = new BN(solAmount * LAMPORTS_PER_SOL);

    const instructions: TransactionInstruction[] = [];
    for (const deployer of deployerPublicKeys) {
        instructions.push(
            SystemProgram.transfer({
                fromPubkey: keypair.publicKey,
                toPubkey: deployer,
                lamports: transferAmount.toNumber(),
            })
        );
    }

    await createAndSendV0Tx({ connection, ix: instructions, signers: [keypair] });
}

export async function fundDeployerAddressesDiffAmounts(solAmount: number[]) {
    if (!devnet) {
        // Don't fund deployer addresses on mainnet for anonymity
        console.log(`Exiting: cannot fund deployer addresses on mainnet`);
        return;
    }

    const deployerPublicKeys: PublicKey[] = getDeployerKeyPairs().map(k => k.publicKey).slice(0, solAmount.length);

    const CHUNK_SIZE = 20; // Max number of transfers per transaction
    for (let i = 0; i < solAmount.length; i += CHUNK_SIZE) {
        const chunk = solAmount.slice(i, i + CHUNK_SIZE);
        const deployerChunk = deployerPublicKeys.slice(i, i + CHUNK_SIZE);
        const ix = deployerChunk.map((deployer, j) => SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: deployer,
            lamports: new BN(chunk[j] * LAMPORTS_PER_SOL).toNumber(),
        }));
        await createAndSendV0Tx({ connection, ix, signers: [keypair] });
    }
}

export async function sendTokensToDeployerAddresses(tokenAmount: number) {
    const deployerPublicKeys: PublicKey[] = getDeployerKeyPairs().map(k => k.publicKey);
    const transferAmount = new BN(tokenAmount * 10 ** Config.Token.decimals);

    const sourceAta = await getOrCreateTokenAta(connection, keypair, mintAddress);

    const instructions: TransactionInstruction[] = [];
    for (const deployer of deployerPublicKeys) {
        const deployerAta = await getAssociatedTokenAddress(mintAddress, deployer);
        instructions.push(
            createTransferCheckedInstruction(
                sourceAta,
                mintAddress,
                deployerAta,
                keypair.publicKey,
                transferAmount.toNumber(),
                9,
            )
        );
    }

    await createAndSendV0Tx({ connection, ix: instructions, signers: [keypair] });
}

export function getDeployerKeyPairs(): Keypair[] {
    const fileContent = fs.readFileSync('deployer-keypairs.json', 'utf-8');
    return JSON.parse(fileContent).map((k: { privateKey: string; }) => Keypair.fromSecretKey(bs58.decode(k.privateKey)));
}

export function getTeamKeyPairs(filename: string = 'team-keypairs.json'): Keypair[] {
    const fileContent = fs.readFileSync(filename, 'utf-8');
    return JSON.parse(fileContent).map((k: { privateKey: string; }) => Keypair.fromSecretKey(bs58.decode(k.privateKey)));
}

export async function sweepSolFromDeployerAddresses(rps: number = 100) {
    const limiter = new Bottleneck({ maxConcurrent: 10, minTime: 1000 / rps });
    const deployerKeyPairs = getDeployerKeyPairs();
    const solBalances = await Promise.all(deployerKeyPairs.map(async (deployer) => limiter.schedule(async () => connection.getBalance(deployer.publicKey))));

    const MAX_TRANSFERS_PER_TXN = 8;
    let ix: TransactionInstruction[] = [];
    let signers: Signer[] = [keypair];

    for (let i = 0; i < deployerKeyPairs.length; i++) {
        const balance = solBalances[i];
        if (balance > 0) {
            ix.push(SystemProgram.transfer({
                fromPubkey: deployerKeyPairs[i].publicKey,
                toPubkey: keypair.publicKey,
                lamports: balance,
            }));
            signers.push(deployerKeyPairs[i]);
        }
        if (ix.length === MAX_TRANSFERS_PER_TXN || (i === deployerKeyPairs.length - 1 && ix.length > 0)) {
            await limiter.schedule(() => createAndSendV0Tx({ connection, ix, signers, computeUnits: 200_000 }));
            ix = [];
            signers = [keypair];
        }
    }
}

export async function sweepSolToExternalAddress(externalAddress: string, startIndex: number = 0, numWallets: number = Config.subsequentSwapsInSol.length, rps: number = 100) {
    const deployerKeyPairs = getDeployerKeyPairs().slice(startIndex, startIndex + numWallets);
    const MAX_TRANSFERS_PER_TXN = 8;
    let ix: TransactionInstruction[] = [];
    let signers: Signer[] = [keypair];
    const limiter = new Bottleneck({ maxConcurrent: 10, minTime: 1000 / rps });
    const solBalances = await Promise.all(deployerKeyPairs.map(async (deployer) => limiter.schedule(async () => connection.getBalance(deployer.publicKey))));

    for (let i = 0; i < deployerKeyPairs.length; i++) {
        const deployer = deployerKeyPairs[i];
        const balance = solBalances[i];
        if (balance > 0) {
            ix.push(SystemProgram.transfer({
                fromPubkey: deployer.publicKey,
                toPubkey: new PublicKey(externalAddress),
                lamports: balance,
            }));
            signers.push(deployer);
        }
        if (ix.length === MAX_TRANSFERS_PER_TXN || (i === deployerKeyPairs.length - 1 && ix.length > 0)) {
            await limiter.schedule(() => createAndSendV0Tx({ connection, ix, signers, computeUnits: 200_000 }));
            ix = [];
            signers = [keypair];
        }
    }
}

export async function maintainWsolBalances(targetWsolBalances: BN[], deployerKeypairs: Keypair[], rps: number = 100) {
    const limiter = new Bottleneck({ minTime: 1000 / rps });
    const wallets = deployerKeypairs.slice(0, targetWsolBalances.length);
    const wsolAtas = await Promise.all(wallets.map(async (deployer) => limiter.schedule(() => getOrCreateWsolAta(connection, deployer))));
    const actualWsolBalances = await Promise.all(
        wsolAtas.map(a => limiter.schedule(() => connection.getTokenAccountBalance(a).then(b => new BN(b.value.amount))))
    );

    const wrapIx: TransactionInstruction[] = [];
    const signers: Signer[] = [];
    for (let i = 0; i < wallets.length; i++) {
        if (actualWsolBalances[i].lt(targetWsolBalances[i])) {
            wrapIx.push(...await wrapSol(connection, wallets[i], targetWsolBalances[i].sub(actualWsolBalances[i]).toNumber(), wsolAtas[i]));
            signers.push(wallets[i]);
        }
    }

    const keypairChunkSize = 6;
    for (let i = 0; i < signers.length; i += keypairChunkSize) {
        const txSigners = signers.slice(i, i + keypairChunkSize);
        const instructions = wrapIx.slice(i * 2, (i + keypairChunkSize) * 2);
        await retry(
            () => limiter.schedule(() => createAndSendV0Tx({ connection, ix: instructions, signers: txSigners, computeUnits: 200_000 })),
            { retries: 3, minTimeout: 200, onRetry: (e, attempt) => console.error(`Attempt #${attempt}/3 to wrap SOL failed`, e) }
        );
    }
}

if (require.main === module) {
    if (process.argv.includes('--sweep')) {
        sweepSolFromDeployerAddresses()
            .catch(console.error);
    } else if (process.argv.includes('--external')) {
        sweepSolToExternalAddress("")
            .catch(console.error);
    } else if (process.argv.includes('--wsol')) {
        maintainWsolBalances([
            Config.initialSol, ...Config.subsequentSwapsInSol.map((a) => new BN(a * LAMPORTS_PER_SOL))
        ], [keypair, ...getDeployerKeyPairs()])
            .catch(console.error);
    } else if (process.argv.includes('--sol')) {
        // fundDeployerAddressesDiffAmounts(Config.pumpfunBundleConfig.swapAmountsInSol.map(a => a * 1.05 + 0.05))
        fundDeployerAddressesDiffAmounts(Config.subsequentSwapsInSol)
            .catch(console.error);
    } else {
        fundDeployerAddresses(0.1) // 0.1 SOL
            .catch(console.error);
    }
}
