import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getTokenBalance, getWsolBalance } from '../raydium/execute-txns';
import BN from 'bn.js';
import { loadEnv } from '../utils/load-env';
import * as bs58 from 'bs58';
import { getDeployerKeyPairs, getTeamKeyPairs } from './fund-deployers';
import { Config } from '../config';
import { getPoolKeysFromMarketId } from '../raydium/get-pool-keys-from-market-id';
import fs from 'fs';
import Bottleneck from 'bottleneck';
import cliProgress from 'cli-progress';

// Load environment variables
loadEnv();

// Extract and parse environment variables
const privateKeyBase58 = process.env.PRIVATE_KEY!;
const privateKey = bs58.decode(privateKeyBase58);
const mintAddress = new PublicKey(process.env.MINT_ADDRESS!);
const keypair = Keypair.fromSecretKey(privateKey);

export async function displayBalances(connection: Connection, pubKeys: PublicKey[], withPool: boolean = false, tokenMint: PublicKey = mintAddress, decimals: number = Config.Token.decimals, rps: number = 500) {
	const chunkSize = 10;
	// 5 RPC calls per wallet
	const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 5 * chunkSize * 1000 / rps });
	const balances: { Address: string; SOL: number; WSOL: number; Tokens: number }[] = [];

	const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
	progressBar.start(pubKeys.length, 0);

	for (let i = 0; i < pubKeys.length; i += chunkSize) {
		const chunk = pubKeys.slice(i, i + chunkSize);
		balances.push(...await limiter.schedule(async () => Promise.all(chunk.map(pubKey => getBalances(connection, pubKey, tokenMint, decimals)))));
		progressBar.increment(chunk.length);
	}

	progressBar.stop();

	if (withPool) {
		try {
			const poolKeys = await getPoolKeysFromMarketId(new PublicKey(process.env.MARKET_ID!));
			const { baseVault, quoteVault } = poolKeys;
			const wsolBalance = await connection.getBalance(quoteVault);
			const tokenBalance = new BN((await connection.getTokenAccountBalance(baseVault)).value.amount);
			const poolBalance = {
				Address: 'Liquidity Pool',
				SOL: 0,
				WSOL: wsolBalance / LAMPORTS_PER_SOL,
				Tokens: tokenBalance.div(new BN(10 ** decimals)).toNumber(),
			};
			balances.push(poolBalance);
		} catch (err) {
			// Ignore error if pool is not found, simply skip the row
		}
	}

	const totals = balances.reduce((acc, balance) => {
		acc.SOL += balance.SOL;
		acc.WSOL += balance.WSOL;
		acc.Tokens += balance.Tokens;
		return acc;
	}, { SOL: 0, WSOL: 0, Tokens: 0, Address: 'Total' });
	balances.push(totals);

	// Format for display
	const formattedBalances = balances.map(balance => ({
		Address: balance.Address,
		SOL: balance.SOL.toFixed(2),
		WSOL: balance.WSOL.toFixed(2),
		Tokens: new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(balance.Tokens),
	}));

	console.table(formattedBalances);
}

async function getBalances (connection: Connection, pubKey: PublicKey, tokenMint: PublicKey = mintAddress, decimals: number = Config.Token.decimals): Promise<{ Address: string; SOL: number; WSOL: number; Tokens: number }> {
	let solBalance = 0; let tokenBalance = new BN(0); let wsolBalance = new BN(0);

	try {
		solBalance = await connection.getBalance(pubKey);
	} catch (err) {
		// Ignore error
	}

	try {
		wsolBalance = await getWsolBalance(connection, pubKey);
	} catch (err) {
		// Ignore error
	}

	try {
		tokenBalance = await getTokenBalance(connection, pubKey, tokenMint);
	} catch (err) {
		// Ignore error
	}

	return {
		Address: pubKey.toBase58(),
		SOL: solBalance / LAMPORTS_PER_SOL,
		WSOL: wsolBalance.toNumber() / LAMPORTS_PER_SOL,
		Tokens: tokenBalance.div(new BN(10 ** decimals)).toNumber(),
	};
}

export type TokenInfo = {
	tokenMint: PublicKey;
	decimals: number;
	symbol: string;
}

export type BalanceInfo = {
	Address: string;
	SOL: number;
	WSOL: number;
	[key: string]: number | string;
}

export async function displayTokenBalances (connection: Connection, pubKeys: PublicKey[], tokenInfos: TokenInfo[]) {
	const chunkSize = 10;
	// 5 RPC calls per wallet
	const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 5 * chunkSize * 1000 / 100 });
	const balances: BalanceInfo[] = [];

	const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
	progressBar.start(pubKeys.length, 0);

	for (let i = 0; i < pubKeys.length; i += chunkSize) {
		const chunk = pubKeys.slice(i, i + chunkSize);
		balances.push(...await limiter.schedule(async () => Promise.all(chunk.map(pubKey => getTokenBalances(connection, pubKey, tokenInfos)))));
		progressBar.increment(chunk.length);
	}

	progressBar.stop();

	const totals = balances.reduce((acc, balance) => {
		for (const [key, value] of Object.entries(balance)) {
			if (key === 'Address') continue;
			acc[key] = (typeof acc[key] === 'number' ? acc[key] : 0) + (typeof value === 'number' ? value : 0);
		}
		return acc;
	}, { Address: 'Total', SOL: 0, WSOL: 0, ...Object.fromEntries(tokenInfos.map(tokenInfo => [tokenInfo.symbol, 0])) });

	balances.push(totals);

	// Format for display
	const formattedBalances = balances.map(balance => {
		const formattedBalance: { [key: string]: number | string } = { Address: balance.Address };

		for (const [key, value] of Object.entries(balance)) {
			if (key === 'Address') continue;
			if (key === 'SOL' || key === 'WSOL') {
				formattedBalance[key] = (typeof value === 'number' ? value.toFixed(2) : value);
			} else {
				formattedBalance[key] = typeof value === 'number' ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value) : value;
			}
		}

		return formattedBalance;
	});

	console.table(formattedBalances);
}

async function getTokenBalances (connection: Connection, pubKey: PublicKey, tokenInfos: TokenInfo[]): Promise<BalanceInfo> {
	let solBalance = 0; let wsolBalance = new BN(0);
	const tokenBalances: { [key: string]: number } = {};

	try {
		solBalance = await connection.getBalance(pubKey);
	} catch (err) {
		// Ignore error
	}

	try {
		wsolBalance = await getWsolBalance(connection, pubKey);
	} catch (err) {
		// Ignore error
	}

	for (const tokenInfo of tokenInfos) {
		const { tokenMint, decimals, symbol } = tokenInfo;
		let tokenBalance = new BN(0);

		try {
			tokenBalance = await getTokenBalance(connection, pubKey, tokenMint);
		} catch (err) {
			// Ignore error
		}

		tokenBalances[symbol] = tokenBalance.div(new BN(10 ** decimals)).toNumber();
	}

	return {
		Address: pubKey.toBase58(),
		SOL: solBalance / LAMPORTS_PER_SOL,
		WSOL: wsolBalance.toNumber() / LAMPORTS_PER_SOL,
		...tokenBalances,
	};
}

if (require.main === module) {
	const rpcUrl = process.env.RPC_URL!;
	const connection = new Connection(rpcUrl, Config.rpcCommitment);
	const deployerPublicKeys = getDeployerKeyPairs().map(keypair => keypair.publicKey);

	if (process.argv.includes('--team')) {
		// const teamPublicKeys = Array.from(
		// 	new Set(fs.readFileSync('team-publickeys.txt', 'utf-8').split('\n').filter(x => x.trim() !== ''))
		// ).map(k => new PublicKey(k));
		const teamPublicKeys = getTeamKeyPairs().map(keypair => keypair.publicKey);
		displayBalances(connection, teamPublicKeys).catch(console.error);
	} else if (process.argv.includes('--mm')) {
		const mmWallets = Array.from(
			new Set(fs.readFileSync('recipient-publickeys.txt', 'utf-8').split('\n').filter(x => x.trim() !== ''))
		).map(k => new PublicKey(k));;
		displayBalances(connection, mmWallets).catch(console.error);
	} else if (process.argv.includes('--pks')) {
		const wallets = Array.from(
			new Set(fs.readFileSync('team-privatekeys.txt', 'utf-8').split('\n').filter(x => x.trim() !== ''))
		).map(k => Keypair.fromSecretKey(bs58.decode(k)).publicKey);
		displayBalances(connection, wallets).catch(console.error);
	} else if (process.argv.includes('--own')) {
		const wallets = Array.from(
			new Set(fs.readFileSync('own-publickeys.txt', 'utf-8').split('\n').filter(x => x.trim() !== ''))
		).map(k => new PublicKey(k));
		// displayBalances(connection, wallets, false, new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), 6).catch(console.error);
		displayTokenBalances(connection, wallets, [
			{ tokenMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), decimals: 6, symbol: 'USDC' },
			{ tokenMint: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), decimals: 6, symbol: 'USDT' },
			{ tokenMint: new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"), decimals: 9, symbol: 'JitoSOL' },
			{ tokenMint: new PublicKey("jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v"), decimals: 9, symbol: 'JupSOL' },
		]).catch(console.error);
	} else if (process.argv.includes('--other')) {
		const wallets = Array.from(
			new Set(fs.readFileSync('other-publickeys.txt', 'utf-8').split('\n').filter(x => x.trim() !== ''))
		).map(k => new PublicKey(k));
		displayBalances(connection, wallets).catch(console.error);
	} else {
		displayBalances(connection, [keypair.publicKey, ...deployerPublicKeys]).catch(console.error);
	}
}