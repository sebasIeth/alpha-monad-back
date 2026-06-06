/**
 * Builds a prompt per game type and parses the LLM reply into the exact
 * response shape each AlphArena turn-controller expects:
 *   chess    → { move: "e2e4" }
 *   rps      → { move: "rock" }
 *   poker    → { action: "fold"|"check"|"call"|"raise"|"all_in", amount? }
 *   uno      → { type: "PLAY_CARD", cardId } | { type: "DRAW_CARD" } | { type: "PASS" }
 *   werewolf → { type: <ACTION_TYPE>, target?, role? }
 */

export interface Persona {
  name?: string;
  avatar?: string;
  vibe?: 'aggressive' | 'balanced' | 'defensive';
}

const VIBE_HINT: Record<string, string> = {
  aggressive: 'You are AGGRESSIVE: pressure opponents, take calculated risks, punish weakness.',
  balanced: 'You are BALANCED: steady and calculating, play the long game, exploit mistakes.',
  defensive: 'You are DEFENSIVE: play safe, minimize risk, wait for opponent errors.',
};

function personaHeader(persona: Persona): string {
  const vibe = VIBE_HINT[persona?.vibe || 'balanced'] || VIBE_HINT.balanced;
  return `You are "${persona?.name || 'Agent'}", an AI playing a competitive game on AlphArena. ${vibe}`;
}

export function buildPrompt(persona: Persona, req: any): string {
  const header = personaHeader(persona);
  switch (req.gameType) {
    case 'chess':
      return `${header}

You are playing CHESS as ${req.yourColor}.
FEN: ${req.fen}
${req.isCheck ? 'You are in CHECK.' : ''}
Legal moves (UCI): ${(req.legalMoves || []).join(', ')}

Pick the strongest legal move. Respond with ONLY JSON: {"move":"<uci>"} where <uci> is one of the legal moves above.`;

    case 'rps': {
      const oppScore = Object.entries(req.scores || {}).filter(([k]) => k !== req.yourSide).map(([, v]) => v)[0] ?? 0;
      const history: Array<{ round: number; you: string; opponent: string; result: string }> = req.history || [];
      const historyText = history.length
        ? `\nPrevious rounds (oldest first):\n${history.map((h) => `  R${h.round}: you=${h.you}, opponent=${h.opponent} → ${h.result}`).join('\n')}\n`
        : '';
      return `${header}

You are playing ROCK-PAPER-SCISSORS, best of ${req.bestOf}.
Round ${req.currentRound}. Score: you=${req.scores?.[req.yourSide] ?? 0}, opponent=${oppScore}.
${historyText}
Study the opponent's pattern above. Only deviate from randomness when you see a CLEAR pattern to exploit (e.g. they repeated the same throw 3+ times — then counter it). Otherwise optimal play is random: use your assigned random throw for this round: "${req.randomFallback || 'rock'}". Never assume the opponent reasons like you.

Pick rock, paper, or scissors. Respond with ONLY JSON: {"move":"rock"} (or "paper" / "scissors").`;
    }

    case 'poker': {
      const la = req.legalActions || {};
      const hole = (req.yourHoleCards || []).map((c: any) => `${c.rank}${c.suit}`).join(' ');
      const comm = (req.communityCards || []).map((c: any) => `${c.rank}${c.suit}`).join(' ') || '(none)';
      const options: string[] = [];
      if (la.canFold) options.push('fold');
      if (la.canCheck) options.push('check');
      if (la.canCall) options.push(`call (${la.callAmount})`);
      if (la.canRaise) options.push(`raise (min ${la.minRaise}, max ${la.maxRaise})`);
      if (la.canAllIn) options.push(`all_in (${la.allInAmount})`);
      return `${header}

You are playing POKER (Texas Hold'em heads-up). Street: ${req.street}.
Your hole cards: ${hole}
Community cards: ${comm}
Pot: ${req.pot}. Your stack: ${req.yourStack}. Your current bet: ${req.yourCurrentBet}.
Legal actions: ${options.join(', ')}

HEADS-UP STRATEGY (2 players — hand values shift dramatically):
- Ranges are WIDE: any pair, any ace or king, queen/jack-high, suited or connected cards are playable. Raise or call with them.
- Folding preflop should be RARE — only truly weak hands (like unsuited disconnected low cards) facing a big raise. Folding every hand bleeds blinds and guarantees a loss.
- Prefer check/call over fold when the price is small relative to the pot. Mix in raises to apply pressure.

Choose one action. Respond with ONLY JSON:
{"action":"fold"} | {"action":"check"} | {"action":"call"} | {"action":"raise","amount":<n>} | {"action":"all_in"}`;
    }

    case '2048': {
      const grid: number[][] = req.grid || [];
      const gridText = grid.map((row: number[]) => row.map((v) => String(v || '.').padStart(5)).join(' ')).join('\n');
      return `${header}

You are playing 2048 DUEL: you and the opponent each play your OWN 4x4 board with identical tile luck. First to build a 2048 tile wins instantly; otherwise the higher score wins when both boards are stuck or moves run out.

Your board (move ${req.moveNumber}, ${req.movesLeft} moves left):
${gridText}

Your score: ${req.score}. Opponent score: ${req.opponentScore} (best tile ${req.opponentBestTile}).
Legal moves: ${(req.legalMoves || []).join(', ')}

STRATEGY: keep your highest tile in a corner, build rows in order, avoid moves that scatter big tiles. Merge greedily when safe.

Respond with ONLY JSON: {"move":"up"} (or "down" / "left" / "right").`;
    }

    case 'uno': {
      const hand = (req.hand || [])
        .map((c: any) => `${c.color || 'WILD'} ${c.type}${c.value !== null && c.value !== undefined ? ' ' + c.value : ''} (id:${c.id})`)
        .join('\n  ');
      const top = `${req.topCard?.color || 'WILD'} ${req.topCard?.type}${req.topCard?.value !== null && req.topCard?.value !== undefined ? ' ' + req.topCard.value : ''}`;
      const actions = (req.legalActions || []).map((a: any) => JSON.stringify(a)).join('\n  ');
      return `${header}

You are playing UNO.
Current color: ${req.currentColor}
Top card: ${top}
Your hand:
  ${hand}

Legal actions (pick ONE, respond with the EXACT JSON of your chosen action):
  ${actions}

Respond with ONLY the chosen action object as JSON, nothing else.`;
    }

    case 'werewolf': {
      const alive = (req.alivePlayers || []).map((p: any) => `${p.side}=${p.displayName}`).join(', ');
      const actions = (req.legalActions || []).map((a: any) => JSON.stringify(a)).join('\n  ');
      const disc = (req.discussionLog || [])
        .slice(-12)
        .map((d: any) => `${d.side || d.displayName || '?'}: ${d.message || d.text || JSON.stringify(d)}`)
        .join('\n  ');
      return `${header}

You are playing WEREWOLF. Your role: ${req.yourRole}. Phase: ${req.phase}. Cycle: ${req.cycle}.
You are ${req.yourDisplayName} (side ${req.yourSide}).
Alive players: ${alive}
${req.knownWerewolves ? `Known werewolves: ${JSON.stringify(req.knownWerewolves)}` : ''}
${req.yourSeerMemory ? `Your seer findings: ${JSON.stringify(req.yourSeerMemory)}` : ''}
Recent discussion:
  ${disc || '(none yet)'}

Legal actions (pick ONE, respond with the EXACT JSON of your chosen action):
  ${actions}

Play to win for your faction. Respond with ONLY the chosen action object as JSON, nothing else.`;
    }

    default:
      return `${header}\n\nGame: ${req.gameType}. Request: ${JSON.stringify(req)}\nRespond with ONLY a JSON move object.`;
  }
}

/** Extract a JSON object (or bare word for RPS/chess) from the model's text reply. */
export function parseReply(text: string, req: any): any | null {
  const trimmed = (text || '').trim();

  // JSON FIRST: the prompt asks for {"move":"..."}, so prefer the move field.
  // (For RPS, scanning the raw text for the first rock/paper/scissors word grabbed
  // any mention in the model's reasoning — e.g. "rock" in "rock-paper-scissors" —
  // so it always returned rock. Reading the JSON value avoids that.)
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (req.gameType === 'chess') {
        const legal: string[] = req.legalMoves || [];
        if (obj?.move && (!legal.length || legal.includes(obj.move))) return obj;
      } else if (req.gameType === 'rps') {
        const mv = String(obj?.move || '').toLowerCase();
        if (mv === 'rock' || mv === 'paper' || mv === 'scissors') return { move: mv };
      } else {
        return obj;
      }
    } catch {
      /* fall through */
    }
  }

  if (req.gameType === 'rps') {
    // No usable JSON — last resort: take the LAST rock/paper/scissors word
    // (the model usually states its final choice at the end, after any reasoning).
    const all = trimmed.toLowerCase().match(/rock|paper|scissors/g);
    if (all && all.length) return { move: all[all.length - 1] };
  }

  if (req.gameType === '2048') {
    // Same last-resort for 2048: the final direction word wins.
    const all = trimmed.toLowerCase().match(/\b(up|down|left|right)\b/g);
    if (all && all.length) return { move: all[all.length - 1] };
  }

  if (req.gameType === 'chess') {
    const legal: string[] = req.legalMoves || [];
    // Prefer a UCI token that is actually in the legal-move list (avoids grabbing
    // a square mentioned in prose). Fall back to any UCI-shaped token.
    const tokens = trimmed.match(/\b[a-h][1-8][a-h][1-8][qrbn]?\b/g) || [];
    const legalHit = tokens.find((t) => legal.includes(t));
    if (legalHit) return { move: legalHit };
    if (tokens.length) return { move: tokens[0] };
  }

  return null;
}

/** Deterministic safe fallback if the LLM fails — never lose by silence. */
export function fallbackMove(req: any): any {
  switch (req.gameType) {
    case 'chess':
      return { move: (req.legalMoves || [])[0] };
    case 'rps':
      return { move: 'rock' };
    case 'poker': {
      const la = req.legalActions || {};
      if (la.canCheck) return { action: 'check' };
      if (la.canCall && la.callAmount === 0) return { action: 'call' };
      return { action: 'fold' };
    }
    case 'uno': {
      const acts = req.legalActions || [];
      const play = acts.find((a: any) => a.type === 'PLAY_CARD');
      return play || acts.find((a: any) => a.type === 'DRAW_CARD') || acts[0] || { type: 'PASS' };
    }
    case 'werewolf': {
      const acts = req.legalActions || [];
      const pass = acts.find((a: any) => /PASS/.test(a.type));
      return pass || acts[0] || { type: 'DAY_PASS' };
    }
    case '2048':
      return { move: (req.legalMoves || [])[0] || 'up' };
    default:
      return {};
  }
}
