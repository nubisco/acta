/**
 * The one seam between the open-source core and the Enterprise Edition
 * (`packages/ee/`, proprietary, see LICENSE).
 *
 * The core never imports the EE. It asks this module, and this module answers
 * with whatever edition was registered, or with the core edition when none
 * was: no limits, no extra routes. That is what every self-hosted build runs,
 * the Bun server and the Docker image included, because neither entry point
 * registers anything.
 *
 * Nubisco's hosted deployment starts from `packages/ee/src/worker.ts`, which
 * registers the EE and then serves the core worker unchanged.
 *
 * Where the EE plugs in:
 * - getLimits: plan limits per workspace (LA-399). Enforced through
 *   assertWithinLimit, which the services call before they create something.
 * - mountRoutes: extra HTTP routes, mounted ahead of the workspace API and
 *   its auth middleware, so each EE route authenticates for itself. Signup and
 *   provisioning (LA-398) and billing (LA-399) arrive here.
 * - onUnknownSignIn: a person the identity provider vouched for who belongs
 *   to no workspace. The core refuses them (not_a_member). Signup instead
 *   sends them on to create one.
 * - scheduled: work for the cron tick (signup's Free inactivity job).
 * - raiseLimit, writeBlock, historyDays: plans (LA-399). A cap the edition can
 *   lift by billing for it, what a downgrade makes read-only, and how long
 *   history is kept.
 * - features: named capabilities the SPA reads from /auth/config, so it shows
 *   signup only where signup exists.
 */

import type { Context, Hono } from 'hono'
import type { IAppEnv } from '../app'
import type { IAuthEnv } from '../routes/auth'
import type { ISqlDriver } from '../db'
import { ApiError, type ICtx } from './ctx'
import type { TEmailSender } from './email'

/** Everything a plan can cap. Bytes are bytes, everything else is a count. */
export type TLimitedResource =
  | 'spaces'
  | 'members'
  | 'agents'
  | 'rules'
  | 'webhooks'
  | 'items'
  | 'storage_bytes'
  | 'file_bytes'

/** One cap per resource. null means no cap. */
export type TPlanLimits = Record<TLimitedResource, number | null>

export const UNLIMITED: Readonly<TPlanLimits> = Object.freeze({
  spaces: null,
  members: null,
  agents: null,
  rules: null,
  webhooks: null,
  items: null,
  storage_bytes: null,
  file_bytes: null,
})

/** What createApp hands an edition when it mounts its routes. */
export interface IEditionDeps {
  db: ISqlDriver
  baseUrl?: string
  /** Sends email, when the instance has a sender. */
  emailSender?: TEmailSender
  /**
   * The deployment's variables (wrangler [vars] and secrets), so an EE
   * feature reads its own settings without the core naming each one.
   */
  env?: Record<string, string | undefined>
}

/** Who the identity provider says just signed in. */
export interface IVouchedIdentity {
  email: string
  name?: string
  /** The provider's own id for this person. */
  sub: string
  /** Already checked to be on the provider's origin, or undefined. */
  picture?: string
}

/** What the cron tick hands an edition. */
export interface IEditionTickDeps {
  db: ISqlDriver
  send?: TEmailSender
  baseUrl?: string
  nowMs?: number
  env?: Record<string, string | undefined>
}

export interface IEdition {
  /** Reported by /healthz, so the client and a reader can tell which runs. */
  name: string
  getLimits(db: ISqlDriver, workspaceId: string): Promise<TPlanLimits>
  mountRoutes?(app: Hono<IAppEnv>, deps: IEditionDeps): void
  /**
   * Routes inside the workspace API, after its auth middleware: the handler
   * reads db, workspaceId and actor from the context like any API route.
   * Mounted on both the /api/v1/w/:workspace and the bare /api/v1 router.
   */
  mountWorkspaceRoutes?(app: Hono<IAuthEnv>, deps: IEditionDeps): void
  /** Named capabilities, reported by /auth/config. */
  features?: string[]
  /**
   * A vouched-for person with no workspace to land in. Answer with a response
   * to take over (signup), or null and the core refuses them as before.
   */
  onUnknownSignIn?(
    c: Context,
    identity: IVouchedIdentity,
    deps: IEditionDeps,
  ): Promise<Response | null>
  /** Runs on the cron tick, after the core's own work. */
  scheduled?(deps: IEditionTickDeps): Promise<void>
  /**
   * Called when a creation would pass a cap, before it is refused. Answer true
   * when the edition raised the cap to `needed` (Acta Team buys one more
   * member, LA-399), so the creation goes ahead. With `dryRun` it only says
   * whether it could, and changes nothing.
   */
  raiseLimit?(
    db: ISqlDriver,
    workspaceId: string,
    resource: TLimitedResource,
    needed: number,
    opts: { dryRun: boolean },
  ): Promise<boolean>
  /**
   * Whether this write may go ahead on a workspace over its plan's caps after
   * a downgrade. Nothing is deleted on a downgrade: what is over the cap
   * becomes read-only instead. Answer the refusal, or null.
   */
  writeBlock?(
    db: ISqlDriver,
    workspaceId: string,
    target: IWriteTarget,
  ): Promise<PlanLimitError | null>
  /** Days of history the workspace keeps. null keeps the core default. */
  historyDays?(db: ISqlDriver, workspaceId: string): Promise<number | null>
}

/** Who is writing, and where, for writeBlock. */
export interface IWriteTarget {
  actorId: string
  actorKind: 'human' | 'agent' | 'system'
  /** The space the write lands in, when it lands in one. */
  spaceId?: string
}

export const CORE_EDITION: IEdition = {
  name: 'core',
  getLimits: async () => ({ ...UNLIMITED }),
}

let edition: IEdition = CORE_EDITION

/** Called once, by an entry point, before the app is built. */
export function registerEdition(next: IEdition): void {
  edition = next
}

export function currentEdition(): IEdition {
  return edition
}

/** Whether the registered edition offers a named capability. */
export function editionHas(feature: string): boolean {
  return edition.features?.includes(feature) ?? false
}

/** For tests: back to the core edition. */
export function resetEdition(): void {
  edition = CORE_EDITION
}

export function getLimits(
  db: ISqlDriver,
  workspaceId: string,
): Promise<TPlanLimits> {
  return edition.getLimits(db, workspaceId)
}

/** The body of a plan-limit refusal, the same on REST and MCP. */
export interface IPlanLimitDetail {
  error: 'plan_limit'
  resource: TLimitedResource
  limit: number
  current: number
}

function describe(resource: TLimitedResource, n: number): string {
  if (resource === 'storage_bytes' || resource === 'file_bytes') {
    const mb = n / (1024 * 1024)
    const size =
      mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.ceil(mb)} MB`
    return resource === 'file_bytes'
      ? `files up to ${size}`
      : `${size} of storage`
  }
  return `${n} ${resource}`
}

/**
 * 402 when a plan caps this resource. The message is a sentence a person, or
 * a model reading an MCP result, can act on. `current` carries the detail.
 */
export class PlanLimitError extends ApiError {
  constructor(resource: TLimitedResource, limit: number, current: number) {
    super(
      402,
      resource === 'file_bytes'
        ? `This workspace's plan allows ${describe(resource, limit)}. Upgrade the plan for larger files.`
        : `This workspace's plan allows ${describe(resource, limit)}, and it has ${describe(resource, current)}. Upgrade the plan to add more.`,
      {
        error: 'plan_limit',
        resource,
        limit,
        current,
      } satisfies IPlanLimitDetail,
    )
  }
}

/**
 * Refuses a creation that would take the workspace past its plan's cap.
 *
 * `current` is the count before the change and `adding` what it adds (bytes
 * for the byte resources). The caller counts, because only it knows what
 * counts: archived spaces do not, for example. Under the core edition this
 * never refuses anything.
 */
export async function assertWithinLimit(
  ctx: Pick<ICtx, 'db' | 'workspaceId'>,
  resource: TLimitedResource,
  current: number,
  adding = 1,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  const limit = (await getLimits(ctx.db, ctx.workspaceId))[resource]
  if (limit === null || current + adding <= limit) return
  const raised = await edition.raiseLimit?.(
    ctx.db,
    ctx.workspaceId,
    resource,
    current + adding,
    { dryRun: opts.dryRun ?? false },
  )
  if (raised) return
  throw new PlanLimitError(resource, limit, current)
}

/**
 * Refuses a write the plan has made read-only: a space or a member over the
 * caps after a downgrade. The core edition never refuses.
 */
export async function assertCanWrite(
  ctx: ICtx,
  spaceId?: string,
): Promise<void> {
  if (!edition.writeBlock) return
  const block = await edition.writeBlock(ctx.db, ctx.workspaceId, {
    actorId: ctx.actor.id,
    actorKind: ctx.actor.kind,
    spaceId,
  })
  if (block) throw block
}
