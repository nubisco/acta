// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * The Workers entry point of Nubisco's hosted deployment (server/wrangler.toml
 * `main`). It registers the Enterprise Edition, then serves the core worker
 * unchanged. The core builds and runs without this file: self-hosted builds
 * start from server/src/worker.ts or server/src/index.ts, register nothing,
 * and get the core edition.
 *
 * Registration happens when this module loads, which is before the first
 * request builds the app, because the core worker builds it lazily.
 */

import { registerEnterpriseEdition } from './index'

registerEnterpriseEdition()

export { default, LiveHub } from '../../../server/src/worker'
