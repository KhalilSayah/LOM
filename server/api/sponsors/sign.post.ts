import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { moveCredits } from '~~/server/utils/openPack';
import { sponsorBook, sponsorCatalogue, contractsFor } from '~~/server/utils/sponsors';
import { SPONSOR_SLOTS } from '~~/shared/sponsors';

/**
 * Sign a contract you hold into one of your slots.
 *
 * The signing bonus is paid once per contract, ever — `signed_at` is the record of that, so
 * releasing and re-signing the same brand is free but does not pay again. Otherwise a slot
 * would be a button that prints the bonus.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const body = await readBody<{ sponsorKey?: string; slot?: number }>(event);
  const key = String(body?.sponsorKey ?? '').trim().toUpperCase();
  if (!key) throw createError({ statusCode: 400, statusMessage: 'Which sponsor?' });

  const [catalogue, held] = await Promise.all([sponsorCatalogue(db), contractsFor(db, profileId)]);

  const def = catalogue.find((d) => d.key === key);
  if (!def) throw createError({ statusCode: 404, statusMessage: 'No such sponsor.' });

  const contract = held.find((h) => h.sponsor_key === key);
  if (!contract) {
    throw createError({ statusCode: 403, statusMessage: 'You do not hold that contract.' });
  }
  if (contract.slot !== null) {
    throw createError({ statusCode: 409, statusMessage: `${def.name} is already signed.` });
  }

  // The slot they asked for, or the lowest free one.
  const taken = new Set(held.filter((h) => h.slot !== null).map((h) => h.slot));
  let slot = Number.isInteger(body?.slot) ? Number(body!.slot) : null;

  if (slot === null) {
    for (let i = 0; i < SPONSOR_SLOTS; i++) {
      if (!taken.has(i)) { slot = i; break; }
    }
  }

  if (slot === null) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Both slots are taken. Release one first.',
    });
  }
  if (slot < 0 || slot >= SPONSOR_SLOTS) {
    throw createError({ statusCode: 400, statusMessage: 'No such slot.' });
  }
  if (taken.has(slot)) {
    throw createError({ statusCode: 409, statusMessage: 'Something is already signed in that slot.' });
  }

  const firstSigning = !contract.signed_at;

  /**
   * The slot claim is the lock.
   *
   * `slot is null` in the WHERE means two taps cannot both move the same contract, and the
   * partial unique index on (profile_id, slot) means two different contracts cannot both
   * land in one slot. Whichever loses is told plainly rather than silently overwriting.
   */
  const { data: signed, error } = await db
    .from('manager_sponsors')
    .update({
      slot,
      signed_at: new Date().toISOString(),
      // A fresh term: the commitment starts from this signing, not from the first one.
      matches_since_signed: 0,
    })
    .eq('id', contract.id)
    .is('slot', null)
    .select('id')
    .maybeSingle();

  if (error?.code === '23505' || !signed) {
    throw createError({ statusCode: 409, statusMessage: 'That slot was just taken.' });
  }
  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  let bonus = 0;
  if (firstSigning && def.signing_bonus > 0) {
    bonus = def.signing_bonus;
    await moveCredits(db, profileId, bonus, `SPONSOR_SIGNING:${def.key}`);
  }

  const [book, { data: profile }] = await Promise.all([
    sponsorBook(db, profileId),
    db.from('profiles').select('credits').eq('id', profileId).single(),
  ]);

  return {
    signed: def.key,
    name: def.name,
    slot,
    signingBonus: bonus,
    credits: profile?.credits ?? 0,
    ...book,
  };
});
