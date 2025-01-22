import { Connection, Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import fs from 'fs';
import * as bs58 from 'bs58';
import { getDeployerKeyPairs } from './fund-deployers';
import { createAndSendV0Tx, getAccountCreationInstructions } from '../raydium/execute-txns';
import { loadEnv, updateEnvVariable } from './load-env';
import { Config } from '../config';

// Generates a new mnemonic phrase
function generateMnemonic(): string {
	return bip39.generateMnemonic();
}

// Derive a seed from the mnemonic
function deriveSeed(mnemonic: string): Buffer {
	if (!bip39.validateMnemonic(mnemonic)) {
		throw new Error('Invalid mnemonic phrase.');
	}
	return bip39.mnemonicToSeedSync(mnemonic);
}

// Generate multiple Solana wallets from a mnemonic
function generateSolanaWallets(mnemonic: string, numberOfWallets: number): Keypair[] {
	const seed = deriveSeed(mnemonic);
	const wallets: Keypair[] = [];

	for (let index = 0; index < numberOfWallets; index++) {
		// Derive a path according to BIP44, Solana's coin type is 501
		// Follows Phantom wallet's derivation path: https://help.phantom.app/hc/en-us/articles/12988493966227-What-derivation-paths-does-Phantom-wallet-support
		const path = `m/44'/501'/${index}'/0'`;
		const keyData = derivePath(path, seed.toString('hex')).key;
		const keypair = Keypair.fromSeed(keyData);
		wallets.push(keypair);
	}

	return wallets;
}

function saveKeyPairsToFile(keypairs: Keypair[], filename: string = 'deployer-keypairs.json') {
	// Check if the file already exists
	if (fs.existsSync(filename)) {
		throw new Error(`File ${filename} already exists. Please delete it first.`);
	}
	const serializedKeypairs = keypairs.map(keypair => ({
		publicKey: keypair.publicKey.toBase58(),
		privateKey: bs58.encode(keypair.secretKey),
		secretKey: Array.from(keypair.secretKey)
	}));

	fs.writeFileSync(filename, JSON.stringify(serializedKeypairs, null, 2));
	console.log(`${keypairs.length} keypairs created and saved to ${filename}`);
}

function generateAndSaveKeyPairs() {
	const mnemonic = generateMnemonic();
	console.log(`Generated Mnemonic: ${mnemonic}`);

	const numberOfWallets = Config.subsequentSwapsInSol.length;
	const wallets = generateSolanaWallets(mnemonic, numberOfWallets);

	saveKeyPairsToFile(wallets);
	updateEnvVariable('DEPLOYER_MNEMONIC', '"' + mnemonic + '"');
}

function generateAndSaveTeamKeypairs(numTeamWallets: number = Config.subsequentSwapsInSol.length) {
	const mnemonic = generateMnemonic();
	console.log(`Generated Mnemonic: ${mnemonic}`);

	const wallets = generateSolanaWallets(mnemonic, numTeamWallets);

	saveKeyPairsToFile(wallets, 'team-keypairs.json');
	updateEnvVariable('TEAM_MNEMONIC', '"' + mnemonic + '"');

	const output = wallets.map(k => k.publicKey.toBase58()).join("\n");
	fs.writeFileSync('team-publickeys.txt', output);
	console.log(`Public keys saved to team-publickeys.txt`);
}

function generateAndSaveMMWallets(numMMWallets: number = 12) {
	const mnemonic = generateMnemonic();
	console.log(`Generated Mnemonic: ${mnemonic}`);

	const wallets = generateSolanaWallets(mnemonic, numMMWallets);

	saveKeyPairsToFile(wallets, 'mm-keypairs.json');
	updateEnvVariable('MM_MNEMONIC', '"' + mnemonic + '"');

	const output = wallets.map(k => k.publicKey.toBase58()).join("\n");
	fs.writeFileSync('recipient-publickeys.txt', output);
	console.log(`Public keys saved to recipient-publickeys.txt`);
}

async function createDeployerAccounts(): Promise<void> {
	loadEnv();
	const rpcUrl = process.env.RPC_URL!;
	const privateKeyBase58 = process.env.PRIVATE_KEY!;
	const privateKey = bs58.decode(privateKeyBase58);
	const keypair = Keypair.fromSecretKey(privateKey);
	const connection = new Connection(rpcUrl, Config.rpcCommitment);

	const deployerKeypairs: Keypair[] = getDeployerKeyPairs();
	const chunkSize = 5;

	for (let i = 0; i < deployerKeypairs.length; i += chunkSize) {
		const chunk = deployerKeypairs.slice(i, i + chunkSize);
		const instructions = await getAccountCreationInstructions(connection, chunk.map(k => k.publicKey), keypair);
		await createAndSendV0Tx({ connection, ix: instructions, signers: [keypair, ...chunk] });
	}
}

async function createDeployerKeypairsFromPks() {
	const pks = fs.readFileSync('deployer-pks.txt', 'utf-8').split('\n').map(pk => pk.trim());
	const keypairs = pks.map(pk => Keypair.fromSecretKey(bs58.decode(pk)));
	saveKeyPairsToFile(keypairs, 'dep-keypairs.json');
	console.log(keypairs.map(k => '[' + k.secretKey + ']').join('\n'));
}

if (require.main === module) {
	if (process.argv.includes('--team')) {
		generateAndSaveTeamKeypairs(100);
	} else if (process.argv.includes('--mm')) {
		generateAndSaveMMWallets();
	} else if (process.argv.includes('--pks')) {
		createDeployerKeypairsFromPks();
	} else {
		generateAndSaveKeyPairs();
	}
	// createDeployerAccounts().catch(console.error);
}