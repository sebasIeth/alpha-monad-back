import { Injectable, Logger, BadRequestException, NotFoundException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Agent, User, Match } from '../database/schemas';
import { MatchmakingService } from '../matchmaking/matchmaking.service';
import { SettlementRouterService } from '../settlement/settlement-router.service';
import { X402PaymentStore } from '../settlement/x402-payment-store.service';
import { HumanMoveService } from '../orchestrator/human-move.service';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { MatchManagerService } from '../orchestrator/match-manager.service';
import { DEFAULT_ELO, DISABLED_GAME_TYPES } from '../common/constants/game.constants';

@Injectable()
export class PlayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlayService.name);
  private readonly withdrawCooldowns = new Map<string, number>();
  private static readonly WITHDRAW_COOLDOWN_MS = 60_000; // 1 minute
  private autoplayInterval: ReturnType<typeof setInterval> | null = null;
  private autoplayRunning = false;
  private static readonly AUTOPLAY_INTERVAL_MS = 10_000;

  onModuleInit() {
    // Don't start the loop immediately — only start it when at least one agent
    // has autoPlay enabled. This avoids pointless Mongo queries every 10s when
    // nobody is using autoplay.
    void this.maybeStartAutoplayLoop();
  }

  onModuleDestroy() {
    this.stopAutoplayLoop();
  }

  /** Start the autoplay polling loop if it's not already running. */
  private startAutoplayLoop() {
    if (this.autoplayInterval) return; // already running
    this.autoplayInterval = setInterval(() => { void this.autoplayTick(); }, PlayService.AUTOPLAY_INTERVAL_MS);
    this.logger.log('Managed autoplay loop started');
  }

  /** Stop the autoplay polling loop. */
  private stopAutoplayLoop() {
    if (!this.autoplayInterval) return;
    clearInterval(this.autoplayInterval);
    this.autoplayInterval = null;
    this.logger.log('Managed autoplay loop stopped (no agents with autoPlay)');
  }

  /** Check if any agent has autoPlay enabled; start or stop the loop accordingly. */
  private async maybeStartAutoplayLoop() {
    const count = await this.agentModel.countDocuments({ managed: true, autoPlay: true }).catch(() => 0);
    if (count > 0) {
      this.startAutoplayLoop();
    } else {
      this.stopAutoplayLoop();
    }
  }

  /**
   * One autoplay tick: enqueue every idle, funded, autoPlay managed agent that isn't
   * already queued/in a match. Errors per-agent are swallowed so one bad agent never
   * stops the loop (e.g. insufficient stake → just skipped until refunded/funded).
   * If no agents have autoPlay enabled, the loop stops itself.
   */
  private async autoplayTick(): Promise<void> {
    if (this.autoplayRunning) return; // avoid overlap if a tick runs long
    this.autoplayRunning = true;
    try {
      const agents = await this.agentModel
        .find({ managed: true, autoPlay: true, status: 'idle' })
        .select('+walletPrivateKey');

      // No autoPlay agents at all — stop the loop to save resources
      if (agents.length === 0) {
        const totalAutoPlay = await this.agentModel.countDocuments({ managed: true, autoPlay: true }).catch(() => 0);
        if (totalAutoPlay === 0) {
          this.stopAutoplayLoop();
          return;
        }
        // Some exist but none are idle (all queued/in_match) — keep polling
        return;
      }

      // Keep only agents that can ACTUALLY play right now (brain active + enough stake
      // on-chain). Counting by status alone strands a funded agent next to a broke one.
      const ready: Array<{ agent: Agent; stake: number }> = [];
      for (const agent of agents) {
        const stake = agent.autoPlayStakeAmount && agent.autoPlayStakeAmount > 0 ? agent.autoPlayStakeAmount : 1;
        if (await this.canAutoplay(agent, stake)) ready.push({ agent, stake });
      }
      if (ready.length === 0) return;

      // Don't strand a lone agent: only enqueue when there will be ≥2 in the queue
      // (already-waiting players + the ready agents) so they can actually pair.
      const alreadyWaiting = await this.matchmakingService.getQueueSize().catch(() => 0);
      if (alreadyWaiting + ready.length < 2) {
        this.logger.log(`Autoplay: holding ${ready.length} funded agent(s) — waiting for an opponent in queue`);
        return;
      }

      for (const { agent, stake } of ready) {
        try {
          await this.escrowAndEnqueue(agent, 'any', stake);
          this.logger.log(`Autoplay: enqueued ${agent.persona?.name || agent.name} (${agent._id}) @ ${stake} USDC`);
          await this.agentModel.updateOne({ _id: agent._id }, { $set: { autoPlayConsecutiveErrors: 0 } });
        } catch (e) {
          // Log the error so we can diagnose matchmaking failures.
          this.logger.warn(`Autoplay skip ${agent.persona?.name || agent.name} (${agent._id}): ${(e as Error).message}`);
          await this.agentModel.updateOne({ _id: agent._id }, { $inc: { autoPlayConsecutiveErrors: 1 } }).catch(() => {});
        }
      }
    } catch (e) {
      this.logger.warn(`Autoplay tick failed: ${(e as Error).message}`);
    } finally {
      this.autoplayRunning = false;
    }
  }

  /** Can this agent actually enter a staked match right now? (brain funded + stake on-chain) */
  private async canAutoplay(agent: Agent, stake: number): Promise<boolean> {
    if (!agent.podActivated || (agent.podBalanceUsdc ?? 0) <= 0) return false;
    try {
      const bal = await this.settlementRouter.getAgentTokenBalance(agent.chain || 'monad', agent.walletAddress, 'USDC');
      return parseFloat(bal) >= stake;
    } catch {
      return false;
    }
  }

  /** Toggle autonomous play for a user's managed agent. */
  async setManagedAutoplay(userId: string, enabled: boolean, agentId?: string): Promise<{ autoPlay: boolean; leftQueue?: boolean }> {
    const agent = await this.resolveMyManagedAgent(userId, agentId);
    await this.agentModel.updateOne({ _id: agent._id }, { $set: { autoPlay: enabled } });
    this.logger.log(`Autoplay ${enabled ? 'ON' : 'OFF'} for managed agent ${agent._id}`);

    // Start or stop the loop based on whether any agent now has autoPlay
    if (enabled) {
      this.startAutoplayLoop();
    } else {
      void this.maybeStartAutoplayLoop();
    }

    // Turning autoplay OFF while waiting in the queue should also leave it (and refund),
    // otherwise the agent stays queued with its stake locked.
    let leftQueue = false;
    if (!enabled && agent.status === 'queued') {
      try {
        await this.matchmakingService.leaveQueue(agent._id.toString());
        await this.agentModel.updateOne({ _id: agent._id }, { $set: { status: 'idle' } });
        leftQueue = true;
        this.logger.log(`Autoplay off → left queue + refunded for ${agent._id}`);
      } catch (e) {
        this.logger.warn(`Autoplay off: could not leave queue for ${agent._id}: ${(e as Error).message}`);
      }
    }
    return { autoPlay: enabled, leftQueue };
  }

  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly matchmakingService: MatchmakingService,
    private readonly settlementRouter: SettlementRouterService,
    private readonly x402PaymentStore: X402PaymentStore,
    private readonly humanMoveService: HumanMoveService,
    private readonly orchestratorService: OrchestratorService,
    private readonly matchManager: MatchManagerService,
  ) {}

  async joinQueue(userId: string, gameType?: string, stakeAmountInput?: number, token?: string) {
    const agent = await this.getOrCreateHumanAgent(userId);

    // If already queued, check if actually in the matchmaking queue
    if (agent.status === 'queued') {
      const inQueue = await this.matchmakingService.getQueueStatus(agent._id.toString());
      if (inQueue) {
        return {
          message: 'Already in the matchmaking queue',
          agentId: agent._id.toString(),
          stakeAmount: inQueue.stakeAmount,
        };
      }
      this.logger.log(`Recovering stale queued status for human agent ${agent._id}`);
      agent.status = 'idle';
      await agent.save();
    }

    if (agent.status !== 'idle') {
      throw new BadRequestException(`Your player agent is currently "${agent.status}". It must be "idle" to join the queue.`);
    }

    if (!agent.walletAddress) {
      throw new BadRequestException('Wallet not found. Please contact support.');
    }

    // Auto-calculate stake: $1 USD equivalent
    const matchToken = token || 'USDC';
    const chain = agent.chain || 'monad';
    let stakeAmount = stakeAmountInput ?? 1;
    if (matchToken === 'ALPHA') {
      const alphaPrice = await this.settlementRouter.getAlphaPriceUsd();
      if (alphaPrice && alphaPrice > 0) {
        stakeAmount = Math.ceil(1 / alphaPrice);
      }
    } else {
      stakeAmount = 1;
    }

    if (stakeAmount > 0) {
      const user = await this.userModel.findById(userId).select('+walletPrivateKey');
      if (!user) throw new BadRequestException('User not found');

      const isExternal = user.walletType === 'external' && user.externalWalletAddress;

      if (isExternal) {
        // Non-custodial: require pre-payment via x402 (user already signed client-side)
        const x402Payment = this.x402PaymentStore.getPayment(agent._id.toString());
        if (!x402Payment) {
          throw new BadRequestException(
            `External wallet matches require pre-payment. POST to /x402/stake with your signed transaction first.`,
          );
        }
        if (x402Payment.amount < stakeAmount) {
          throw new BadRequestException(
            `x402 payment insufficient: paid ${x402Payment.amount} ${matchToken} but stake requires ${stakeAmount}`,
          );
        }
        this.logger.log(`Play pre-paid (external wallet): user=${userId}, amount=${stakeAmount} ${matchToken}, tx=${x402Payment.txSignature}`);
      } else {
        // Custodial: server-side escrow transfer
        const tokenBalance = await this.settlementRouter.getAgentTokenBalance(chain, agent.walletAddress, matchToken).catch(() => '0');

        if (parseFloat(tokenBalance) < stakeAmount) {
          throw new BadRequestException(
            `Insufficient ${matchToken} balance. You have ${tokenBalance} but need ${stakeAmount}. Deposit to ${agent.walletAddress}`,
          );
        }

        if (!user.walletPrivateKey) throw new BadRequestException('Wallet not configured');
        const privKey = user.walletPrivateKey; // already decrypted by schema getter
        const decimals = this.settlementRouter.getTokenDecimals(chain, matchToken);
        const amountAtomic = BigInt(Math.round(stakeAmount * 10 ** decimals));
        const platformWallet = this.settlementRouter.getPlatformWalletAddress(chain);
        if (!platformWallet) throw new BadRequestException('Settlement not configured');

        const escrowTx = await this.settlementRouter.transferTokenFromAgent(chain, privKey, platformWallet, amountAtomic, matchToken);
        if (!escrowTx) throw new BadRequestException(`${matchToken} escrow transfer failed`);
        this.logger.log(`Play escrow: user=${userId}, amount=${stakeAmount} ${matchToken}, tx=${escrowTx}`);

        // Register payment in x402 store so matchmaking can validate it
        this.x402PaymentStore.setPayment(agent._id.toString(), {
          txSignature: escrowTx,
          amount: stakeAmount,
          token: matchToken,
          verifiedAt: new Date(),
          gameType: 'any',
        });
      }
    }

    agent.status = 'queued';
    await agent.save();

    try {
      const queueGameType = gameType || 'any';
      await this.matchmakingService.joinQueue(agent._id.toString(), userId, agent.eloRating, stakeAmount, queueGameType, 'human', token);
      return {
        message: 'Successfully joined the matchmaking queue',
        agentId: agent._id.toString(),
        stakeAmount,
      };
    } catch (err) {
      agent.status = 'idle';
      await agent.save();
      throw err;
    }
  }

  async cancelQueue(userId: string) {
    const agent = await this.agentModel.findOne({
      userId,
      type: 'human',
      status: 'queued',
    });

    if (!agent) {
      throw new BadRequestException('You are not currently in the queue.');
    }

    await this.matchmakingService.leaveQueue(agent._id.toString());
    agent.status = 'idle';
    await agent.save();

    return { message: 'Successfully left the matchmaking queue' };
  }

  async getStatus(userId: string) {
    // Check for any human agent in queue or in match
    const agents = await this.agentModel.find({
      userId,
      type: 'human',
      status: { $in: ['queued', 'in_match'] },
    });

    if (agents.length === 0) {
      return { inQueue: false, inMatch: false };
    }

    for (const agent of agents) {
      if (agent.status === 'queued') {
        const queueEntry = await this.matchmakingService.getQueueStatus(agent._id.toString());
        return {
          inQueue: true,
          inMatch: false,
          agentId: agent._id.toString(),
          gameType: queueEntry?.gameType,
          stakeAmount: queueEntry?.stakeAmount,
        };
      }

      if (agent.status === 'in_match') {
        const activeMatch = await this.matchModel.findOne({
          $or: [
            { 'agents.a.agentId': agent._id.toString() },
            { 'agents.b.agentId': agent._id.toString() },
          ],
          status: { $in: ['starting', 'active'] },
        }).select('_id gameType status').lean();

        if (activeMatch) {
          return {
            inQueue: false,
            inMatch: true,
            agentId: agent._id.toString(),
            matchId: activeMatch._id.toString(),
            gameType: activeMatch.gameType,
            matchStatus: activeMatch.status,
          };
        }
      }
    }

    return { inQueue: false, inMatch: false };
  }

  async getBalance(userId: string) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    const isExternal = user.walletType === 'external' && user.externalWalletAddress;
    const activeWallet = isExternal ? user.externalWalletAddress! : user.walletAddress;

    if (!activeWallet) {
      throw new NotFoundException('User wallet not found');
    }

    const chain = 'monad';
    const [alpha, usdc, sol] = await Promise.all([
      this.settlementRouter.getAgentTokenBalance(chain, activeWallet, 'ALPHA'),
      this.settlementRouter.getAgentTokenBalance(chain, activeWallet, 'USDC'),
      this.settlementRouter.getAgentNativeBalance(chain, activeWallet),
    ]);

    return {
      walletAddress: activeWallet,
      walletType: user.walletType ?? 'custodial',
      alpha,
      usdc,
      sol,
    };
  }

  async getWerewolfPrivateState(userId: string, matchId: string) {
    const ww = this.matchManager.getWerewolfState(matchId);
    if (!ww) throw new NotFoundException('Werewolf match not found');

    const matchState = this.orchestratorService.getActiveMatch(matchId);
    if (!matchState) throw new NotFoundException('Match not active');

    // Find the human's side
    let mySide: string | null = null;
    for (const side of Object.keys(matchState.agents)) {
      const agentInfo = matchState.agents[side];
      if (!agentInfo?.agentId) continue;
      const agent = await this.agentModel.findById(agentInfo.agentId);
      if (agent?.type === 'human' && agent.userId?.toString() === userId) {
        mySide = side;
        break;
      }
    }
    if (!mySide) throw new BadRequestException('You are not a human player in this match');

    const me = ww.players[mySide];
    if (!me) throw new NotFoundException('Player not found in state');

    // Public players view (no roles leaked except own + co-wolves)
    const publicPlayers: Record<string, unknown> = {};
    for (const [side, p] of Object.entries(ww.players)) {
      publicPlayers[side] = {
        side: p.side,
        displayName: p.displayName,
        isAlive: p.isAlive,
        deathCycle: p.deathCycle,
        deathCause: p.deathCause,
        // Reveal: own role, co-wolves to wolves, dead players' roles
        role:
          side === mySide
            ? p.role
            : !p.isAlive
            ? p.role
            : me.role === 'WEREWOLF' && p.role === 'WEREWOLF'
            ? p.role
            : undefined,
      };
    }

    const response: Record<string, unknown> = {
      mySide,
      yourRole: me.role,
      yourDisplayName: me.displayName,
      phase: ww.phase,
      cycle: ww.cycle,
      activeSide: ww.activeSide,
      players: publicPlayers,
      discussionLog: ww.discussionLog,
      deaths: ww.deaths,
      status: ww.status,
      winner: ww.winner,
    };

    if (me.role === 'WEREWOLF') {
      response.knownWerewolves = Object.values(ww.players)
        .filter((p) => p.role === 'WEREWOLF' && p.side !== mySide)
        .map((p) => p.side);
    }
    if (me.role === 'SEER') {
      response.seerMemory = ww.seerMemory;
    }
    return response;
  }

  async submitMove(userId: string, matchId: string, move: unknown) {
    // Find the user's human agent involved in this match
    const pendingAgentId = this.humanMoveService.getPendingAgentId(matchId);
    if (!pendingAgentId) {
      throw new BadRequestException('No pending move for this match.');
    }

    const agent = await this.agentModel.findById(pendingAgentId);
    if (!agent || (agent.userId && agent.userId.toString() !== userId) || agent.type !== 'human') {
      throw new BadRequestException('You are not the human player in this match.');
    }

    const submitted = this.humanMoveService.submitMove(matchId, pendingAgentId, move);
    if (!submitted) {
      throw new BadRequestException('Failed to submit move. It may no longer be your turn.');
    }

    return { success: true };
  }

  async getOrCreateHumanAgent(userId: string): Promise<Agent> {
    // Find existing human agent for this user (one per user, plays all games)
    let agent = await this.agentModel.findOne({
      userId,
      type: 'human',
      status: { $ne: 'disabled' },
    });

    if (agent) {
      // Sync wallet if user switched wallet type
      const user = await this.userModel.findById(userId);
      if (user) {
        const isExternal = user.walletType === 'external' && user.externalWalletAddress;
        const expectedWallet = isExternal ? user.externalWalletAddress! : user.walletAddress!;
        if (expectedWallet && agent.walletAddress !== expectedWallet) {
          agent.walletAddress = expectedWallet;
          if (isExternal) {
            agent.walletPrivateKey = null as unknown as string;
          } else {
            const userWithKey = await this.userModel.findById(userId).select('+walletPrivateKey');
            agent.walletPrivateKey = userWithKey?.walletPrivateKey ?? (null as unknown as string);
          }
          await agent.save();
          this.logger.log(`Synced human agent wallet for user ${userId} to ${user.walletType}`);
        }
      }
      return agent;
    }

    // Create a new human agent
    const user = await this.userModel.findById(userId).select('+walletPrivateKey');
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const isExternal = user.walletType === 'external' && user.externalWalletAddress;
    const walletAddress = isExternal ? user.externalWalletAddress : user.walletAddress;

    if (!walletAddress) {
      throw new BadRequestException('User does not have a wallet.');
    }

    agent = await this.agentModel.create({
      userId,
      name: user.username,
      type: 'human',
      gameTypes: [],
      eloRating: DEFAULT_ELO,
      status: 'idle',
      stats: { wins: 0, losses: 0, draws: 0, totalMatches: 0, winRate: 0, totalEarnings: 0 },
      walletAddress,
      walletPrivateKey: isExternal ? null : user.walletPrivateKey,
      chain: 'monad',
    });

    this.logger.log(`Created human agent "${user.username}" (${user.walletType}) for user ${userId}`);
    return agent;
  }

  private checkWithdrawCooldown(userId: string) {
    const lastWithdraw = this.withdrawCooldowns.get(userId);
    if (lastWithdraw && Date.now() - lastWithdraw < PlayService.WITHDRAW_COOLDOWN_MS) {
      const remaining = Math.ceil((PlayService.WITHDRAW_COOLDOWN_MS - (Date.now() - lastWithdraw)) / 1000);
      throw new BadRequestException(`Please wait ${remaining}s before withdrawing again.`);
    }
  }

  async withdraw(userId: string, amount: number, to: string, token: string = 'USDC') {
    this.checkWithdrawCooldown(userId);
    const user = await this.userModel.findById(userId).select('+walletPrivateKey');
    if (!user) throw new NotFoundException('User not found');

    const isExternal = user.walletType === 'external' && user.externalWalletAddress;

    if (isExternal) {
      // Non-custodial: can still withdraw from custodial wallet if it has balance
      if (!user.walletAddress || !user.walletPrivateKey) {
        throw new BadRequestException(
          'Your active wallet is an external wallet. Manage funds directly from your wallet app, or switch to custodial wallet to withdraw from your custodial balance.',
        );
      }
      // Fall through to withdraw from custodial wallet
    }

    if (!user.walletAddress || !user.walletPrivateKey) {
      throw new BadRequestException('User does not have a custodial wallet');
    }

    if (token === 'SOL') {
      throw new BadRequestException('SOL withdrawals coming soon. Use ALPHA or USDC.');
    }

    if (token === 'USDC' && amount < 10) {
      throw new BadRequestException('Minimum USDC withdrawal is 10 USDC.');
    }

    const chain = 'monad';
    const balanceStr = await this.settlementRouter.getAgentTokenBalance(chain, user.walletAddress, token);
    const balance = parseFloat(balanceStr);
    if (balance < amount) {
      throw new BadRequestException(`Insufficient balance: you have ${balance.toFixed(2)} ${token} but tried to withdraw ${amount}`);
    }

    const decimals = this.settlementRouter.getTokenDecimals(chain, token);
    const amountWei = BigInt(Math.round(amount * 10 ** decimals));
    const privKey = user.walletPrivateKey; // already decrypted by schema getter
    const txHash = await this.settlementRouter.transferTokenFromAgent(chain, privKey, to, amountWei, token);

    this.withdrawCooldowns.set(userId, Date.now());
    this.logger.log(`Withdraw: user=${userId}, amount=${amount} ${token}, to=${to}, txHash=${txHash}`);
    return { txHash, amount, to, token, chain };
  }

  /**
   * Build a partially-signed withdraw transaction for external wallet users.
   * Platform signs as fee payer, user signs with their wallet on the frontend.
   */
  async buildWithdraw(userId: string, amount: number, to: string, token: string = 'USDC') {
    this.checkWithdrawCooldown(userId);
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    if (user.walletType !== 'external' || !user.externalWalletAddress) {
      throw new BadRequestException('This endpoint is for external wallet users only. Use POST /play/withdraw instead.');
    }

    if (token === 'SOL') {
      throw new BadRequestException('SOL withdrawals coming soon. Use ALPHA or USDC.');
    }

    const chain = 'monad';
    const balanceStr = await this.settlementRouter.getAgentTokenBalance(chain, user.externalWalletAddress, token);
    const balance = parseFloat(balanceStr);
    if (balance < amount) {
      throw new BadRequestException(`Insufficient balance: you have ${balance.toFixed(2)} ${token} but tried to withdraw ${amount}`);
    }

    const decimals = this.settlementRouter.getTokenDecimals(chain, token);
    const amountAtomic = BigInt(Math.round(amount * 10 ** decimals));

    const result = await this.settlementRouter.buildPartiallySignedTransfer(
      chain, user.externalWalletAddress, to, amountAtomic, token,
    );

    if (!result) {
      throw new BadRequestException('Failed to build transaction. Settlement service may not be configured.');
    }

    this.withdrawCooldowns.set(userId, Date.now());
    this.logger.log(`Built withdraw tx: user=${userId}, amount=${amount} ${token}, to=${to}`);
    return { transaction: result.transaction, blockhash: result.blockhash, amount, to, token, chain };
  }

  /**
   * Create a free test match against a simple random-move bot.
   * No stake required — for testing purposes.
   */
  async createTestMatch(userId: string, gameType: string): Promise<{ matchId: string }> {
    if (DISABLED_GAME_TYPES.includes(gameType)) {
      throw new BadRequestException(`${gameType} is temporarily paused.`);
    }
    const agent = await this.getOrCreateHumanAgent(userId);

    if (agent.status === 'in_match') {
      throw new BadRequestException('Your agent is already in a match.');
    }

    const humanAgent = {
      agentId: agent._id.toString(),
      userId: agent.userId?.toString() || userId,
      name: agent.name,
      endpointUrl: agent.endpointUrl || '',
      eloRating: agent.eloRating || DEFAULT_ELO,
      type: 'human',
      chain: 'monad',
      token: 'USDC',
    };

    // Werewolf: 1 human + 6 internal bots
    if (gameType === 'werewolf') {
      const bots = await this.ensureBotAgents(agent.userId?.toString() || userId, 6);
      const botAgents = bots.map((b, i) => ({
        agentId: b._id.toString(),
        userId: b.userId?.toString() || userId,
        name: `${b.name} ${i + 1}`,
        endpointUrl: b.endpointUrl || 'internal://random-bot',
        eloRating: b.eloRating || DEFAULT_ELO,
        type: 'http',
        chain: 'monad',
        token: 'USDC',
      }));
      const matchId = await this.orchestratorService.startMatchMulti(
        [humanAgent, ...botAgents],
        0,
        'werewolf',
      );
      this.logger.log(`Werewolf test match created: ${matchId}, user=${userId}`);
      return { matchId };
    }

    // Default: 1 human + 1 bot
    const botAgent = await this.getOrCreateSharedBot();
    const agentB = {
      agentId: botAgent._id.toString(),
      userId: botAgent.userId?.toString() || userId,
      name: botAgent.name,
      endpointUrl: botAgent.endpointUrl || 'internal://random-bot',
      eloRating: botAgent.eloRating || DEFAULT_ELO,
      type: 'http',
      chain: 'monad',
      token: 'USDC',
    };

    const matchId = await this.orchestratorService.startMatch(humanAgent, agentB, 0, gameType);
    this.logger.log(`Test match created: ${matchId}, gameType=${gameType}, user=${userId}`);
    return { matchId };
  }

  /**
   * Exhibition match for a user's MANAGED agent (Pod-powered brain) vs the
   * internal bot, stake 0. Unlike createTestMatch (which uses the human agent
   * that the user drives manually), this routes moves to the managed agent's
   * endpointUrl → the in-process brain → Claude via Pod. Lets us watch the
   * managed agent play a full game without any staking / x402 friction.
   */
  async createManagedExhibitionMatch(
    userId: string,
    gameType: string,
    opponentAgentId?: string,
    agentId?: string,
  ): Promise<{ matchId: string }> {
    if (DISABLED_GAME_TYPES.includes(gameType)) {
      throw new BadRequestException(`${gameType} is temporarily paused.`);
    }
    const agent = await this.resolveMyManagedAgent(userId, agentId);
    if (agent.status === 'in_match') throw new BadRequestException('Your managed agent is already in a match.');

    // Self-heal the brain endpoint: the in-process brain always lives on our own
    // host. An old env once baked an unreachable host here, forfeiting matches.
    const expectedBrainUrl = `http://localhost:${process.env.PORT || 3001}/internal/managed-agent/${agent._id}`;
    if (agent.endpointUrl !== expectedBrainUrl) {
      await this.agentModel.updateOne({ _id: agent._id }, { $set: { endpointUrl: expectedBrainUrl } });
      agent.endpointUrl = expectedBrainUrl;
      this.logger.log(`Repaired managed agent endpointUrl → ${expectedBrainUrl}`);
    }

    const managed = {
      agentId: agent._id.toString(),
      userId,
      name: agent.persona?.name || agent.name,
      endpointUrl: agent.endpointUrl, // → /internal/managed-agent/:id → Claude via Pod
      eloRating: agent.eloRating || DEFAULT_ELO,
      type: 'http',
      chain: 'monad',
      token: 'USDC',
    };

    // Opponent: another managed agent (Claude vs Claude) if given, else the internal bot.
    let opponent: any;
    if (opponentAgentId) {
      const opp = await this.agentModel.findById(opponentAgentId);
      if (!opp || !opp.managed) throw new BadRequestException('Opponent is not a managed agent.');
      if (opp._id.toString() === agent._id.toString()) throw new BadRequestException('An agent cannot play itself.');
      const oppBrainUrl = `http://localhost:${process.env.PORT || 3001}/internal/managed-agent/${opp._id}`;
      if (opp.endpointUrl !== oppBrainUrl) {
        await this.agentModel.updateOne({ _id: opp._id }, { $set: { endpointUrl: oppBrainUrl } });
      }
      opponent = {
        agentId: opp._id.toString(),
        userId: opp.userId?.toString() || userId,
        name: opp.persona?.name || opp.name,
        endpointUrl: oppBrainUrl,
        eloRating: opp.eloRating || DEFAULT_ELO,
        type: 'http',
        chain: 'monad',
        token: 'USDC',
      };
    } else {
      const botAgent = await this.getOrCreateSharedBot();
      opponent = {
        agentId: botAgent._id.toString(),
        userId: botAgent.userId?.toString() || userId,
        name: botAgent.name,
        endpointUrl: botAgent.endpointUrl || 'internal://random-bot',
        eloRating: botAgent.eloRating || DEFAULT_ELO,
        type: 'http',
        chain: 'monad',
        token: 'USDC',
      };
    }

    const matchId = await this.orchestratorService.startMatch(managed, opponent, 0, gameType);
    this.logger.log(`Managed exhibition match created: ${matchId}, gameType=${gameType}, ${managed.agentId} vs ${opponent.agentId}`);
    return { matchId };
  }

  /**
   * Join a REAL staked match with the user's managed agent (1-click). The agent is
   * custodial (we hold its key), so we do the whole x402 flow server-side: move the
   * 1 USDC stake from the agent's wallet into the platform escrow, record the verified
   * payment, then enqueue. No external signing / no Pod dashboard needed.
   */
  async managedJoinQueue(
    userId: string,
    gameType: string,
    agentId?: string,
  ): Promise<{ queued: true; txSignature: string; stakeAmount: number; gameType: string }> {
    const agent = await this.resolveMyManagedAgent(userId, agentId, true);
    if (agent.status === 'queued') throw new BadRequestException('Your agent is already in the queue.');
    if (agent.status === 'in_match') throw new BadRequestException('Your agent is already in a match.');

    const res = await this.escrowAndEnqueue(agent, gameType, 1);
    return { queued: true, ...res };
  }

  /**
   * Resolve a managed agent the user owns. With agentId → that specific agent (ownership
   * checked); without → the user's first managed agent (back-compat for single-agent UI).
   * withKey loads the encrypted wallet key (needed for staking).
   */
  private async resolveMyManagedAgent(userId: string, agentId: string | undefined, withKey = false): Promise<Agent> {
    const q = agentId
      ? this.agentModel.findOne({ _id: agentId, userId, managed: true, status: { $ne: 'disabled' } })
      : this.agentModel.findOne({ userId, managed: true, status: { $ne: 'disabled' } });
    const agent = await (withKey ? q.select('+walletPrivateKey') : q);
    if (!agent) throw new NotFoundException('Managed agent not found for this user.');
    return agent;
  }

  /**
   * Core staked-join used by both the manual Play button and the autoplay loop:
   * escrow the stake from the agent's wallet → record the x402 payment → enqueue.
   * Operates on an Agent doc loaded WITH +walletPrivateKey.
   */
  private async escrowAndEnqueue(
    agent: Agent,
    gameType: string,
    stakeAmount: number,
  ): Promise<{ txSignature: string; stakeAmount: number; gameType: string }> {
    if (!agent.walletPrivateKey) throw new BadRequestException('Agent wallet key unavailable.');

    const chain = agent.chain || 'monad';
    const token = 'USDC';

    if (!agent.podActivated || (agent.podBalanceUsdc ?? 0) <= 0) {
      throw new BadRequestException("Agent's brain (Pod) has no balance. Fund the brain first.");
    }

    const balStr = await this.settlementRouter.getAgentTokenBalance(chain, agent.walletAddress, token);
    if (parseFloat(balStr) < stakeAmount) {
      throw new BadRequestException(
        `Insufficient ${token}: agent has ${balStr}, needs ${stakeAmount}. Fund ${agent.walletAddress}.`,
      );
    }

    const platformWallet = this.settlementRouter.getPlatformWalletAddress(chain);
    if (!platformWallet) throw new BadRequestException('Platform wallet not configured.');

    const decimals = this.settlementRouter.getTokenDecimals(chain, token);
    const amountAtomic = BigInt(Math.round(stakeAmount * 10 ** decimals));
    const txSignature = await this.settlementRouter.transferTokenFromAgent(
      chain,
      agent.walletPrivateKey,
      platformWallet,
      amountAtomic,
      token,
    );
    if (!txSignature) throw new BadRequestException('Stake transfer failed.');
    this.logger.log(`Managed stake escrowed: ${stakeAmount} ${token} from ${agent._id} (tx: ${txSignature})`);

    this.x402PaymentStore.markTxUsed(txSignature);
    this.x402PaymentStore.setPayment(agent._id.toString(), {
      txSignature,
      amount: stakeAmount,
      token,
      verifiedAt: new Date(),
      gameType: 'any',
    });

    try {
      await this.matchmakingService.joinQueue(
        agent._id.toString(),
        agent.userId?.toString() || '',
        agent.eloRating,
        stakeAmount,
        gameType || 'any',
        agent.type,
        token,
      );
      agent.status = 'queued';
      await agent.save();
    } catch (err) {
      this.logger.error(`Managed join failed after escrow for ${agent._id}: ${(err as Error).message}`);
      throw err;
    }

    return { txSignature, stakeAmount, gameType: gameType || 'any' };
  }

  private async getOrCreateSharedBot() {
    let bot = await this.agentModel.findOne({ name: 'AlphArena Bot', type: 'http' });
    if (!bot) {
      bot = await this.agentModel.create({
        name: 'AlphArena Bot',
        type: 'http',
        endpointUrl: 'internal://random-bot',
        gameTypes: ['chess', 'poker', 'rps', 'uno'],
        userId: null,
        eloRating: DEFAULT_ELO,
        elo: DEFAULT_ELO,
        status: 'idle',
        chain: 'monad',
        walletAddress: '',
      });
    }
    if (bot.status !== 'idle') {
      bot.status = 'idle';
      await bot.save();
    }
    return bot;
  }

  private async ensureBotAgents(fallbackUserId: string, count: number): Promise<Agent[]> {
    const bots: Agent[] = [];
    for (let i = 1; i <= count; i++) {
      const name = `AlphArena Bot ${i}`;
      let bot = await this.agentModel.findOne({ name, type: 'http' });
      if (!bot) {
        bot = await this.agentModel.create({
          name,
          type: 'http',
          endpointUrl: 'internal://random-bot',
          gameTypes: ['werewolf', 'chess', 'poker', 'rps', 'uno'],
          userId: fallbackUserId,
          eloRating: DEFAULT_ELO,
          elo: DEFAULT_ELO,
          status: 'idle',
          chain: 'monad',
          walletAddress: '',
        });
      }
      if (bot.status !== 'idle') {
        bot.status = 'idle';
        await bot.save();
      }
      bots.push(bot);
    }
    return bots;
  }
}
