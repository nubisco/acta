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

export function enterpriseEdition(modules: IEeModule[] = EE_MODULES): IEdition {
  const limiters = modules.filter((m) => m.getLimits)
  if (limiters.length > 1) {
    throw new Error(
      `Two EE modules supply plan limits (${limiters.map((m) => m.name).join(', ')}). Exactly one may.`,
    )
  }
  const limits = limiters[0]?.getLimits
  return {
    name: 'enterprise',
    // Until plans exist (LA-399), the EE limits nothing either.
    getLimits: limits ?? (async () => ({ ...UNLIMITED })),
    mountRoutes: (app, deps) => {
      for (const m of modules) m.mountRoutes?.(app, deps)
    },
  }
}

/** Registers the EE with the core. Entry points call this before serving. */
export function registerEnterpriseEdition(
  modules: IEeModule[] = EE_MODULES,
): void {
  registerEdition(enterpriseEdition(modules))
}
