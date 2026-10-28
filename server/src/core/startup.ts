/**
 * Builds something once and shares it, the way the Workers entrypoint builds
 * its driver and app on the first request and reuses them for the rest.
 *
 * A plain cached promise is shared in failure too. If the build rejects,
 * every later request gets the same rejection, and if it never settles (a
 * database call that hangs during a provider incident), every later request
 * waits on it forever with no error and no log. One bad start then takes the
 * whole site down for as long as the isolate lives.
 *
 * So a build that fails, or outlasts `timeoutMs`, is forgotten, and the next
 * call starts a fresh one. A build that succeeds is kept for good.
 */
export function sharedStartup<A extends unknown[], T>(
  build: (...args: A) => Promise<T>,
  timeoutMs: number,
  label = 'startup',
): (...args: A) => Promise<T> {
  let current: Promise<T> | null = null

  return (...args: A) => {
    if (current) return current
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt: Promise<T> = Promise.race([
      build(...args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
          timeoutMs,
        )
      }),
    ])
      .catch((err: unknown) => {
        // Only forget the attempt that failed, never a newer one.
        if (current === attempt) current = null
        throw err
      })
      .finally(() => clearTimeout(timer))
    current = attempt
    return attempt
  }
}
