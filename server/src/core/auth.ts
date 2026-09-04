import { newId } from '@nubisco/acta-shared'
import type { ISqlDriver } from '../db'
import type { IActorCtx } from './ctx'
import { now } from './ctx'

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface IAuthedActor extends IActorCtx {
  tokenKind: 'session' | 'agent'
}

/** Resolve a bearer/cookie token to an actor, or null. */
export async function resolveToken(
  db: ISqlDriver,
  token: string,
): Promise<IAuthedActor | null> {
  const hash = await sha256Hex(token)
  const rows = await db.query<{
    kind: 'session' | 'agent'
    scopes: string
    expires_at: number | null
    revoked_at: number | null
    actor_id: string
    actor_kind: 'human' | 'agent' | 'system'
    handle: string
    role: 'admin' | 'member'
    on_behalf_of: string | null
    disabled: number
  }>(
    `SELECT t.kind, t.scopes, t.expires_at, t.revoked_at,
            a.id AS actor_id, a.kind AS actor_kind, a.handle, a.role, a.on_behalf_of, a.disabled
       FROM auth_token t JOIN actor a ON a.id = t.actor_id
      WHERE t.token_hash = ?`,
    [hash],
  )
  if (rows.length === 0) return null
  const r = rows[0]
  if (r.revoked_at !== null || r.disabled === 1) return null
  if (r.expires_at !== null && r.expires_at < now()) return null
  return {
    id: r.actor_id,
    kind: r.actor_kind,
    handle: r.handle,
    role: r.role,
    onBehalfOf: r.on_behalf_of ?? undefined,
    scopes: r.scopes.split(','),
    tokenKind: r.kind,
  }
}

export async function createToken(
  db: ISqlDriver,
  workspaceId: string,
  actorId: string,
  kind: 'session' | 'agent',
  scopes: string[],
  ttlMs?: number,
): Promise<string> {
  const token = randomToken()
  await db.run(
    `INSERT INTO auth_token (id, workspace_id, actor_id, kind, token_hash, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('act'),
      workspaceId,
      actorId,
      kind,
      await sha256Hex(token),
      scopes.join(','),
      ttlMs ? now() + ttlMs : null,
      now(),
    ],
  )
  return token
}

/** Six-digit OTP; delivery is pluggable (console by default, mvp F6). */
export type TOtpSender = (email: string, code: string) => Promise<void> | void

export const consoleOtpSender: TOtpSender = (email, code) => {
  console.log(`[acta] OTP for ${email}: ${code}`)
}
