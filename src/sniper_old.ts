import { Mutex as TSMutex } from 'async-mutex';
import { PublicKey, Keypair, VersionedTransaction, MessageV0 } from '@solana/web3.js';
import { SnipeConfig, SnipeConfigModel } from './db/snipeConfig';
import { SniperError, SniperErrorVariant } from './error';
import { sighash } from './utils';
import { RPC_CONNECTION } from './config';
import { sendTransaction } from './services';
import { AppState } from './index';
import { logger } from './logger';  // <--- NEW

/**
 * DexSniper-like interface
 */
export interface IDexSniper<T> {
  programId(): PublicKey;
  filterInstruction(ixs: any[]): boolean;
  discriminator(): Uint8Array;
  arrangeAccounts(accounts: any[]): T | null;
  getSwapTransaction(amount: number, wallet: PublicKey, token: PublicKey): Promise<VersionedTransaction>;
  notify(state: AppState): Promise<void>;
  getSubscribeRequest(): any;
  decompile(tx: any): Promise<MeteoraSniper>;
}

/**
 * Represents the accounts needed for a Meteora LB pair
 */
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

  // IMPORTANT: anchor code actually calls it "initializeLbPair"
  // so we must use sighash("initializeLbPair"), not "initialize_lb_pair"
  discriminator(): Uint8Array {
    // This was the mismatch
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

  /**
   * Minimally build a swap transaction
   */
  async getSwapTransaction(
    amount: number,
    wallet: PublicKey,
    token: PublicKey
  ): Promise<VersionedTransaction> {
    logger.info(`[MeteoraSniper] Building swap transaction for wallet=${wallet}, token=${token}, amount=${amount}`);
    const blockhashObj = await RPC_CONNECTION.getLatestBlockhash();
    return new VersionedTransaction(
      new MessageV0({
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        recentBlockhash: blockhashObj.blockhash,
        compiledInstructions: [],
        addressTableLookups: [],
        staticAccountKeys: []
      })
    );
  }

  /**
   * Add the new sniper to the "channel"
   */
  async notify(state: AppState): Promise<void> {
    logger.info(`[MeteoraSniper.notify] Pushing newly discovered pool sniper into channel...`);
    state.meteoraChannel.push(this);
  }

  /**
   * Subscriptions config
   */
  getSubscribeRequest(): any {
    const filterMap = {
      sniper: {
        account_include: [MeteoraSniper.program_id().toBase58()],
      },
    };
    return { transactions: filterMap };
  }

  /**
   * Decompile from a Helius-style instruction array
   */
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
  logger.debug(`[sniper.filter] Checking if transaction has instructions for the LBPair init...`);
  if (tx.transaction?.transaction?.message) {
    const ixs = tx.transaction.transaction.message.instructions || [];
    const matched = [MeteoraSniper.filterInstruction(ixs)].some(Boolean);
    logger.debug(`[sniper.filter] matched? ${matched}`);
    return matched;
  }
  logger.debug(`[sniper.filter] No transaction.message found, skipping`);
  return false;
}

/**
 * The main process loop for meteora sniping
 */
export async function process_meteora(
  state: AppState,
  receiver: AsyncGenerator<MeteoraSniper, void, undefined> | AsyncIterable<MeteoraSniper>
): Promise<void> {
  logger.info(`[process_meteora] Starting main sniping loop...`);

  const snipesMutex = new TSMutex();
  const snipeConfigsMutex = new TSMutex();

  // Init from DB
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

  // Periodic refresh
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

  // Another background to process snipe configs
  (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const newSnipeConfigs: MeteoraSniper[] = [];
      const releaseSC = await snipeConfigsMutex.acquire();
      try {
        const existing = (state as any)._snipe_configs || [];
        for (const sniper of existing) {
          // We look for matching wallets
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

  // Main loop to receive new pool events
  for await (const data of receiver) {
    logger.info(`[process_meteora] *** Received new MeteoraSniper from channel => ${JSON.stringify(data.accounts)} ***`);
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

/**
 * Actually execute the swap for each wallet
 */
async function execute_swaps(
  data: MeteoraSniper,
  filteredWallets: SnipeConfigModel[],
  state: AppState
): Promise<string[]> {
  logger.info(`[execute_swaps] Attempting swaps on pool => lb_pair=${data.accounts.lb_pair.toBase58()}`);
  const succeeded: string[] = [];

  await Promise.all(
    filteredWallets.map(async (s) => {
      logger.debug(`[execute_swaps] Building swap for wallet=${s.wallet}, token=${s.token}, amount=${s.snipe_amount}`);
      try {
        const walletPubkey = new PublicKey(s.wallet);
        const tokenPubkey = new PublicKey(s.token);
        const tx = await data.getSwapTransaction(s.snipe_amount, walletPubkey, tokenPubkey);

        // decode ephemeral privkey
        const secretKey = Buffer.from(s.priv_key, 'base64');
        const kp = Keypair.fromSecretKey(secretKey);

        // send
        const sig = await sendTransaction(tx, [kp]);
        logger.info(`[execute_swaps] Swap success => signature=${sig}`);

        // update DB
        await SnipeConfig.update_data(
          s.wallet,
          1, // mark as done
          sig,
          new Date(),
          state.pool
        );

        succeeded.push(s.wallet);
        logger.info(`[execute_swaps] Marked wallet ${s.wallet} as completed (status=1)`);
      } catch (err) {
        logger.error(`[execute_swaps] Swap failed for wallet=${s.wallet}, error=${(err as Error).message}`);
      }
    })
  );

  return succeeded;
}

