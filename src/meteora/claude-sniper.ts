import { loadEnv } from "../utils/load-env";
import WebSocket from "ws";
import { 
    Connection, 
    Keypair, 
    LAMPORTS_PER_SOL, 
    PublicKey,
    Transaction,
    SystemProgram
} from "@solana/web3.js";
import { 
    getOrCreateAssociatedTokenAccount,
    NATIVE_MINT,
    createSyncNativeInstruction,
    TOKEN_PROGRAM_ID 
} from "@solana/spl-token";
import bs58 from "bs58";
import BN from "bn.js";
import DynamicAmm from "@mercurial-finance/dynamic-amm-sdk";
import { createAndSendV0Tx } from "./execute-txns2";
import retry from "async-retry";

// Load environment variables first
loadEnv();

// Constants
export const DYNAMIC_AMM_PROGRAM_ID = new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TARGET_TOKEN_ADDRESS = new PublicKey("FhAM574jFUY2pkxdkpLFGH9X4mDuUScuQirHsTJETJB9");
const MAINNET_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=e7a0fa4f-35a0-44b0-abcc-67b82875b2df";
const HELIUS_API_KEY = "e7a0fa4f-35a0-44b0-abcc-67b82875b2df";
const PRIVATE_KEY = "4GYnnYLEwLBxNucU4PMSk7awiwDMoAgxraCHj1AoBVomJcJYMhqUvCbP2s2v7Xz5dNwGJ6zNbRLLpfDiDj9zq3mC";

// Connection and wallet setup
let processedTxCount = 0;

// Settings from environment
const SETTINGS = {
    swapAmountInSOL: process.env.SWAP_AMOUNT_SOL ? parseFloat(process.env.SWAP_AMOUNT_SOL) : 0.01,
    minLiquidityInSOL: process.env.MIN_LIQUIDITY_SOL ? parseFloat(process.env.MIN_LIQUIDITY_SOL) : 0.0,
    maxPriceImpact: process.env.MAX_PRICE_IMPACT ? parseFloat(process.env.MAX_PRICE_IMPACT) : 100,
    slippageBps: process.env.SLIPPAGE_BPS ? parseInt(process.env.SLIPPAGE_BPS) : 10000,
    usdcPerSol: 20,  // Rough estimate, can be updated with real price feed
    retryAttempts: 3,
    retryDelay: 100,
    wsReconnectDelay: 5000,
    pingInterval: 30000
};

class MeteoraDLMMSniper {
    private ws: WebSocket | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private initialized: boolean = false;

    constructor(
        private connection: Connection,
        private sniperKeypair: Keypair,
        private wsUrl: string,
        private targetMint: PublicKey
    ) {}

    async start() {
        if (!this.initialized) {
            console.log("\n🎯 Starting Meteora DLMM sniper with settings:");
            console.log(`Target token: ${this.targetMint.toBase58()}`);
            console.log(`Swap amount: ${SETTINGS.swapAmountInSOL} SOL`);
            console.log(`Min liquidity: ${SETTINGS.minLiquidityInSOL} SOL`);
            console.log(`Max price impact: ${SETTINGS.maxPriceImpact}%`);
            console.log(`Slippage: ${SETTINGS.slippageBps / 10000}%`);
            console.log(`Wallet: ${this.sniperKeypair.publicKey.toBase58()}\n`);
            this.initialized = true;
        }

        this.setupWebSocket();
    }

    private setupWebSocket() {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on("open", () => {
            console.log("✅ WebSocket connected");
            this.setupPingInterval();
            this.subscribeToProgram();
        });

        this.ws.on("message", (data) => this.handleMessage(data));
        this.ws.on("error", this.handleError.bind(this));
        this.ws.on("close", this.handleClose.bind(this));
    }

    private setupPingInterval() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, SETTINGS.pingInterval);
    }

    private subscribeToProgram() {
        const request = {
            jsonrpc: "2.0",
            id: "meteora-dlmm-sub",
            method: "transactionSubscribe",
            params: [
                {
                    accountInclude: [DYNAMIC_AMM_PROGRAM_ID.toBase58()],
                    type: "program",
                    commitment: "confirmed",
                    encoding: "jsonParsed",
                    transactionDetails: "full",
                    showRewards: false,
                    maxSupportedTransactionVersion: 0,
                },
            ],
        };

        this.ws!.send(JSON.stringify(request));
        console.log("👀 Monitoring for new Meteora DLMM pool creations...");
    }

    private async handleMessage(data: WebSocket.Data) {
        try {
            const msg = JSON.parse(data.toString());
            
            if (msg.result && typeof msg.result === "number") {
                console.log("✅ Subscription confirmed, ID:", msg.result);
                return;
            }

            if (msg.method === "transactionNotification" && msg.params?.result?.signature) {
                processedTxCount++;
                if (processedTxCount % 100 === 0) {
                    console.log(`Processed ${processedTxCount} transactions...`);
                }

                const { signature, slot } = msg.params.result;
                console.log(`\n🔍 Slot ${slot} - New transaction: ${signature}`);

                // Check for pool initialization
                const isPoolInit = this.isPoolInitialization(msg.params.result.transaction);
                if (!isPoolInit) return;

                console.log("🏦 Detected pool initialization...");
                await this.handleTransaction(msg.params.result);
            }
        } catch (err) {
            console.error("❌ Error processing message:", err);
        }
    }

    private isPoolInitialization(transaction: any): boolean {
        if (!transaction?.message?.instructions) return false;
        
        // Look for initialization instruction
        const initInstruction = transaction.message.instructions.find((ix: any) => {
            // Here we would check the instruction data for the specific initialization code
            // This is a placeholder - you'd need to add the actual initialization instruction detection
            return ix.programId === DYNAMIC_AMM_PROGRAM_ID.toBase58();
        });

        return !!initInstruction;
    }

    private async handleTransaction(tx: any) {
        try {
            const txDetails = await this.connection.getTransaction(tx.signature, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
            });

            if (!txDetails || txDetails.meta?.err) {
                console.log("❌ Invalid or failed transaction");
                return;
            }

            await this.scanForNewPools(tx.signature, txDetails);
        } catch (err) {
            console.error("❌ Error handling transaction:", err);
        }
    }

    private handleError(error: Error) {
        console.error("⚠️ WebSocket error:", error);
    }

    private handleClose() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        console.log("WebSocket closed, attempting reconnect in 5s...");
        setTimeout(() => this.start(), SETTINGS.wsReconnectDelay);
    }

    private async scanForNewPools(signature: string, txn: any) {
        if (!txn.meta) return;

        const acctKeys = txn.transaction.message.staticAccountKeys;
        console.log(`📝 Scanning ${acctKeys.length} accounts for new DLMM pools...`);

        for (let i = 0; i < acctKeys.length; i++) {
            const key = acctKeys[i];
            
            // Only check new accounts
            if (txn.meta.preBalances[i] !== 0) {
                continue;
            }

            try {
                const pool = await DynamicAmm.create(this.connection, key);
                if (!pool?.poolInfo) continue;

                await this.processPool(pool, signature);
            } catch (err) {
                // Not a valid pool, continue scanning
            }
        }
    }

    private async processPool(pool: any, signature: string) {
        const tokenAMint = pool.tokenAMint.address.toBase58();
        const tokenBMint = pool.tokenBMint.address.toBase58();

        // Check if pool contains our target token
        if (tokenAMint !== this.targetMint.toBase58() && tokenBMint !== this.targetMint.toBase58()) {
            return;
        }

        console.log("\n🎯 Found pool with target token!");
        console.log(`Pool Address: ${pool.publicKey.toBase58()}`);
        console.log(`Token A: ${tokenAMint}`);
        console.log(`Token B: ${tokenBMint}`);

        // Handle WSOL/USDC selection
        const useUsdc = tokenAMint === USDC_MINT.toBase58() || tokenBMint === USDC_MINT.toBase58();
        const useWsol = tokenAMint === SOL_MINT.toBase58() || tokenBMint === SOL_MINT.toBase58();

        if (!useUsdc && !useWsol) {
            console.log("❌ Pool doesn't use WSOL or USDC");
            return;
        }

        const quoteIn = this.targetMint.toBase58() === tokenBMint;
        console.log(`Using ${useUsdc ? 'USDC' : 'WSOL'} for swap`);
        console.log(`Quote token is input: ${quoteIn}`);

        // Execute the snipe with retries
        await retry(
            async () => this.executeSnipe(pool, SETTINGS.swapAmountInSOL, quoteIn, useUsdc),
            {
                retries: SETTINGS.retryAttempts,
                minTimeout: SETTINGS.retryDelay,
                factor: 2,
                onRetry: (error) => {
                    console.log("🔄 Retrying snipe due to error:", error);
                }
            }
        );
    }

    private async executeSnipe(
        pool: any,
        swapAmountInSol: number,
        quoteIn: boolean,
        useUsdc: boolean
    ) {
        console.log("\n🚀 Executing snipe...");

        // First handle token accounts and SOL wrapping
        const { inTokenAta, outTokenAta } = await this.prepareTokenAccounts(pool, useUsdc);

        // If using SOL, wrap it first
        if (!useUsdc) {
            await this.wrapSol(swapAmountInSol, inTokenAta);
        }

        // Calculate input amount
        const amountIn = useUsdc ? 
            new BN(swapAmountInSol * SETTINGS.usdcPerSol * 1e6) : 
            new BN(swapAmountInSol * LAMPORTS_PER_SOL);

        // Get swap quote
        const swapQuote = pool.getSwapQuote(
            amountIn,
            SETTINGS.slippageBps,
            quoteIn
        );

        console.log("📊 Swap Quote:");
        console.log(`Input Amount: ${amountIn.toString()}`);
        console.log(`Expected Output: ${swapQuote.outAmount.toString()}`);
        console.log(`Price Impact: ${swapQuote.priceImpact}%`);

        // Execute swap
        const swapTx = await pool.swap(
            this.sniperKeypair.publicKey,
            quoteIn ? pool.tokenAMint.address : pool.tokenBMint.address,
            amountIn,
            swapQuote.minOutAmount
        );

        // Send with priority
        await createAndSendV0Tx({
            connection: this.connection,
            ix: swapTx.instructions,
            signers: [this.sniperKeypair],
            computeUnits: 200_000,
            fixedPriorityFee: true,
            minPriorityFee: 1_000_000
        });

        console.log("✅ Snipe executed successfully!");
    }

    private async prepareTokenAccounts(pool: any, useUsdc: boolean) {
        const inMint = useUsdc ? USDC_MINT : SOL_MINT;
        const outMint = this.targetMint;

        // Create ATAs
        const [inTokenAta, outTokenAta] = await Promise.all([
            getOrCreateAssociatedTokenAccount(
                this.connection,
                this.sniperKeypair,
                inMint,
                this.sniperKeypair.publicKey
            ),
            getOrCreateAssociatedTokenAccount(
                this.connection,
                this.sniperKeypair,
                outMint,
                this.sniperKeypair.publicKey
            )
        ]);

        return {
            inTokenAta: inTokenAta.address,
            outTokenAta: outTokenAta.address
        };
    }

    private async wrapSol(amount: number, wsolAta: PublicKey) {
        const lamports = amount * LAMPORTS_PER_SOL;
        
        const wrapTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: this.sniperKeypair.publicKey,
                toPubkey: wsolAta,
                lamports,
            }),
            createSyncNativeInstruction(wsolAta)
        );

        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        wrapTx.recentBlockhash = blockhash;
        wrapTx.feePayer = this.sniperKeypair.publicKey;

        const signature = await this.connection.sendTransaction(wrapTx, [this.sniperKeypair]);
        await this.connection.confirmTransaction(signature, 'confirmed');
        console.log("✅ SOL wrapped successfully");
    }

    async testMode() {
        console.log("🧪 Running in test mode...");
        
        // Test connection
        try {
            const blockHeight = await this.connection.getBlockHeight();
            console.log("✅ RPC Connection test passed, block height:", blockHeight);
        } catch (err) {
            console.error("❌ RPC Connection test failed:", err);
            return;
        }

        // Test pool search
        await this.testPoolSearch();

        // Test wallet balance
        try {
            const balance = await this.connection.getBalance(this.sniperKeypair.publicKey);
            console.log("\n✅ Wallet balance test passed:");
            console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL");
            
            if (balance < SETTINGS.swapAmountInSOL * LAMPORTS_PER_SOL) {
                console.warn("⚠️  Warning: Wallet balance lower than swap amount");
            }
        } catch (err) {
            console.error("❌ Wallet balance test failed:", err);
            return;
        }

        // Test token accounts
        try {
            const { inTokenAta, outTokenAta } = await this.prepareTokenAccounts(
                null,
                process.env.QUOTE_MINT === 'USDC'
            );
            console.log("\n✅ Token account creation test passed:");
            console.log("Input Token ATA:", inTokenAta.toBase58());
            console.log("Output Token ATA:", outTokenAta.toBase58());
        } catch (err) {
            console.error("❌ Token account test failed:", err);
            return;
        }

        console.log("\n✅ All tests passed! Sniper is ready to run.");
    }

    async testPoolSearch() {
        console.log("🔍 Searching for existing DLMM pools with target token...");
        console.log(`Target token: ${this.targetMint.toBase58()}`);

        try {
            // Use Meteora's API to find pools
            const url = `https://dlmm-api.meteora.ag/pair/all_by_groups?sort_key=tvl&order_by=desc&search_term=${this.targetMint.toBase58()}&include_unknown=false`;
            
            console.log("Querying Meteora API...");
            const response = await (await fetch(url)).json();
            
            if (!response.groups || response.groups.length === 0) {
                console.log("❌ No existing pools found with target token");
                return;
            }

            console.log(`\n✅ Found pools containing target token:\n`);
            
            for (const group of response.groups) {
                console.log(`Group: ${group.name}`);
                for (const pair of group.pairs) {
                    console.log(`Pool Address: ${pair.address}`);
                    console.log(`Base: ${pair.base_token_symbol} (${pair.base_token_address})`);
                    console.log(`Quote: ${pair.quote_token_symbol} (${pair.quote_token_address})`);
                    console.log(`TVL: $${pair.tvl.toLocaleString()}`);
                    console.log(`24h Volume: $${pair.volume_24h.toLocaleString()}\n`);

                    // Load actual pool data
                    const pool = await DynamicAmm.create(this.connection, new PublicKey(pair.address));
                    const { tokenAAmount, tokenBAmount } = pool.poolInfo;
                    console.log(`Current Reserves: ${tokenAAmount.toString()} / ${tokenBAmount.toString()}\n`);
                }
            }

        } catch (err) {
            console.error("❌ Pool search failed:", err);
        }
    }
}

// Command line argument handling
function parseArgs() {
    const args = process.argv.slice(2);
    return {
        test: args.includes('--test'),
        help: args.includes('--help') || args.includes('-h')
    };
}

function showHelp() {
console.log(`
Meteora DLMM Sniper - Usage:
npx ts-node src/super-sniper-dlmm.ts [options]

Options:
--test     Run test mode to verify configuration
--help     Show this help message

Environment Variables:
TARGET_TOKEN_ADDRESS    Address of token to snipe
SWAP_PRIVATE_KEY       Private key for sniper wallet
SWAP_AMOUNT_SOL        Amount of SOL to swap
SLIPPAGE_BPS          Slippage in basis points (100 = 1%)
MIN_LIQUIDITY_SOL     Minimum pool liquidity in SOL
QUOTE_MINT            'WSOL' or 'USDC' to force quote token
`);
}

if (require.main === module) {
    const args = parseArgs();

    if (args.help) {
        showHelp();
        process.exit(0);
    }

    const connection = new Connection(MAINNET_ENDPOINT, {
        commitment: "confirmed"
    });

    const sniper = new MeteoraDLMMSniper(
        connection,
        Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY)),
        `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
        TARGET_TOKEN_ADDRESS
    );

    if (args.test) {
        sniper.testMode();
    } else {
        sniper.start();
        
        process.on("SIGINT", () => {
            console.log("\n👋 Shutting down gracefully...");
            process.exit(0);
        });
    }
}