import { Connection, PublicKey, AddressLookupTableAccount } from '@solana/web3.js';

// Simple cache structure to store lookup tables
interface LookupTableCache {
	[key: string]: AddressLookupTableAccount;
}

// Initialize the cache object
const lookupTableCache: LookupTableCache = {};

export async function getLookupTable (connection: Connection, lookupTableAddress: PublicKey): Promise<AddressLookupTableAccount | null> {
	const address = lookupTableAddress.toBase58();
	// Check if the lookup table is already in the cache
	if (lookupTableCache[address]) {
		return lookupTableCache[address];
	}

	// Fetch the lookup table from the blockchain
	const lookupTable = await connection.getAddressLookupTable(lookupTableAddress);
	if (!lookupTable || !lookupTable.value) {
		return null;
	}

	// Add the lookup table to the cache
	lookupTableCache[address] = lookupTable.value;

	return lookupTable.value;
};

export async function getLookupTableForTxn (connection: Connection, lookupTableAddress?: string, throwOnError: boolean = false): Promise<AddressLookupTableAccount[] | undefined> {
	if (!lookupTableAddress) {
		if (throwOnError) throw new Error('Lookup table address not found');
		return undefined;
	}
	const lookupTable = await getLookupTable(connection, new PublicKey(lookupTableAddress));
	if (!lookupTable) {
		if (throwOnError) throw new Error('Lookup table not found');
		return undefined;
	}

	return [lookupTable];
}