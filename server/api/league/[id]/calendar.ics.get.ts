import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { requireMembership, draftedSides } from '~~/server/utils/league';
import { FIXTURE_LOBBY_LEAD_SECONDS } from '~~/shared/league';

/**
 * My fixtures in this league, as a calendar file.
 *
 * The reminder that does not need a push service: download it once and the phone's own
 * calendar does the nagging, fifteen minutes before kick-off, which is when the lobby
 * opens. Times are written in UTC (`...Z`), which every calendar app converts to the
 * phone's zone — so a manager travelling with a Paris league still gets the right hour.
 *
 * Only this season, and only my own fixtures: everyone else's evenings are theirs. A
 * playoff fixture whose sides are not known yet is included only once I am in it, so
 * the file never promises a final nobody has reached.
 *
 * It is a download rather than a subscription URL. A subscription is fetched by the
 * calendar provider's servers, without anybody's session, and a URL that worked without
 * one would be a way to read somebody's league from outside it.
 */

const MATCH_MINUTES = 30;

/** RFC 5545 escaping for TEXT values. */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** 20261121T193000Z */
const stamp = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Lines longer than 75 octets are folded with a leading space (RFC 5545 section 3.1). */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

const STAGE_LABEL: Record<string, string> = {
  SEMI: 'Semi-final',
  GRAND_FINAL: 'Final',
  GHOST: 'Ghost match',
};

export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Which league?' });

  const { league, members, me } = await requireMembership(db, id, profileId);
  const name = new Map(members.map((m) => [m.id, m.team_name]));

  const { data, error } = await db
    .from('league_fixtures')
    .select('id, day_index, stage, blue_member_id, red_member_id, ghost_side, scheduled_at, status')
    .eq('league_id', league.id)
    .eq('season', league.season ?? 1)
    .not('scheduled_at', 'is', null)
    .neq('status', 'VOID')
    .or(`blue_member_id.eq.${me.id},red_member_id.eq.${me.id}`)
    .order('scheduled_at', { ascending: true });

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const origin = getRequestURL(event).origin;
  const now = stamp(new Date());

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LOM//League fixtures//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${league.name} — ${me.team_name}`)}`,
  ];

  for (const f of (data || []) as any[]) {
    const sides = draftedSides(f);
    const mine = sides.blue === me.id ? 'BLUE' : sides.red === me.id ? 'RED' : null;
    if (!mine) continue;

    const opponentId = mine === 'BLUE' ? sides.red : sides.blue;
    const opponent = opponentId ? name.get(opponentId) ?? 'Unknown' : 'a Ghost';
    const start = new Date(f.scheduled_at);
    const end = new Date(start.getTime() + MATCH_MINUTES * 60_000);
    const stage = STAGE_LABEL[f.stage] ? `${STAGE_LABEL[f.stage]} · ` : '';

    lines.push(
      'BEGIN:VEVENT',
      `UID:${f.id}@lom`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${esc(`${stage}${me.team_name} v ${opponent} — ${league.name}`)}`,
      `DESCRIPTION:${esc(
        `Day ${f.day_index}. ${mine === 'BLUE' ? 'You draft first.' : 'They draft first.'} `
        + `The lobby opens ${FIXTURE_LOBBY_LEAD_SECONDS / 60} minutes before kick-off and the draft starts at kick-off. `
        + `${origin}/leagues/${league.id}`,
      )}`,
      `URL:${origin}/leagues/${league.id}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(`Lobby open: ${me.team_name} v ${opponent}`)}`,
      `TRIGGER:-PT${FIXTURE_LOBBY_LEAD_SECONDS / 60}M`,
      'END:VALARM',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');

  const slug = league.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'league';
  setResponseHeader(event, 'Content-Type', 'text/calendar; charset=utf-8');
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${slug}-fixtures.ics"`);
  setResponseHeader(event, 'Cache-Control', 'private, no-store');

  return lines.map(fold).join('\r\n') + '\r\n';
});
