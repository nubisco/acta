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
 */

import type { Hono } from 'hono'
import type { IAppEnv } from '../app'
import type { ISqlDriver } from '../db'
import { ApiError, type ICtx } from './ctx'

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
}

export interface IEdition {
  /** Reported by /healthz, so the client and a reader can tell which runs. */
  name: string
  getLimits(db: ISqlDriver, workspaceId: string): Promise<TPlanLimits>
  mountRoutes?(app: Hono<IAppEnv>, deps: IEditionDeps): void
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

/**
 * 402 when a plan caps this resource. The message is a sentence a person, or
 * a model reading an MCP result, can act on. `current` carries the detail.
 */
export class PlanLimitError extends ApiError {
  constructor(resource: TLimitedResource, limit: number, current: number) {
    super(
      402,
      `This workspace's plan allows ${limit} ${resource.replace('_', ' ')}, and it has ${current}. Upgrade the plan to add more.`,
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
  ctx: ICtx,
  resource: TLimitedResource,
  current: number,
  adding = 1,
): Promise<void> {
  const limit = (await getLimits(ctx.db, ctx.workspaceId))[resource]
  if (limit !== null && current + adding > limit) {
    throw new PlanLimitError(resource, limit, current)
  }
}
