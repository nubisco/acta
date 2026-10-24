// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * Signup and provisioning (LA-398), as one EE module.
 *
 * - A vouched-for sign-in with no workspace is sent to /signup instead of
 *   being refused (intent.ts).
 * - /api/v1/auth/signup/* creates the workspace, one per account (routes.ts).
 * - The cron tick runs the Free inactivity ladder (inactivity.ts).
 */

import type { IEeModule } from '../modules'
import { inactivitySweep } from './inactivity'
import { startIntent } from './intent'
import { mountSignupRoutes } from './routes'

export const signupModule: IEeModule = {
  name: 'signup',
  features: ['signup'],
  mountRoutes: mountSignupRoutes,
  onUnknownSignIn: async (c, identity, deps) => {
    await startIntent(c, deps.db, identity)
    console.log(
      'signup: a vouched-for person with no workspace was sent to /signup',
    )
    return c.redirect('/signup', 302)
  },
  scheduled: async (deps) => {
    await inactivitySweep({
      db: deps.db,
      isFreePlan: deps.isFreePlan,
      send: deps.send,
      baseUrl: deps.baseUrl,
      nowMs: deps.nowMs,
    })
  },
}
