import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as bs58 from 'bs58';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Agent, Match } from '../database/schemas';
import { PodClient } from './pod.client';
import { ConfigService } from '../common/config/config.service';
import { CreateManagedAgentDto } from './dto/create-managed-agent.dto';
import { SaidService, SaidStatus } from '../said/said.service';
import { SettlementRouterService } from '../settlement/settlement-router.service';
import { RelayerService } from '../relayer/relayer.service';

const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Pod's on-chain deposit program (Anchor). deposit_usdc(code: [u8;8], amount: u64).
// A plain SPL transfer is NOT credited — the deposit_code must live in the ix data.
const POD_PROGRAM = new PublicKey('BBAdcqUkg68JXNiPQ1HR1wujfZuayyK3eQTQSYAh6FSW');
const DEPOSIT_USDC_DISCRIMINATOR = Buffer.from([184, 148, 250, 169, 224, 213, 34, 126]);
const MIN_FEE_LAMPORTS = 5000; // a single deposit tx fee

/** bs58 decode that tolerates both default and namespace import shapes. */
function bs58Decode(s: string): Uint8Array {
  const lib = (bs58 as any).default ?? bs58;
  return lib.decode(s);
}

@Injectable()
export class ManagedAgentService {
  private readonly logger = new Logger(ManagedAgentService.name);
  private connection: Connection | null = null;

  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly podClient: PodClient,
    private readonly configService: ConfigService,
    private readonly saidService: SaidService,
    private readonly settlementRouter: SettlementRouterService,
    private readonly relayer: RelayerService,
  ) {}

  /**
   * The agent's live match id (active match it's seated in), or null. Sides are
   * object keys (a, b, … i for poker), so check every possible seat.
   */
  private async findActiveMatchId(agentId: string): Promise<string | null> {
    const sides = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const match = await this.matchModel
      .findOne({
        status: 'active',
        $or: sides.map((s) => ({ [`agents.${s}.agentId`]: agentId })),
      })
      .select('_id')
      .sort({ createdAt: -1 });
    return match ? match._id.toString() : null;
  }

  /**
   * Register a managed agent's identity on-chain with SAID Protocol, signing
   * with the agent's custodial keypair (user-triggered, self-service).
   * The user pays SAID_REGISTRATION_FEE_USDC (default 1 USDC) from the agent's
   * stake balance; in exchange the platform fronts all the SOL (rent + fees).
   */
  async registerWithSaid(userId: string, agentId: string): Promise<{ ok: boolean; txSignature?: string; message?: string; feeChargedUsdc?: number }> {
    // SAID is paused on the Monad deployment (Solana-native protocol; agent
    // wallets here are EVM). Re-enable by setting SAID_PAUSED=false + a Solana flow.
    if (process.env.SAID_PAUSED !== 'false') {
      throw new BadRequestException('SAID verification is currently paused on Monad.');
    }
    const agent = await this.agentModel.findById(agentId).select('+walletPrivateKey');
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.userId?.toString() !== userId) throw new BadRequestException('Not your agent');
    if (!agent.managed) throw new BadRequestException('Not a managed agent');
    if (!agent.walletAddress || !agent.walletPrivateKey) throw new BadRequestException('Agent has no wallet');

    // Fee gate: dynamic quote = full SOL cost x SOL price x margin (the USER
    // pays everything — the platform never subsidizes). Floor of 1 USDC; env
    // can only raise it.
    const feeUsdc = await this.saidService.getVerificationFeeUsdc();
    const balance = await this.getSolanaUsdcBalance(agent.walletAddress).catch(() => 0);
    if (balance < feeUsdc) {
      throw new BadRequestException(
        `SAID verification costs ${feeUsdc} USDC — the agent balance is ${balance.toFixed(2)} USDC. Fund your agent first.`,
      );
    }

    // Public AgentCard JSON (served by our card.json endpoint) — stored on-chain
    // as the identity's metadata URI.
    const apiBase = process.env.PUBLIC_API_URL || 'https://api.alpharena.ai';
    const metadataUri = `${apiBase.replace(/\/$/, '')}/agents/managed/${agentId}/card.json`;

    // Full cycle: register if needed, then SAID's on-chain verification (the
    // blue badge). One click, one charge — only when at least one step ran.
    let didWork = false;

    const status = await this.saidService.getStatus(agent.walletAddress);
    if (status?.verified) return { ok: true, message: 'already verified' };

    if (!status?.registered) {
      const reg = await this.saidService.registerOnChain(agent.walletPrivateKey, metadataUri);
      if (!reg.ok) return reg;
      if (!/already/i.test(reg.message || '')) didWork = true;
    }

    const ver = await this.saidService.verifyOnChain(agent.walletPrivateKey);
    if (!ver.ok) return ver;
    if (!/already/i.test(ver.message || '')) didWork = true;

    // Charge AFTER success — balance was checked upfront, so a failure here is
    // a transient network error; we absorb the cost rather than double-charge.
    if (didWork) {
      try {
        const platformWallet = this.settlementRouter.getPlatformWalletAddress('solana');
        const decimals = this.settlementRouter.getTokenDecimals('solana', 'USDC');
        const amountAtomic = BigInt(Math.round(feeUsdc * 10 ** decimals));
        await this.settlementRouter.transferTokenFromAgent('solana', agent.walletPrivateKey, platformWallet!, amountAtomic, 'USDC');
        this.logger.log(`SAID verification fee charged: ${feeUsdc} USDC from agent ${agentId}`);
        return { ...ver, feeChargedUsdc: feeUsdc };
      } catch (e) {
        this.logger.error(`SAID fee charge failed for ${agentId} (verification kept): ${(e as Error).message}`);
      }
    }
    return ver;
  }

  /** Public AgentCard JSON for SAID metadata (no secrets — name/desc/skills only). */
  async getAgentCard(agentId: string): Promise<Record<string, unknown>> {
    const agent = await this.agentModel.findById(agentId);
    if (!agent || !agent.managed) throw new NotFoundException('Agent not found');
    return {
      name: agent.persona?.name || agent.name,
      description: 'AI agent competing on AlphArena (alpharena.ai) — plays chess, poker, UNO and RPS for USDC stakes on Solana.',
      website: `https://alpharena.ai/agents/${agentId}`,
      skills: ['gaming', 'chess', 'poker', 'uno', 'rps'],
      wallet: agent.walletAddress,
    };
  }

  private getConnection(): Connection {
    if (!this.connection) {
      // Managed-agent USDC is the MAINNET mint (EPjFW…), and users fund the stake
      // wallet on mainnet — so this read must hit a mainnet RPC. SOLANA_RPC_URL may
      // point to devnet (used elsewhere), which is why the stake showed 0.
      const rpcUrl =
        process.env.SOLANA_MAINNET_RPC_URL ||
        (this.configService.solanaRpcUrl && !/devnet|testnet/i.test(this.configService.solanaRpcUrl)
          ? this.configService.solanaRpcUrl
          : 'https://api.mainnet-beta.solana.com');
      this.connection = new Connection(rpcUrl, 'confirmed');
    }
    return this.connection;
  }

  /**
   * The in-process brain endpoint for a managed agent. The brain runs inside this
   * same back service, so the URL is always our own host — never an external server.
   * (A stale MANAGED_AGENT_SERVER_URL from the old separate-server design used to
   * bake a wrong, unreachable host into endpointUrl, which forfeited every match.)
   */
  private internalBrainUrl(agentId: string): string {
    const base =
      this.configService.managedAgentServerUrl ||
      `http://localhost:${process.env.PORT || 3001}`;
    return `${base.replace(/\/$/, '')}/internal/managed-agent/${agentId}`;
  }

  /**
   * Self-heal a managed agent's endpointUrl if it doesn't point at our current
   * internal brain route (e.g. baked wrong by an old env). Returns the correct URL.
   */
  async ensureBrainEndpoint(agent: Agent): Promise<string> {
    const expected = this.internalBrainUrl(agent._id.toString());
    if (agent.endpointUrl !== expected) {
      await this.agentModel.updateOne({ _id: agent._id }, { $set: { endpointUrl: expected } });
      agent.endpointUrl = expected;
      this.logger.log(`Repaired endpointUrl for managed agent ${agent._id} → ${expected}`);
    }
    return expected;
  }

  /** Find the managed agent owned by this user (if any). */
  async findMine(userId: string): Promise<Agent | null> {
    return this.agentModel.findOne({ userId, managed: true, status: { $ne: 'disabled' } });
  }

  /** All managed agents owned by this user (newest first). */
  async findAllMine(userId: string): Promise<Agent[]> {
    return this.agentModel
      .find({ userId, managed: true, status: { $ne: 'disabled' } })
      .sort({ createdAt: -1 });
  }

  /** Enrich every managed agent the user owns with live balances (for the dashboard list). */
  async getAllMineEnriched(
    userId: string,
  ): Promise<Array<{ agent: Agent; stakeUsdc: number; brainActive: boolean; podUsdc: number; currentMatchId: string | null; said: SaidStatus | null }>> {
    const agents = await this.agentModel
      .find({ userId, managed: true, status: { $ne: 'disabled' } })
      .select('+podToken')
      .sort({ createdAt: -1 });
    return Promise.all(
      agents.map(async (agent) => {
        const [stakeUsdc, brain, currentMatchId, said] = await Promise.all([
          this.getSolanaUsdcBalance(agent.walletAddress).catch(() => 0),
          this.probeBrain(agent),
          agent.status === 'in_match'
            ? this.findActiveMatchId(agent._id.toString()).catch(() => null)
            : Promise.resolve(null),
          this.saidService.getStatus(agent.walletAddress),
        ]);
        return { agent, stakeUsdc, brainActive: brain.activated, podUsdc: brain.balance, currentMatchId, said };
      }),
    );
  }

  /**
   * Find the user's managed agent and enrich it with LIVE data for the dashboard:
   *  - stakeUsdc: read on-chain (the cached value would be stale)
   *  - brainActive: probe Pod — it exposes no balance API, only activated/not.
   * Both run in parallel so the card load stays snappy.
   */
  async getMineEnriched(
    userId: string,
  ): Promise<{ agent: Agent; stakeUsdc: number; brainActive: boolean; podUsdc: number; currentMatchId: string | null } | null> {
    const agent = await this.agentModel
      .findOne({ userId, managed: true, status: { $ne: 'disabled' } })
      .select('+podToken');
    if (!agent) return null;

    const [stakeUsdc, brain, currentMatchId] = await Promise.all([
      this.getSolanaUsdcBalance(agent.walletAddress).catch((e) => {
        this.logger.warn(`stake balance read failed for ${agent._id}: ${(e as Error).message}`);
        return 0;
      }),
      this.probeBrain(agent),
      agent.status === 'in_match'
        ? this.findActiveMatchId(agent._id.toString()).catch(() => null)
        : Promise.resolve(null),
    ]);

    return { agent, stakeUsdc, brainActive: brain.activated, podUsdc: brain.balance, currentMatchId };
  }

  /**
   * Live Pod balance + activation via GET /proxy/<token>/balance. On a network error
   * we fall back to cached values rather than flip the UI to "off"/"$0". Persists the
   * fresh balance + activation so subsequent loads are correct even if Pod is briefly down.
   */
  private async probeBrain(agent: Agent): Promise<{ activated: boolean; balance: number }> {
    const token = agent.podToken;
    if (!token) return { activated: agent.podActivated || false, balance: agent.podBalanceUsdc || 0 };

    const r = await this.podClient.getBalance(token);
    if (r === null) {
      // network blip — trust cache
      return { activated: agent.podActivated || false, balance: agent.podBalanceUsdc || 0 };
    }

    this.agentModel
      .updateOne(
        { _id: agent._id },
        {
          $set: {
            podActivated: r.activated || agent.podActivated,
            podBalanceUsdc: r.balance,
            podLastBalanceCheck: new Date(),
          },
        },
      )
      .catch(() => {});

    return r;
  }

  /** Return avatars already used by a specific user's managed agents. */
  async getTakenAvatars(userId?: string): Promise<string[]> {
    const filter: any = { managed: true, 'persona.avatar': { $exists: true }, status: { $ne: 'disabled' } };
    if (userId) filter.userId = userId;
    const agents = await this.agentModel
      .find(filter)
      .select('persona.avatar')
      .lean();
    return [...new Set(agents.map((a: any) => a.persona?.avatar).filter(Boolean))];
  }

  /** Create a new managed agent: Pod register + Solana wallet + Mongo insert. */
  async create(userId: string, dto: CreateManagedAgentDto): Promise<Agent> {
    // Users may own multiple managed agents — no single-agent guard.
    if (!dto.persona?.name?.trim()) {
      throw new BadRequestException('persona.name is required');
    }

    // Prevent same user from having two agents with the same avatar
    if (dto.persona?.avatar) {
      const taken = await this.getTakenAvatars(userId);
      if (taken.includes(dto.persona.avatar)) {
        throw new BadRequestException('You already have an agent with this avatar. Please choose another one.');
      }
    }

    // 1. Register a Pod token (this is free, just an HTTP call)
    const pod = await this.podClient.register();
    this.logger.log(`Pod registered: token=${pod.apiToken.slice(0, 8)}... code=${pod.depositCode}`);

    // 2. Generate a fresh Monad (EVM) wallet for stakes
    const stakePrivKey = generatePrivateKey();
    const stakeAccount = privateKeyToAccount(stakePrivKey);
    const walletAddress = stakeAccount.address;
    const walletPrivateKey = stakePrivKey;

    // 3. Insert agent in Mongo
    const agent = await this.agentModel.create({
      userId,
      name: dto.persona.name,
      type: 'http',
      // endpointUrl is patched below to embed the agent id so the shared
      // managed-agent-server knows which agent's Pod token + persona to use.
      endpointUrl: '',
      walletAddress,
      walletPrivateKey,
      chain: 'monad',
      gameTypes: ['chess', 'rps', 'poker', 'uno', 'werewolf', '2048'],
      status: 'idle',
      managed: true,
      persona: {
        name: dto.persona.name.trim().slice(0, 30),
        avatar: dto.persona.avatar || '🤖',
        vibe: dto.persona.vibe || 'balanced',
      },
      llmModel: dto.model || 'claude-haiku-4-5',
      podToken: pod.apiToken,
      podDepositAddress: pod.contractAddress,
      podDepositCode: pod.depositCode,
      podDashboardUrl: pod.dashboardUrl,
      podActivated: false,
      podBalanceUsdc: 0,
    });

    // The brain lives inside this same back service. The orchestrator pushes
    // moves over HTTP to endpointUrl, so we point it at our own internal route.
    agent.endpointUrl = this.internalBrainUrl(agent._id.toString());
    await agent.save();

    this.logger.log(`Managed agent created: ${dto.persona.name} (id=${agent._id}) by user ${userId}`);
    return agent;
  }

  /** Get balances of the stake wallet (USDC on Solana) and Pod's live balance. */
  async getBalances(userId: string, agentId: string): Promise<{ stakeUsdc: number; podUsdc: number }> {
    const agent = await this.agentModel.findById(agentId).select('+podToken');
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.userId?.toString() !== userId) throw new BadRequestException('Not your agent');
    if (!agent.managed) throw new BadRequestException('Not a managed agent');

    const [stakeUsdc, brain] = await Promise.all([
      this.getSolanaUsdcBalance(agent.walletAddress).catch((e) => {
        this.logger.warn(`Failed stake USDC balance for ${agentId}: ${(e as Error).message}`);
        return 0;
      }),
      this.probeBrain(agent),
    ]);

    return { stakeUsdc, podUsdc: brain.balance };
  }

  /**
   * Programmatically fund the agent's Pod brain by moving USDC from its stake wallet
   * into Pod via the on-chain `deposit_usdc` instruction. The platform pays the tx fee
   * (so a fresh user's wallet needs no SOL); falls back to the agent paying if the
   * platform key isn't configured. Returns the tx signature + new Pod balance.
   */
  async depositStakeToPod(
    userId: string,
    agentId: string,
    amountUsdc: number,
  ): Promise<{ txSignature: string; amount: number; podUsdc: number }> {
    if (!amountUsdc || amountUsdc <= 0) throw new BadRequestException('amount must be > 0');

    const agent = await this.agentModel.findById(agentId).select('+walletPrivateKey');
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.userId?.toString() !== userId) throw new BadRequestException('Not your agent');
    if (!agent.managed) throw new BadRequestException('Not a managed agent');
    if (!agent.podDepositCode || !/^[0-9a-fA-F]{16}$/.test(agent.podDepositCode)) {
      throw new BadRequestException('Agent has no valid Pod deposit code');
    }
    if (!agent.walletPrivateKey) throw new BadRequestException('Agent wallet key unavailable');

    // Cross-chain brain funding:
    //  1. Move `amountUsdc` Monad USDC from the agent's stake wallet → relayer (platform) Monad wallet.
    //  2. The relayer credits the agent's Pod brain with the equivalent USDC on Solana.
    const stakeUsdc = await this.getSolanaUsdcBalance(agent.walletAddress);
    if (stakeUsdc < amountUsdc) {
      throw new BadRequestException(
        `Insufficient stake USDC: has ${stakeUsdc}, need ${amountUsdc}. Fund ${agent.walletAddress} first.`,
      );
    }

    const platformMonad = this.settlementRouter.getPlatformWalletAddress('monad');
    if (!platformMonad) throw new BadRequestException('Monad relayer wallet not configured.');

    // 1. Pull the USDC into the relayer wallet on Monad.
    const decimals = this.settlementRouter.getTokenDecimals('monad', 'USDC');
    const atomic = BigInt(Math.round(amountUsdc * 10 ** decimals));
    const monadTx = await this.settlementRouter.transferTokenFromAgent(
      'monad',
      agent.walletPrivateKey,
      platformMonad,
      atomic,
      'USDC',
    );
    if (!monadTx) throw new BadRequestException('Monad USDC transfer to relayer failed.');
    this.logger.log(`Brain fund: pulled ${amountUsdc} USDC on Monad from agent ${agentId} (tx: ${monadTx})`);

    // 2. Relayer credits the Pod brain on Solana.
    let sig: string;
    try {
      sig = await this.relayer.fundPodBrain(agent.podDepositCode, amountUsdc);
    } catch (e) {
      this.logger.error(`Relayer Pod deposit failed for ${agentId}: ${(e as Error).message}`);
      throw new BadRequestException(`Brain funding failed at the relayer: ${(e as Error).message}`);
    }

    // Refresh the cached Pod balance (Pod credits within a few seconds).
    const after = await this.refreshPodBalance(userId, agentId).catch(() => ({ podUsdc: 0, activated: false }));
    return { txSignature: sig, amount: amountUsdc, podUsdc: after.podUsdc };
  }

  /** Poll Pod for activation status; update cached balance if available. */
  async refreshPodBalance(userId: string, agentId: string): Promise<{ podUsdc: number; activated: boolean }> {
    const agent = await this.agentModel.findById(agentId).select('+podToken');
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.userId?.toString() !== userId) throw new BadRequestException('Not your agent');
    if (!agent.managed) throw new BadRequestException('Not a managed agent');

    const podToken = agent.podToken;
    if (!podToken) return { podUsdc: agent.podBalanceUsdc || 0, activated: agent.podActivated };

    const r = await this.podClient.getBalance(podToken);
    if (r === null) {
      // network blip — return cached
      return { podUsdc: agent.podBalanceUsdc || 0, activated: agent.podActivated };
    }
    await this.agentModel.updateOne(
      { _id: agentId },
      {
        $set: {
          podActivated: r.activated || agent.podActivated,
          podBalanceUsdc: r.balance,
          podLastBalanceCheck: new Date(),
        },
      },
    );

    return { podUsdc: r.balance, activated: r.activated };
  }

  /** Change which LLM an existing managed agent's brain uses. */
  async setModel(userId: string, agentId: string, model: string): Promise<{ model: string }> {
    if (!model?.trim()) throw new BadRequestException('model is required');
    const agent = await this.agentModel.findById(agentId);
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.userId?.toString() !== userId) throw new BadRequestException('Not your agent');
    if (!agent.managed) throw new BadRequestException('Not a managed agent');
    await this.agentModel.updateOne({ _id: agentId }, { $set: { llmModel: model.trim().slice(0, 60) } });
    this.logger.log(`Managed agent ${agentId} model → ${model}`);
    return { model: model.trim().slice(0, 60) };
  }

  /** Soft-delete a managed agent so the user can create another. */
  async deleteMine(userId: string, agentId: string): Promise<{ ok: true }> {
    const agent = await this.agentModel.findById(agentId);
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.userId?.toString() !== userId) throw new BadRequestException('Not your agent');
    if (!agent.managed) throw new BadRequestException('Not a managed agent');
    if (agent.status === 'in_match') {
      throw new BadRequestException('Cannot delete an agent while it is in a match.');
    }
    await this.agentModel.updateOne({ _id: agentId }, { $set: { status: 'disabled' } });
    this.logger.log(`Managed agent ${agentId} soft-deleted by user ${userId}`);
    return { ok: true };
  }

  /**
   * Live USDC balance of the agent's STAKE wallet. The stake wallet is on Monad
   * (EVM), so this reads the Monad USDC balance via the settlement router.
   * (Method name kept for call-site compatibility.)
   */
  private async getSolanaUsdcBalance(walletAddress: string): Promise<number> {
    if (!walletAddress) return 0;
    const bal = await this.settlementRouter
      .getAgentTokenBalance('monad', walletAddress, 'USDC')
      .catch(() => '0');
    return parseFloat(bal) || 0;
  }
}
