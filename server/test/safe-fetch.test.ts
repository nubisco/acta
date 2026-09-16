/**
 * The SSRF guard in front of link previews.
 *
 * This is the part of the feature that can hurt somebody. The URL comes from
 * a document, the fetch is made by the server from inside the network, and
 * the valuable targets (cloud metadata, an unauthenticated admin port on
 * loopback, the database on 10/8) are all reachable from there and from
 * nowhere else. Every case below is an attack somebody has actually used.
 *
 * Nothing here touches the network: the resolver and `fetch` are both
 * injected, so a test that says "this address is refused" is testing the
 * decision rather than whether the machine happens to be offline.
 */
import { describe, expect, it } from 'bun:test'
import {
  assertPublicUrl,
  isBlockedAddress,
  isBlockedHostname,
  MAX_BYTES,
  MAX_REDIRECTS,
  safeFetch,
  UrlRefused,
  type IFetchDeps,
} from '../src/core/safeFetch'

/** A resolver that answers with whatever the test says, and nothing else. */
function resolver(map: Record<string, string[]>): IFetchDeps['resolve'] {
  return (hostname) => Promise.resolve(map[hostname] ?? [])
}

const publicDeps = (fetchImpl?: typeof fetch): IFetchDeps => ({
  // Bun's `fetch` type carries a `preconnect` property, which a plain
  // function does not, so the refusing default is cast rather than widened.
  fetch:
    fetchImpl ??
    ((() =>
      Promise.reject(
        new Error('no fetch in this test'),
      )) as unknown as typeof fetch),
  resolve: resolver({
    'example.com': ['93.184.216.34'],
    'evil.test': ['127.0.0.1'],
    'split.test': ['93.184.216.34', '10.0.0.5'],
    'six.test': ['2606:2800:220:1:248:1893:25c8:1946'],
    'rebind.test': ['::1'],
  }),
})

/**
 * The message safeFetch failed with, or 'resolved'.
 *
 * Written out rather than using `expect().rejects`, whose bun:test typing is
 * void and so cannot be awaited.
 */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'resolved'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

async function refusal(url: string, deps = publicDeps()): Promise<string> {
  try {
    await assertPublicUrl(url, deps)
  } catch (err) {
    if (err instanceof UrlRefused) return err.reason
    return `threw ${String(err)}`
  }
  return 'allowed'
}

describe('address ranges', () => {
  it('blocks every private and special-use IPv4 range', () => {
    const blocked = [
      '127.0.0.1', // loopback
      '127.1.2.3',
      '0.0.0.0', // routed to localhost by several stacks
      '10.0.0.1', // private
      '10.255.255.255',
      '172.16.0.1', // private
      '172.31.255.254',
      '192.168.1.1', // private
      '169.254.169.254', // AWS/GCP/Azure metadata, the classic target
      '169.254.170.2', // ECS task metadata
      '100.64.0.1', // carrier-grade NAT
      '192.0.0.1',
      '198.18.0.1',
      '224.0.0.1', // multicast
      '255.255.255.255',
    ]
    for (const address of blocked)
      expect(isBlockedAddress(address), address).toBe(true)
  })

  it('allows ordinary public addresses', () => {
    const allowed = [
      '93.184.216.34',
      '8.8.8.8',
      '1.1.1.1',
      '172.15.255.255', // just below 172.16/12
      '172.32.0.1', // just above it
      '9.255.255.255',
      '11.0.0.1',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]
    for (const address of allowed)
      expect(isBlockedAddress(address), address).toBe(false)
  })

  it('blocks the IPv6 private and loopback ranges', () => {
    const blocked = [
      '::1', // loopback
      '::', // unspecified
      'fc00::1', // unique local
      'fd12:3456::1',
      'fe80::1', // link-local
      'ff02::1', // multicast
      '2001:db8::1', // documentation
    ]
    for (const address of blocked)
      expect(isBlockedAddress(address), address).toBe(true)
  })

  it('sees through the IPv6 spellings of an IPv4 address', () => {
    // A dual-stack host reaches loopback through every one of these.
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true)
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true)
    expect(isBlockedAddress('64:ff9b::7f00:1')).toBe(true) // NAT64
    expect(isBlockedAddress('2002:7f00:1::')).toBe(true) // 6to4 of 127.0.0.1
    // The same wrappers around a public address stay allowed.
    expect(isBlockedAddress('::ffff:93.184.216.34')).toBe(false)
  })

  it('blocks anything it cannot parse rather than guessing', () => {
    for (const junk of [
      '',
      'not-an-address',
      '1.2.3',
      '1.2.3.4.5',
      '999.1.1.1',
    ])
      expect(isBlockedAddress(junk), junk).toBe(true)
  })

  it('blocks the names that stand for those addresses', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'anything.localhost',
      'metadata.google.internal',
      'nas.local',
      'db.internal',
    ])
      expect(isBlockedHostname(host), host).toBe(true)
    expect(isBlockedHostname('example.com')).toBe(false)
    expect(isBlockedHostname('internal.example.com')).toBe(false)
  })
})

describe('assertPublicUrl', () => {
  it('refuses every scheme that is not http or https', async () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'gopher://example.com:70/_x',
      'vbscript:msgbox(1)',
    ])
      expect(await refusal(url), url).toBe('scheme')
  })

  it('refuses a literal private address without asking DNS', async () => {
    // No entry in the resolver map for any of these, so a refusal for
    // 'unresolved' rather than 'private-address' would mean the literal was
    // being resolved instead of read.
    for (const url of [
      'http://127.0.0.1/',
      'http://127.0.0.1:8080/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://192.168.0.1/',
      'http://[::1]/',
      'http://[fd00::1]/',
    ])
      expect(await refusal(url), url).toBe('private-address')
  })

  it('normalises the obfuscated spellings of 127.0.0.1', async () => {
    // Decimal, octal and hex are all the same address to the URL parser, and
    // this is the assertion that says so out loud: it is exactly the
    // behaviour a dependency upgrade could take away.
    for (const url of [
      'http://2130706433/', // decimal
      'http://0177.0.0.1/', // octal
      'http://0x7f.0.0.1/', // hex
      'http://127.1/', // short form
    ])
      expect(await refusal(url), url).toBe('private-address')
  })

  it('refuses a public NAME that resolves to a private address', async () => {
    // The whole reason the string is not enough. evil.test is a perfectly
    // ordinary public name, and its A record says 127.0.0.1.
    expect(await refusal('https://evil.test/page')).toBe('private-address')
  })

  it('refuses when ANY of the resolved addresses is private', async () => {
    // One public, one on 10/8. Which one gets connected to is the resolver's
    // choice, not ours, so the name is refused outright.
    expect(await refusal('https://split.test/')).toBe('private-address')
  })

  it('refuses a name that resolves to nothing, rather than trying anyway', async () => {
    expect(await refusal('https://nowhere.test/')).toBe('unresolved')
  })

  it('refuses credentials in the URL', async () => {
    expect(await refusal('https://user:pw@example.com/')).toBe('credentials')
  })

  it('allows an ordinary public URL', async () => {
    expect(await refusal('https://example.com/page?q=1')).toBe('allowed')
    expect(await refusal('https://six.test/')).toBe('allowed')
  })
})

describe('safeFetch', () => {
  /** A fetch that answers from a table of URLs. */
  function stub(
    routes: Record<
      string,
      { status?: number; headers?: Record<string, string>; body?: string }
    >,
  ): { fetch: typeof fetch; calls: string[] } {
    const calls: string[] = []
    const impl = ((url: string) => {
      calls.push(String(url))
      const route = routes[String(url)]
      if (!route)
        return Promise.resolve(new Response('missing', { status: 404 }))
      return Promise.resolve(
        new Response(route.body ?? '', {
          status: route.status ?? 200,
          headers: { 'content-type': 'text/html', ...(route.headers ?? {}) },
        }),
      )
    }) as unknown as typeof fetch
    return { fetch: impl, calls }
  }

  it('reads a plain page', async () => {
    const { fetch: impl } = stub({
      'https://example.com/page': { body: '<title>Hi</title>' },
    })
    const res = await safeFetch('https://example.com/page', publicDeps(impl))
    expect(res.body).toContain('Hi')
    expect(res.truncated).toBe(false)
  })

  it('re-checks every redirect hop, so a public URL cannot bounce inward', async () => {
    // The attack this closes: the first request is to a name that resolves
    // correctly, and the answer is a 302 to loopback.
    const { fetch: impl, calls } = stub({
      'https://example.com/page': {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      },
    })
    expect(
      await failure(safeFetch('https://example.com/page', publicDeps(impl))),
    ).toContain('private-address')
    // Proof it stopped rather than merely failed later: the metadata endpoint
    // was never contacted.
    expect(calls).toEqual(['https://example.com/page'])
  })

  it('re-resolves the redirect target, not just its literal string', async () => {
    const { fetch: impl, calls } = stub({
      'https://example.com/page': {
        status: 302,
        headers: { location: 'https://evil.test/' },
      },
    })
    expect(
      await failure(safeFetch('https://example.com/page', publicDeps(impl))),
    ).toContain('private-address')
    expect(calls).toEqual(['https://example.com/page'])
  })

  it('caps the number of redirects', async () => {
    const routes: Record<
      string,
      { status: number; headers: Record<string, string> }
    > = {}
    for (let i = 0; i < 10; i++)
      routes[`https://example.com/${i}`] = {
        status: 302,
        headers: { location: `https://example.com/${i + 1}` },
      }
    const { fetch: impl, calls } = stub(routes)
    expect(
      await failure(safeFetch('https://example.com/0', publicDeps(impl))),
    ).toContain('too many redirects')
    expect(calls.length).toBe(MAX_REDIRECTS + 1)
  })

  it('caps the response size', async () => {
    const huge = 'a'.repeat(MAX_BYTES * 2)
    const { fetch: impl } = stub({ 'https://example.com/big': { body: huge } })
    const res = await safeFetch('https://example.com/big', publicDeps(impl))
    expect(res.truncated).toBe(true)
    expect(res.body.length).toBeLessThanOrEqual(MAX_BYTES)
  })

  it('refuses a body that declares itself enormous before reading it', async () => {
    const { fetch: impl } = stub({
      'https://example.com/big': {
        headers: { 'content-length': String(MAX_BYTES * 100) },
      },
    })
    expect(
      await failure(safeFetch('https://example.com/big', publicDeps(impl))),
    ).toContain('too large')
  })

  it('passes an abort signal, so a hanging site cannot hold the request', async () => {
    let seen: AbortSignal | undefined
    const impl = ((_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return Promise.resolve(
        new Response('', { headers: { 'content-type': 'text/html' } }),
      )
    }) as unknown as typeof fetch
    await safeFetch('https://example.com/page', publicDeps(impl))
    expect(seen).toBeInstanceOf(AbortSignal)
  })

  it('times out a body that dribbles, not just headers that never arrive', async () => {
    // The gap this closes, found by reading the code back: the timer used to
    // be cleared as soon as the headers landed, so a site that answered
    // promptly and then sent a byte at a time held the request open for as
    // long as it liked. The size cap does not help there, because a trickle
    // never reaches it.
    //
    // The body stream fails on abort, which is what a real fetch's body does.
    // That is the whole assertion: if the timer has already been cleared by
    // the time the body is read, nothing ever aborts and this hangs.
    const impl = ((_url: string, init?: RequestInit) => {
      const signal = init?.signal
      const trickle = new ReadableStream<Uint8Array>({
        pull(controller) {
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              controller.enqueue(new Uint8Array([0x61]))
              resolve()
            }, 10)
            signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(new Error('aborted'))
            })
          })
        },
      })
      return Promise.resolve(
        new Response(trickle, { headers: { 'content-type': 'text/html' } }),
      )
    }) as unknown as typeof fetch
    const deps = { ...publicDeps(impl), timeoutMs: 40 }
    expect(await failure(safeFetch('https://example.com/slow', deps))).toBe(
      'aborted',
    )
  })

  it('never follows a redirect automatically', async () => {
    let mode: string | undefined
    const impl = ((_url: string, init?: RequestInit) => {
      mode = init?.redirect
      return Promise.resolve(
        new Response('', { headers: { 'content-type': 'text/html' } }),
      )
    }) as unknown as typeof fetch
    await safeFetch('https://example.com/page', publicDeps(impl))
    expect(mode).toBe('manual')
  })
})
