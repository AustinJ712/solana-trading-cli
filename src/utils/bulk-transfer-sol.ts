import {
	Connection,
	PublicKey,
	TransactionInstruction,
	Keypair,
	SendOptions,
	Signer,
	SystemProgram,
} from "@solana/web3.js";
import { createAndSendV0Tx } from "../raydium/execute-txns";
import Bottleneck from "bottleneck";
import { Config } from "../config";

export interface BulkTransferInfo {
	recipientAddress: string;
	amount: bigint; // lamports amount
	txnId?: string; // Unique identifier for the transaction
}

// Maximum number of transfers allowed in a single transaction based on 1232 bytes limit
export const NUM_BULK_TRANSFERS_PER_TXN = 10;

export async function bulkTransferSOLInSingleTxn(
	connection: Connection,
	owner: Keypair,
	transfers: BulkTransferInfo[],
	signers: Signer[],
	addPriorityFee: boolean = true,
	minPriorityFee: number = Config.minPriorityFee,
	options: SendOptions = {},
	confirm: boolean = true,
	numTransfersPerTxn: number = NUM_BULK_TRANSFERS_PER_TXN
) {
	const instructions: TransactionInstruction[] = [];

	if (transfers.length === 0) {
		throw new Error("No transfers specified");
	}

	if (transfers.length > numTransfersPerTxn) {
		throw new Error(`Bulk transfer limit exceeded. Max ${numTransfersPerTxn} transfers allowed per transaction`);
	}

	for (const transfer of transfers) {
		const recipientPublicKey = new PublicKey(transfer.recipientAddress);

		// Add the SOL transfer instruction
		instructions.push(
			SystemProgram.transfer({
				fromPubkey: owner.publicKey,
				toPubkey: recipientPublicKey,
				lamports: transfer.amount,
			})
		);
	}

	// Send the transaction
	await createAndSendV0Tx({ connection, ix: instructions, signers, addPriorityFee, minPriorityFee, options, confirm });
}

export async function bulkTransferSOL(
	connection: Connection,
	owner: Keypair,
	transfers: BulkTransferInfo[],
	signers: Signer[],
	rps: number = 10, // RPC calls per second
	addPriorityFee: boolean = true,
	minPriorityFee: number = Config.minPriorityFee,
	options: SendOptions = {},
	confirm: boolean = true,
	successCallback?: (transfers: BulkTransferInfo[]) => Promise<void>,
	numTransfersPerTxn: number = NUM_BULK_TRANSFERS_PER_TXN
) {
	if (transfers.length <= numTransfersPerTxn) {
		await bulkTransferSOLInSingleTxn(connection, owner, transfers, signers, addPriorityFee, minPriorityFee, options, confirm, numTransfersPerTxn);
		if (successCallback) {
			await successCallback(transfers);
		}
		return;
	}

	// Calculate the balance SOL in the account
	const startingBalance = await connection.getBalance(owner.publicKey); // lamports
	const totalTransferAmount = transfers.reduce((acc, transfer) => acc + transfer.amount, 0n);

	// Check if the owner has enough balance to cover the total transfer amount
	if (startingBalance < totalTransferAmount) {
		throw new Error(`Insufficient balance. Required SOL: ${totalTransferAmount}, Available: ${startingBalance}`);
	}

	// Add a rate limiter to limit the transactions based on provided TPS (transactions per second)
	// TPS is calculated as RPS since each transaction has ~1 RPC calls assuming 10 transfers per transaction
	const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 1000 / rps });

	// Chunk the transfers into groups of BULK_TRANSFER_LIMIT_PER_TXN
	for (let i = 0; i < transfers.length; i += numTransfersPerTxn) {
        const chunk = transfers.slice(i, i + numTransfersPerTxn);

		const isLastChunk = i + numTransfersPerTxn >= transfers.length;

        // Schedule the chunked transfers using the rate limiter. We always block for confirmation on the last chunk.
        await limiter.schedule(async () => bulkTransferSOLInSingleTxn(
			connection, owner, chunk, signers, addPriorityFee, minPriorityFee, options, isLastChunk || confirm, numTransfersPerTxn
		));

		if (successCallback) {
			await successCallback(chunk);
		}
    }

	console.log(`Bulk SOL transfer of ${transfers.length} transfers completed`);
}