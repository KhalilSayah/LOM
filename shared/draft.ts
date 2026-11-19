/**
 * The draft: what happens when, and what is legal.
 *
 * Pure and shared. The server decides, but the client renders the same order and greys out
 * the same illegal champions, and the only way those two agree forever is for there to be
 * one copy of the rules.
 *
 * docs/05 section 3.
 */

export type Side = 'BLUE' | 'RED';
export type ActionKind = 'BAN' | 'PICK';
export type Slot = 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP';

export const SLOTS: Slot[] = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];

export interface DraftStep {
  idx: number;
  side: Side;
  kind: ActionKind;
  /** Which of the four phases this step belongs to, for the header on the draft screen. */
  phase: 'BAN_1' | 'PICK_1' | 'BAN_2' | 'PICK_2';
}

/**
 * Standard competitive order: 10 bans, 10 picks, 20 actions.
 *
 *   Ban  1:  B R B R B R
 *   Pick 1:  B R R B B R
 *   Ban  2:  R B R B
 *   Pick 2:  R B B R
 *
 * Blue has first ban and first pick; red has last pick. The asymmetry is the whole
 * reason side assignment matters, so sides are drawn at accept rather than given to
 * whoever sent the challenge.
 */
const ORDER_SPEC: Array<[ActionKind, Side, DraftStep['phase']]> = [
  ['BAN', 'BLUE', 'BAN_1'], ['BAN', 'RED', 'BAN_1'],
  ['BAN', 'BLUE', 'BAN_1'], ['BAN', 'RED', 'BAN_1'],
  ['BAN', 'BLUE', 'BAN_1'], ['BAN', 'RED', 'BAN_1'],

  ['PICK', 'BLUE', 'PICK_1'], ['PICK', 'RED', 'PICK_1'], ['PICK', 'RED', 'PICK_1'],
  ['PICK', 'BLUE', 'PICK_1'], ['PICK', 'BLUE', 'PICK_1'], ['PICK', 'RED', 'PICK_1'],

  ['BAN', 'RED', 'BAN_2'], ['BAN', 'BLUE', 'BAN_2'],
  ['BAN', 'RED', 'BAN_2'], ['BAN', 'BLUE', 'BAN_2'],

  ['PICK', 'RED', 'PICK_2'], ['PICK', 'BLUE', 'PICK_2'],
  ['PICK', 'BLUE', 'PICK_2'], ['PICK', 'RED', 'PICK_2'],
];

export const DRAFT_ORDER: DraftStep[] = ORDER_SPEC.map(([kind, side, phase], idx) => ({
  idx, side, kind, phase,
}));

export const DRAFT_LENGTH = DRAFT_ORDER.length;

export const PHASE_LABEL: Record<DraftStep['phase'], string> = {
  BAN_1: 'First bans',
  PICK_1: 'First picks',
  BAN_2: 'Second bans',
  PICK_2: 'Last picks',
};

/** docs/05 section 3.3. The server owns these; the client only renders a countdown. */
export const ACTION_SECONDS = 30;
export const BONUS_SECONDS = 60;

export const stepAt = (turn: number): DraftStep | null => DRAFT_ORDER[turn] ?? null;

export interface LockedAction {
  idx: number;
  side: Side;
  kind: ActionKind;
  championKey: string;
  championName: string;
  slot: Slot | null;
  auto: boolean;
}

/** Champions already spoken for — banned or picked, by either side. */
export const takenChampions = (actions: LockedAction[]): Set<string> =>
  new Set(actions.map((a) => a.championKey));

/** Slots a side has already filled. */
export const filledSlots = (actions: LockedAction[], side: Side): Set<Slot> =>
  new Set(actions.filter((a) => a.side === side && a.slot).map((a) => a.slot as Slot));

export interface LegalityInput {
  turn: number;
  actions: LockedAction[];
  side: Side;
  kind: ActionKind;
  championKey: string;
  slot?: Slot | null;
  /** Champion keys that exist in the pinned catalogue. */
  pool: Set<string>;
}

/**
 * Why an action is not allowed, or null when it is.
 *
 * Returns the reason rather than a boolean because every one of these is shown to a
 * person — "that champion is gone" and "it is not your turn" are different problems and a
 * draft screen that says "illegal" to both is useless under time pressure.
 *
 * Mastery is deliberately absent, per docs/05 section 3.2: any card may be drafted onto any
 * champion. Taking a champion nobody on your roster can play is a bad idea, not an illegal
 * one, and the penalty is the constraint.
 */
export function illegalBecause(input: LegalityInput): string | null {
  const step = stepAt(input.turn);
  if (!step) return 'The draft is over.';
  if (step.side !== input.side) return 'It is not your turn.';
  if (step.kind !== input.kind) {
    return step.kind === 'BAN' ? 'This is a ban, not a pick.' : 'This is a pick, not a ban.';
  }
  if (!input.championKey) return 'No champion chosen.';
  if (!input.pool.has(input.championKey)) return 'That champion is not in this catalogue.';
  if (takenChampions(input.actions).has(input.championKey)) return 'That champion is already gone.';

  if (step.kind === 'PICK') {
    if (!input.slot) return 'A pick needs a lineup slot.';
    if (!SLOTS.includes(input.slot)) return 'That is not a lineup slot.';
    if (filledSlots(input.actions, input.side).has(input.slot)) return 'That slot is already filled.';
  } else if (input.slot) {
    return 'A ban does not take a slot.';
  }

  return null;
}

/** The picks of one side, in slot order, once the draft is done. */
export function lineupFromActions(actions: LockedAction[], side: Side): Record<Slot, string | null> {
  const out = {} as Record<Slot, string | null>;
  for (const slot of SLOTS) out[slot] = null;
  for (const a of actions) {
    if (a.side === side && a.kind === 'PICK' && a.slot) out[a.slot] = a.championName;
  }
  return out;
}

export const bansOf = (actions: LockedAction[], side: Side): LockedAction[] =>
  actions.filter((a) => a.side === side && a.kind === 'BAN');

export const picksOf = (actions: LockedAction[], side: Side): LockedAction[] =>
  actions.filter((a) => a.side === side && a.kind === 'PICK');
