import { Connection, Keypair } from '@solana/web3.js';
import { updateEnvVariable } from './load-env';
import bs58 from 'bs58';

function generateDeployerKeypair() {
	const keypair = Keypair.generate();
	console.log(`🔑 Deployer keypair generated: ${keypair.publicKey.toBase58()}`);
	updateEnvVariable('PUBLIC_KEY', keypair.publicKey.toBase58());
	updateEnvVariable('PRIVATE_KEY', bs58.encode(keypair.secretKey));
	return keypair;
}

function generateFundingKeypair() {
	const keypair = Keypair.generate();
	console.log(`🔑 Funding keypair generated: ${keypair.publicKey.toBase58()}`);
	updateEnvVariable('FUNDING_PUBLIC_KEY', keypair.publicKey.toBase58());
	updateEnvVariable('FUNDING_PRIVATE_KEY', bs58.encode(keypair.secretKey));
	return keypair;
}

function generateFreezeKeypair() {
	const keypair = Keypair.generate();
	console.log(`🔑 Freeze keypair generated: ${keypair.publicKey.toBase58()}`);
	updateEnvVariable('FREEZE_PUBLIC_KEY', keypair.publicKey.toBase58());
	updateEnvVariable('FREEZE_PRIVATE_KEY', bs58.encode(keypair.secretKey));
	return keypair;
}

function generateAdditionalKeypair() {
	const keypair = Keypair.generate();
	console.log(`🔑 Additional keypair generated: ${keypair.publicKey.toBase58()}`);
	updateEnvVariable('ADDITIONAL_PUBLIC_KEY', keypair.publicKey.toBase58());
	updateEnvVariable('ADDITIONAL_PRIVATE_KEY', bs58.encode(keypair.secretKey));
	return keypair;
}

if (require.main === module) {
	if (process.argv.includes('--funding')) {
		generateFundingKeypair();
	} else if (process.argv.includes('--freeze')) {
		generateFreezeKeypair();
	} else if (process.argv.includes('--additional')) {
		generateAdditionalKeypair();
	} else {
		generateDeployerKeypair();
	}
}