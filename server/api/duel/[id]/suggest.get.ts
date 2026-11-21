import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { SLOTS, stepAt, type Slot } from '~~/shared/draft';
import { loadActions, draftPool, sideOf } from '~~/server/utils/duelRun';
import { scorePicks, scoreBans, type Lineup } from '~~/server/utils/duel';
import { championRoles } from '~~/server/utils/championRoles';

/**
 * What the agent would do in your seat, for the step you are on.
 *
 * On a pick: the three best champions for each of your open slots, scored exactly as the
 * agent scores its own picks (scorePicks) — rating on that card, what it adds to the comp,
 * flex value, and how much the other side wants it — without the noise the agent adds to
 * itself. On a ban: the champions whose loss costs the other side most, and which of their
 * cards loses it.
 *
 * Only on your own turn. It is advice, and advice about the other side's turn is a way of
 * reading their best options off the server.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  const { data: duel } = await db
    .from('duels')
    .select('id, status, turn, blue_id, red_id, blue_lineup, red_lineup, catalogue_version_id')
    .eq('id', id)
    .maybeSingle();
  if (!duel) throw createError({ statusCode: 404, statusMessage: 'No such duel.' });

  const side = sideOf(duel, profileId);
  if (!side) throw createError({ statusCode: 403, statusMessage: 'That duel is not yours.' });

  const step = duel.status === 'DRAFTING' ? stepAt(duel.turn) : null;
  if (!step || step.side !== side) return { turn: duel.turn, kind: null };

  const [pool, roles, actions] = await Promise.all([
    draftPool(db, duel.catalogue_version_id),
    championRoles(db, duel.catalogue_version_id),
    loadActions(db, duel.id),
  ]);

  const mine = (side === 'BLUE' ? duel.blue_lineup : duel.red_lineup) as Lineup;
  const theirs = (side === 'BLUE' ? duel.red_lineup : duel.blue_lineup) as Lineup;
  const theirSide = side === 'BLUE' ? 'RED' : 'BLUE';

  if (step.kind === 'PICK') {
    const options = scorePicks(mine, theirs, actions, side, pool, roles);
    const bySlot: Partial<Record<Slot, Array<{ championKey: string; championName: string; mastery: number; rating: number }>>> = {};
    for (const slot of SLOTS) {
      const top = options.filter((o) => o.slot === slot).slice(0, 3);
      if (top.length) {
        bySlot[slot] = top.map((o) => ({
          championKey: o.championKey,
          championName: o.championName,
          mastery: o.mastery,
          rating: Math.round(o.rating),
        }));
      }
    }
    return { turn: duel.turn, kind: 'PICK', best: options[0]?.slot ?? null, bySlot };
  }

  const bans = scoreBans(theirs, actions, theirSide, pool, roles)
    .filter((b) => b.cost > 0 && b.victim)
    .slice(0, 3)
    .map((b) => ({
      championKey: b.championKey,
      championName: b.championName,
      cost: Math.round(b.cost),
      victim: b.victim,
    }));
  return { turn: duel.turn, kind: 'BAN', bans };
});
