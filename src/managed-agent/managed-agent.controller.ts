import { Controller, Get, Post, Delete, Body, Param, UseGuards, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthPayload } from '../common/types';
import { ManagedAgentService } from './managed-agent.service';
import { SaidService } from '../said/said.service';
import { CreateManagedAgentDto } from './dto/create-managed-agent.dto';
import { Agent } from '../database/schemas';

/** Shape returned to the front. Hides sensitive fields (podToken, walletPrivateKey). */
function presentAgent(
  a: Agent,
  opts: { stakeUsdc?: number; brainActive?: boolean; podUsdc?: number; currentMatchId?: string | null; said?: any } = {},
): any {
  const brainActive = opts.brainActive ?? a.podActivated ?? false;
  const stakeBalanceUsdc = opts.stakeUsdc ?? 0;
  const podBalanceUsdc = opts.podUsdc ?? a.podBalanceUsdc ?? 0;
  return {
    agentId: a._id.toString(),
    persona: a.persona || { name: a.name, avatar: '🤖', vibe: 'balanced' },
    stakeWalletAddress: a.walletAddress,
    podDepositAddress: a.podDepositAddress,
    podDepositCode: a.podDepositCode,
    // Pod's dashboard needs the api_token (UUID), NOT the deposit_code (hex).
    // Prefer the stored dashboard URL; else rebuild it from the token.
    podDashboardUrl: (a as any).podDashboardUrl
      || ((a as any).podToken ? `https://usepod.ai/dashboard?token=${(a as any).podToken}` : ''),
    // 'queued' shows the same waiting state as 'in_match' so the card doesn't offer
    // a second Play button while the agent is already in the queue.
    model: (a as any).llmModel || 'claude-haiku-4-5',
    status:
      a.status === 'in_match' ? 'in_match'
      : a.status === 'queued' ? 'queued'
      : (brainActive ? 'funded' : 'draft'),
    stakeBalanceUsdc,
    brainActive,
    // Live Pod balance (USDC) read from GET /proxy/<token>/balance.
    podBalanceUsdc,
    autoPlay: !!a.autoPlay,
    elo: a.eloRating,
    // Live match the agent is seated in (only set while in_match) — lets the
    // dashboard card deep-link straight to the spectator view.
    currentMatchId: opts.currentMatchId || null,
    // SAID Protocol identity (saidprotocol.com): null = unknown (SAID unreachable)
    said: opts.said ?? null,
    createdAt: (a as any).createdAt?.toISOString?.() || new Date().toISOString(),
  };
}

@Controller('agents/managed')
export class ManagedAgentController {
  constructor(
    private readonly service: ManagedAgentService,
    private readonly saidService: SaidService,
  ) {}

  /** Current USDC price of a SAID verification (dynamic — follows SOL price). */
  @Get('said/fee')
  async saidFee() {
    return { feeUsdc: await this.saidService.getVerificationFeeUsdc() };
  }

  /** Returns avatars already used by the current user's agents. */
  @UseGuards(JwtAuthGuard)
  @Get('taken-avatars')
  async takenAvatars(@CurrentUser() user: AuthPayload) {
    return { avatars: await this.service.getTakenAvatars(user.userId) };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@CurrentUser() user: AuthPayload) {
    const enriched = await this.service.getMineEnriched(user.userId);
    if (!enriched) throw new NotFoundException('No managed agent for this user');
    return presentAgent(enriched.agent, {
      stakeUsdc: enriched.stakeUsdc,
      brainActive: enriched.brainActive,
      podUsdc: enriched.podUsdc,
      currentMatchId: enriched.currentMatchId,
    });
  }

  /** All managed agents owned by the user (users can own several). */
  @UseGuards(JwtAuthGuard)
  @Get('mine')
  async mine(@CurrentUser() user: AuthPayload) {
    const list = await this.service.getAllMineEnriched(user.userId);
    return list.map((e) =>
      presentAgent(e.agent, {
        stakeUsdc: e.stakeUsdc,
        brainActive: e.brainActive,
        podUsdc: e.podUsdc,
        currentMatchId: e.currentMatchId,
        said: (e as any).said,
      }),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('create')
  async create(@CurrentUser() user: AuthPayload, @Body() dto: CreateManagedAgentDto) {
    const agent = await this.service.create(user.userId, dto);
    return presentAgent(agent);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/balances')
  async balances(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.service.getBalances(user.userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/pod/refresh')
  async refresh(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.service.refreshPodBalance(user.userId, id);
  }

  /** Auto-fund the Pod brain from the agent's stake wallet (on-chain deposit_usdc). */
  @UseGuards(JwtAuthGuard)
  @Post(':id/pod/deposit')
  async deposit(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: { amount?: number },
  ) {
    return this.service.depositStakeToPod(user.userId, id, Number(body?.amount));
  }

  /** Change the LLM the agent's brain uses. */
  @UseGuards(JwtAuthGuard)
  @Post(':id/model')
  async setModel(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() body: { model: string },
  ) {
    return this.service.setModel(user.userId, id, body?.model);
  }

  /** Public AgentCard JSON — SAID stores this URL on-chain as metadata URI. */
  @Get(':id/card.json')
  async agentCard(@Param('id') id: string) {
    return this.service.getAgentCard(id);
  }

  /** Register the agent's identity on-chain with SAID (user-triggered, self-service). */
  @UseGuards(JwtAuthGuard)
  @Post(':id/said/register')
  async saidRegister(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.service.registerWithSaid(user.userId, id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async remove(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.service.deleteMine(user.userId, id);
  }
}
