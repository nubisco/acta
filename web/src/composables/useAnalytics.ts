/**
 * Thin wrapper around the Nubisco Analytics tracker script (window.nba.*),
 * the same shape as Verba's (apps/web/src/composables/useAnalytics.ts).
 *
 * Unlike Verba, the address comes from the server (/auth/config, set by
 * ACTA_ANALYTICS_URL) rather than from the build: one image serves the hosted
 * service and every self-hosted instance, and only the hosted one names a
 * tracker. With none named, nothing loads and every call here is a no-op.
 *
 * Identity is never sent: no email, no name. Events carry only what the
 * funnel needs.
 */

const APP_ID = 'acta'

interface INba {
  track: (name: string, props?: Record<string, unknown>) => void
}

/** The tracker puts itself on window once its script has loaded. */
function tracker(): INba | undefined {
  return (window as unknown as { nba?: INba }).nba
}

let initialized = false

export async function initAnalytics(base: string | undefined): Promise<void> {
  if (initialized || !base || !import.meta.env.PROD) return
  initialized = true
  await new Promise<void>((resolve) => {
    const script = document.createElement('script')
    script.src = `${base.replace(/\/$/, '')}/script.js`
    script.defer = true
    script.dataset.app = APP_ID
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => resolve(), { once: true })
    document.head.appendChild(script)
  })
}

/**
 * The signup funnel: Signup Started, Signup Completed, Workspace Created,
 * First Space, First Invite.
 */
export function trackEvent(
  name: string,
  props?: Record<string, unknown>,
): void {
  tracker()?.track(name, props)
}
