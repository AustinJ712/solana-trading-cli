import { Keypair } from "@solana/web3.js";
import { Config } from "../config";
import { getDeployerKeyPairs, getTeamKeyPairs } from "./fund-deployers";
import bs58 from 'bs58';

export async function displayPubKeys() {
    const deployerKeypairs = getDeployerKeyPairs();
    console.log(deployerKeypairs.map(k => k.publicKey.toBase58()).join('\n'));
}

export async function displayTeamKeys() {
    const deployerKeypairs = getTeamKeyPairs();
    console.log(deployerKeypairs.map(k => k.publicKey.toBase58()).join('\n'));
}

export async function displayPrivateKeys() {
    const deployerKeypairs = getDeployerKeyPairs();
    console.log(deployerKeypairs.map(k => bs58.encode(k.secretKey)).join('\n'));
}

export async function displayMMKeys() {
    const deployerKeypairs = getTeamKeyPairs('mm-keypairs.json');
    console.log(deployerKeypairs.map(k => k.publicKey.toBase58()).join('\n'));
}

export async function displayPrivateKeysInUint8Array(startIndex: number = 0, numWallets: number = Config.subsequentSwapsInSol.length) {
    const deployerKeypairs = getDeployerKeyPairs().slice(startIndex, startIndex + numWallets);
    console.log(deployerKeypairs.map(k => '[' + k.secretKey + ']').join('\n'));
}

export async function displayUint8ArrayFromPrivateKey(privateKey: string) {
    const deployerKeypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    console.log('[' + deployerKeypair.secretKey + ']');
}

if (require.main === module) {
    if (process.argv.includes('--private')) {
        displayPrivateKeys();
    } else if (process.argv.includes('--team')) {
        displayTeamKeys();
    } else if (process.argv.includes('--mm')) {
        displayMMKeys();
    } else if (process.argv.includes('--array')) {
        displayPrivateKeysInUint8Array(88, 12);
    } else if (process.argv.includes('--from')) {
        displayUint8ArrayFromPrivateKey(process.argv[process.argv.indexOf('--from') + 1]);
    } else {
        displayPubKeys();
    }
}