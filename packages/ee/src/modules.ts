// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * The EE module registry: one entry per enterprise feature.
 *
 * Each feature lives in its own module and adds itself to EE_MODULES, so
 * signup and billing can be built side by side without editing each other.
 *
 * - LA-398 (signup and provisioning) adds a module with mountRoutes.
 * - LA-399 (plans and billing) adds a module with mountRoutes and getLimits.
 *
 * At most one module may supply getLimits, and at most one isFreePlan. The
 * edition refuses to start with two, rather than let the order of this list
 * decide a customer's plan.
 */

import type { Context, Hono } from 'hono'
import type { IAppEnv } from '../../../server/src/app'
import type {
  IEditionDeps,
  IEditionTickDeps,
  IVouchedIdentity,
  TPlanLimits,
} from '../../../server/src/core/edition'
import type { ISqlDriver } from '../../../server/src/db'
import { signupModule } from './signup'

/** Whether a workspace is on the Free plan, as the plans module knows it. */
export type TFreePlanCheck = (
  db: ISqlDriver,
  workspaceId: string,
) => Promise<boolean>

/** The cron tick, plus what one module may ask of another. */
export interface IEeTickDeps extends IEditionTickDeps {
  isFreePlan: TFreePlanCheck
}

export interface IEeModule {
  /** For logs and for the duplicate check. */
  name: string
  /** Named capabilities, reported by /auth/config. */
  features?: string[]
  mountRoutes?(app: Hono<IAppEnv>, deps: IEditionDeps): void
  getLimits?(db: ISqlDriver, workspaceId: string): Promise<TPlanLimits>
  /**
   * Whether a workspace is on the Free plan. Supplied by the plans module
   * (LA-399). Until one does, every workspace counts as paid, so nothing that
   * only happens to Free workspaces (the inactivity job) happens to any.
   */
  isFreePlan?: TFreePlanCheck
  onUnknownSignIn?(
    c: Context,
    identity: IVouchedIdentity,
    deps: IEditionDeps,
  ): Promise<Response | null>
  scheduled?(deps: IEeTickDeps): Promise<void>
}

export const EE_MODULES: IEeModule[] = [signupModule]
