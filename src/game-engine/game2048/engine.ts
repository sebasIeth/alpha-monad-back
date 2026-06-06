import { Board2048, Game2048State, Move2048 } from '../../common/types/game2048.types';

/**
 * 2048 Duel engine. Pure functions, no I/O.
 *
 * Fairness: both sides start from an identical board and share the same RNG
 * seed, so the tile-spawn luck stream is equal — outcomes diverge only through
 * the moves each agent chooses.
 */

const SIZE = 4;
export const MOVES_2048: Move2048[] = ['up', 'down', 'left', 'right'];

/** mulberry32 — tiny deterministic PRNG; state is a 32-bit int we persist. */
function nextRandom(state: number): { value: number; state: number } {
  let s = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: s };
}

function emptyCells(grid: number[][]): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (grid[r][c] === 0) cells.push([r, c]);
  return cells;
}

/** Spawn a tile (90% a 2, 10% a 4) in a random empty cell, advancing the RNG. */
function spawnTile(board: Board2048): void {
  const cells = emptyCells(board.grid);
  if (cells.length === 0) return;
  let rnd = nextRandom(board.rngState);
  const cell = cells[Math.floor(rnd.value * cells.length)];
  let rnd2 = nextRandom(rnd.state);
  board.grid[cell[0]][cell[1]] = rnd2.value < 0.9 ? 2 : 4;
  board.rngState = rnd2.state;
}

/** Slide+merge one row to the LEFT. Returns the new row and score gained. */
function slideRowLeft(row: number[]): { row: number[]; gained: number } {
  const tiles = row.filter((v) => v !== 0);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      const merged = tiles[i] * 2;
      out.push(merged);
      gained += merged;
      i++; // consume the pair
    } else {
      out.push(tiles[i]);
    }
  }
  while (out.length < SIZE) out.push(0);
  return { row: out, gained };
}

/** Apply a move to a grid. Returns null when the move doesn't change anything. */
export function applyMoveToGrid(grid: number[][], move: Move2048): { grid: number[][]; gained: number } | null {
  // Normalize every direction to "slide left" via transpose/reverse.
  const transpose = (g: number[][]) => g[0].map((_, c) => g.map((row) => row[c]));
  const reverseRows = (g: number[][]) => g.map((row) => [...row].reverse());

  let work = grid.map((r) => [...r]);
  if (move === 'up') work = transpose(work);
  else if (move === 'down') work = reverseRows(transpose(work));
  else if (move === 'right') work = reverseRows(work);

  let gained = 0;
  work = work.map((row) => {
    const res = slideRowLeft(row);
    gained += res.gained;
    return res.row;
  });

  if (move === 'up') work = transpose(work);
  else if (move === 'down') work = transpose(reverseRows(work));
  else if (move === 'right') work = reverseRows(work);

  const changed = work.some((row, r) => row.some((v, c) => v !== grid[r][c]));
  return changed ? { grid: work, gained } : null;
}

export function getLegalMoves(board: Board2048): Move2048[] {
  return MOVES_2048.filter((m) => applyMoveToGrid(board.grid, m) !== null);
}

function bestTileOf(grid: number[][]): number {
  return Math.max(...grid.flat());
}

function freshBoard(seed: number): Board2048 {
  const board: Board2048 = {
    grid: Array.from({ length: SIZE }, () => Array(SIZE).fill(0)),
    score: 0,
    moves: 0,
    stuck: false,
    rngState: seed | 0,
    bestTile: 0,
  };
  spawnTile(board);
  spawnTile(board);
  board.bestTile = bestTileOf(board.grid);
  return board;
}

export function createInitialState(maxMovesPerSide: number, seed: number = 0x2048): Game2048State {
  // Both sides get byte-identical boards and RNG state → equal luck.
  return {
    players: { a: freshBoard(seed), b: freshBoard(seed) },
    currentTurn: 'a',
    status: 'playing',
    winner: null,
    winReason: null,
    moveCount: 0,
    maxMovesPerSide,
  };
}

/** Apply one move for `side`. Mutates state; resolves turn passing + endings. */
export function applyMove(state: Game2048State, side: string, move: Move2048): { ok: boolean } {
  const board = state.players[side];
  if (!board || state.status !== 'playing') return { ok: false };

  const res = applyMoveToGrid(board.grid, move);
  if (!res) return { ok: false };

  board.grid = res.grid;
  board.score += res.gained;
  board.moves += 1;
  state.moveCount += 1;
  spawnTile(board);
  board.bestTile = bestTileOf(board.grid);
  board.stuck = getLegalMoves(board).length === 0;

  // Instant win: first to forge a 2048 tile.
  if (board.bestTile >= 2048) {
    state.status = 'finished';
    state.winner = side;
    state.winReason = '2048_tile';
    return { ok: true };
  }

  resolveTurnOrEnd(state, side);
  return { ok: true };
}

/** Skip a side that's done (stuck or out of moves); end when both are. */
export function resolveTurnOrEnd(state: Game2048State, justMoved: string): void {
  const done = (s: string) =>
    state.players[s].stuck || state.players[s].moves >= state.maxMovesPerSide;

  const other = justMoved === 'a' ? 'b' : 'a';
  if (!done(other)) {
    state.currentTurn = other;
    return;
  }
  if (!done(justMoved)) {
    state.currentTurn = justMoved;
    return;
  }

  // Both finished → higher score wins, equal scores draw.
  state.status = 'finished';
  const a = state.players.a.score;
  const b = state.players.b.score;
  state.winner = a > b ? 'a' : b > a ? 'b' : null;
  state.winReason = state.winner ? 'score' : 'draw';
}

export function toSpectatorView(state: Game2048State): Record<string, unknown> {
  return {
    g2048Boards: {
      a: { grid: state.players.a.grid, score: state.players.a.score, bestTile: state.players.a.bestTile, moves: state.players.a.moves, stuck: state.players.a.stuck },
      b: { grid: state.players.b.grid, score: state.players.b.score, bestTile: state.players.b.bestTile, moves: state.players.b.moves, stuck: state.players.b.stuck },
    },
    g2048Turn: state.currentTurn,
    g2048Status: state.status,
    g2048Winner: state.winner,
    g2048MaxMoves: state.maxMovesPerSide,
  };
}
