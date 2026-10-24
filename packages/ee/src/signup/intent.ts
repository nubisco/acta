// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * A signup in progress: someone the identity provider vouched for a moment
 * ago, who belongs to no workspace, on their way to create one.
 *
 * The browser holds a random token in an httpOnly cookie. The database holds
 * its hash and what the provider said about the person, for half an hour. So
 * the signup page never takes an email from the browser: the address the new
 * workspace is created for is the one the provider proved.
 */

import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { randomToken, sha256Hex } from '../../../../server/src/core/auth'
import { now } from '../../../../server/src/core/ctx'
import type { IVouchedIdentity } from '../../../../server/src/core/edition'
import type { ISqlDriver } from '../../../../server/src/db'

export const SIGNUP_COOKIE = 'acta_signup'
export const INTENT_TTL_MS = 30 * 60 * 1000

export interface IPendingSignup {
  email: string
  name: string | null
  platformUserId: string | null
  picture: string | null
}

/** Record a vouched-for person and hand their browser the token. */
export async function startIntent(
  c: Context,
  db: ISqlDriver,
  identity: IVouchedIdentity,
  at = now(),
): Promise<void> {
  // Expired intents go whenever a new one starts, so the table never holds
  // more than half an hour of signups.
  await db.run('DELETE FROM signup_intent WHERE expires_at < ?', [at])
  const token = randomToken()
  await db.run(
    `INSERT INTO signup_intent (token_hash, email, name, platform_user_id, picture,
                                created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      await sha256Hex(token),
      identity.email,
      identity.name ?? null,
      identity.sub,
      identity.picture ?? null,
      at,
      at + INTENT_TTL_MS,
    ],
  )
  setCookie(c, SIGNUP_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: INTENT_TTL_MS / 1000,
  })
}

/** The signup this browser is in the middle of, or null. */
export async function pendingSignup(
  c: Context,
  db: ISqlDriver,
  at = now(),
): Promise<(IPendingSignup & { tokenHash: string }) | null> {
  const token = getCookie(c, SIGNUP_COOKIE)
  if (!token) return null
  const hash = await sha256Hex(token)
  const row = (
    await db.query<{
      email: string
      name: string | null
      platform_user_id: string | null
      picture: string | null
      expires_at: number
    }>(
      `SELECT email, name, platform_user_id, picture, expires_at
         FROM signup_intent WHERE token_hash = ?`,
      [hash],
    )
  )[0]
  if (!row || row.expires_at < at) return null
  return {
    tokenHash: hash,
    email: row.email,
    name: row.name,
    platformUserId: row.platform_user_id,
    picture: row.picture,
  }
}

/** Used once: the workspace exists, so the intent and its cookie go. */
export async function finishIntent(
  c: Context,
  db: ISqlDriver,
  tokenHash: string,
): Promise<void> {
  await db.run('DELETE FROM signup_intent WHERE token_hash = ?', [tokenHash])
  deleteCookie(c, SIGNUP_COOKIE, { path: '/' })
}
