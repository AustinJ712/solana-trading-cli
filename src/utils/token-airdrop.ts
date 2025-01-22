import Bottleneck from "bottleneck";
import { getDeployerKeyPairs, getTeamKeyPairs } from "./fund-deployers";
import { Config } from "../config";
import { getTokenBalance } from "../raydium/execute-txns";
import { loadEnv } from "./load-env";
import { Connection } from "@solana/web3.js";
import fs from "fs";
import { parse } from "csv-parse";
import { BN } from "bn.js";
import { confirmFromUser } from "./console-helpers";
import { transferSingle } from "../mm-airdrop";

loadEnv();
const connection = new Connection(process.env.RPC_URL!, Config.rpcCommitment);

export interface TransferInfo {
	address: string;
	amount: number;
}

export async function parseTransfersFromCsv(filePath: string): Promise<TransferInfo[]> {
	const results: TransferInfo[] = [];

	const parser = fs.createReadStream(filePath).pipe(parse());

	for await (const record of parser) {
		const transferInfo: TransferInfo = {
			address: record[0],
			amount: Number(record[1]),
		};
		results.push(transferInfo);
	}

	return results;
}

export async function tokenAirdrop(rps: number = 100, startIndex: number = 0, numWallets: number = Config.subsequentSwapsInSol.length, funded: boolean = false) {
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 2500 / rps });
    const senderWallets = getDeployerKeyPairs().slice(startIndex, startIndex + numWallets);
    // const senderWallets = getTeamKeyPairs('team-keypairs.json').slice(startIndex, startIndex + numWallets);
    let tokenBalances = (await Promise.all(
        senderWallets.map((keypair) => limiter.schedule(() => getTokenBalance(connection, keypair.publicKey, Config.Token.mint)))
    )).map((balance) => balance.div(new BN(10).pow(new BN(Config.Token.decimals))));

    console.log(`🪙 Total balance: ${tokenBalances.reduce((acc, balance) => acc.add(balance), new BN(0)).toNumber().toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
    let transferInfos: TransferInfo[] = await parseTransfersFromCsv("fixed-transfers.csv");
    const totalAmountToTransfer = transferInfos.reduce((acc, transfer) => acc + transfer.amount, 0);
    await confirmFromUser(`Total amount to transfer: ${totalAmountToTransfer.toLocaleString('en-US', { maximumFractionDigits: 0 })}. Continue?`);

    for (let i = 0, j = 0; i < transferInfos.length && j < senderWallets.length; i++) {
        const recipientInfo = transferInfos[i];
        while (recipientInfo.amount > 0) {
            while (tokenBalances[j].eq(new BN(0))) {
                j++;
            }

            const amountToTransfer = Math.min(recipientInfo.amount, tokenBalances[j].toNumber());
            tokenBalances[j] = tokenBalances[j].sub(new BN(amountToTransfer));
            recipientInfo.amount -= amountToTransfer;

            await limiter.schedule(() => transferSingle(senderWallets[j], recipientInfo.address, BigInt(amountToTransfer) * BigInt(10 ** Config.Token.decimals), funded));
        }
    }
}

if (require.main === module) {
    tokenAirdrop(100).catch(console.error);
}