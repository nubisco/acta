/**
 * Home's panels beyond Next up (Jose, 2026-10-09): what is falling behind,
 * what colleagues did that concerns you, and the pages that changed under
 * you. Each answers one question and returns only what that panel shows.
 * The layout each person chooses for Home is stored here too.
 */
import { z } from 'zod'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { hiddenDocIds, viewerOf } from '../core/docAccess'

const DAY = 86_400_000

/** Spaces this person works in: where they hold, or have held, a card. */
const MY_SPACES = `SELECT DISTINCT it.space_id FROM item_assignee ia
  JOIN item it ON it.id = ia.item_id WHERE ia.actor_id = ?`

/**
 * What is slipping in the spaces this person works in, whoever holds it:
 * cards past their date, cards sitting in an active list untouched for a
 * week, and goals in flight past their target date.
 */
export async function fallingBehind(ctx: ICtx, limit = 8) {
  const me = viewerOf(ctx)
  const today = now()
  const late = await ctx.db.query<{
    key: string
    title: string
    space: string
    due: number
    holders: string | null
  }>(
    `SELECT i.key, i.title, s.name AS space, i.due,
            (SELECT GROUP_CONCAT(a.handle) FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id
              WHERE ia.item_id = i.id) AS holders
       FROM item i JOIN space s ON s.id = i.space_id AND s.archived = 0
       JOIN list l ON l.id = i.list_id
      WHERE i.workspace_id = ? AND i.archived = 0 AND i.completed = 0 AND l.role != 'done'
        AND i.due IS NOT NULL AND i.due < ? AND i.space_id IN (${MY_SPACES})
      ORDER BY i.due LIMIT ?`,
    [ctx.workspaceId, today, me, limit],
  )
  const stuck = await ctx.db.query<{
    key: string
    title: string
    space: string
    updated_at: number
    holders: string | null
  }>(
    `SELECT i.key, i.title, s.name AS space, i.updated_at,
            (SELECT GROUP_CONCAT(a.handle) FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id
              WHERE ia.item_id = i.id) AS holders
       FROM item i JOIN space s ON s.id = i.space_id AND s.archived = 0
       JOIN list l ON l.id = i.list_id AND l.role = 'active'
      WHERE i.workspace_id = ? AND i.archived = 0 AND i.completed = 0
        AND i.updated_at < ? AND i.space_id IN (${MY_SPACES})
      ORDER BY i.updated_at LIMIT ?`,
    [ctx.workspaceId, today - 7 * DAY, me, limit],
  )
  const goals = await ctx.db.query<{
    number: number
    title: string
    status: string
    target_date: number
  }>(
    `SELECT number, title, status, target_date FROM goal
      WHERE workspace_id = ? AND archived = 0
        AND status IN ('pending', 'on_track', 'at_risk', 'off_track')
        AND target_date IS NOT NULL AND target_date < ?
      ORDER BY target_date LIMIT ?`,
    [ctx.workspaceId, today, limit],
  )
  const days = (from: number) => Math.max(1, Math.floor((today - from) / DAY))
  return {
    late: late.map((r) => ({
      key: r.key,
      title: r.title,
      space: r.space,
      days_late: days(r.due),
      holders: r.holders ? r.holders.split(',') : [],
    })),
    stuck: stuck.map((r) => ({
      key: r.key,
      title: r.title,
      space: r.space,
      idle_days: days(r.updated_at),
      holders: r.holders ? r.holders.split(',') : [],
    })),
    goals: goals.map((g) => ({
      key: `G-${g.number}`,
      number: g.number,
      title: g.title,
      status: g.status,
      days_late: days(g.target_date),
    })),
  }
}

/**
 * What colleagues did on the cards this person is on (holds, created or has
 * commented on) in the last week, newest first. Their own doing is left
 * out, and so are mentions, which Next up already ranks.
 */
export async function needsAttention(ctx: ICtx, limit = 10) {
  const me = viewerOf(ctx)
  const rows = await ctx.db.query<{
    id: string
    ts: number
    verb: string
    summary: string
    actor: string
    actor_name: string
    key: string
    title: string
  }>(
    `SELECT e.id, e.ts, e.verb, e.summary, a.handle AS actor, a.name AS actor_name,
            i.key, i.title
       FROM event e
       JOIN item i ON i.id = e.entity_id AND e.entity = 'item'
       JOIN actor a ON a.id = e.actor_id
      WHERE e.workspace_id = ? AND e.ts > ? AND e.actor_id != ?
        AND a.kind != 'system'
        AND i.archived = 0
        AND (EXISTS (SELECT 1 FROM item_assignee ia WHERE ia.item_id = i.id AND ia.actor_id = ?)
             OR i.created_by = ?
             OR EXISTS (SELECT 1 FROM comment c WHERE c.item_id = i.id AND c.actor_id = ?))
      ORDER BY e.id DESC LIMIT ?`,
    [ctx.workspaceId, now() - 7 * DAY, me, me, me, me, limit * 3],
  )
  // One line per card: the latest thing that happened to it, and how many
  // more there were, so a busy card does not fill the panel.
  const byCard = new Map<
    string,
    { key: string; title: string; latest: (typeof rows)[number]; more: number }
  >()
  for (const row of rows) {
    const seen = byCard.get(row.key)
    if (seen) seen.more += 1
    else
      byCard.set(row.key, {
        key: row.key,
        title: row.title,
        latest: row,
        more: 0,
      })
  }
  return {
    entries: [...byCard.values()].slice(0, limit).map((c) => ({
      key: c.key,
      title: c.title,
      verb: c.latest.verb,
      summary: c.latest.summary,
      actor: c.latest.actor,
      actor_name: c.latest.actor_name,
      at: c.latest.ts,
      more: c.more,
    })),
  }
}

/**
 * Pages that changed under this person in the last two weeks: ones they
 * own, have commented on or are named in, edited by somebody else. Open
 * comment threads on pages they own are counted on each. Private pages
 * follow the usual rule.
 */
export async function docUpdates(ctx: ICtx, limit = 8) {
  const me = viewerOf(ctx)
  const hidden = JSON.stringify(await hiddenDocIds(ctx))
  const rows = await ctx.db.query<{
    slug: string
    title: string
    updated_at: number
    by_name: string | null
    owner_id: string | null
    open_comments: number
    commented: number
    named: number
  }>(
    `SELECT d.slug, d.title, d.updated_at, d.owner_id,
            (SELECT a.name FROM doc_version v JOIN actor a ON a.id = v.actor_id
              WHERE v.document_id = d.id ORDER BY v.rev DESC LIMIT 1) AS by_name,
            (SELECT COUNT(*) FROM doc_comment c WHERE c.document_id = d.id AND c.resolved_at IS NULL) AS open_comments,
            EXISTS (SELECT 1 FROM doc_comment c WHERE c.document_id = d.id AND c.actor_id = ?) AS commented,
            EXISTS (SELECT 1 FROM notification n WHERE n.actor_id = ? AND n.doc_slug = d.slug AND n.reason = 'mention') AS named
       FROM document d
      WHERE d.workspace_id = ? AND d.archived = 0 AND d.updated_at > ?
        AND d.id NOT IN (SELECT value FROM json_each(?))
        AND (SELECT v.actor_id FROM doc_version v WHERE v.document_id = d.id ORDER BY v.rev DESC LIMIT 1) != ?
      ORDER BY d.updated_at DESC LIMIT 50`,
    [me, me, ctx.workspaceId, now() - 14 * DAY, hidden, me],
  )
  return {
    docs: rows
      .filter((r) => r.owner_id === me || r.commented || r.named)
      .slice(0, limit)
      .map((r) => ({
        slug: r.slug,
        title: r.title,
        updated: r.updated_at,
        by: r.by_name ?? undefined,
        why: r.owner_id === me ? 'owner' : r.named ? 'named' : 'commented',
        open_comments: r.owner_id === me ? r.open_comments : undefined,
      })),
  }
}

// --------------------------------------------------------------------------
// The layout each person chooses for Home
// --------------------------------------------------------------------------

export const zHomeLayout = z.object({
  version: z.literal(1),
  /** In order. A panel left out is one this build added since: it is shown. */
  panels: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        hidden: z.boolean().optional(),
        wide: z.boolean().optional(),
      }),
    )
    .max(32),
})
export type THomeLayout = z.infer<typeof zHomeLayout>

export async function homeLayoutGet(ctx: ICtx): Promise<THomeLayout | null> {
  const row = (
    await ctx.db.query<{ home_layout: string | null }>(
      'SELECT home_layout FROM actor WHERE id = ?',
      [ctx.actor.id],
    )
  )[0]
  if (!row?.home_layout) return null
  const parsed = zHomeLayout.safeParse(
    (() => {
      try {
        return JSON.parse(row.home_layout)
      } catch {
        return null
      }
    })(),
  )
  return parsed.success ? parsed.data : null
}

export async function homeLayoutSet(
  ctx: ICtx,
  body: unknown,
): Promise<THomeLayout> {
  const parsed = zHomeLayout.safeParse(body)
  if (!parsed.success) throw new ApiError(400, 'bad home layout')
  await ctx.db.run('UPDATE actor SET home_layout = ? WHERE id = ?', [
    JSON.stringify(parsed.data),
    ctx.actor.id,
  ])
  return parsed.data
}

export async function homeLayoutReset(ctx: ICtx): Promise<void> {
  await ctx.db.run('UPDATE actor SET home_layout = NULL WHERE id = ?', [
    ctx.actor.id,
  ])
}
