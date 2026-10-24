// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * Plans and billing (LA-399): where the deployment's settings live.
 *
 * Plans only switch on when the deployment can reach the licenses service
 * (ACTA_LICENSES_URL and ACTA_LICENSES_SERVICE_TOKEN). Without them every
 * workspace is unlimited and no billing UI is offered, so a deployment that
 * has not been set up for billing behaves like the core.
 */

export interface IPlansConfig {
  licensesUrl: string
  serviceToken: string
  /** HMAC key for entitlement.updated. Unset, the webhook route answers 404. */
  webhookSecret: string | null
  paddleEnv: 'production' | 'sandbox'
  /** Paddle.js client-side token. Public by design. */
  paddleClientToken: string | null
  salesUrl: string | null
  /** Server-side analytics (Nubisco Analytics ingestion API), optional. */
  analytics: { url: string; token: string; domain: string } | null
  fetchImpl: typeof fetch
}

let config: IPlansConfig | null = null

export function plansConfig(): IPlansConfig | null {
  return config
}

/** Reads the deployment's variables. Null when billing is not set up. */
export function configFromEnv(
  env: Record<string, string | undefined> = {},
  fetchImpl: typeof fetch = fetch,
): IPlansConfig | null {
  const licensesUrl = env.ACTA_LICENSES_URL?.trim()
  const serviceToken = env.ACTA_LICENSES_SERVICE_TOKEN?.trim()
  if (!licensesUrl || !serviceToken) return null
  const analyticsUrl = env.ACTA_ANALYTICS_API?.trim()
  const analyticsToken = env.ACTA_ANALYTICS_TOKEN?.trim()
  const analyticsDomain = env.ACTA_ANALYTICS_DOMAIN?.trim()
  return {
    licensesUrl: licensesUrl.replace(/\/+$/, ''),
    serviceToken,
    webhookSecret: env.ACTA_ENTITLEMENT_WEBHOOK_SECRET?.trim() || null,
    paddleEnv: env.ACTA_PADDLE_ENV === 'sandbox' ? 'sandbox' : 'production',
    paddleClientToken: env.ACTA_PADDLE_CLIENT_TOKEN?.trim() || null,
    salesUrl: env.ACTA_SALES_URL?.trim() || null,
    analytics:
      analyticsUrl && analyticsToken && analyticsDomain
        ? {
            url: analyticsUrl.replace(/\/+$/, ''),
            token: analyticsToken,
            domain: analyticsDomain,
          }
        : null,
    fetchImpl,
  }
}

/** Set once when the module mounts. Tests set and clear it directly. */
export function configurePlans(next: IPlansConfig | null): void {
  config = next
}
