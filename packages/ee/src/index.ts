// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * The Enterprise Edition, built from the modules in modules.ts and handed to
 * the core through its one seam, server/src/core/edition.ts.
 */

import {
  UNLIMITED,
  registerEdition,
  type IEdition,
} from '../../../server/src/core/edition'
import { EE_MODULES, type IEeModule } from './modules'

type TSingleHook =
  'getLimits' | 'isFreePlan' | 'raiseLimit' | 'writeBlock' | 'historyDays'

function onlyOne<K extends TSingleHook>(
  modules: IEeModule[],
  hook: K,
): IEeModule[K] | undefined {
  const supplying = modules.filter((m) => m[hook])
  if (supplying.length > 1) {
    throw new Error(
      `Two EE modules supply ${hook} (${supplying.map((m) => m.name).join(', ')}). Exactly one may.`,
    )
  }
  return supplying[0]?.[hook]
}

export function enterpriseEdition(modules: IEeModule[] = EE_MODULES): IEdition {
  const limits = onlyOne(modules, 'getLimits')
  // Until plans exist (LA-399) every workspace counts as paid, so a job that
  // only touches Free workspaces touches none rather than all of them.
  const isFreePlan = onlyOne(modules, 'isFreePlan') ?? (async () => false)
  return {
    name: 'enterprise',
    // Without a plans module, the EE limits nothing either.
    getLimits: limits ?? (async () => ({ ...UNLIMITED })),
    raiseLimit: onlyOne(modules, 'raiseLimit'),
    writeBlock: onlyOne(modules, 'writeBlock'),
    historyDays: onlyOne(modules, 'historyDays'),
    // Read when asked, not when registered: a module may only know whether
    // it is on once its routes have mounted and read the deployment's config.
    get features() {
      return modules.flatMap((m) => m.features ?? [])
    },
    mountRoutes: (app, deps) => {
      for (const m of modules) m.mountRoutes?.(app, deps)
    },
    mountWorkspaceRoutes: (app, deps) => {
      for (const m of modules) m.mountWorkspaceRoutes?.(app, deps)
    },
    onUnknownSignIn: async (c, identity, deps) => {
      for (const m of modules) {
        const taken = await m.onUnknownSignIn?.(c, identity, deps)
        if (taken) return taken
      }
      return null
    },
    scheduled: async (deps) => {
      // One module failing never stops the next.
      for (const m of modules) {
        try {
          await m.scheduled?.({ ...deps, isFreePlan })
        } catch (err) {
          console.error(`ee ${m.name} tick failed`, err)
        }
      }
    },
  }
}

/** Registers the EE with the core. Entry points call this before serving. */
export function registerEnterpriseEdition(
  modules: IEeModule[] = EE_MODULES,
): void {
  registerEdition(enterpriseEdition(modules))
}
