import {
	Connection,
	PublicKey,
	TransactionInstruction,
	Keypair,
	SendOptions,
	Signer,
} from "@solana/web3.js";
import {
	createAssociatedTokenAccountInstruction,
	createTransferInstruction,
	getAssociatedTokenAddress,
	getAccount,
} from "@solana/spl-token";
import { createAndSendV0Tx, getOrCreateAta } from "../raydium/execute-txns";
import Bottleneck from "bottleneck";
import { Config } from "../config";

export interface BulkTransferInfo {
	recipient: PublicKey;
	sender: PublicKey;
	senderTokenAccount?: PublicKey;
	amount: bigint; // Token amount in the smallest unit (e.g., lamports for SOL)
	txnId?: string; // Unique identifier for the transaction
}

export async function bulkTransferOneToOneSPLTokensInSingleTxn(
	connection: Connection,
	mintAddress: PublicKey,
	transfers: BulkTransferInfo[],
	signers: Signer[],
	addPriorityFee: boolean = true,
	minPriorityFee: number = Config.minPriorityFee,
	options: SendOptions = {},
	confirm: boolean = true,
	payer?: Signer
) {
	const instructions: TransactionInstruction[] = [];

	if (transfers.length === 0) {
		throw new Error("No transfers specified");
	}

	// Cache the recipient accounts to avoid adding duplicate createATA instructions
	const recipientAccountsProcessed = new Set<string>();

	for (const transfer of transfers) {
		const associatedTokenAddress = await getAssociatedTokenAddress(
			mintAddress,
			transfer.recipient,
			true,
		  );

		// Create the associated token account for the recipient if it has not been created yet
		if (!recipientAccountsProcessed.has(transfer.recipient.toBase58())) {
			// Check if the account already exists
			const accountInfo = await connection.getAccountInfo(associatedTokenAddress);

			if (!accountInfo) {
				// Create the associated token account for the recipient if it does not exist
				instructions.push(
					createAssociatedTokenAccountInstruction(
						transfer.sender,
						associatedTokenAddress,
						transfer.recipient,
						mintAddress,
					)
				);
			}
			recipientAccountsProcessed.add(transfer.recipient.toBase58());
		}

		// Add the SPL token transfer instruction
		instructions.push(
			createTransferInstruction(
				transfer.senderTokenAccount || (await getAssociatedTokenAddress(mintAddress, transfer.sender, true)),
				associatedTokenAddress,
				transfer.sender,
				transfer.amount,
				[],
			)
		);
	}

	// Send the transaction
	if (payer) {
		signers.unshift(payer);
	}
	await createAndSendV0Tx({ connection, ix: instructions, signers, addPriorityFee, minPriorityFee, options, confirm });
}

export async function bulkTransferOneToOneSPLTokens(
	connection: Connection,
	mintAddress: PublicKey,
	transfers: BulkTransferInfo[],
	signers: Signer[],
	rps: number = 10, // RPC calls per second
	numTransfersPerTxn: number = 1,
	addPriorityFee: boolean = true,
	minPriorityFee: number = Config.minPriorityFee,
	options: SendOptions = {},
	confirm: boolean = true,
	successCallback?: (transfers: BulkTransferInfo[]) => Promise<void>,
	payer?: Signer
) {
	if (transfers.length <= numTransfersPerTxn) {
		await bulkTransferOneToOneSPLTokensInSingleTxn(connection, mintAddress, transfers, signers, addPriorityFee, minPriorityFee, options, confirm, payer);
		if (successCallback) {
			await successCallback(transfers);
		}
		return;
	}

	// Add a rate limiter to limit the transactions based on provided TPS (transactions per second)
	// TPS is calculated as RPS / 25 since each transaction has ~25 RPC calls assuming 10 transfers per transaction
	const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 2500 * numTransfersPerTxn / rps });

	// Chunk the transfers into groups of numTransfersPerTxn
	for (let i = 0; i < transfers.length; i += numTransfersPerTxn) {
        const chunk = transfers.slice(i, i + numTransfersPerTxn);
		const chunkSigners = signers.filter((s) => chunk.some((t) => t.sender.equals(s.publicKey)));

		const isLastChunk = i + numTransfersPerTxn >= transfers.length;

        // Schedule the chunked transfers using the rate limiter. We always block for confirmation on the last chunk.
        await limiter.schedule(async () => bulkTransferOneToOneSPLTokensInSingleTxn(
			connection, mintAddress, chunk, chunkSigners, addPriorityFee, minPriorityFee, options, isLastChunk || confirm, payer
		));

		if (successCallback) {
			await successCallback(chunk);
		}
    }

	console.log(`Bulk transfer of ${transfers.length} transfers completed`);
}