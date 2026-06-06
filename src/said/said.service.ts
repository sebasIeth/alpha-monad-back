import { Injectable, Logger } from '@nestjs/common';

/**
 * SAID Protocol (saidprotocol.com) — on-chain identity & verification for AI
 * agents on Solana. Verification checks are free and keyless; registering an
 * agent in the SAID directory (off-chain) is also free. The 0.01 SOL on-chain
 * verification is paid by the agent itself (via their CLI/SDK), not by us.
 */

export interface SaidStatus {
  registered: boolean;
  verified: boolean;
  /** SAID reputation trust tier (e.g. "low", "bronze") when available. */
  trustTier: string | null;
  /** Composite trust score 0-100 when available. */
  trustScore: number | null;
}

interface CacheEntry {
  status: SaidStatus | null; // null = lookup failed (cached briefly to avoid hammering)
  fetchedAt: number;
}

const SAID_API = 'https://api.saidprotocol.com';
const OK_TTL_MS = 60 * 60 * 1000; // verification rarely changes — 1h
const ERR_TTL_MS = 5 * 60 * 1000; // retry failed lookups after 5 min
const TIMEOUT_MS = 6_000;

/** Worst-case SOL the platform fronts per full verification (register rent
 *  top-up + 0.01 SOL SAID fee + rent-exempt floors + tx fees). */
export const SAID_TOTAL_SOL_COST = 0.0145;
/** Margin over raw cost so SOL price swings between quote and charge never
 *  leave the platform subsidizing. */
const FEE_MARGIN = 1.25;
const SOL_PRICE_TTL_MS = 10 * 60 * 1000;
/** Conservative fallback when every price source fails — overprices rather
 *  than undercharges. */
const SOL_PRICE_FALLBACK_USD = 250;

@Injectable()
export class SaidService {
  private readonly logger = new Logger(SaidService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private solPrice: { usd: number; fetchedAt: number } | null = null;

  /** SOL/USD with a 10-min cache; conservative fallback on outage. */
  private async getSolPriceUsd(): Promise<number> {
    if (this.solPrice && Date.now() - this.solPrice.fetchedAt < SOL_PRICE_TTL_MS) return this.solPrice.usd;
    const sources: Array<() => Promise<number>> = [
      async () => {
        const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(5000) });
        const j: any = await r.json();
        return Number(j?.solana?.usd);
      },
      async () => {
        const r = await fetch('https://lite-api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112', { signal: AbortSignal.timeout(5000) });
        const j: any = await r.json();
        return Number(j?.data?.So11111111111111111111111111111111111111112?.price);
      },
    ];
    for (const src of sources) {
      try {
        const usd = await src();
        if (usd > 0) {
          this.solPrice = { usd, fetchedAt: Date.now() };
          return usd;
        }
      } catch { /* next source */ }
    }
    this.logger.warn(`SOL price sources failed — using conservative fallback $${SOL_PRICE_FALLBACK_USD}`);
    return SOL_PRICE_FALLBACK_USD;
  }

  /**
   * USDC price the USER pays for a full verification: real SOL cost × SOL/USD
   * × margin, rounded up to whole USDC. Env can only raise it; floor is 1.
   */
  async getVerificationFeeUsdc(): Promise<number> {
    const solUsd = await this.getSolPriceUsd();
    const dynamic = Math.ceil(SAID_TOTAL_SOL_COST * solUsd * FEE_MARGIN);
    const envFee = Number(process.env.SAID_REGISTRATION_FEE_USDC) || 0;
    return Math.max(1, dynamic, envFee);
  }

  /**
   * Verification status for a wallet. Fail-safe: any SAID outage or timeout
   * returns null and MUST be treated as "unknown", never as "not verified
   * forever" — callers simply omit the badge.
   */
  async getStatus(wallet: string | null | undefined): Promise<SaidStatus | null> {
    // SAID is paused on the Monad deployment (SAID is a Solana-native protocol;
    // agent wallets here are EVM). Returning null hides the SAID UI cleanly.
    if (process.env.SAID_PAUSED !== 'false') return null;
    if (!wallet) return null;

    const hit = this.cache.get(wallet);
    if (hit) {
      const ttl = hit.status ? OK_TTL_MS : ERR_TTL_MS;
      if (Date.now() - hit.fetchedAt < ttl) return hit.status;
    }

    // The REST API carries reputation extras but its indexer lags the chain
    // (a freshly registered PDA shows registered:false for a while) — so when
    // REST says "not registered", double-check the chain itself.
    let status = await this.fetchRestStatus(wallet);
    if (!status || !status.registered || !status.verified) {
      // The indexer lags BOTH flags — when either is still false, the chain decides.
      const onchain = await this.fetchOnChainStatus(wallet);
      if (onchain?.registered) {
        status = {
          ...onchain,
          trustTier: status?.trustTier ?? null,
          trustScore: status?.trustScore ?? null,
        };
      } else if (!status) {
        status = onchain;
      }
    }

    this.cache.set(wallet, { status, fetchedAt: Date.now() });
    return status;
  }

  /** SAID REST status (includes reputation); null on outage. */
  private async fetchRestStatus(wallet: string): Promise<SaidStatus | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const res = await fetch(`${SAID_API}/api/verify/${wallet}`, { signal: controller.signal });
      clearTimeout(timer);
      // SAID answers 404 WITH a valid body ({registered:false,...}) for unknown
      // agents — that's real data ("not registered"), not an outage.
      const data: any = await res.json().catch(() => null);
      if (!data || typeof data.registered === 'undefined') throw new Error(`HTTP ${res.status}`);
      return {
        registered: !!data.registered,
        verified: !!data.verified,
        trustTier: data.reputation?.trustTier ?? data.reputation?.tier ?? null,
        trustScore: typeof data.trustScore?.score === 'number' ? data.trustScore.score : null,
      };
    } catch (e) {
      this.logger.warn(`SAID REST lookup failed for ${wallet}: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Source of truth: read the SAID identity PDA straight from the chain.
   * Parsed manually — the SDK's lookup() hard-codes a 263-byte account size /
   * stale layout and returns null for identities its own registerAgent() wrote.
   * Actual on-chain layout (reverse-engineered from a live account):
   *   8 discriminator | 32 owner | 32 authority | 4 uriLen | uri | 8 registeredAt | 1 isVerified | 8 verifiedAt
   */
  private async fetchOnChainStatus(wallet: string): Promise<SaidStatus | null> {
    const rpcs = [process.env.SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com'].filter(
      (u, i, arr): u is string => !!u && arr.indexOf(u) === i,
    );
    for (const rpcUrl of rpcs) {
      try {
        const { SAID } = await import('said-sdk');
        const { Connection } = await import('@solana/web3.js');
        const [pda] = SAID.deriveAgentPDA(wallet);
        const conn = new Connection(rpcUrl, 'confirmed');
        const info = await conn.getAccountInfo(pda);
        if (!info || !info.data || info.data.length < 61) {
          return { registered: false, verified: false, trustTier: null, trustScore: null };
        }
        let verified = false;
        try {
          const uriLength = info.data.readUInt32LE(72);
          if (uriLength > 0 && 76 + uriLength + 9 <= info.data.length) {
            verified = info.data[76 + uriLength + 8] === 1;
          }
        } catch {
          /* tolerate layout drift — registration alone still counts */
        }
        return { registered: true, verified, trustTier: null, trustScore: null };
      } catch (e) {
        this.logger.warn(`SAID on-chain lookup failed for ${wallet} via ${rpcUrl}: ${(e as Error).message}`);
      }
    }
    return null;
  }

  /**
   * Register an agent identity ON-CHAIN (SAID PDA on Solana) signing with the
   * agent's own custodial keypair. The platform wallet funds the ~0.003 SOL
   * rent so agent wallets don't need SOL. Idempotent: an already-registered
   * wallet is reported as success.
   */
  async registerOnChain(
    agentSecretKeyBase58: string,
    metadataUri: string,
  ): Promise<{ ok: boolean; txSignature?: string; message?: string }> {
    // Lazy imports keep boot fast and avoid hard-failing if the SDK is absent.
    const { SAID } = await import('said-sdk');
    const { Keypair } = await import('@solana/web3.js');
    const bs58 = (await import('bs58')) as any;
    const decode = (s: string) => (bs58.default ?? bs58).decode(s);

    const agentWallet = Keypair.fromSecretKey(decode(agentSecretKeyBase58));
    const walletAddress = agentWallet.publicKey.toBase58();

    // Primary RPC first; public mainnet as fallback (a rate-limited Helius key
    // shouldn't block a one-off registration tx).
    const rpcs = [process.env.SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com'].filter(
      (u, i, arr): u is string => !!u && arr.indexOf(u) === i,
    );

    // SAID's register_agent transfers the PDA rent (~0.0033 SOL) FROM THE AGENT
    // WALLET — the SDK "funder" only covers the tx fee. Agent wallets hold no
    // SOL by design, so the platform tops up the shortfall first.
    // PDA rent (3 271 200) + the agent wallet's own rent-exempt floor (~900k):
    // after paying the rent the agent account must still hold the minimum.
    const RENT_TARGET_LAMPORTS = 4_200_000;
    // Every Solana account must keep the rent-exempt minimum (~0.00089 SOL) —
    // the funder can't be drained below it or the transfer fails simulation.
    const RENT_EXEMPT_MIN_LAMPORTS = 900_000;
    const TX_FEE_LAMPORTS = 15_000;

    let lastError = 'no RPC available';
    for (const rpcUrl of rpcs) {
      try {
        const said = new SAID({ rpcUrl });

        if (await said.isRegistered(walletAddress)) {
          this.cache.delete(walletAddress);
          return { ok: true, message: 'already registered' };
        }

        const funderKey = process.env.SOLANA_PRIVATE_KEY;
        const funder = funderKey ? Keypair.fromSecretKey(decode(funderKey)) : undefined;

        const { Connection, SystemProgram, Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
        const conn = new Connection(rpcUrl, 'confirmed');
        const agentLamports = await conn.getBalance(agentWallet.publicKey);
        if (agentLamports < RENT_TARGET_LAMPORTS) {
          if (!funder) return { ok: false, message: 'Agent wallet lacks SOL for SAID rent and no platform funder is configured.' };
          const shortfall = RENT_TARGET_LAMPORTS - agentLamports;
          const funderLamports = await conn.getBalance(funder.publicKey);
          if (funderLamports < shortfall + TX_FEE_LAMPORTS + RENT_EXEMPT_MIN_LAMPORTS) {
            const needSol = ((shortfall + TX_FEE_LAMPORTS + RENT_EXEMPT_MIN_LAMPORTS - funderLamports) / 1e9).toFixed(4);
            return { ok: false, message: `Platform wallet needs ~${needSol} more SOL to fund the SAID registration rent.` };
          }
          const topUp = new Transaction().add(
            SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: agentWallet.publicKey, lamports: shortfall }),
          );
          await sendAndConfirmTransaction(conn, topUp, [funder], { commitment: 'confirmed' });
          this.logger.log(`SAID rent top-up: ${shortfall} lamports → ${walletAddress}`);
        }

        const res = await said.registerAgent(agentWallet, metadataUri, funder);
        this.cache.delete(walletAddress); // next read picks up the new state
        this.logger.log(`SAID on-chain registration for ${walletAddress}: pda=${res.agentPDA} tx=${res.txSignature}`);
        return { ok: true, txSignature: res.txSignature };
      } catch (e) {
        lastError = (e as Error).message;
        this.logger.warn(`SAID register error for ${walletAddress} via ${rpcUrl}: ${lastError}`);
        // Rate limits / network issues → try the next RPC; anything else is final.
        if (!/429|rate|max usage|blockhash|fetch failed|timeout/i.test(lastError)) break;
      }
    }
    return { ok: false, message: lastError };
  }

  /**
   * SAID on-chain VERIFICATION (the blue badge): the agent pays SAID's 0.01 SOL
   * fee to the protocol treasury, signing with its own keypair. As with
   * registration, the platform tops up the agent's SOL first.
   */
  async verifyOnChain(agentSecretKeyBase58: string): Promise<{ ok: boolean; txSignature?: string; message?: string }> {
    const { SAID } = await import('said-sdk');
    const { Keypair, Connection, SystemProgram, Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
    const bs58 = (await import('bs58')) as any;
    const decode = (s: string) => (bs58.default ?? bs58).decode(s);

    const agentWallet = Keypair.fromSecretKey(decode(agentSecretKeyBase58));
    const walletAddress = agentWallet.publicKey.toBase58();

    // 0.01 SOL fee + the agent's rent-exempt floor + tx fee headroom.
    const VERIFY_TARGET_LAMPORTS = 11_000_000;
    const RENT_EXEMPT_MIN_LAMPORTS = 900_000;
    const TX_FEE_LAMPORTS = 15_000;

    const rpcs = [process.env.SOLANA_RPC_URL, 'https://api.mainnet-beta.solana.com'].filter(
      (u, i, arr): u is string => !!u && arr.indexOf(u) === i,
    );

    let lastError = 'no RPC available';
    for (const rpcUrl of rpcs) {
      try {
        const onchain = await this.fetchOnChainStatus(walletAddress);
        if (onchain?.verified) {
          this.cache.delete(walletAddress);
          return { ok: true, message: 'already verified' };
        }
        if (onchain && !onchain.registered) {
          return { ok: false, message: 'Agent must be registered before verification.' };
        }

        const funderKey = process.env.SOLANA_PRIVATE_KEY;
        const funder = funderKey ? Keypair.fromSecretKey(decode(funderKey)) : undefined;
        const conn = new Connection(rpcUrl, 'confirmed');

        const agentLamports = await conn.getBalance(agentWallet.publicKey);
        if (agentLamports < VERIFY_TARGET_LAMPORTS) {
          if (!funder) return { ok: false, message: 'Agent wallet lacks SOL for the SAID verification fee and no platform funder is configured.' };
          const shortfall = VERIFY_TARGET_LAMPORTS - agentLamports;
          const funderLamports = await conn.getBalance(funder.publicKey);
          if (funderLamports < shortfall + TX_FEE_LAMPORTS + RENT_EXEMPT_MIN_LAMPORTS) {
            const needSol = ((shortfall + TX_FEE_LAMPORTS + RENT_EXEMPT_MIN_LAMPORTS - funderLamports) / 1e9).toFixed(4);
            return { ok: false, message: `Platform wallet needs ~${needSol} more SOL to fund the SAID verification fee.` };
          }
          const topUp = new Transaction().add(
            SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: agentWallet.publicKey, lamports: shortfall }),
          );
          await sendAndConfirmTransaction(conn, topUp, [funder], { commitment: 'confirmed' });
          this.logger.log(`SAID verify top-up: ${shortfall} lamports → ${walletAddress}`);
        }

        const said = new SAID({ rpcUrl });
        const res = await said.verifyAgent(agentWallet);
        // Pin the truth in the cache — a lagging REST read right after this
        // would otherwise re-poison it with verified:false for an hour.
        this.cache.set(walletAddress, {
          status: { registered: true, verified: true, trustTier: null, trustScore: null },
          fetchedAt: Date.now(),
        });
        this.logger.log(`SAID on-chain verification for ${walletAddress}: tx=${res.txSignature}`);
        return { ok: true, txSignature: res.txSignature };
      } catch (e) {
        lastError = (e as Error).message;
        this.logger.warn(`SAID verify error for ${walletAddress} via ${rpcUrl}: ${lastError}`);
        if (!/429|rate|max usage|blockhash|fetch failed|timeout/i.test(lastError)) break;
      }
    }
    return { ok: false, message: lastError };
  }
}
