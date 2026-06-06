// ── 2048 Duel Types ───────────────────────────────────────────────────────────
// Competitive 2048: each side plays its OWN 4x4 board with an identical RNG
// seed (equal luck), alternating turns. First to build a 2048 tile wins
// instantly; otherwise the higher score wins once both boards are stuck or the
// per-side move cap is reached.

export type Move2048 = 'up' | 'down' | 'left' | 'right';

export interface Board2048 {
  /** 4x4 grid; 0 = empty, otherwise the tile value (2, 4, 8, …). */
  grid: number[][];
  /** Sum of all merge values (standard 2048 scoring). */
  score: number;
  /** Moves this side has played. */
  moves: number;
  /** No legal move changes the board → this side is done. */
  stuck: boolean;
  /** Deterministic RNG state for tile spawns (same seed both sides). */
  rngState: number;
  /** Highest tile on the board. */
  bestTile: number;
}

export interface Game2048State {
  players: Record<string, Board2048>; // keyed by side: 'a', 'b'
  currentTurn: string; // side to move next
  status: 'playing' | 'finished';
  winner: string | null; // side letter, or null for draw while finished
  winReason: '2048_tile' | 'score' | 'draw' | null;
  moveCount: number; // total moves across both sides
  maxMovesPerSide: number;
}

export interface Move2048Request {
  matchId: string;
  gameType: '2048';
  yourSide: string;
  grid: number[][];
  score: number;
  opponentScore: number;
  opponentBestTile: number;
  movesLeft: number;
  legalMoves: Move2048[];
  moveNumber: number;
  timeRemainingMs: number;
}
