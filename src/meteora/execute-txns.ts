import {
	Connection,
	PublicKey,
	Signer,
	TransactionInstruction,
	VersionedTransaction,
	TransactionMessage,
	AddressLookupTableAccount,
	SystemProgram,
	LAMPORTS_PER_SOL,
	ComputeBudgetProgram,
	SendOptions,
	TransactionExpiredBlockheightExceededError,
  } from "@solana/web3.js";
  import BN from "bn.js";
  import retry from "async-retry";
  
  export type BlockhashWithExpiryBlockHeight = {
	blockhash: string;
	lastValidBlockHeight: number;
  };
  
  // If you want to fetch an estimate from Helius or keep a cached priority fee
  async function getMedianPrioritizationFee(): Promise<number> {
	// Hardcode or implement your fetch from Helius / aggregator if needed:
	// e.g. return await getPriorityFeeEstimate();
	// For now we just default to 2000 microLamports
	return 2000;
  }
  
  export async function createAndSendV0Tx(options: {
	connection: Connection;
	ix: TransactionInstruction[];     // instructions
	signers: Signer[];               // signers
	computeUnits?: number;
	addPriorityFee?: boolean;
	minPriorityFee?: number;         // in micro-lamports
	fixedPriorityFee?: boolean;
	confirm?: boolean;
	lookupTableAccounts?: AddressLookupTableAccount[];
	maxTxnRetries?: number;
	staked?: boolean;                // if you want a staked RPC
	simulateTransaction?: boolean;
  }): Promise<string> {
	const {
	  connection,
	  ix,
	  signers,
	  computeUnits = 0,
	  addPriorityFee = true,
	  minPriorityFee = 1000,
	  fixedPriorityFee = false,
	  confirm = true,
	  lookupTableAccounts,
	  maxTxnRetries = 3,
	  simulateTransaction,
	} = options;
  
	if (ix.length === 0) {
	  throw new Error("No instructions provided");
	}
	if (signers.length === 0) {
	  throw new Error("No signers provided");
	}
  
	// 1) Build final instruction array
	let instructions = [...ix];
  
	const latest = await connection.getLatestBlockhash();
	const blockhash = latest.blockhash;
	let priorityFee = 0;
  
	// 2) Possibly add a compute-unit-limit and priority fee
	if (computeUnits > 0) {
	  instructions.unshift(
		ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })
	  );
	}
  
	if (addPriorityFee) {
	  if (fixedPriorityFee) {
		// use exactly minPriorityFee
		priorityFee = minPriorityFee;
	  } else {
		// fetch from aggregator or fallback
		priorityFee = await getMedianPrioritizationFee();
		if (priorityFee < minPriorityFee) {
		  priorityFee = minPriorityFee;
		}
	  }
	  instructions.unshift(
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })
	  );
	}
  
	// 3) Create a VersionedTransaction
	const msgV0 = new TransactionMessage({
	  payerKey: signers[0].publicKey,
	  recentBlockhash: blockhash,
	  instructions,
	}).compileToV0Message(lookupTableAccounts);
	const tx = new VersionedTransaction(msgV0);
	tx.sign(signers);
  
	// 4) (Optional) Simulate
	if (simulateTransaction) {
	  const simRes = await connection.simulateTransaction(tx, {
		replaceRecentBlockhash: true,
	  });
	  if (simRes.value.err) {
		throw new Error(
		  `Transaction simulation failed: ${JSON.stringify(simRes.value.err)}`
		);
	  }
	}
  
	// 5) Send + Confirm
	const txid = await retry(
	  async () => {
		const signature = await connection.sendTransaction(tx, {
		  skipPreflight: true,
		  maxRetries: 10,
		} as SendOptions);
  
		if (confirm) {
		  const rc = await connection.confirmTransaction(
			{
			  signature,
			  blockhash: blockhash,
			  lastValidBlockHeight: latest.lastValidBlockHeight,
			},
			"confirmed"
		  );
		  if (rc.value.err) {
			throw new Error(`Transaction ${signature} failed`);
		  }
		  console.log(`✅ Tx confirmed: ${signature}`);
		} else {
		  console.log(`✈️ Tx sent: ${signature}`);
		}
		return signature;
	  },
	  {
		retries: maxTxnRetries,
		factor: 1.5,
		minTimeout: 500,
		onRetry: (err, attempt) => {
		  if (err instanceof TransactionExpiredBlockheightExceededError) {
			throw err;
		  }
		  console.log(`Retrying... ${attempt}/${maxTxnRetries}`);
		},
	  }
	);
	return txid;
  }
  