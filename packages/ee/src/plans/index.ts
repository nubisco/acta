// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * Plans and billing (LA-399), as one EE module.
 *
 * - Limits per workspace from the entitlement licenses keeps (store.ts,
 *   limits.ts), enforced through the core's assertWithinLimit.
 * - The 11th Team member onwards is bought, billed at the next renewal.
 * - After a downgrade, what is over the caps becomes read-only. Nothing is
 *   deleted.
 * - The billing routes and the entitlement webhook (routes.ts).
 * - Free versus paid for the inactivity job, and the history window.
 *
 * Off until ACTA_LICENSES_URL and ACTA_LICENSES_SERVICE_TOKEN are set: then
 * every workspace is unlimited and the SPA shows no billing.
 */

import type { IEeModule } from '../modules'
import { configFromEnv, configurePlans, plansConfig } from './config'
import {
  historyDays,
  isFreePlan,
  planLimits,
  raiseLimit,
  writeBlock,
} from './limits'
import { mountBillingRoutes, mountEntitlementWebhook } from './routes'

export const plansModule: IEeModule = {
  name: 'plans',
  get features() {
    return plansConfig() ? ['plans'] : []
  },
  mountRoutes: (app, deps) => {
    configurePlans(configFromEnv(deps.env))
    mountEntitlementWebhook(app, deps)
  },
  mountWorkspaceRoutes: (app) => mountBillingRoutes(app),
  getLimits: planLimits,
  isFreePlan,
  raiseLimit,
  writeBlock,
  historyDays,
}
