import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { MoveDoc, Match, Agent } from '../database/schemas';
import { Game2048State, Move2048 } from '../common/types/game2048.types';
import { getLegalMoves, applyMove, toSpectatorView, MOVES_2048 } from '../game-engine/game2048';
import { ActiveMatchesService, ActiveMatchState } from './active-matches.service';
import { AgentClientService } from './agent-client.service';
import { EventBusService } from './event-bus.service';
import { HumanMoveService } from './human-move.service';
import { ChessMoveRequest } from '../common/types/chess.types';

const TURN_TIMEOUT = 70_000;

@Injectable()
export class Game2048TurnControllerService {
  private readonly logger = new Logger(Game2048TurnControllerService.name);

  constructor(
    @InjectModel(MoveDoc.name) private readonly moveModel: Model<MoveDoc>,
    @InjectModel(Match.name) private readonly matchModel: Model<Match>,
    private readonly activeMatches: ActiveMatchesService,
    private readonly agentClient: AgentClientService,
    private readonly eventBus: EventBusService,
    private readonly humanMoveService: HumanMoveService,
  ) {}

  /** One 2048 turn: ask the current side for a direction, apply it to ITS board. */
  async executeTurn(
    matchState: ActiveMatchState,
    state: Game2048State,
  ): Promise<{ state: Game2048State; matchOver: boolean; winner: string | null }> {
    const { matchId } = matchState;
    const side = state.currentTurn;
    const board = state.players[side];

    const legalMoves = getLegalMoves(board);
    this.logger.log(`2048 turn ${state.moveCount + 1}: match=${matchId}, side=${side}, legal=[${legalMoves.join(',')}]`);

    this.eventBus.emit('match:move', { matchId, ...toSpectatorView(state) });

    const move = await this.requestMove(matchState, state, side, legalMoves);
    applyMove(state, side, move);

    this.eventBus.emit('match:move', {
      matchId,
      side,
      g2048Move: move,
      ...toSpectatorView(state),
    });

    await this.saveMove(matchId, matchState.agents[side].agentId, side, state, move);
    await this.persistState(matchId, state);

    const matchOver = state.status === 'finished';
    return { state, matchOver, winner: state.winner };
  }

  private async requestMove(
    matchState: ActiveMatchState,
    state: Game2048State,
    side: string,
    legalMoves: Move2048[],
  ): Promise<Move2048> {
    const { matchId } = matchState;
    const agent = matchState.agents[side];
    const board = state.players[side];
    const other = side === 'a' ? 'b' : 'a';

    const moveRequest = {
      matchId,
      gameType: '2048',
      yourSide: side,
      grid: board.grid,
      score: board.score,
      opponentScore: state.players[other].score,
      opponentBestTile: state.players[other].bestTile,
      movesLeft: state.maxMovesPerSide - board.moves,
      legalMoves,
      moveNumber: board.moves + 1,
      timeRemainingMs: TURN_TIMEOUT,
    };

    try {
      let response: unknown;

      if (agent.type === 'human' || agent.type === 'pull') {
        this.eventBus.emit('match:your_turn', {
          matchId,
          side,
          gameType: '2048',
          ...toSpectatorView(state),
          legalMoves,
          turnTimeoutMs: TURN_TIMEOUT,
        });
        response = await this.humanMoveService.waitForMove(matchId + ':' + side, side, agent.agentId, TURN_TIMEOUT);
      } else if (agent.type === 'openclaw') {
        response = await this.agentClient.requestChessMoveFromOpenClaw(agent as unknown as Agent, moveRequest as unknown as ChessMoveRequest, { side, agentId: agent.agentId });
      } else {
        response = await this.agentClient.requestMove(agent.endpointUrl, moveRequest as unknown as Record<string, unknown>);
      }

      const move = this.parseMove(response, legalMoves);
      if (move) return move;

      this.logger.warn(`Invalid 2048 move from ${side} in match ${matchId}: ${JSON.stringify(response).slice(0, 120)}`);
      return legalMoves[0];
    } catch {
      this.logger.warn(`2048 move timeout for side ${side} in match ${matchId}`);
      const newTimeouts = { ...matchState.timeouts };
      newTimeouts[side] = (newTimeouts[side] || 0) + 1;
      this.activeMatches.updateMatch(matchId, { timeouts: newTimeouts });
      this.matchModel.updateOne({ _id: matchId }, { [`timeouts.${side}`]: newTimeouts[side] }).catch(() => {});
      this.eventBus.emit('match:timeout', { matchId, side, timeoutCount: newTimeouts[side] });
      return legalMoves[0];
    }
  }

  private parseMove(response: unknown, legalMoves: Move2048[]): Move2048 | null {
    let value: unknown = response;
    if (typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;
      value = obj.move ?? obj.direction ?? obj.g2048Move;
    }
    if (typeof value === 'string') {
      const move = value.toLowerCase().trim() as Move2048;
      if (MOVES_2048.includes(move) && legalMoves.includes(move)) return move;
    }
    return null;
  }

  private async persistState(matchId: string, state: Game2048State): Promise<void> {
    try {
      await this.matchModel.updateOne(
        { _id: matchId },
        {
          g2048State: state,
          scores: { a: state.players.a.score, b: state.players.b.score },
          moveCount: state.moveCount,
        },
      );
    } catch (err: unknown) {
      this.logger.error(`Failed to persist 2048 state for match ${matchId}: ${(err as Error).message}`);
    }
  }

  private async saveMove(
    matchId: string,
    agentId: string,
    side: string,
    state: Game2048State,
    move: Move2048,
  ): Promise<void> {
    try {
      await this.moveModel.collection.insertOne({
        matchId: new Types.ObjectId(matchId),
        agentId: new Types.ObjectId(agentId),
        side,
        moveNumber: state.players[side].moves,
        moveData: { g2048Move: move, ...toSpectatorView(state) },
        boardStateAfter: state.players[side].grid,
        scoreAfter: { a: state.players.a.score, b: state.players.b.score },
        thinkingTimeMs: 0,
        timestamp: new Date(),
      });
    } catch (err: unknown) {
      this.logger.error(`Failed to save 2048 move for match ${matchId}: ${(err as Error).message}`);
    }
  }
}
