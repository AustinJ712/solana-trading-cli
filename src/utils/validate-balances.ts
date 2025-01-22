import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import Bottleneck from 'bottleneck';
import { loadEnv } from './load-env';
import { Config } from '../config';
import { getWsolBalance } from '../raydium/execute-txns';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getDeployerKeyPairs } from './fund-deployers';
import { getEnumInput } from './console-helpers';

loadEnv();
const connection = new Connection(process.env.RPC_URL!, Config.rpcCommitment);
const keypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));

export async function validateBalances(targetBalances: BN[], pubKeys: PublicKey[], excludeWsol: boolean = false, rps: number = 100) {
    const limiter = new Bottleneck({ minTime: 2000 / rps });

    const actualBalances = await Promise.all(pubKeys.map(async (pubKey) => limiter.schedule(async () => {
        const solBalance = new BN(await connection.getBalance(pubKey));
        if (excludeWsol) {
            return solBalance;
        }
        let wsolBalance = new BN(0);
        try {
            wsolBalance = await getWsolBalance(connection, pubKey);
        } catch (err) {
            // ignore
        }
        return solBalance.add(wsolBalance);
    })));

    const shortfall = targetBalances.map(
        (target, i) => target.lte(actualBalances[i]) ? new BN(0) : target.sub(actualBalances[i])
    );
    const surplus = targetBalances.map(
        (target, i) => target.gte(actualBalances[i]) ? new BN(0) : actualBalances[i].sub(target)
    );

    const table = pubKeys.map((pubKey, i) => ({
        Address: pubKey.toBase58(),
        Actual: (actualBalances[i].toNumber() / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 2 }),
        Target: (targetBalances[i].toNumber() / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 2 }),
        Sufficient: shortfall[i].toNumber() == 0 ? ('✅' + (surplus[i].toNumber() / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' SOL extra') : ('❌ ' + (shortfall[i].toNumber() / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' SOL short'),
    }));
    console.table(table);
}

export async function validateSnipeBundleBalances(rps: number = 100) {
    await validateBalances(
        [Config.initialSol, ...Config.subsequentSwapsInSol.map(a => new BN(a * LAMPORTS_PER_SOL))],
        [keypair, ...getDeployerKeyPairs().slice(0, Config.subsequentSwapsInSol.length)].map(k => k.publicKey),
        false, rps
    );
}

export async function validateSecretBundleBalances(rps: number = 100) {
    await validateBalances(
        [Config.initialLpAddInSol, ...Config.subsequentSwapsInSol].map(a => new BN(a * LAMPORTS_PER_SOL)),
        [keypair, ...getDeployerKeyPairs().slice(0, Config.subsequentSwapsInSol.length)].map(k => k.publicKey),
        false, rps
    );
}

export async function validatePumpFunBundleBalances(rps: number = 100) {
    await validateBalances(
        [Config.pumpfunBundleConfig.initialSol, ...Config.pumpfunBundleConfig.swapAmountsInSol]
            .map(a => new BN(a * LAMPORTS_PER_SOL).add(new BN(a * LAMPORTS_PER_SOL).mul(Config.pumpfunBundleConfig.slippage.numerator).div(Config.pumpfunBundleConfig.slippage.denominator))),
        [keypair, ...getDeployerKeyPairs().slice(0, Config.pumpfunBundleConfig.swapAmountsInSol.length)].map(k => k.publicKey),
        true, rps
    );
}

export async function validatePumpFunSnipeBalances(rps: number = 100) {
    await validateBalances(
        [Config.pumpfunBundleConfig.initialSol, ...Config.pumpfunBundleConfig.initialSnipeAmountsInSol, ...Config.pumpfunBundleConfig.swapAmountsInSol]
            .map(a => new BN(a * LAMPORTS_PER_SOL).add(new BN(a * LAMPORTS_PER_SOL).mul(Config.pumpfunBundleConfig.slippage.numerator).div(Config.pumpfunBundleConfig.slippage.denominator))),
        [keypair, ...getDeployerKeyPairs().slice(0, Config.pumpfunBundleConfig.initialSnipeAmountsInSol.length + Config.pumpfunBundleConfig.swapAmountsInSol.length)].map(k => k.publicKey),
        true, rps
    );
}

export async function validateFreezeBundleBalances(rps: number = 100) {
    await validateBalances(
        Config.subsequentSwapsInSol.map(a => new BN(a * LAMPORTS_PER_SOL)),
        getDeployerKeyPairs().slice(0, Config.subsequentSwapsInSol.length).map(k => k.publicKey),
        false, rps
    );
}

export async function validateBundleBalances(rps: number = 100) {
    const selected = await getEnumInput('Select bundle type to validate balances\n1. Snipe Bundle\n2. Secret Bundle\n3. Freeze Bundle\n4. PumpFun Bundle\n5. Pumpfun Snipe', ['1', '2', '3', '4', '5']);
    switch (selected) {
        case '1':
            await validateSnipeBundleBalances(rps);
            break;
        case '2':
            await validateSecretBundleBalances(rps);
            break;
        case '3':
            await validateFreezeBundleBalances(rps);
            break;
        case '4':
            await validatePumpFunBundleBalances(rps);
            break;
        case '5':
            await validatePumpFunSnipeBalances(rps);
            break;
        default:
            throw new Error('Invalid selection');
    }
}

if (require.main === module) {
    validateBundleBalances().catch(console.error);
}