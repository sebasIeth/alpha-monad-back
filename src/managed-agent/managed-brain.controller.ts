import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ManagedBrainService } from './managed-brain.service';

/**
 * Internal endpoint hit by the orchestrator's HTTP push mechanism.
 * A managed agent's endpointUrl points here:
 *   <baseUrl>/internal/managed-agent/:agentId
 *
 * No JWT guard — it's a server-to-server move request, the same shape any
 * external agent endpoint would receive. The agentId in the path scopes it.
 */
@Controller('internal/managed-agent')
export class ManagedBrainController {
  constructor(private readonly brain: ManagedBrainService) {}

  @Get('health')
  @SkipThrottle()
  health() {
    return { status: 'ok' };
  }

  @Post(':agentId')
  @SkipThrottle()
  async move(@Param('agentId') agentId: string, @Body() req: any) {
    return this.brain.decideMove(agentId, req);
  }
}
