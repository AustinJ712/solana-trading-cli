import { AddressLookupTableAccount, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Signer, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { prepareV0Tx } from "../raydium/execute-txns";
import { Config } from "../config";
import { loadEnv } from "../utils/load-env";
import { getDeployerKeyPairs } from "../utils/fund-deployers";
import bs58 from "bs58";

export interface PostSubmitBatchRequest {
    entries: PostSubmitRequestEntry[];
    submitStrategy: SubmitStrategy;
    useBundle?: boolean;
    frontRunningProtection?: boolean;
}

export interface PostSubmitRequestEntry {
    transaction?: TransactionMessage;
    skipPreFlight: boolean;
}

export interface TransactionMessage {
    content: string;
    isCleanup: boolean;
}

export type SubmitStrategy =
    | "P_UKNOWN"
    | "P_SUBMIT_ALL"
    | "P_ABORT_ON_FIRST_ERROR"
    | "P_WAIT_FOR_CONFIRMATION";

export interface PostSubmitBatchResponse {
    transactions: PostSubmitBatchResponseEntry[];
}

export interface PostSubmitBatchResponseEntry {
    signature: string;
    error: string;
    submitted: boolean;
}

export interface PostSubmitRequest {
    transaction?: TransactionMessage;
    skipPreFlight: boolean;
    frontRunningProtection?: boolean;
    tip?: string;
    useStakedRPCs?: boolean;
    fastBestEffort?: boolean;
    allowBackRun?: boolean;
    revenueAddress?: string;
}

export interface PostSubmitResponse {
    signature: string;
}

export const BLOXROUTE_API_TIP_WALLET = "HWEoBxYs7ssKuudEjzjmpfJVX7Dvi7wescFsVx2L5yoY";
export const TRADER_API_MEMO_PROGRAM = "HQ2UUt18uJqKaQFJhgV9zaTdQxUZjNrsKFgoEDquBkcx";

export class BloxrouteProvider {
    private readonly authHeader: string;
    private readonly baseUrl: string;
    private readonly apiV1Url: string;
    private readonly apiV2Url: string;

    constructor(authHeader: string, baseUrl: string) {
        this.authHeader = authHeader;
        this.baseUrl = baseUrl;
        this.apiV1Url = `${baseUrl}/api/v1`;
        this.apiV2Url = `${baseUrl}/api/v2`;
    }

    private async post<T, R>(path: string, data: T): Promise<R> {
        const response = await fetch(path, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: this.authHeader,
            },
            body: JSON.stringify(data),
        });

        const responseData = await response.json();

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} with data: ${JSON.stringify(responseData)}`);
        }

        return responseData as R;
    }

    public async submitBatchTxs({ ixs, signers, submitStrategy = "P_SUBMIT_ALL", useBundle = false, frontRunningProtection = false, connection, computeUnits, addPriorityFee = true, minPriorityFee = Config.minPriorityFee, fixedPriorityFee = false, lookupTableAccounts, confirm = true }: {
        ixs: TransactionInstruction[][], signers: Signer[][], submitStrategy?: SubmitStrategy,
        useBundle?: boolean, frontRunningProtection?: boolean, computeUnits?: number, connection: Connection, confirm?: boolean,
        addPriorityFee?: boolean, minPriorityFee?: number, fixedPriorityFee?: boolean, lookupTableAccounts?: AddressLookupTableAccount[] | undefined,
    }) {
        for (let i = 0; i < ixs.length; i++) {
            // ixs[i].push(this.getMemoIx());
            ixs[i].push(this.getTipIx(signers[i][0].publicKey));
            // console.log(`Tx ${i + 1} prepared with ${ixs[i].length} instructions`);
        }

        const recentBlockhash = await connection.getLatestBlockhash(Config.rpcCommitment);

        const txs = await Promise.all(ixs.map(async (ix, i) => {
            return prepareV0Tx({ connection, ix, signers: signers[i], computeUnits, addPriorityFee, recentBlockhash: recentBlockhash.blockhash, minPriorityFee, fixedPriorityFee, lookupTableAccounts });
        }));

        const entries: PostSubmitRequestEntry[] = txs.map((txn) => {
            const serializedTx = txn.serialize();
            const encodedTx = Buffer.from(serializedTx).toString("base64");
            return {
                transaction: {
                    content: encodedTx,
                    isCleanup: false,
                },
                skipPreFlight: true,
            }
        });

        const response = await this.submitBatch({ entries, submitStrategy, useBundle, frontRunningProtection });
        for (let i = 0; i < response.transactions.length; i++) {
            if (response.transactions[i].submitted) {
                console.log(`✈️ Tx ${i + 1} submitted: ${response.transactions[i].signature}`);
            } else {
                console.log(`❌ Tx ${i + 1} failed: ${response.transactions[i].error}, signature: ${response.transactions[i].signature}`);
            }
        }
        if (confirm) {
            const confirmations = await Promise.all(response.transactions.map((tx) => connection.confirmTransaction({ signature: tx.signature, blockhash: recentBlockhash.blockhash, lastValidBlockHeight: recentBlockhash.lastValidBlockHeight }, Config.rpcCommitment)));
            for (let i = 0; i < confirmations.length; i++) {
                if (confirmations[i].value.err) {
                    console.log(`❌ Tx ${i + 1} failed: ${response.transactions[i].signature}`);
                } else {
                    console.log(`✅ Tx ${i + 1} confirmed: ${response.transactions[i].signature}`);
                }
            }
        }
        return response;
    }

    public async submitBatch(request: PostSubmitBatchRequest): Promise<PostSubmitBatchResponse> {
        return this.post<PostSubmitBatchRequest, PostSubmitBatchResponse>(`${this.apiV2Url}/submit-batch`, request);
    }

    public async submitTx({ ix, signers, connection, computeUnits, frontRunningProtection = false, fastBestEffort = false, useStakedRPCs = false, allowBackRun = false, tipAmountInSol = 0.001, revenueAddress, lookupTableAccounts, addPriorityFee = true, minPriorityFee = Config.minPriorityFee, fixedPriorityFee = false, confirm = true }: {
        ix: TransactionInstruction[], signers: Signer[], connection: Connection, computeUnits: number, tipAmountInSol?: number, confirm?: boolean,
        frontRunningProtection?: boolean, fastBestEffort?: boolean, useStakedRPCs?: boolean, allowBackRun?: boolean, revenueAddress?: string,
        addPriorityFee?: boolean, minPriorityFee?: number, fixedPriorityFee?: boolean, lookupTableAccounts?: AddressLookupTableAccount[] | undefined,
    }) {
        ix.push(this.getTipIx(signers[0].publicKey, tipAmountInSol));

        const recentBlockhash = await connection.getLatestBlockhash(Config.rpcCommitment);
        const txn = await prepareV0Tx({ connection, ix, signers, computeUnits, recentBlockhash: recentBlockhash.blockhash, lookupTableAccounts, addPriorityFee, minPriorityFee, fixedPriorityFee });
        const encodedTx = Buffer.from(txn.serialize()).toString("base64");

        const response = await this.submitTxn({
            transaction: {
                content: encodedTx,
                isCleanup: false,
            },
            skipPreFlight: true,
            frontRunningProtection,
            fastBestEffort,
            useStakedRPCs,
            allowBackRun,
            revenueAddress,
        });

        console.log(`✈️ Tx submitted: ${response.signature}`);

        if (confirm) {
            const confirmation = await connection.confirmTransaction({ signature: response.signature, blockhash: recentBlockhash.blockhash, lastValidBlockHeight: recentBlockhash.lastValidBlockHeight }, Config.rpcCommitment);
            if (confirmation.value.err) {
                console.log(`❌ Tx failed: ${response.signature}`);
            } else {
                console.log(`✅ Tx confirmed: ${response.signature}`);
            }
        }

        return response;
    }

    public async submitTxn(request: PostSubmitRequest): Promise<PostSubmitResponse> {
        return this.post<PostSubmitRequest, PostSubmitResponse>(`${this.apiV2Url}/submit`, request);
    }

    public getTipIx(sender: PublicKey, tipAmountInSol: number = 0.001): TransactionInstruction {
        // required once per batch, but testing revealed required on every tx
        tipAmountInSol = Math.max(0.001, tipAmountInSol); // Minimum tip amount is 0.001 SOL

        return SystemProgram.transfer({
            fromPubkey: sender,
            toPubkey: new PublicKey(BLOXROUTE_API_TIP_WALLET),
            lamports: tipAmountInSol * LAMPORTS_PER_SOL,
        });
    }

    public getMemoIx(msg: string = "Powered by bloXroute Trader Api"): TransactionInstruction {
        // required on every tx, but testing revealed not really required lol
        return new TransactionInstruction({
            keys: [],
            programId: new PublicKey(TRADER_API_MEMO_PROGRAM),
            data: Buffer.from(msg),
        });
    }
}

if (require.main === module) {
    loadEnv();
    const authHeader = process.env.BLOXROUTE_AUTH_HEADER!;
    const baseUrl = process.env.BLOXROUTE_BASE_URL!;
    const blx = new BloxrouteProvider(authHeader, baseUrl);
    const connection = new Connection(process.env.RPC_URL!, Config.rpcCommitment);
    const mainDeployer = new PublicKey(process.env.PUBLIC_KEY!);

    if (process.argv.includes('--batch')) {
        const deployerKeypairs = getDeployerKeyPairs().slice(0, 6);
        const ixs: TransactionInstruction[][] = [];
        const signers: Signer[][] = [];
        const txAmountInSol = 0.01;
        for (let i = 0; i < deployerKeypairs.length; i++) {
            ixs.push([SystemProgram.transfer({
                fromPubkey: deployerKeypairs[i].publicKey,
                toPubkey: mainDeployer,
                lamports: txAmountInSol * LAMPORTS_PER_SOL,
            })]);
            signers.push([deployerKeypairs[i]]);
        }
        blx.submitBatchTxs({ ixs, signers, connection, computeUnits: 20_000, submitStrategy: "P_SUBMIT_ALL" }).catch(console.error);
    } else {
        const keypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
        const ix = [SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: getDeployerKeyPairs()[0].publicKey,
            lamports: 0.01 * LAMPORTS_PER_SOL,
        })];
        blx.submitTx({ ix, signers: [keypair], connection, computeUnits: 20_000, frontRunningProtection: true, fastBestEffort: true }).catch(console.error);
    }
}