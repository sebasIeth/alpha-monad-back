import { Injectable, Logger } from '@nestjs/common';

/**
 * Minimal client for Pod (usepod.ai) — decentralized AI inference on Solana.
 *
 * Pod issues a token + deposit address on register. Users fund the deposit
 * address with USDC (via Pod's deposit instruction on Solana mainnet).
 * Once activated, inference calls go to https://api.usepod.ai/proxy/<token>
 * with any OpenAI/Anthropic-compatible SDK.
 */
@Injectable()
export class PodClient {
  private readonly logger = new Logger(PodClient.name);
  private readonly baseUrl = 'https://api.usepod.ai';

  /** Register a fresh Pod token and get its deposit info. */
  async register(): Promise<PodRegisterResponse> {
    const res = await fetch(`${this.baseUrl}/v1/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Pod register failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as PodRegisterRaw;
    return {
      apiToken: json.api_token,
      depositCode: json.deposit_code,
      contractAddress: json.instructions?.contract_address ?? '',
      dashboardUrl: json.instructions?.dashboard_url ?? '',
      status: json.status,
    };
  }

  /**
   * Read the live balance + activation for a token.
   *   GET https://api.usepod.ai/proxy/<token>/balance
   *   → { is_active: bool, usdc_balance: <microunits>, credit_balance, ... }
   * usdc_balance is in microunits (1 USDC = 1_000_000). Returns null on network error
   * so callers can fall back to cached values rather than show a wrong "0".
   */
  async getBalance(apiToken: string): Promise<{ activated: boolean; balance: number } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/proxy/${apiToken}/balance`);
      if (!res.ok) {
        // 401/404 before the deposit lands — token exists but isn't live yet
        return { activated: false, balance: 0 };
      }
      const j = (await res.json()) as { is_active?: boolean; usdc_balance?: number };
      return {
        activated: !!j.is_active,
        balance: (j.usdc_balance ?? 0) / 1_000_000,
      };
    } catch (e) {
      this.logger.warn(`Pod balance check failed for token ${apiToken.slice(0, 8)}...: ${(e as Error).message}`);
      return null;
    }
  }

  /** Back-compat: activation only (delegates to getBalance). */
  async checkActivation(apiToken: string): Promise<{ activated: boolean; balance?: number }> {
    const r = await this.getBalance(apiToken);
    if (!r) return { activated: false };
    return { activated: r.activated, balance: r.balance };
  }
}

interface PodRegisterRaw {
  api_token: string;
  deposit_code: string;
  instructions?: {
    contract_address?: string;
    dashboard_url?: string;
  };
  status: string;
}

export interface PodRegisterResponse {
  apiToken: string;
  depositCode: string;
  contractAddress: string;
  dashboardUrl: string;
  status: string;
}
