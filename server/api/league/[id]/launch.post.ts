import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import {
  requireMembership, requireOwner, assertLaunchable, buildFixtures, firstMatchDate, shapeLeague,
  membersOf,
} from '~~/server/utils/league';
import { matchDayCount } from '~~/shared/league';

/**
 * Start the season.
 *
 * The one irreversible thing a league owner does: it closes the invite code, pins the
 * catalogue, and writes every fixture of the season as a row. docs/01 section 2 calls
 * this the lock, and the whole point of locking is that a manager who has seen "you
 * play Sam on Thursday" still plays Sam on Thursday a week later.
 *
 * Ordering matters. The status flips first, with `status = 'FORMING'` in the WHERE
 * clause, so a double-tapped button loses the race in the database rather than in a
 * count read a moment earlier — the loser gets "already started" and no second set of
 * fixtures. If the fixture insert then fails, the flip is rolled back by hand: there
 * is no transaction across two PostgREST calls, so the compensation has to be written
 * out, and a league stuck ACTIVE with no calendar would be unplayable and unfixable
 * from the UI.
 *
 * The fixtures are built from the members read *after* the flip, not before it. The
 * join trigger (migration 0016) locks the league row and refuses anything that is not
 * FORMING, so once the flip has landed nobody else can get in — and anybody who got in
 * while this request was checking rosters is in the list read afterwards, rather than a
 * member with no fixtures.
 */
export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which league?' });

  const { league, members } = await requireMembership(db, id, profileId);
  requireOwner(league, profileId);

  if (league.status === 'ACTIVE') {
    throw createError({ statusCode: 409, statusMessage: `${league.name} has already started.` });
  }
  if (league.status === 'FINISHED') {
    throw createError({ statusCode: 409, statusMessage: `${league.name} is finished.` });
  }

  assertLaunchable(members);

  /**
   * Who has not set a five yet.
   *
   * A warning rather than a rule. Nothing is drafted at launch — the first kick-off
   * is hours away, and a manager who fills their roster this evening has lost
   * nothing. But the owner is committing other people to a fortnight, so they are
   * told who is not ready and have to say "start anyway" to go past it. Named, not
   * counted, because the point of knowing is to go and chase those people.
   */
  const { data: slots } = await db
    .from('roster_slots').select('profile_id, role')
    .in('profile_id', members.map((m) => m.profile_id));

  const filled = new Map<string, number>();
  for (const row of (slots || []) as any[]) {
    filled.set(row.profile_id, (filled.get(row.profile_id) ?? 0) + 1);
  }
  const unready = members.filter((m) => (filled.get(m.profile_id) ?? 0) < 5);

  const body = await readBody<{ ignoreUnready?: boolean }>(event).catch(() => null);
  if (unready.length && !body?.ignoreUnready) {
    throw createError({
      statusCode: 409,
      statusMessage: `${unready.map((m) => m.team_name).join(', ')} ${unready.length === 1 ? 'has' : 'have'} not set a full roster yet.`,
      data: { unready: unready.map((m) => m.team_name), canForce: true },
    });
  }

  const { data: active } = await db
    .from('catalogue_versions').select('id').eq('is_active', true).maybeSingle();
  if (!active) throw createError({ statusCode: 503, statusMessage: 'No active catalogue to pin.' });

  const now = new Date();
  const startsOn = firstMatchDate(league, now);

  const { data: claimed } = await db
    .from('leagues')
    .update({
      status: 'ACTIVE',
      starts_on: startsOn,
      started_at: now.toISOString(),
      catalogue_version_id: active.id,
    })
    .eq('id', league.id)
    .eq('status', 'FORMING')
    .select('id')
    .maybeSingle();

  if (!claimed) {
    throw createError({ statusCode: 409, statusMessage: `${league.name} has already started.` });
  }

  const roster = await membersOf(db, league.id);
  const undo = () => db.from('leagues')
    .update({ status: 'FORMING', starts_on: null, started_at: null })
    .eq('id', league.id);

  let fixtures: ReturnType<typeof buildFixtures>;
  try {
    assertLaunchable(roster);
    fixtures = buildFixtures(league, roster, now);
  } catch (e) {
    await undo();
    throw e;
  }

  const { error } = await db.from('league_fixtures').insert(fixtures);

  if (error) {
    // Scoped to the season being launched. A launch only ever happens out of FORMING, so
    // there is nothing else there today — but an unscoped delete in a compensation path is
    // the kind of line that becomes a data loss the first time the surrounding code grows
    // a second season (migration 0014).
    await db.from('league_fixtures')
      .delete().eq('league_id', league.id).eq('season', league.season ?? 1);
    await undo();
    throw createError({ statusCode: 500, statusMessage: `Could not write the schedule: ${error.message}` });
  }

  /**
   * A pack each, to open before day 1. docs/01 section 2 grants a starter squad at
   * league start; with one collection per manager rather than one per league, the
   * honest version of that is a pack, not a squad — nobody's existing cards are
   * taken away and nobody arrives with nothing.
   *
   * The reason key carries the league id, so a manager in three leagues gets three
   * and a second launch of the same league gets none.
   */
  for (const m of roster) {
    const { error: giftError } = await db.rpc('grant_pack_gift', {
      p_profile: m.profile_id,
      p_pack: 'SIGNING',
      p_reason: `SEASON:${league.id}`,
      p_title: `${league.name} — season pack`,
      p_body: 'Three players to open before day 1.',
    });
    // A missing gift is not worth failing a launch that has already written itself.
    if (giftError) console.warn(`[league] season pack for ${m.profile_id}: ${giftError.message}`);
  }

  const days = new Set(fixtures.map((f) => f.day_index));

  return {
    league: shapeLeague({ ...league, status: 'ACTIVE', starts_on: startsOn }, roster, profileId),
    startsOn,
    days: days.size,
    matchDays: matchDayCount(
      [...days].map((dayIndex) => ({
        dayIndex,
        rest: fixtures.some((f) => f.day_index === dayIndex && f.stage === 'REST'),
        pairings: [],
      })),
    ),
    fixtures: fixtures.length,
  };
});
