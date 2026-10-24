/**
 * Invitations: the only way a person joins a workspace.
 *
 * An admin used to add a member by typing an email address, which created an
 * actor on the spot. Nobody confirmed the address, and the moment that actor
 * was mentioned or assigned, mail went out from our domain to whatever had
 * been typed. On a shared instance that is a spam relay with a kanban board in
 * front of it (LA-397).
 *
 * Now an admin invites, and the person accepts. Acceptance proves the address
 * is theirs in one of two ways:
 *
 *  - With an identity provider, they sign in through it, and the provider's
 *    email claim must be the invited address.
 *  - With one-time codes, the link itself is the proof: it was only ever sent
 *    to that address. That is the same proof a code is.
 *
 * Until then there is no actor, so there is nobody to mention, assign or email.
 * The invitation email is the one message an unconfirmed address ever gets,
 * and it is capped per workspace per day.
 */

import { newId } from '@nubisco/acta-shared'
import { z } from 'zod'
import { randomToken, sha256Hex } from '../core/auth'
import { ApiError, now, type ICtx } from '../core/ctx'
import { invitationEmail, type TEmailSender } from '../core/email'
import {
  emailQuotaLeft,
  INVITE_EMAILS_PER_DAY,
  takeEmailQuota,
} from '../core/emailQuota'
import { emitEvent, flushPendingEvents } from '../core/events'
import type { ISqlDriver } from '../db'

/** How long a link works. Long enough for a holiday, short enough to forget. */
export const INVITE_TTL_DAYS = 7
const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000

/** Pending invitations one workspace may hold at once. */
export const MAX_PENDING_INVITES = 100

export const zInvitationCreate = z.object({
  email: z.email().max(254),
  handle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  name: z.string().min(1).max(120),
  role: z.enum(['admin', 'member']).default('member'),
})
export type TInvitationCreate = z.infer<typeof zInvitationCreate>

export interface IInviteDelivery {
  /** Unset on an instance with no email configured. */
  send?: TEmailSender
  /** Acta's public address, for the link. */
  baseUrl?: string
}

export type TInvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked'

interface IInvitationRow {
  id: string
  workspace_id: string
  email: string
  handle: string
  name: string
  role: 'admin' | 'member'
  invited_by: string
  emailed: number
  expires_at: number
  accepted_at: number | null
  revoked_at: number | null
  created_at: number
}

function statusOf(row: IInvitationRow, ts: number): TInvitationStatus {
  if (row.accepted_at !== null) return 'accepted'
  if (row.revoked_at !== null) return 'revoked'
  if (row.expires_at <= ts) return 'expired'
  return 'pending'
}

function handleFrom(email: string): string {
  const base = email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')
  return base.length >= 2 ? base.slice(0, 40) : `member-${base}`.slice(0, 40)
}

/** The absolute accept link, or null when the instance does not know its address. */
function acceptUrl(baseUrl: string | undefined, token: string): string | null {
  const base = (baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/]/i.test(base)) return null
  return `${base}/invite/${token}`
}

/**
 * Invite someone. Admin only.
 *
 * Returns the invitation. The link itself comes back only on an instance
 * that sends no email, so its admin can pass it on by hand. Wherever email is
 * configured the link is withheld: handing it to the admin would let them
 * accept as somebody else on an instance where the link is the proof, and
 * turn that address into a confirmed one that digests are then sent to.
 */
export async function createInvitation(
  ctx: ICtx,
  body: TInvitationCreate,
  delivery: IInviteDelivery,
): Promise<{
  invitation: ReturnType<typeof present>
  emailed: boolean
  accept_url?: string
}> {
  const db = ctx.db
  const ts = now()
  const email = body.email.trim()

  const member = await db.query(
    'SELECT id FROM actor WHERE workspace_id = ? AND lower(email) = lower(?)',
    [ctx.workspaceId, email],
  )
  if (member.length > 0)
    throw new ApiError(409, 'that person is already a member of this workspace')

  const handle = body.handle ?? handleFrom(email)
  const handleTaken = await db.query(
    'SELECT id FROM actor WHERE workspace_id = ? AND handle = ?',
    [ctx.workspaceId, handle],
  )
  if (handleTaken.length > 0)
    throw new ApiError(409, `the handle @${handle} is taken in this workspace`)

  const token = `acta_inv_${randomToken(24)}`
  const pending = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM invitation
      WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at > ?`,
    [ctx.workspaceId, ts],
  )
  if ((pending[0]?.n ?? 0) >= MAX_PENDING_INVITES)
    throw new ApiError(
      429,
      `this workspace already has ${MAX_PENDING_INVITES} open invitations; revoke some first`,
    )

  // The daily cap is taken before anything is written, so a refused
  // invitation leaves nothing behind. Only on an instance that sends email:
  // without it the admin is the delivery and there is nothing to cap.
  const link = acceptUrl(delivery.baseUrl, token)
  if (delivery.send && link) {
    const room = await takeEmailQuota(
      db,
      ctx.workspaceId,
      'invite',
      INVITE_EMAILS_PER_DAY,
      ts,
    )
    if (!room)
      throw new ApiError(
        429,
        `this workspace has sent its ${INVITE_EMAILS_PER_DAY} invitations for today; try again tomorrow`,
      )
  }

  // A second invitation to the same address replaces the first, so there is
  // only ever one live link per person per workspace.
  await db.run(
    `UPDATE invitation SET revoked_at = ?
      WHERE workspace_id = ? AND lower(email) = lower(?)
        AND accepted_at IS NULL AND revoked_at IS NULL`,
    [ts, ctx.workspaceId, email],
  )

  const id = newId('inv')
  await db.run(
    `INSERT INTO invitation
       (id, workspace_id, email, handle, name, role, token_hash, invited_by,
        emailed, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      ctx.workspaceId,
      email,
      handle,
      body.name,
      body.role,
      await sha256Hex(token),
      ctx.actor.id,
      ts + INVITE_TTL_MS,
      ts,
    ],
  )

  let emailed = false
  if (delivery.send && link) {
    const meta = (
      await db.query<{ workspace: string; inviter: string }>(
        `SELECT w.name AS workspace, a.name AS inviter
           FROM workspace w JOIN actor a ON a.id = ?
          WHERE w.id = ?`,
        [ctx.actor.id, ctx.workspaceId],
      )
    )[0]
    try {
      await delivery.send({
        to: email,
        ...invitationEmail({
          workspace: meta?.workspace ?? 'Acta',
          inviter: meta?.inviter ?? 'An administrator',
          acceptUrl: link,
          expiresInDays: INVITE_TTL_DAYS,
        }),
      })
      emailed = true
      await db.run('UPDATE invitation SET emailed = 1 WHERE id = ?', [id])
    } catch (err) {
      // The invitation stands and can be sent again by inviting again. The
      // link is still not handed to the admin: see the doc comment above.
      console.error('invitation email failed:', (err as Error).message)
    }
  }

  await emitEvent(
    ctx,
    'member.invited',
    'invitation',
    id,
    `invited @${handle} as ${body.role}`,
  )
  flushPendingEvents()

  const row = await invitationById(db, ctx.workspaceId, id)
  return {
    invitation: present(row!, ts),
    emailed,
    // Without email the admin is the delivery, so they get the link. On an
    // instance that sends email they never do, for the reason in the doc
    // comment above, even when this particular send failed.
    ...(delivery.send ? {} : { accept_url: link ?? `/invite/${token}` }),
  }
}

async function invitationById(
  db: ISqlDriver,
  workspaceId: string,
  id: string,
): Promise<IInvitationRow | null> {
  const rows = await db.query<IInvitationRow>(
    `SELECT id, workspace_id, email, handle, name, role, invited_by, emailed,
            expires_at, accepted_at, revoked_at, created_at
       FROM invitation WHERE workspace_id = ? AND id = ?`,
    [workspaceId, id],
  )
  return rows[0] ?? null
}

function present(row: IInvitationRow, ts: number) {
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    name: row.name,
    role: row.role,
    status: statusOf(row, ts),
    emailed: row.emailed === 1,
    expires_at: row.expires_at,
    created_at: row.created_at,
  }
}

/** Open invitations, newest first, plus how many emails are left today. Admin only. */
export async function listInvitations(ctx: ICtx) {
  const ts = now()
  const rows = await ctx.db.query<IInvitationRow>(
    `SELECT id, workspace_id, email, handle, name, role, invited_by, emailed,
            expires_at, accepted_at, revoked_at, created_at
       FROM invitation
      WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 200`,
    [ctx.workspaceId],
  )
  return {
    invitations: rows.map((r) => present(r, ts)),
    emails_left_today: await emailQuotaLeft(
      ctx.db,
      ctx.workspaceId,
      'invite',
      INVITE_EMAILS_PER_DAY,
      ts,
    ),
  }
}

/** Revoke an open invitation. Admin only. The link stops working at once. */
export async function revokeInvitation(ctx: ICtx, id: string): Promise<void> {
  const row = await invitationById(ctx.db, ctx.workspaceId, id)
  if (!row) throw new ApiError(404, 'invitation not found')
  if (row.accepted_at !== null)
    throw new ApiError(409, 'that invitation was already accepted')
  if (row.revoked_at !== null) return
  await ctx.db.run('UPDATE invitation SET revoked_at = ? WHERE id = ?', [
    now(),
    id,
  ])
  await emitEvent(
    ctx,
    'member.invite_revoked',
    'invitation',
    id,
    `revoked the invitation for @${row.handle}`,
  )
  flushPendingEvents()
}

interface IPublicInvitation {
  row: IInvitationRow
  workspace: { id: string; name: string; slug: string }
  inviter: string
  status: TInvitationStatus
}

/** An invitation by the secret in its link, with what the accept page shows. */
export async function invitationByToken(
  db: ISqlDriver,
  token: string,
): Promise<IPublicInvitation | null> {
  if (!token || token.length > 200) return null
  const rows = await db.query<
    IInvitationRow & { ws_name: string; ws_slug: string; inviter: string }
  >(
    `SELECT i.id, i.workspace_id, i.email, i.handle, i.name, i.role,
            i.invited_by, i.emailed, i.expires_at, i.accepted_at, i.revoked_at,
            i.created_at, w.name AS ws_name, w.slug AS ws_slug,
            a.name AS inviter
       FROM invitation i
       JOIN workspace w ON w.id = i.workspace_id
       JOIN actor a ON a.id = i.invited_by
      WHERE i.token_hash = ?`,
    [await sha256Hex(token)],
  )
  const row = rows[0]
  if (!row) return null
  return {
    row,
    workspace: { id: row.workspace_id, name: row.ws_name, slug: row.ws_slug },
    inviter: row.inviter,
    status: statusOf(row, now()),
  }
}

/** What the accept page may show to anyone holding the link. */
export function publicView(inv: IPublicInvitation) {
  return {
    workspace: inv.workspace.name,
    inviter: inv.inviter,
    email: inv.row.email,
    role: inv.row.role,
    status: inv.status,
    expires_at: inv.row.expires_at,
  }
}

export type TAcceptResult =
  | {
      ok: true
      actorId: string
      role: 'admin' | 'member'
      workspace: { id: string; slug: string }
    }
  | {
      ok: false
      reason: 'invalid' | 'expired' | 'revoked' | 'accepted' | 'email_mismatch'
    }

/**
 * Turn an invitation into a member.
 *
 * `provenEmail` is the address the person has just proved they own: the
 * provider's email claim, or, with one-time codes, the invited address itself
 * (the link was the proof). It must be the invited address. Otherwise anyone
 * handed a forwarded link could join as somebody else.
 *
 * Idempotent for the person it was meant for: accepting twice, or accepting
 * when an actor with that address already exists (an admin re-enabled them),
 * lands on the same actor rather than creating a second.
 */
export async function acceptInvitation(
  db: ISqlDriver,
  token: string,
  provenEmail: string,
): Promise<TAcceptResult> {
  const inv = await invitationByToken(db, token)
  if (!inv) return { ok: false, reason: 'invalid' }
  if (inv.status === 'revoked') return { ok: false, reason: 'revoked' }
  if (inv.status === 'expired') return { ok: false, reason: 'expired' }
  if (inv.row.email.toLowerCase() !== provenEmail.trim().toLowerCase())
    return { ok: false, reason: 'email_mismatch' }

  const workspaceId = inv.workspace.id
  const ts = now()
  const existing = (
    await db.query<{ id: string; role: 'admin' | 'member'; disabled: number }>(
      `SELECT id, role, disabled FROM actor
        WHERE workspace_id = ? AND lower(email) = lower(?) AND kind = 'human'`,
      [workspaceId, inv.row.email],
    )
  )[0]

  if (inv.status === 'accepted') {
    // The same person following their own link again. Anyone else has been
    // refused by the email check above.
    if (existing && existing.disabled === 0)
      return {
        ok: true,
        actorId: existing.id,
        role: existing.role,
        workspace: inv.workspace,
      }
    return { ok: false, reason: 'accepted' }
  }

  let actorId: string
  let role: 'admin' | 'member'
  if (existing) {
    // A disabled member stays disabled: an invitation is not a way around an
    // admin's decision to remove someone.
    if (existing.disabled === 1) return { ok: false, reason: 'revoked' }
    actorId = existing.id
    role = existing.role
  } else {
    actorId = newId('act')
    role = inv.row.role
    const clash = await db.query(
      'SELECT id FROM actor WHERE workspace_id = ? AND handle = ?',
      [workspaceId, inv.row.handle],
    )
    const handle =
      clash.length > 0
        ? `${inv.row.handle}-${actorId.slice(-4)}`
        : inv.row.handle
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role,
                          email_confirmed_at, created_at)
       VALUES (?, ?, 'human', ?, ?, ?, ?, ?, ?)`,
      [actorId, workspaceId, handle, inv.row.name, inv.row.email, role, ts, ts],
    )
    const system = (
      await db.query<{ id: string; handle: string }>(
        "SELECT id, handle FROM actor WHERE workspace_id = ? AND kind = 'system' LIMIT 1",
        [workspaceId],
      )
    )[0]
    if (system) {
      await emitEvent(
        {
          db,
          workspaceId,
          actor: {
            id: system.id,
            kind: 'system',
            handle: system.handle,
            role: 'member',
            scopes: ['write'],
          },
        },
        'member.added',
        'actor',
        actorId,
        `@${handle} accepted an invitation and joined`,
      )
      flushPendingEvents()
    }
  }

  await db.run(
    `UPDATE actor SET email_confirmed_at = COALESCE(email_confirmed_at, ?)
      WHERE id = ?`,
    [ts, actorId],
  )
  await db.run(
    'UPDATE invitation SET accepted_at = ?, accepted_actor_id = ? WHERE id = ?',
    [ts, actorId, inv.row.id],
  )
  return { ok: true, actorId, role, workspace: inv.workspace }
}
