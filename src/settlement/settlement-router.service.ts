import { Injectable, Logger } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { SolanaSettlementService } from './solana-settlement.service';

/**
 * Chain-agnostic facade that routes settlement operations to the
 * appropriate chain-specific service (EVM or Solana).
 *
 * For Solana, all methods accept an optional `token` param (default 'ALPHA').
 */
@Injectable()
export class SettlementRouterService {
  private readonly logger = new Logger(SettlementRouterService.name);

  constructor(
    private readonly evmSettlement: SettlementService,
    private readonly solanaSettlement: SolanaSettlementService,
  ) {}

  getTokenDecimals(chain: string, token: string = 'USDC'): number {
    if (chain === 'solana') {
      return this.solanaSettlement.getTokenDecimals(token);
    }
    return this.evmSettlement.getUsdcDecimals();
  }

  async transferTokenFromAgent(
    chain: string,
    agentPrivateKey: string,
    to: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    if (chain === 'solana') {
      return this.solanaSettlement.transferTokenFromAgent(agentPrivateKey, to, amount, token);
    }
    return this.evmSettlement.transferUsdcFromAgent(agentPrivateKey, to, amount);
  }

  async transferTokenFromPlatform(
    chain: string,
    to: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    if (chain === 'solana') {
      return this.solanaSettlement.transferTokenFromPlatform(to, amount, token);
    }
    return this.evmSettlement.transferUsdcFromPlatform(to, amount);
  }

  /**
   * Send fee to the dedicated fee wallet.
   */
  async sendFee(
    chain: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    if (chain === 'solana') {
      return this.solanaSettlement.sendFeeToFeeWallet(amount, token);
    }
    return this.evmSettlement.sendFeeToFeeWallet(amount);
  }

  async getAgentTokenBalance(chain: string, walletAddress: string, token: string = 'USDC'): Promise<string> {
    if (chain === 'solana') {
      return this.solanaSettlement.getAgentTokenBalance(walletAddress, token);
    }
    return this.evmSettlement.getAgentUsdcBalance(walletAddress);
  }

  async getAgentNativeBalance(chain: string, walletAddress: string): Promise<string> {
    if (chain === 'solana') {
      return this.solanaSettlement.getAgentSolBalance(walletAddress);
    }
    return this.evmSettlement.getAgentEthBalance(walletAddress);
  }

  getPlatformWalletAddress(chain: string): string | null {
    if (chain === 'solana') {
      return this.solanaSettlement.getPlatformWalletAddress();
    }
    return this.evmSettlement.getPlatformWalletAddress();
  }

  getFeeWalletAddress(chain: string): string | null {
    if (chain === 'solana') {
      return this.solanaSettlement.getFeeWalletAddress();
    }
    return this.evmSettlement.getFeeWalletAddress();
  }

  async escrow(
    chain: string,
    matchId: string,
    agentAAddress: string,
    agentBAddress: string,
    escrowAmount: bigint,
  ): Promise<string | null> {
    // Both Solana and Monad use implicit escrow: agents transfer their stake to
    // the platform wallet (done in escrowAndEnqueue), the platform pays the winner.
    this.logger.log(`Escrow is implicit (agent transfers) for match ${matchId} on ${chain}`);
    return null;
  }

  async payout(
    chain: string,
    matchId: string,
    winnerAddress: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<string | null> {
    if (chain === 'solana') {
      return this.solanaSettlement.transferTokenFromPlatform(winnerAddress, amount, token);
    }
    return this.evmSettlement.payout(matchId, winnerAddress, amount);
  }

  /** Refund each target. Returns EVERY tx signature (one transfer per agent on Solana). */
  async refund(
    chain: string,
    matchId: string,
    refundTargets?: Array<{ address: string; amount: bigint }>,
    token: string = 'USDC',
  ): Promise<string[]> {
    if (chain === 'solana') {
      if (!refundTargets?.length) {
        this.logger.warn(`Solana refund for match ${matchId} — no refund targets`);
        return [];
      }
      const txSigs: string[] = [];
      for (const target of refundTargets) {
        const sig = await this.solanaSettlement.transferTokenFromPlatform(target.address, target.amount, token);
        if (sig) txSigs.push(sig);
      }
      return txSigs;
    }
    // EVM/Monad: direct platform transfers, one per refund target.
    if (!refundTargets?.length) return [];
    const txSigs: string[] = [];
    for (const target of refundTargets) {
      const sig = await this.evmSettlement.transferUsdcFromPlatform(target.address, target.amount);
      if (sig) txSigs.push(sig);
    }
    return txSigs;
  }

  async ensureTokenAccounts(chain: string, walletAddress: string): Promise<void> {
    if (chain === 'solana') {
      await this.solanaSettlement.ensureTokenAccounts(walletAddress);
    }
  }

  async getAlphaPriceUsd(): Promise<number | null> {
    return this.solanaSettlement.getAlphaPriceUsd();
  }

  async buildPartiallySignedTransfer(
    chain: string,
    senderAddress: string,
    to: string,
    amount: bigint,
    token: string = 'USDC',
  ): Promise<{ transaction: string; blockhash: string } | null> {
    if (chain === 'solana') {
      return this.solanaSettlement.buildPartiallySignedTransfer(senderAddress, to, amount, token);
    }
    return null;
  }
}
