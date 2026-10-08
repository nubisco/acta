/**
 * The Workers half of live updates (see core/live.ts): one Durable Object per
 * workspace, holding every open tab's socket.
 *
 * The sockets are accepted through the hibernation API, so between events the
 * object is evicted from memory and costs nothing, with the sockets kept open
 * by Cloudflare. The tabs' keepalive pings are answered by the runtime itself
 * (setWebSocketAutoResponse) and never wake it. It only runs to accept a tab
 * and to fan a published frame out.
 *
 * Who may connect is decided before the request reaches here: the worker only
 * forwards /events/socket after the workspace middleware has signed the
 * person in and resolved the workspace they belong to.
 */
import {
  LIVE_MAX_AGE_MS,
  LIVE_PING,
  LIVE_PONG,
  LIVE_REAUTH_CODE,
  type ILiveTransport,
} from './core/live'

/** The few runtime types used here, so the server needs no Workers typings. */
interface IHubSocket {
  send(message: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

/** What a socket carries through hibernation. */
interface IHubAttachment {
  openedAt: number
}

interface IHubState {
  acceptWebSocket(ws: IHubSocket): void
  getWebSockets(): IHubSocket[]
  setWebSocketAutoResponse(pair: unknown): void
}

interface IHubStub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
}

export interface IHubNamespace {
  idFromName(name: string): unknown
  get(id: unknown): IHubStub
}

declare const WebSocketPair: new () => [IHubSocket, IHubSocket]
declare const WebSocketRequestResponsePair: new (
  request: string,
  response: string,
) => unknown

const PUBLISH = 'https://live.hub/publish'

export class LiveHub {
  constructor(private readonly state: IHubState) {
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(LIVE_PING, LIVE_PONG),
    )
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'POST' && request.url === PUBLISH) {
      const frame = await request.text()
      const now = Date.now()
      for (const ws of this.state.getWebSockets()) {
        try {
          // Checked here rather than on a timer: an old socket that is sent
          // nothing has nothing to leak, and this is when the hub is awake.
          const at = (ws.deserializeAttachment() as IHubAttachment | null)
            ?.openedAt
          if (!at || now - at > LIVE_MAX_AGE_MS)
            ws.close(LIVE_REAUTH_CODE, 'Sign in again')
          else ws.send(frame)
        } catch {
          // A socket closing as the frame goes out. It is gone either way.
        }
      }
      return new Response(null, { status: 204 })
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    const [client, server] = new WebSocketPair()
    this.state.acceptWebSocket(server)
    server.serializeAttachment({
      openedAt: Date.now(),
    } satisfies IHubAttachment)
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit)
  }

  /** Tabs only ever send pings, and the runtime answers those. */
  webSocketMessage(): void {}

  webSocketClose(ws: IHubSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }
}

/** The transport the worker hands createApp. */
export function hubLive(namespace: IHubNamespace): ILiveTransport {
  const hub = (workspaceId: string) =>
    namespace.get(namespace.idFromName(workspaceId))
  return {
    socket: (c) => hub(c.get('workspaceId')).fetch(c.req.raw),
    publish: async (workspaceId, frame) => {
      await hub(workspaceId).fetch(PUBLISH, { method: 'POST', body: frame })
    },
  }
}
