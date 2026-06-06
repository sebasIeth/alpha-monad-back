import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '../common/config/config.service';
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  formatEther,
  formatUnits,
  type Chain,
  type PublicClient,
  type WalletClient,
  type HttpTransport,
  type Address,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import * as chains from 'viem/chains';
import { erc20Abi } from './contracts/arena-abi';

/** USDC addresses per chain (fallback when USDC_ADDRESS env is not set). */
const USDC_BY_CHAIN: Record<number, Address> = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // Base mainnet
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
};

/** Monad chain definitions (viem may not bundle these yet). RPC is overridden by env. */
const MONAD_TESTNET = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
  blockExplorers: { default: { name: 'MonadExplorer', url: 'https://testnet.monadexplorer.com' } },
  testnet: true,
});

const MONAD_MAINNET = defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
  blockExplorers: { default: { name: 'MonadExplorer', url: 'https://monadexplorer.com' } },
});

const CUSTOM_CHAINS: Record<number, Chain> = {
  10143: MONAD_TESTNET,
  143: MONAD_MAINNET,
};

interface SettlementClients {
  publicClient: PublicClient<HttpTransport, Chain>;
  walletClient: WalletClient<HttpTransport, Chain, PrivateKeyAccount>;
  account: PrivateKeyAccount;
}

/**
 * EVM settlement for Monad (relayer-wallet model).
 *
 * The platform/relayer wallet holds USDC and distributes payouts directly via
 * ERC-20 transfers — no Arena smart contract needed. Escrow is implicit: agents
 * transfer their stake to the platform wallet, and the platform pays the winner.
 *
 * USDC decimals are read live from the token contract on startup (Monad USDC is
 * typically 6, NOT 18) so amounts are never miscomputed.
 */
@Injectable()
export class SettlementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementService.name);
  private clients: SettlementClients | null = null;
  private usdcAddress: Address | null = null;
  private usdcDecimals = 6;
  private feeWalletAddress: Address | null = null;
  private rpcUrl: string | null = null;
  private chain: Chain | null = null;

  constructor(private readonly configService: ConfigService) {}

  // ── Lifecycle ────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  private async start(): Promise<void> {
    const rpcUrl = this.configService.rpcUrl;
    const privateKey = this.configService.privateKey;
    const chainIdStr = String(this.configService.chainId);
    const usdcAddr = this.configService.usdcAddress;

    if (!rpcUrl || !privateKey) {
      this.logger.warn(
        'EVM settlement incomplete (RPC_URL / PRIVATE_KEY). Running in no-op mode — no on-chain txs.',
      );
      return;
    }

    const resolvedChainId = chainIdStr ? parseInt(chainIdStr, 10) : 10143;
    this.chain = this.resolveChain(resolvedChainId);
    this.rpcUrl = rpcUrl;

    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const publicClient = createPublicClient({ chain: this.chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain: this.chain, transport: http(rpcUrl), account });
    this.clients = { publicClient, walletClient, account };

    // Fee wallet (optional)
    const feeWallet = this.configService.evmFeeWallet;
    if (feeWallet) {
      this.feeWalletAddress = feeWallet as Address;
      this.logger.log(`EVM fee wallet: ${this.feeWalletAddress}`);
    }

    // USDC
    this.usdcAddress = (usdcAddr as Address) ?? USDC_BY_CHAIN[resolvedChainId] ?? null;
    if (this.usdcAddress) {
      try {
        const decimals = await publicClient.readContract({
          address: this.usdcAddress,
          abi: erc20Abi,
          functionName: 'decimals',
        });
        this.usdcDecimals = Number(decimals);
        this.logger.log(`USDC token: ${this.usdcAddress} (${this.usdcDecimals} decimals)`);
      } catch {
        this.usdcDecimals = 6;
        this.logger.warn(`USDC token: ${this.usdcAddress} (fallback ${this.usdcDecimals} decimals)`);
      }
    } else {
      this.logger.warn(`No USDC address for chain ${resolvedChainId}. Settlement will fail.`);
    }

    this.logger.log(
      `EVM settlement started (Monad relayer mode) — chain=${resolvedChainId}, usdc=${this.usdcAddress}, platform=${account.address}`,
    );
  }

  private stop(): void {
    this.clients = null;
    this.usdcAddress = null;
    this.rpcUrl = null;
    this.chain = null;
    this.logger.log('EVM settlement stopped');
  }

  // ── Chain resolution ──────────────────────────────────────────────

  private resolveChain(chainId: number): Chain {
    if (CUSTOM_CHAINS[chainId]) return CUSTOM_CHAINS[chainId];
    for (const value of Object.values(chains)) {
      if (typeof value === 'object' && value !== null && 'id' in value && (value as Chain).id === chainId) {
        return value as Chain;
      }
    }
    throw new Error(`Unsupported chain ID: ${chainId}. Add it to CUSTOM_CHAINS or use a viem-known chain.`);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private isReady(): boolean {
    return this.clients !== null && this.usdcAddress !== null;
  }

  // ── Token info ────────────────────────────────────────────────────

  getUsdcDecimals(): number {
    return this.usdcDecimals;
  }

  getPlatformWalletAddress(): string | null {
    return this.clients?.account.address ?? null;
  }

  getFeeWalletAddress(): string | null {
    return this.feeWalletAddress ?? null;
  }

  // ── Balances ──────────────────────────────────────────────────────

  async getAgentUsdcBalance(walletAddress: string): Promise<string> {
    if (!this.clients || !this.usdcAddress) return '0';
    const balance = await this.clients.publicClient.readContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [walletAddress as Address],
    });
    return formatUnits(balance as bigint, this.usdcDecimals);
  }

  async getAgentEthBalance(walletAddress: string): Promise<string> {
    if (!this.clients) return '0';
    const balance = await this.clients.publicClient.getBalance({ address: walletAddress as Address });
    return formatEther(balance);
  }

  // ── Transfers ─────────────────────────────────────────────────────

  /**
   * Ensure an agent wallet has enough native MON to pay gas. Agents are funded
   * with USDC but no MON, so the platform/relayer tops them up before any
   * agent-signed tx (mirrors the Solana "platform pays the fee" UX — no MON needed).
   */
  async ensureAgentGas(agentAddress: string): Promise<void> {
    if (!this.clients) return;
    const { publicClient, walletClient, account } = this.clients;
    const MIN = 100_000_000_000_000_000n;  // 0.1 MON threshold
    const TOPUP = 300_000_000_000_000_000n; // 0.3 MON top-up (covers Monad's high gas-limit balance check)
    try {
      const bal = await publicClient.getBalance({ address: agentAddress as Address });
      if (bal >= MIN) return;
      this.logger.log(`Topping up gas: ${agentAddress} has ${formatEther(bal)} MON → sending 0.03 MON`);
      const hash = await walletClient.sendTransaction({
        account,
        chain: this.chain!,
        to: agentAddress as Address,
        value: TOPUP,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    } catch (e) {
      this.logger.warn(`Gas top-up failed for ${agentAddress}: ${(e as Error).message}`);
    }
  }

  /** Transfer USDC from an agent wallet to a destination. The platform fronts the gas. */
  async transferUsdcFromAgent(
    agentPrivateKey: string,
    to: string,
    amount: bigint,
  ): Promise<string | null> {
    if (!this.clients || !this.usdcAddress) {
      this.logger.warn('transferUsdcFromAgent skipped — not initialised');
      return null;
    }
    const { publicClient } = this.clients;
    const agentAccount = privateKeyToAccount(agentPrivateKey as `0x${string}`);

    // Make sure the agent can pay gas (platform tops up MON if needed).
    await this.ensureAgentGas(agentAccount.address);

    const agentWalletClient = createWalletClient({
      chain: this.chain!,
      transport: http(this.rpcUrl!),
      account: agentAccount,
    });

    this.logger.log(`Transfer USDC from agent ${agentAccount.address} → ${to}, amount=${amount}`);
    const { request } = await publicClient.simulateContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to as Address, amount],
      account: agentAccount,
      // Cap the gas limit so Monad's "balance >= gasLimit * price" check needs a
      // small amount of MON (the default high limit would demand several MON).
      gas: 120_000n,
    });
    const txHash = await agentWalletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    this.logger.log(`USDC transfer confirmed: ${txHash}`);
    return txHash;
  }

  /** Transfer USDC from the platform/relayer wallet to a destination. */
  async transferUsdcFromPlatform(to: string, amount: bigint): Promise<string | null> {
    if (!this.isReady()) {
      this.logger.warn('transferUsdcFromPlatform skipped — not initialised');
      return null;
    }
    const { publicClient, walletClient, account } = this.clients!;
    this.logger.log(`Transfer USDC from platform ${account.address} → ${to}, amount=${amount}`);
    const { request } = await publicClient.simulateContract({
      address: this.usdcAddress!,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to as Address, amount],
      account,
    });
    const txHash = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    this.logger.log(`USDC platform transfer confirmed: ${txHash}`);
    return txHash;
  }

  // ── Settlement (relayer model: no contract) ───────────────────────

  /** Escrow is implicit on Monad — agents transfer their stake to the platform wallet. */
  async escrow(): Promise<string | null> {
    return null;
  }

  /** Pay the winner directly from the platform wallet. */
  async payout(_matchId: string, winnerAddress: string, amount: bigint): Promise<string | null> {
    return this.transferUsdcFromPlatform(winnerAddress, amount);
  }

  /** Refund each target directly from the platform wallet. Returns the last tx hash. */
  async refund(_matchId: string, targets?: Array<{ address: string; amount: bigint }>): Promise<string | null> {
    if (!targets?.length) {
      this.logger.warn('EVM refund — no refund targets');
      return null;
    }
    let last: string | null = null;
    for (const t of targets) {
      last = await this.transferUsdcFromPlatform(t.address, t.amount);
    }
    return last;
  }

  /** Send platform fee to the dedicated fee wallet (if configured). */
  async sendFeeToFeeWallet(amount: bigint): Promise<string | null> {
    if (!this.feeWalletAddress) return null; // fee stays in platform wallet
    return this.transferUsdcFromPlatform(this.feeWalletAddress, amount);
  }
}
