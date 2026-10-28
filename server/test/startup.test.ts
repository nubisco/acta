/**
 * One bad start must not take the site down.
 *
 * On 2026-10-28 every request to acta.nubisco.io hung with no error and no
 * log. The Workers entrypoint cached its startup promise, a D1 call hung
 * during a Cloudflare incident, and every later request in that isolate
 * waited on it. A failed or timed-out start is now forgotten and retried.
 */
import { describe, expect, it } from 'bun:test'
import { sharedStartup } from '../src/core/startup'

/** The rejection message, or null if the promise resolved. */
function failure(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (err: unknown) => String(err),
  )
}

describe('sharedStartup', () => {
  it('builds once and shares the result', async () => {
    let builds = 0
    const get = sharedStartup(async () => ++builds, 1000)
    expect(await Promise.all([get(), get(), get()])).toEqual([1, 1, 1])
    expect(await get()).toBe(1)
    expect(builds).toBe(1)
  })

  it('retries after a build that rejects', async () => {
    let builds = 0
    const get = sharedStartup(async () => {
      builds++
      if (builds === 1) throw new Error('D1 unavailable')
      return 'app'
    }, 1000)
    expect(await failure(get())).toContain('D1 unavailable')
    expect(await get()).toBe('app')
    expect(builds).toBe(2)
  })

  it('gives up on a build that never settles, then retries', async () => {
    let builds = 0
    const get = sharedStartup(
      () => {
        builds++
        return builds === 1
          ? new Promise<string>(() => {})
          : Promise.resolve('app')
      },
      20,
      'app startup',
    )
    expect(await failure(get())).toContain('app startup timed out after 20 ms')
    expect(await get()).toBe('app')
    expect(builds).toBe(2)
  })

  it('passes the first call arguments to the build', async () => {
    const get = sharedStartup(async (origin: string) => origin, 1000)
    expect(await get('https://a.example')).toBe('https://a.example')
    expect(await get('https://b.example')).toBe('https://a.example')
  })
})
