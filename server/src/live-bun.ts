/**
 * Live sockets on Bun. One process holds every tab, so each socket listens to
 * the in-process event bus directly, the way the stream always has.
 */
import { upgradeWebSocket, websocket } from 'hono/bun'
import { onEvent } from './core/events'
import {
  LIVE_MAX_AGE_MS,
  LIVE_PING,
  LIVE_REAUTH_CODE,
  LIVE_PONG,
  liveFrame,
  type ILiveTransport,
} from './core/live'

export const bunLive: ILiveTransport = {
  socket: upgradeWebSocket((c) => {
    const workspaceId = c.get('workspaceId')
    let off: (() => void) | null = null
    return {
      onOpen(_event, ws) {
        const openedAt = Date.now()
        off = onEvent((event) => {
          if (event.workspace_id !== workspaceId) return
          if (Date.now() - openedAt > LIVE_MAX_AGE_MS) {
            off?.()
            ws.close(LIVE_REAUTH_CODE, 'Sign in again')
            return
          }
          ws.send(liveFrame(event))
        })
      },
      onMessage(event, ws) {
        if (event.data === LIVE_PING) ws.send(LIVE_PONG)
      },
      onClose() {
        off?.()
      },
    }
  }),
}

/** Bun.serve's socket handler, exported beside fetch by the entrypoint. */
export { websocket as bunWebsocket }
