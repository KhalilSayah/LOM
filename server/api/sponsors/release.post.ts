import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { moveCredits } from '~~/server/utils/openPack';
import { sponsorBook, sponsorCatalogue, contractsFor } from '~~/server/utils/sponsors';
import { SPONSOR_TERM, buyoutCost } from '~~/shared/sponsors';

/**
 * Release a contract from its slot.
 *
 * Free once the term has been served, a buy-out before that (shared/sponsors.ts explains
 * why the term exists at all). The brand itself is kept either way — you own the
 * relationship, you are only ending this spell of it, and it can be re-signed later without
 * paying the signing bonus again.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const body = await readBody<{ sponsorKey?: string; buyout?: boolean }>(event);
  const key = String(body?.sponsorKey ?? '').trim().toUpperCase();
  if (!key) throw createError({ statusCode: 400, statusMessage: 'Which sponsor?' });

  const [catalogue, held] = await Promise.all([sponsorCatalogue(db), contractsFor(db, profileId)]);

  const def = catalogue.find((d) => d.key === key);
  const contract = held.find((h) => h.sponsor_key === key);

  if (!def || !contract) {
    throw createError({ statusCode: 404, statusMessage: 'You do not hold that contract.' });
  }
  if (contract.slot === null) {
    throw createError({ statusCode: 409, statusMessage: `${def.name} is not signed.` });
  }

  const served = contract.matches_since_signed >= SPONSOR_TERM;
  const cost = served ? 0 : buyoutCost(def.signing_bonus);

  /**
   * An early release has to be asked for explicitly.
   *
   * The screen shows the price on the button, and this is the server's half of that: a
   * release request that does not know it is a buy-out is refused rather than charged, so
   * nobody is billed by a tap they thought was free.
   */
  if (cost > 0 && !body?.buyout) {
    const left = SPONSOR_TERM - contract.matches_since_signed;
    throw createError({
      statusCode: 409,
      statusMessage: `${def.name} has ${left} ${left === 1 ? 'match' : 'matches'} left on its term. Buying out costs ${cost} Credits.`,
    });
  }

  // Charged before the slot is freed, because the SQL function is what refuses an
  // overdraw: freeing the slot first would mean a release nobody could pay for.
  if (cost > 0) {
    try {
      await moveCredits(db, profileId, -cost, `SPONSOR_BUYOUT:${def.key}`);
    } catch {
      throw createError({
        statusCode: 402,
        statusMessage: `Buying out of ${def.name} costs ${cost} Credits and you do not have them.`,
      });
    }
  }

  const { error } = await db
    .from('manager_sponsors')
    .update({ slot: null, matches_since_signed: 0 })
    .eq('id', contract.id);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const [book, { data: profile }] = await Promise.all([
    sponsorBook(db, profileId),
    db.from('profiles').select('credits').eq('id', profileId).single(),
  ]);

  return {
    released: def.key,
    name: def.name,
    buyoutPaid: cost,
    credits: profile?.credits ?? 0,
    ...book,
  };
});
