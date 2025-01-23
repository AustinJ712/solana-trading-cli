import { logger } from "../helpers/logger";
import {flexSwap} from "./Pool/swap"
import { program } from "commander";

let token: string = "",
    amount: number = 0,
    useUsdc: boolean = false;

program
  .option("--token <ADDRESS_TOKEN>", "Specify the token address")
  .option("--amount <AMOUNT>", "Amount of SOL/USDC to spend")
  .option("--usdc", "Use USDC instead of SOL", false)
  .option("-h, --help", "display help for command")
  .action((options) => {
    if (options.help) {
      logger.info(
        "ts-node buy --token <ADDRESS_TOKEN> --amount <AMOUNT> [--usdc]"
      );
      process.exit(0);
    }
    if (!options.token || !options.amount) {
      console.error("❌ Missing required options");
      process.exit(1);
    }
    token = options.token;
    amount = options.amount;
    useUsdc = options.usdc;
  });

program.parse();

async function buy(token_address: string, amount: number, useUsdc: boolean) {
  try {
    await flexSwap(token_address, amount, useUsdc);
  } catch (error) {
    console.error("Buy failed:", error);
  }
}

buy(token, amount, useUsdc);