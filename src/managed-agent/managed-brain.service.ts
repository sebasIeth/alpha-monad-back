import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import Anthropic from '@anthropic-ai/sdk';
import { Agent } from '../database/schemas';
import { ConfigService } from '../common/config/config.service';
import { buildPrompt, parseReply, fallbackMove } from './game-prompts';

const POD_BASE_URL = process.env.POD_BASE_URL || 'https://api.usepod.ai';
const POD_MODEL = process.env.POD_MODEL || 'claude-haiku-4-5';

/**
 * The "brain" for managed agents. Given a move request from the orchestrator,
 * loads the agent's Pod token, prompts the LLM through Pod's proxy (billed to
 * the agent's own balance), and returns the move in the turn-controller's
 * expected shape. Always returns a legal fallback on failure.
 */
@Injectable()
export class ManagedBrainService {
  private readonly logger = new Logger(ManagedBrainService.name);

  constructor(
    @InjectModel(Agent.name) private readonly agentModel: Model<Agent>,
    private readonly configService: ConfigService,
  ) {}

  async decideMove(agentId: string, req: any): Promise<any> {
    try {
      const agent = await this.agentModel.findById(agentId).select('+podToken');
      if (!agent) throw new Error('agent not found');
      if (!agent.managed) throw new Error('not a managed agent');
      if (!agent.podToken) throw new Error('no pod token');

      const podToken = agent.podToken; // getter decrypts
      const persona = agent.persona || { name: agent.name, vibe: 'balanced' };

      const client = new Anthropic({
        baseURL: `${POD_BASE_URL}/proxy/${podToken}`,
        apiKey: 'pod', // ignored — token is in the path
      });

      const prompt = buildPrompt(persona as any, req);
      const response = await client.messages.create({
        model: (agent as any).llmModel || POD_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = (response?.content?.[0] as any)?.text || '';
      const parsed = parseReply(text, req);
      if (!parsed) {
        this.logger.warn(`Parse failed for ${req.gameType} (agent ${agentId}); raw="${text.slice(0, 200)}"; using fallback`);
        return fallbackMove(req);
      }
      return parsed;
    } catch (e) {
      const fb = fallbackMove(req);
      this.logger.warn(`Brain failed for agent ${agentId} (${req?.gameType}): ${(e as Error).message} → fallback ${JSON.stringify(fb)}`);
      return fb;
    }
  }
}
