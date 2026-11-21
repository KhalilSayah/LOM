import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { moveCredits } from '~~/server/utils/openPack';
import {
  sponsorBook, sponsorCatalogue, contractsFor, pickSponsor, duplicateCredits, toSponsor,
} from '~~/server/utils/sponsors';
import { SPONSOR_PACK } from '~~/shared/sponsors';

/**
 * Take a sponsor meeting: one contract, 600 Credits.
 *
 * The same order as buying a card pack (server/api/pack/buy.post.ts): roll first, because a
 * roll has no side effects and a spend does, then spend, then grant. If the catalogue has
 * nothing to offer, the manager still has their Credits.
 *
 * A brand already held cannot be signed twice, so it pays out instead — the sponsor
 * equivalent of a duplicate card, at the tier that was rolled.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const [catalogue, held, { data: profile }] = await Promise.all([
    sponsorCatalogue(db),
    contractsFor(db, profileId),
    db.from('profiles').select('credits').eq('id', profileId).single(),
  ]);

  if (!catalogue.length) {
    throw createError({ statusCode: 503, statusMessage: 'No sponsors to meet. Run migration 0012.' });
  }

  const price = SPONSOR_PACK.price;
  if ((profile?.credits ?? 0) < price) {
    throw createError({
      statusCode: 402,
      statusMessage: `A sponsor meeting costs ${price} Credits and you have ${profile?.credits ?? 0}.`,
    });
  }

  const owned = new Set(held.map((h) => h.sponsor_key));
  const { def, tier } = pickSponsor(catalogue, owned, Math.random);

  let balance: number;
  try {
    balance = await moveCredits(db, profileId, -price, 'SPONSOR_PACK');
  } catch {
    throw createError({ statusCode: 402, statusMessage: 'Not enough Credits for that.' });
  }

  // Every brand already held: the meeting pays off instead of signing anybody new.
  if (!def) {
    const credits = duplicateCredits(tier);
    if (credits > 0) balance = await moveCredits(db, profileId, credits, `SPONSOR_DUPLICATE:${tier}`);
    const book = await sponsorBook(db, profileId);
    return {
      spent: price,
      tier,
      sponsor: null,
      duplicate: true,
      creditsEarned: credits,
      credits: balance,
      ...book,
    };
  }

  const { error } = await db.from('manager_sponsors').insert({
    profile_id: profileId,
    sponsor_key: def.key,
  });

  /**
   * 23505 means the manager pulled this brand in two meetings at once. Falling back to the
   * duplicate payout is better than losing the contract and the Credits both.
   */
  if (error) {
    if (error.code !== '23505') throw createError({ statusCode: 500, statusMessage: error.message });
    const credits = duplicateCredits(def.tier);
    if (credits > 0) balance = await moveCredits(db, profileId, credits, `SPONSOR_DUPLICATE:${def.key}`);
    const book = await sponsorBook(db, profileId);
    return {
      spent: price,
      tier: def.tier,
      sponsor: toSponsor(def),
      duplicate: true,
      creditsEarned: credits,
      credits: balance,
      ...book,
    };
  }

  const book = await sponsorBook(db, profileId);

  return {
    spent: price,
    tier: def.tier,
    sponsor: book.sponsors.find((s) => s.key === def.key) ?? toSponsor(def),
    duplicate: false,
    creditsEarned: 0,
    credits: balance,
    ...book,
  };
});
