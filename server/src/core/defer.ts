/**
 * Background-work sink. On Bun the default is fire-and-forget; the Workers
 * entrypoint plugs in executionCtx.waitUntil so webhook deliveries and rule
 * runs survive past the response.
 */

type TDeferrer = (work: Promise<unknown>) => void

let deferrer: TDeferrer = () => {}

export function setDeferrer(fn: TDeferrer): void {
  deferrer = fn
}

export function defer(work: Promise<unknown>): void {
  deferrer(work)
}
