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
	recipientAddress: string;
	amount: bigint; // Token amount in the smallest unit (e.g., lamports for SOL)
	txnId?: string; // Unique identifier for the transaction
}

// Maximum number of transfers allowed in a single transaction based on 1232 bytes limit
export const BULK_TRANSFER_LIMIT_PER_TXN = 10;

export async function bulkTransferSPLTokensInSingleTxn(
	connection: Connection,
	owner: Keypair,
	mintAddress: PublicKey,
	transfers: BulkTransferInfo[],
	ownerTokenAccount: PublicKey,
	signers: Signer[],
	addPriorityFee: boolean = true,
	minPriorityFee: number = Config.minPriorityFee,
	options: SendOptions = {},
	confirm: boolean = true
) {
	const instructions: TransactionInstruction[] = [];

	if (transfers.length === 0) {
		throw new Error("No transfers specified");
	}

	if (transfers.length > BULK_TRANSFER_LIMIT_PER_TXN) {
		throw new Error(`Bulk transfer limit exceeded. Max ${BULK_TRANSFER_LIMIT_PER_TXN} transfers allowed per transaction`);
	}

	// Cache the recipient accounts to avoid adding duplicate createATA instructions
	const recipientAccountsProcessed = new Set<string>();

	for (const transfer of transfers) {
		const recipientPublicKey = new PublicKey(transfer.recipientAddress);
		const associatedTokenAddress = await getAssociatedTokenAddress(
			mintAddress,
			recipientPublicKey,
			true,
		  );

		// Create the associated token account for the recipient if it has not been created yet
		if (!recipientAccountsProcessed.has(recipientPublicKey.toBase58())) {
			// Check if the account already exists
			const accountInfo = await connection.getAccountInfo(associatedTokenAddress);

			if (!accountInfo) {
				// Create the associated token account for the recipient if it does not exist
				instructions.push(
					createAssociatedTokenAccountInstruction(
						owner.publicKey,
						associatedTokenAddress,
						recipientPublicKey,
						mintAddress,
					)
				);
			}
			recipientAccountsProcessed.add(recipientPublicKey.toBase58());
		}

		// Add the SPL token transfer instruction
		instructions.push(
			createTransferInstruction(
				ownerTokenAccount,
				associatedTokenAddress,
				owner.publicKey,
				transfer.amount,
				[],
			)
		);
	}

	// Send the transaction
	await createAndSendV0Tx({ connection, ix: instructions, signers, addPriorityFee, minPriorityFee, options, confirm });
}

export async function bulkTransferSPLTokens(
	connection: Connection,
	owner: Keypair,
	mintAddress: PublicKey,
	transfers: BulkTransferInfo[],
	signers: Signer[],
	rps: number = 10, // RPC calls per second
	addPriorityFee: boolean = true,
	minPriorityFee: number = Config.minPriorityFee,
	options: SendOptions = {},
	confirm: boolean = true,
	successCallback?: (transfers: BulkTransferInfo[]) => Promise<void>,
) {
	const ownerTokenAccount = await getOrCreateAta(
        connection,
        owner,
        mintAddress,
        owner.publicKey,
		true
    );

	if (transfers.length <= BULK_TRANSFER_LIMIT_PER_TXN) {
		await bulkTransferSPLTokensInSingleTxn(connection, owner, mintAddress, transfers, ownerTokenAccount.address, signers, addPriorityFee, minPriorityFee, options, confirm);
		if (successCallback) {
			await successCallback(transfers);
		}
		return;
	}

	// Calculate the balance number of SPL tokens in the account
	let tokenAccountInfo = await getAccount(connection, ownerTokenAccount.address, Config.rpcCommitment);
	const startingBalance = tokenAccountInfo.amount;

	const totalTransferAmount = transfers.reduce((acc, transfer) => acc + transfer.amount, 0n);

	// Check if the owner has enough balance to cover the total transfer amount
	if (startingBalance < totalTransferAmount) {
		throw new Error(`Insufficient balance. Required: ${totalTransferAmount}, Available: ${startingBalance}`);
	}

	// Add a rate limiter to limit the transactions based on provided TPS (transactions per second)
	// TPS is calculated as RPS / 25 since each transaction has ~25 RPC calls assuming 10 transfers per transaction
	const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 2500 * BULK_TRANSFER_LIMIT_PER_TXN / rps });

	// Chunk the transfers into groups of BULK_TRANSFER_LIMIT_PER_TXN
	for (let i = 0; i < transfers.length; i += BULK_TRANSFER_LIMIT_PER_TXN) {
        const chunk = transfers.slice(i, i + BULK_TRANSFER_LIMIT_PER_TXN);

		const isLastChunk = i + BULK_TRANSFER_LIMIT_PER_TXN >= transfers.length;

        // Schedule the chunked transfers using the rate limiter. We always block for confirmation on the last chunk.
        await limiter.schedule(async () => bulkTransferSPLTokensInSingleTxn(
			connection, owner, mintAddress, chunk, ownerTokenAccount.address, signers, addPriorityFee, minPriorityFee, options, isLastChunk || confirm
		));

		if (successCallback) {
			await successCallback(chunk);
		}
    }

	console.log(`Bulk transfer of ${transfers.length} transfers completed`);

	// Check the final balance
	tokenAccountInfo = await getAccount(connection, ownerTokenAccount.address, Config.rpcCommitment);
	const finalBalance = tokenAccountInfo.amount;

	if (finalBalance !== (startingBalance - totalTransferAmount)) {
		// Throw an error if the final balance does not match the expected balance.
		throw new Error(`Balance mismatch. Expected: ${startingBalance - totalTransferAmount}, Actual: ${finalBalance}`);
	}
}