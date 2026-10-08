/**
 * The tab's live connection.
 *
 * A socket, so that on Workers every change reaches every tab at once (Jose,
 * 2026-10-08: "lets do proper instant delivery"). A server with no socket
 * gets the older stream instead, and an outage is retried, never mistaken for
 * a server that has no socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setWorkspaceSlug, subscribeEvents } from '@/api/client'

class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    FakeSocket.all.push(this)
  }
  send(m: string) {
    this.sent.push(m)
  }
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  drop() {
    this.readyState = 3
    return this.onclose?.()
  }
}

class FakeStream {
  static all: FakeStream[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  constructor(public url: string) {
    FakeStream.all.push(this)
  }
  close() {}
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.all = []
  FakeStream.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('EventSource', FakeStream)
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  setWorkspaceSlug('nubisco')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the live socket', () => {
  it('connects to the workspace socket and hands every frame on', () => {
    const events: unknown[] = []
    const health = vi.fn()
    const stop = subscribeEvents((e) => events.push(e), health)
    const ws = FakeSocket.all[0]
    expect(ws.url).toMatch(
      /^ws:\/\/[^/]+\/api\/v1\/w\/nubisco\/events\/socket$/,
    )

    ws.open()
    expect(health).toHaveBeenLastCalledWith(false)
    ws.onmessage!({ data: '{"verb":"item.updated","entity":"item"}' })
    ws.onmessage!({ data: 'pong' })
    expect(events).toEqual([{ verb: 'item.updated', entity: 'item' }])

    vi.advanceTimersByTime(25_000)
    expect(ws.sent).toEqual(['ping'])
    stop()
  })

  it('reconnects after a drop, and says so meanwhile', async () => {
    const health = vi.fn()
    const stop = subscribeEvents(() => {}, health)
    FakeSocket.all[0].open()
    await FakeSocket.all[0].drop()
    expect(health).toHaveBeenLastCalledWith(true)
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(2)
    expect(fetchMock).not.toHaveBeenCalled()
    stop()
  })

  it('uses the stream on a server that has no socket', async () => {
    fetchMock.mockResolvedValue({ status: 404 })
    const stop = subscribeEvents(() => {})
    await FakeSocket.all[0].drop()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/w/nubisco/events/socket',
      expect.anything(),
    )
    expect(FakeStream.all.map((s) => s.url)).toEqual([
      '/api/v1/w/nubisco/events/stream',
    ])
    vi.advanceTimersByTime(30_000)
    expect(FakeSocket.all).toHaveLength(1)
    stop()
  })

  it('keeps trying the socket through an outage', async () => {
    fetchMock.mockResolvedValue({ status: 426 })
    const stop = subscribeEvents(() => {})
    await FakeSocket.all[0].drop()
    expect(FakeStream.all).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.all).toHaveLength(2)
    stop()
  })

  it('stops for good when unsubscribed', async () => {
    const stop = subscribeEvents(() => {})
    FakeSocket.all[0].open()
    stop()
    await FakeSocket.all[0].drop()
    vi.advanceTimersByTime(30_000)
    expect(FakeSocket.all).toHaveLength(1)
  })
})
