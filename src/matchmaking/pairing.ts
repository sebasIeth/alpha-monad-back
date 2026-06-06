import { ELO_MATCH_RANGE, GAME_TYPES, DISABLED_GAME_TYPES } from '../common/constants/game.constants';
import { QueueEntryData } from './matchmaking.queue';

const STAKE_TOLERANCE = 0.2;
const POKER_MAX_PLAYERS = 9;
const POKER_MIN_PLAYERS = 2;

/**
 * Game types the random picker can hand to a 2-agent pair (excludes only disabled games).
 * Poker is included: createMatchMulti accepts 2 agents and builds a heads-up table, so a
 * random pair can play poker too — the findPokerGroup path (3+ with countdown) still handles
 * larger tables separately.
 */
const TWO_PLAYER_GAMES = GAME_TYPES.filter(g => !DISABLED_GAME_TYPES.includes(g));

function stakesCompatible(stakeA: number, stakeB: number): boolean {
  const larger = Math.max(stakeA, stakeB);
  const smaller = Math.min(stakeA, stakeB);
  if (larger === 0) return smaller === 0;
  return smaller >= larger * (1 - STAKE_TOLERANCE);
}

// Anti-repeat game picker: avoids handing out the same game over and over (pure
// random could legitimately give UNO 5+ times in a row). Tracks the recently chosen
// games and prefers ones that haven't come up lately, so players see real variety.
let recentGames: string[] = [];
function pickRandomGame(): string {
  if (TWO_PLAYER_GAMES.length === 0) return 'uno';
  if (TWO_PLAYER_GAMES.length === 1) return TWO_PLAYER_GAMES[0];
  const notRecent = TWO_PLAYER_GAMES.filter((g) => !recentGames.includes(g));
  const pool = notRecent.length > 0 ? notRecent : TWO_PLAYER_GAMES;
  const game = pool[Math.floor(Math.random() * pool.length)];
  recentGames.push(game);
  // remember enough history to rotate through all but force at least one change
  if (recentGames.length >= TWO_PLAYER_GAMES.length) recentGames.shift();
  return game;
}

/**
 * Universal pairing: match any 2 agents with compatible stake/elo/token.
 * The system picks the game type randomly.
 */
export function findPairs(waitingEntries: QueueEntryData[]): Array<[QueueEntryData, QueueEntryData, string]> {
  const sorted = [...waitingEntries].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  const paired = new Set<string>();
  const pairs: Array<[QueueEntryData, QueueEntryData, string]> = [];

  for (let i = 0; i < sorted.length; i++) {
    const entryA = sorted[i];
    if (paired.has(entryA.agentId)) continue;

    for (let j = i + 1; j < sorted.length; j++) {
      const entryB = sorted[j];
      if (paired.has(entryB.agentId)) continue;

      // Never pair two agents owned by the same user (you can't bet against yourself).
      // Exception: a human/pull agent (a person playing their own agent for practice).
      if (entryA.userId && entryB.userId && entryA.userId === entryB.userId) {
        const hasHumanOrPull = entryA.agentType === 'human' || entryB.agentType === 'human'
          || entryA.agentType === 'pull' || entryB.agentType === 'pull';
        if (!hasHumanOrPull) continue;
      }
      if (Math.abs(entryA.eloRating - entryB.eloRating) > ELO_MATCH_RANGE) continue;
      if (!stakesCompatible(entryA.stakeAmount, entryB.stakeAmount)) continue;

      // Same token required
      if ((entryA.token || 'USDC') !== (entryB.token || 'USDC')) continue;

      // Respect specific game type requests; skip if incompatible
      const gtA = entryA.gameType;
      const gtB = entryB.gameType;
      const aSpecific = gtA && gtA !== 'any' && gtA !== 'poker';
      const bSpecific = gtB && gtB !== 'any' && gtB !== 'poker';
      let chosenGame: string;
      if (aSpecific && bSpecific) {
        if (gtA !== gtB) continue;
        chosenGame = gtA;
      } else if (aSpecific) {
        chosenGame = gtA;
      } else if (bSpecific) {
        chosenGame = gtB!;
      } else {
        chosenGame = pickRandomGame();
      }
      pairs.push([entryA, entryB, chosenGame]);
      paired.add(entryA.agentId);
      paired.add(entryB.agentId);
      break;
    }
  }
  return pairs;
}

/**
 * For poker: group 2-9 compatible agents into a single table.
 * Only groups agents that queued for "poker".
 */
export function findPokerGroup(waitingEntries: QueueEntryData[]): QueueEntryData[] | null {
  // Filter to agents that queued for poker
  const pokerEntries = waitingEntries.filter(e => e.gameType === 'poker');

  if (pokerEntries.length < POKER_MIN_PLAYERS) return null;

  const sorted = [...pokerEntries].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  const group: QueueEntryData[] = [sorted[0]];

  for (let i = 1; i < sorted.length && group.length < POKER_MAX_PLAYERS; i++) {
    const candidate = sorted[i];
    const baseStake = group[0].stakeAmount;

    // Don't seat two agents owned by the same user at the same table.
    if (candidate.userId && group.some((g) => g.userId && g.userId === candidate.userId)) continue;

    // Same token required
    if ((candidate.token || 'USDC') !== (group[0].token || 'USDC')) continue;

    // ELO range check against the group average
    const avgElo = group.reduce((s, e) => s + e.eloRating, 0) / group.length;
    if (Math.abs(candidate.eloRating - avgElo) > ELO_MATCH_RANGE * 1.5) continue;

    // Stake compatibility
    if (!stakesCompatible(baseStake, candidate.stakeAmount)) continue;

    group.push(candidate);
  }

  return group.length >= POKER_MIN_PLAYERS ? group : null;
}
