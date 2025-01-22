import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getTransfersForWalletWithSource, ParsedNativeTransfer } from "../raydium/helius-api";
import { loadEnv } from "./load-env";
import fs from 'fs';
import Bottleneck from "bottleneck";
import cliProgress from "cli-progress";

export async function getExternalTokenTransferAccountsForSinglePubkey(publicKey: PublicKey) {
    const tokenMint = process.env.MINT_ADDRESS!;
    const txs = await getTransfersForWalletWithSource(publicKey.toBase58());
    const filtered = txs.filter(t => t.type.toLowerCase() === 'transfer')
        .flatMap(t => t.tokenTransfers)
        .filter(t => t.mint === tokenMint).map(t => t.toUserAccount);
    return filtered;
}

export async function getExternalSolTransfersForSinglePubkey(publicKey: PublicKey) {
    const txs = await getTransfersForWalletWithSource(publicKey.toBase58(), "SYSTEM_PROGRAM");
    const filtered = txs.filter(t => t.type.toLowerCase() === 'transfer')
                        .flatMap(t => t.nativeTransfers)
                        .filter(t => t.fromUserAccount === publicKey.toBase58());
    return filtered;
}

export async function getExternalTokenTransferAccounts(rps: number = 1) {
    const pubkeyStrings = fs.readFileSync('other-publickeys.txt', 'utf-8').split('\n');
    const pubkeys = pubkeyStrings.map(p => new PublicKey(p));
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(pubkeys.length, 0);

    const limiter = new Bottleneck({ minTime: 1000 / rps, maxConcurrent: 1 });
    const externalAccounts: string[] = [];
    for (const pubkey of pubkeys) {
        externalAccounts.push(...(await limiter.schedule(() => getExternalTokenTransferAccountsForSinglePubkey(pubkey)))
            .filter(a => !pubkeyStrings.includes(a)));
        progressBar.increment();
    }

    progressBar.stop();

    // Deduplicate
    return Array.from(new Set(externalAccounts));
}

export async function getExternalSolTransfers(rps: number = 1) {
    const pubkeyStrings = fs.readFileSync('other-publickeys.txt', 'utf-8').split('\n');
    const pubkeys = pubkeyStrings.map(p => new PublicKey(p));
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(pubkeys.length, 0);

    const limiter = new Bottleneck({ minTime: 1000 / rps, maxConcurrent: 1 });
    const externalTransfers: ParsedNativeTransfer[] = [];

    for (const pubkey of pubkeys) {
        externalTransfers.push(...(await limiter.schedule(() => getExternalSolTransfersForSinglePubkey(pubkey))));
        progressBar.increment();
    }

    progressBar.stop();

    const filtered = externalTransfers.filter(t => !pubkeyStrings.includes(t.toUserAccount)).sort((a, b) => b.amount - a.amount);
    for (const t of filtered) {
        console.log(`${t.fromUserAccount} -> ${t.toUserAccount}: ${Number(t.amount / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 2 })} SOL`);
    }

    return filtered;
}

if (require.main === module) {
    loadEnv();
    if (process.argv.includes('--sol')) {
        getExternalSolTransfers()
        .catch(console.error);
    } else {
        getExternalTokenTransferAccounts()
        .then(accounts => console.log(accounts.join('\n')))
        .catch(console.error);
    }
}