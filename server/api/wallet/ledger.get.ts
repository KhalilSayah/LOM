import { serverSupabaseServiceRole } from '#supabase/server';
import { requireManager, ensureProfile } from '~~/server/utils/auth';
import { questByKey } from '~~/server/utils/quests';

/**
 * Where the Credits came from and where they went.
 *
 * credit_ledger is the truth behind the balance (migration 0004): every movement is a row
 * with the balance it produced. This reads it newest first, a page at a time, and turns
 * each reason key into something a manager can read. The summary is the last 30 days by
 * source, so "how do I earn more" has an answer in the manager's own numbers.
 */

type Kind = 'MATCH' | 'DUPLICATE' | 'SPONSOR' | 'QUEST' | 'PACK' | 'SEASON' | 'OTHER';

const PAGE = 40;

function titleCase(s: string) {
  return s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export default defineEventHandler(async (event) => {
  const manager = await requireManager(event);
  const db = serverSupabaseServiceRole(event);
  const profileId = await ensureProfile(db, manager);

  const q = getQuery(event);
  const before = Number(q.before);

  let query = db
    .from('credit_ledger')
    .select('id, delta, reason, ref_id, balance_after, created_at')
    .eq('profile_id', profileId)
    .order('id', { ascending: false })
    .limit(PAGE + 1);
  if (Number.isFinite(before) && before > 0) query = query.lt('id', before);

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const [{ data: rows, error }, { data: recent }, { data: profile }, { data: packTypes }, { data: sponsors }] = await Promise.all([
    query,
    db.from('credit_ledger')
      .select('delta, reason')
      .eq('profile_id', profileId)
      .gte('created_at', since)
      .limit(5000),
    db.from('profiles').select('credits').eq('id', profileId).single(),
    db.from('pack_types').select('key, name'),
    db.from('sponsor_definitions').select('key, name'),
  ]);

  if (error) throw createError({ statusCode: 500, statusMessage: error.message });

  const packName = new Map((packTypes || []).map((p: any) => [p.key, p.name as string]));
  const sponsorName = new Map((sponsors || []).map((s: any) => [s.key, s.name as string]));

  const describe = (reason: string, delta: number): { kind: Kind; label: string } => {
    const [head, tail = ''] = reason.split(':');
    switch (head) {
      case 'MATCH': return { kind: 'MATCH', label: 'Match payout' };
      case 'DUPLICATE': return { kind: 'DUPLICATE', label: 'Duplicate pull' };
      case 'SEASON': return { kind: 'SEASON', label: 'Season prize' };
      case 'QUEST': return { kind: 'QUEST', label: `Quest · ${questByKey(tail)?.title ?? titleCase(tail)}` };
      case 'PACK': return { kind: 'PACK', label: `Bought a ${(packName.get(tail) ?? titleCase(tail)).toLowerCase()}` };
      case 'SPONSOR_PACK': return { kind: 'SPONSOR', label: 'Sponsor meeting' };
      case 'SPONSOR_DUPLICATE': return { kind: 'SPONSOR', label: 'Sponsor meeting paid out' };
      case 'SPONSOR_SIGNING': return { kind: 'SPONSOR', label: `Signing bonus · ${sponsorName.get(tail) ?? titleCase(tail)}` };
      case 'SPONSOR_BUYOUT': return { kind: 'SPONSOR', label: `Contract buyout · ${sponsorName.get(tail) ?? titleCase(tail)}` };
      default: return { kind: 'OTHER', label: delta > 0 ? `${titleCase(head || 'Grant')}` : titleCase(head || 'Spend') };
    }
  };

  const page = (rows || []).slice(0, PAGE);
  const entries = page.map((r: any) => {
    const { kind, label } = describe(String(r.reason || ''), r.delta);
    return {
      id: r.id as number,
      delta: r.delta as number,
      balance: r.balance_after as number,
      at: r.created_at as string,
      kind,
      label,
      // A match payout links back to the match it paid for.
      duelId: kind === 'MATCH' ? (r.ref_id as string | null) : null,
      openingId: kind === 'DUPLICATE' || kind === 'PACK' ? (r.ref_id as string | null) : null,
    };
  });

  const totals: Record<Kind, { in: number; out: number }> = {
    MATCH: { in: 0, out: 0 }, DUPLICATE: { in: 0, out: 0 }, SPONSOR: { in: 0, out: 0 },
    QUEST: { in: 0, out: 0 }, PACK: { in: 0, out: 0 }, SEASON: { in: 0, out: 0 }, OTHER: { in: 0, out: 0 },
  };
  for (const r of (recent || []) as any[]) {
    const { kind } = describe(String(r.reason || ''), r.delta);
    if (r.delta > 0) totals[kind].in += r.delta;
    else totals[kind].out += -r.delta;
  }

  return {
    credits: profile?.credits ?? 0,
    entries,
    next: (rows || []).length > PAGE ? entries[entries.length - 1]?.id ?? null : null,
    last30: totals,
  };
});
