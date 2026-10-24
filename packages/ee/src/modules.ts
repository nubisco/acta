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
 * At most one module may supply getLimits. The edition refuses to start with
 * two, rather than let the order of this list decide a customer's plan.
 */

import type { Hono } from 'hono'
import type { IAppEnv } from '../../../server/src/app'
import type {
  IEditionDeps,
  TPlanLimits,
} from '../../../server/src/core/edition'
import type { ISqlDriver } from '../../../server/src/db'

export interface IEeModule {
  /** For logs and for the duplicate check. */
  name: string
  mountRoutes?(app: Hono<IAppEnv>, deps: IEditionDeps): void
  getLimits?(db: ISqlDriver, workspaceId: string): Promise<TPlanLimits>
}

export const EE_MODULES: IEeModule[] = []
