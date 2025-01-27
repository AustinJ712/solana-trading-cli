import { Mutex as TSMutex } from 'async-mutex';
import { PublicKey, Keypair } from '@solana/web3.js';
import { SnipeConfig, SnipeConfigModel } from './db/snipeConfig';
import { SniperError, SniperErrorVariant } from './error';
import { sighash } from './utils';
import { AppState } from './index';
import { logger } from './logger';
import { BN } from 'bn.js';
import DLMM from '@meteora-ag/dlmm';
import { connection } from './helpers/config';
import { flexSwap } from './swap';

export interface IDexSniper<T> {
  programId(): PublicKey;
  filterInstruction(ixs: any[]): boolean;
  discriminator(): Uint8Array;
  arrangeAccounts(accounts: any[]): T | null;
  notify(state: AppState): Promise<void>;
  getSubscribeRequest(): any;
  decompile(tx: any): Promise<MeteoraSniper>;
}

export interface InitializeLbPairInstructionAccounts {
  lb_pair: PublicKey;
  bin_array_bitmap_extension: PublicKey;
  token_mint_x: PublicKey;
  token_mint_y: PublicKey;
  reserve_x: PublicKey;
  reserve_y: PublicKey;
  oracle: PublicKey;
  preset_parameter: PublicKey;
  funder: PublicKey;
  token_program: PublicKey;
  system_program: PublicKey;
  rent: PublicKey;
  event_authority: PublicKey;
  program: PublicKey;
}

export class MeteoraSniper implements IDexSniper<InitializeLbPairInstructionAccounts> {
  public accounts: InitializeLbPairInstructionAccounts;

  constructor(accounts: InitializeLbPairInstructionAccounts) {
    this.accounts = accounts;
  }

  programId(): PublicKey {
    return new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  }

  static program_id(): PublicKey {
    return new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  }

  // The "initializeLbPair" is the anchor method name. In on-chain code it can also appear as "initialize_lb_pair"
  discriminator(): Uint8Array {
    return sighash('initializeLbPair');
  }

  static discriminator(): Uint8Array {
    return sighash('initializeLbPair');
  }

  filterInstruction(ixs: any[]): boolean {
    logger.debug(`[MeteoraSniper.filterInstruction] Checking ${ixs.length} instructions...`);
    return ixs.some((ix, index) => {
      if (ix.data && ix.data.length >= 8) {
        const disc = Buffer.from(ix.data).subarray(0, 8);
        const matches = disc.equals(Buffer.from(this.discriminator()));
        logger.debug(`...Instruction #${index} disc=${disc.toString('hex')} matches? ${matches}`);
        return matches;
      }
      return false;
    });
  }

  static filterInstruction(ixs: any[]): boolean {
    logger.debug(`[MeteoraSniper.static.filterInstruction] Checking ${ixs.length} instructions...`);
    return ixs.some((ix, index) => {
      if (ix.data && ix.data.length >= 8) {
        const disc = Buffer.from(ix.data).subarray(0, 8);
        const matches = disc.equals(Buffer.from(MeteoraSniper.prototype.discriminator()));
        logger.debug(`...Instruction #${index} disc=${disc.toString('hex')} matches? ${matches}`);
        return matches;
      }
      return false;
    });
  }

  arrangeAccounts(accounts: any[]): InitializeLbPairInstructionAccounts | null {
    logger.debug(`[MeteoraSniper.arrangeAccounts] accounts.length=${accounts.length}`);
    if (accounts.length < 14) {
      logger.warn(`[arrangeAccounts] Not enough accounts: ${accounts.length}`);
      return null;
    }
    return {
      lb_pair: new PublicKey(accounts[0].pubkey),
      bin_array_bitmap_extension: new PublicKey(accounts[1].pubkey),
      token_mint_x: new PublicKey(accounts[2].pubkey),
      token_mint_y: new PublicKey(accounts[3].pubkey),
      reserve_x: new PublicKey(accounts[4].pubkey),
      reserve_y: new PublicKey(accounts[5].pubkey),
      oracle: new PublicKey(accounts[6].pubkey),
      preset_parameter: new PublicKey(accounts[7].pubkey),
      funder: new PublicKey(accounts[8].pubkey),
      token_program: new PublicKey(accounts[9].pubkey),
      system_program: new PublicKey(accounts[10].pubkey),
      rent: new PublicKey(accounts[11].pubkey),
      event_authority: new PublicKey(accounts[12].pubkey),
      program: new PublicKey(accounts[13].pubkey),
    };
  }

  static arrangeAccounts(accounts: any[]): InitializeLbPairInstructionAccounts | null {
    logger.debug(`[MeteoraSniper.static.arrangeAccounts] accounts.length=${accounts.length}`);
    if (accounts.length < 14) {
      logger.warn(`[static.arrangeAccounts] Not enough accounts: ${accounts.length}`);
      return null;
    }
    return {
      lb_pair: new PublicKey(accounts[0].pubkey),
      bin_array_bitmap_extension: new PublicKey(accounts[1].pubkey),
      token_mint_x: new PublicKey(accounts[2].pubkey),
      token_mint_y: new PublicKey(accounts[3].pubkey),
      reserve_x: new PublicKey(accounts[4].pubkey),
      reserve_y: new PublicKey(accounts[5].pubkey),
      oracle: new PublicKey(accounts[6].pubkey),
      preset_parameter: new PublicKey(accounts[7].pubkey),
      funder: new PublicKey(accounts[8].pubkey),
      token_program: new PublicKey(accounts[9].pubkey),
      system_program: new PublicKey(accounts[10].pubkey),
      rent: new PublicKey(accounts[11].pubkey),
      event_authority: new PublicKey(accounts[12].pubkey),
      program: new PublicKey(accounts[13].pubkey),
    };
  }

  async notify(state: AppState): Promise<void> {
    logger.info(`[MeteoraSniper.notify] Pushing newly discovered pool sniper into channel...`);
    state.meteoraChannel.push(this);
  }

  getSubscribeRequest(): any {
    const filterMap = {
      sniper: {
        account_include: [MeteoraSniper.program_id().toBase58()],
      },
    };
    return { transactions: filterMap };
  }

  static async decompile(tx: any): Promise<MeteoraSniper> {
    logger.debug(`[MeteoraSniper.decompile] Attempting to find "initializeLbPair" sighash in instructions...`);
    const instructions = tx.decompiledInstructions || [];
    logger.debug(`[MeteoraSniper.decompile] # instructions = ${instructions.length}`);
    const foundIx = instructions.find(
      (ix: any, ixIndex: number) => {
        const matches = (
          ix.programId === MeteoraSniper.program_id().toBase58() &&
          ix.data?.length >= 8 &&
          Buffer.from(ix.data)
            .subarray(0, 8)
            .equals(MeteoraSniper.prototype.discriminator())
        );
        logger.debug(`   IX#${ixIndex} => matches? ${matches} programId=${ix.programId}`);
        return matches;
      }
    );

    if (foundIx) {
      logger.info(`[MeteoraSniper.decompile] Found the "initializeLbPair" instruction! Arranging accounts now...`);
      const arranged = MeteoraSniper.arrangeAccounts(foundIx.accounts);
      if (arranged) {
        return new MeteoraSniper(arranged);
      } else {
        logger.error(`[MeteoraSniper.decompile] Could not parse accounts => throwing InstructionNotParsed`);
        throw new SniperError(SniperErrorVariant.InstructionNotParsed);
      }
    }
    logger.warn(`[MeteoraSniper.decompile] No matching instruction found => InstructionNotFound thrown`);
    throw new SniperError(SniperErrorVariant.InstructionNotFound);
  }

  async decompile(tx: any): Promise<MeteoraSniper> {
    return MeteoraSniper.decompile(tx);
  }
}

/**
 * Filter function used by the subscription logic
 */
export function filter(tx: any): boolean {
  logger.debug(`[sniper.filter] Checking if transaction has pool initialization logs...`);
  if (tx.transaction?.meta?.logMessages) {
    const logMessages = tx.transaction.meta.logMessages;
    const hasInitPool = logMessages.some((log: string) => 
      log.toLowerCase().includes('instruction: initializelbpair') ||
      log.toLowerCase().includes('instruction: initialize_lb_pair')
    );
    logger.debug(`[sniper.filter] matched? ${hasInitPool}`);
    return hasInitPool;
  }
  logger.debug(`[sniper.filter] No log messages found, skipping`);
  return false;
}

export async function process_meteora(
  state: AppState,
  receiver: AsyncGenerator<MeteoraSniper, void, undefined> | AsyncIterable<MeteoraSniper>
): Promise<void> {
  logger.info(`[process_meteora] Starting main sniping loop...`);

  const snipesMutex = new TSMutex();
  const snipeConfigsMutex = new TSMutex();

  // Load from DB at start
  {
    const release = await snipesMutex.acquire();
    try {
      logger.info(`[process_meteora] Loading initial snipe configs (status=0) from DB...`);
      const initSnipes = await SnipeConfig.get_active_snipe_configs(state.pool);
      (state as any)._snipes = initSnipes;
      logger.info(`[process_meteora] Found ${initSnipes.length} pending snipes from DB`);
    } finally {
      release();
    }
  }

  // Periodic refresh from DB
  (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const release = await snipesMutex.acquire();
      try {
        const newSnipes = await SnipeConfig.get_active_snipe_configs(state.pool);
        (state as any)._snipes = newSnipes;
      } finally {
        release();
      }
    }
  })().catch(err => logger.error(`[process_meteora:refreshLoop] Error: ${err}`));

  // Another background to process the new pool "snipers"
  (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const newSnipeConfigs: MeteoraSniper[] = [];
      const releaseSC = await snipeConfigsMutex.acquire();
      try {
        const existing = (state as any)._snipe_configs || [];
        for (const sniper of existing) {
          let filteredWallets: SnipeConfigModel[] = [];
          const releaseS = await snipesMutex.acquire();
          try {
            const allSnipes = (state as any)._snipes as SnipeConfigModel[] || [];
            filteredWallets = allSnipes.filter(
              (conf) =>
                conf.token === sniper.accounts.token_mint_x.toBase58() ||
                conf.token === sniper.accounts.token_mint_y.toBase58()
            );
          } finally {
            releaseS();
          }
          if (filteredWallets.length > 0) {
            logger.info(`[process_meteora] Found ${filteredWallets.length} snipe configs that match the new pool => executing swaps`);
            const succeededWallets = await execute_swaps(sniper, filteredWallets, state);
            const releaseS2 = await snipesMutex.acquire();
            try {
              (state as any)._snipes = ((state as any)._snipes as SnipeConfigModel[]).filter(
                (c) => !succeededWallets.includes(c.wallet)
              );
            } finally {
              releaseS2();
            }
            newSnipeConfigs.push(sniper);
          }
        }
        (state as any)._snipe_configs = newSnipeConfigs;
      } finally {
        releaseSC();
      }
    }
  })().catch(err => logger.error(`[process_meteora:execLoop] Error: ${err}`));

  // Main loop to receive newly discovered pools
  for await (const data of receiver) {
    logger.info(`[process_meteora] *** Received new MeteoraSniper => ${JSON.stringify(data.accounts)} ***`);
    const release3 = await snipeConfigsMutex.acquire();
    try {
      const arr = (state as any)._snipe_configs || [];
      arr.push(data);
      (state as any)._snipe_configs = arr;
    } finally {
      release3();
    }
  }
}

async function execute_swaps(
  data: MeteoraSniper,
  filteredWallets: SnipeConfigModel[],
  state: AppState
): Promise<string[]> {
  logger.info(`[execute_swaps] Attempting swaps on pool => lb_pair=${data.accounts.lb_pair.toBase58()}`);
  const succeeded: string[] = [];

  // Wait 2s to ensure pool init
  logger.info(`[execute_swaps] Waiting 2 seconds for pool initialization...`);
  await new Promise(resolve => setTimeout(resolve, 2000));

  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const WSOL = 'So11111111111111111111111111111111111111112';

  await Promise.all(
    filteredWallets.map(async (s) => {
      logger.debug(`[execute_swaps] Building swap for wallet=${s.wallet}, token=${s.token}, amount_sol=${s.snipe_amount_sol}, amount_usdc=${s.snipe_amount_usdc}`);
      try {
        const ephemeralSecretKey = Buffer.from(s.priv_key, 'base64');
        const ephemeralKp = Keypair.fromSecretKey(ephemeralSecretKey);

        // Determine if we're using USDC or SOL based on the pool's tokens
        const isUsdc = data.accounts.token_mint_x.toBase58() === USDC || 
                      data.accounts.token_mint_y.toBase58() === USDC;
        
        // Use the appropriate amount based on the pool type
        let decimalAmount: number;
        if (isUsdc) {
          if (!s.snipe_amount_usdc) {
            logger.error(`[execute_swaps] No USDC amount configured for wallet ${s.wallet}`);
            return;
          }
          decimalAmount = s.snipe_amount_usdc; // Already in USDC
        } else {
          if (!s.snipe_amount_sol) {
            logger.error(`[execute_swaps] No SOL amount configured for wallet ${s.wallet}`);
            return;
          }
          decimalAmount = s.snipe_amount_sol; // Already in SOL
        }

        logger.debug(`[execute_swaps] Using ${isUsdc ? 'USDC' : 'SOL'} as input token. Amount: ${decimalAmount}`);

        let retries = 10;
        while (retries > 0) {
          try {
            // check pool
            const accountInfo = await connection.getAccountInfo(data.accounts.lb_pair);
            if (!accountInfo) {
              logger.error(`[execute_swaps] Account not found => ${data.accounts.lb_pair.toBase58()}`);
              throw new Error("LB pair not found");
            }
            // attempt a swap
            const signature = await flexSwap(
              s.token,
              data.accounts.lb_pair.toBase58(),
              decimalAmount,
              ephemeralKp,
              isUsdc
            );

            // ASCII / emoji log with "SWAP SUCCESS" so console prints it after 100 lines
            logger.info(`
SNIPED

🔥 SWAP SUCCESS for wallet: ${s.wallet}
Tx: https://solscan.io/tx/${signature}

(This line always prints in console because it has "SWAP SUCCESS")
            `);

            // mark as done
            await SnipeConfig.update_data(
              s.wallet,
              1,
              signature,
              new Date(),
              state.pool
            );
            succeeded.push(s.wallet);
            logger.info(`[execute_swaps] Marked wallet ${s.wallet} as completed`);
            break;
          } catch (err: any) {
            if (!String(err.message || "").includes("no liquidity")) {
              // or whatever error message
              retries--;
              if (retries > 0) {
                logger.warn(`[execute_swaps] Swap attempt failed, retry in 2s => ${retries} left`);
                await new Promise(r=>setTimeout(r,2000));
              } else {
                throw err;
              }
            }
          }
        }
      } catch (err: any) {
        logger.error(`[execute_swaps] Swap failed for wallet=${s.wallet}, error=${err.message}`);
      }
    })
  );

  return succeeded;
}
