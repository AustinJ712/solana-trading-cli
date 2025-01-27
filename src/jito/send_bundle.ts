import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';
import { isError} from 'jito-ts/dist/sdk/block-engine/utils';
import { BundleResult } from 'jito-ts/dist/gen/block-engine/bundle';
import bs58 from 'bs58';

// Define BlockhashWithExpiryBlockHeight type directly instead of importing
type BlockhashWithExpiryBlockHeight = Readonly<{
    blockhash: string;
    lastValidBlockHeight: number;
}>;

// Hardcoded values for development
const JITO_PRIVATE_KEY = "5F6x2LpP9FCht3f724rg2bSK3mJfqSAyVUiY3C7sH5eHMuqQaBG1aNmAzHDzMnaG15M6NqZwkeFyPAKmb4q4VNZc";
const BLOCK_ENGINE_URL = "slc.mainnet.block-engine.jito.wtf";

// Create Jito keypair from private key
const JITO_KEYPAIR = Keypair.fromSecretKey(bs58.decode(JITO_PRIVATE_KEY));

//////////////////////////////////////////////////////////////////////////////////////////////////
// The main Jito bundling logic
//////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * sendBundle: Waits for the near leader slot, then calls the user-supplied
 * txnCallback(...) to build an array of VersionedTransaction(s). Then
 * tries to send them all to Jito block engine.
 */
export const sendBundle = async (
    keypair: Keypair,
    connection: Connection,
    txnCallback: (latestBlockhash: BlockhashWithExpiryBlockHeight, tipAccount: PublicKey) => Promise<VersionedTransaction[]>,
    bundleTxnLimit: number = 5,
    retryInterval: number = 30000
) => {
    // Use JITO_KEYPAIR for authentication with block engine
    const client = searcherClient(BLOCK_ENGINE_URL, JITO_KEYPAIR);

    // If you have multiple tip accounts, you can choose which one. By default, we pick the first
    const tipAccounts = await client.getTipAccounts();
    if (isError(tipAccounts)) {
        throw new Error(`Failed to get tip accounts: ${(tipAccounts as any).error}`);
    }
    if (!tipAccounts.ok || !tipAccounts.value.length) {
        throw new Error("No tip accounts found from Jito block-engine. Are you sure your key is correct?");
    }
    const tipAccount = new PublicKey(tipAccounts.value[0]);

    const balance = await connection.getBalance(keypair.publicKey);
    console.log('Jito searcher key balance:', balance);

    // Wait until we are ~2 slots before next leader slot
    // so that we can attempt a 'block 0 snipe'
    let isLeaderSlot = false;
    while (!isLeaderSlot) {
        let next_leader = await client.getNextScheduledLeader();
        if (isError(next_leader)) {
            throw new Error(`Failed to get next leader: ${(next_leader as any).error}`);
        }
        if (!next_leader.ok) {
            throw new Error("Failed to get next leader info");
        }
        let num_slots = next_leader.value.nextLeaderSlot - next_leader.value.currentSlot;
        isLeaderSlot = num_slots <= 2;
        console.log(`next jito leader slot in ${num_slots} slots (need <=2 to send)`);
        if (!isLeaderSlot) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // fetch latest blockhash
    let blockHash = await connection.getLatestBlockhash('confirmed');
    console.log(`Latest blockhash: ${blockHash.blockhash}`);

    // build the user's transactions
    const transactions = await txnCallback(blockHash, tipAccount);
    if (transactions.length > bundleTxnLimit) {
        throw new Error(`Bundle transaction limit exceeded. Max allowed: ${bundleTxnLimit}`);
    }

    // build a new empty bundle
    const b = new Bundle([], bundleTxnLimit);
    let maybeBundle = b.addTransactions(...transactions);
    if (isError(maybeBundle)) {
        throw maybeBundle;
    }

    // We'll attempt sending the bundle & possibly re-send if we don't see acceptance
    const sendBundleWithRetry = async () => {
        let timeout: NodeJS.Timeout;
        let isResolved = false;

        const resp = await client.sendBundle(maybeBundle);
        console.log('Bundle sent =>', resp);

        // We register a listener for the result
        const onResult = (result: any) => {
            if (isResolved) return;

            if (result.accepted) {
                console.log('Bundle accepted =>', result);
                clearTimeout(timeout);
                isResolved = true;
            } else if (result.rejected) {
                console.log('Bundle rejected =>', result);
                clearTimeout(timeout);
                // after the rejection, we can try again
                setTimeout(sendBundleWithRetry, retryInterval);
                isResolved = true;
            }
        };

        const onError = (error: Error) => {
            if (isResolved) return;

            clearTimeout(timeout);
            isResolved = true;
            throw error;
        };

        client.onBundleResult(onResult, onError);

        timeout = setTimeout(() => {
            if (!isResolved) {
                console.log('Retrying due to timeout...');
                sendBundleWithRetry();
                isResolved = true;
            }
        }, retryInterval);
    };

    await sendBundleWithRetry();
};


/**
 * A simpler "sendBundleNow" that doesn't wait for the near leader slot,
 * just executes immediately. 
 */
export const sendBundleNow = async (
    keypair: Keypair,
    connection: Connection,
    txnCallback: (latestBlockhash: BlockhashWithExpiryBlockHeight, tipAccount: PublicKey) => Promise<VersionedTransaction[]>,
    bundleTxnLimit: number = 5
) => {
    const client = searcherClient(BLOCK_ENGINE_URL, JITO_KEYPAIR);
    const tipAccounts = await client.getTipAccounts();
    if (isError(tipAccounts)) {
        throw new Error(`Failed to get tip accounts: ${(tipAccounts as any).error}`);
    }
    if (!tipAccounts.ok || !tipAccounts.value.length) {
        throw new Error("No tip accounts found from Jito block-engine. Are you sure your key is correct?");
    }
    const tipAccount = new PublicKey(tipAccounts.value[0]);

    let blockHash = await connection.getLatestBlockhash('confirmed');
    console.log(`Latest blockhash: ${blockHash.blockhash}`);

    const b = new Bundle([], bundleTxnLimit);
    const transactions = await txnCallback(blockHash, tipAccount);

    if (transactions.length > bundleTxnLimit) {
        throw new Error(`Bundle transaction limit exceeded. Max transactions: ${bundleTxnLimit}`);
    }
    let maybeBundle = b.addTransactions(...transactions);
    if (isError(maybeBundle)) {
        throw maybeBundle;
    }

    const resp = await client.sendBundle(maybeBundle);
    console.log('Bundle sent =>', resp);
    let isResolved = false;

    const onResult = (result: any) => {
        if (isResolved) return;

        if (result.accepted) {
            console.log('Bundle accepted =>', result);
            isResolved = true;
        } else if (result.rejected) {
            console.log('Bundle rejected =>', result);
            isResolved = true;
        }
    };

    const onError = (error: Error) => {
        if (isResolved) return;
        isResolved = true;
        throw error;
    };

    client.onBundleResult(onResult, onError);
};

/**
 * For convenience, if you want to send multiple partial-bundles in quick succession
 * without re-checking leader time.  Typically unused in the sniper scenario, but
 * we keep it for reference.
 */
export const sendMultipleBundlesNow = async (
    keypair: Keypair,
    connection: Connection,
    txnCallbacks: ((latestBlockhash: BlockhashWithExpiryBlockHeight, tipAccount: PublicKey) => Promise<VersionedTransaction[]>)[],
    bundleTxnLimit: number = 5
) => {
    const client = searcherClient(BLOCK_ENGINE_URL, JITO_KEYPAIR);
    const tipAccounts = await client.getTipAccounts();
    if (isError(tipAccounts)) {
        throw new Error(`Failed to get tip accounts: ${(tipAccounts as any).error}`);
    }
    if (!tipAccounts.ok || !tipAccounts.value.length) {
        throw new Error("No tip accounts found from Jito block-engine. Are you sure your key is correct?");
    }
    const tipAccount = new PublicKey(tipAccounts.value[0]);

    let blockHash = await connection.getLatestBlockhash('confirmed');
    console.log(`Latest blockhash => ${blockHash.blockhash}`);
    const b = new Bundle([], bundleTxnLimit);

    const transactions = await Promise.all(
        txnCallbacks.map(async (cb) => cb(blockHash, tipAccount))
    );

    let isResolved: { [key: string]: boolean } = {};

    // Handler
    const onResult = (result: BundleResult) => {
        if (isResolved[result.bundleId]) return;

        if (result.accepted) {
            console.log('Bundle accepted =>', result);
            isResolved[result.bundleId] = true;
        } else if (result.rejected) {
            console.log('Bundle rejected =>', result);
            isResolved[result.bundleId] = true;
        }
    };
    client.onBundleResult(onResult, console.error);

    // Send each partial-bundle
    for (const txn of transactions) {
        if (txn.length > bundleTxnLimit) {
            throw new Error(`Bundle transaction limit exceeded: max ${bundleTxnLimit}`);
        }
        let maybeBundle = b.addTransactions(...txn);
        if (isError(maybeBundle)) {
            throw maybeBundle;
        }
        const resp = await client.sendBundle(maybeBundle);
        console.log('Bundle sent =>', resp);
    }
};
