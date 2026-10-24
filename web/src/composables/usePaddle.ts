/**
 * Paddle.js for the hosted checkout (LA-399, Enterprise Edition).
 *
 * The browser never chooses what is bought: the server asks licenses for a
 * transaction tied to this workspace and hands back its id, and Paddle.js
 * only opens it. The script loads on first use, from Paddle's CDN, so no
 * other page and no self-hosted instance ever fetches it.
 */

interface IPaddle {
  Environment: { set: (env: 'sandbox' | 'production') => void }
  Initialize: (opts: {
    token: string
    eventCallback?: (event: { name?: string }) => void
  }) => void
  Checkout: {
    open: (opts: {
      transactionId: string
      settings?: Record<string, unknown>
    }) => void
  }
}

const SCRIPT = 'https://cdn.paddle.com/paddle/v2/paddle.js'

let loading: Promise<IPaddle> | null = null
let initialisedWith: string | null = null
let onEvent: ((name: string) => void) | null = null

function paddle(): IPaddle | undefined {
  return (window as unknown as { Paddle?: IPaddle }).Paddle
}

function load(): Promise<IPaddle> {
  const ready = paddle()
  if (ready) return Promise.resolve(ready)
  loading ??= new Promise<IPaddle>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT
    script.async = true
    script.addEventListener('load', () => {
      const p = paddle()
      if (p) resolve(p)
      else reject(new Error('Paddle did not load'))
    })
    script.addEventListener('error', () => {
      loading = null
      reject(new Error('Paddle could not be loaded'))
    })
    document.head.appendChild(script)
  })
  return loading
}

/**
 * Opens Paddle's checkout for a server-made transaction. `events` hears
 * Paddle's checkout events by name (checkout.completed, checkout.closed).
 */
export async function openCheckout(
  transactionId: string,
  cfg: { env: 'production' | 'sandbox'; client_token: string | null },
  events: (name: string) => void,
): Promise<void> {
  if (!cfg.client_token)
    throw new Error('Checkout is not set up on this instance.')
  const p = await load()
  onEvent = events
  if (initialisedWith !== cfg.client_token) {
    p.Environment.set(cfg.env)
    p.Initialize({
      token: cfg.client_token,
      eventCallback: (e) => {
        if (e?.name) onEvent?.(e.name)
      },
    })
    initialisedWith = cfg.client_token
  }
  p.Checkout.open({ transactionId, settings: { displayMode: 'overlay' } })
}
