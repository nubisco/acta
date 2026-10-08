/**
 * Live updates: how a write in one place reaches every open tab at once.
 *
 * The frame is the same on every transport. What differs is who holds the
 * open connections. On Bun there is one process, so it holds them and the
 * in-process event bus reaches them all. On Workers a write is handled by
 * whichever instance Cloudflare picks, and the cron by yet another, so a bus
 * inside one instance only reached the tabs that happened to be connected to
 * it. There, every tab connects to one Durable Object per workspace and every
 * event is published to it, which is what makes delivery instant everywhere.
 */
import type { MiddlewareHandler } from 'hono'
import type { IAuthEnv } from '../routes/auth'
import type { IEvent } from './events'

/** What a tab receives for an event: enough to know what to re-read. */
export function liveFrame(event: IEvent): string {
  return JSON.stringify({
    id: event.id,
    verb: event.verb,
    entity: event.entity,
    entity_id: event.entity_id,
    actor_kind: event.actor_kind,
  })
}

/** Sent by a tab to keep its socket open through idle proxies. */
export const LIVE_PING = 'ping'
export const LIVE_PONG = 'pong'

export interface ILiveTransport {
  /**
   * Answers GET /events/socket, after the workspace middleware has resolved
   * who is asking (c.get('workspaceId') is set).
   */
  socket: MiddlewareHandler<IAuthEnv>
  /**
   * Delivers a frame to everybody connected to a workspace. Unset when the
   * socket handler already listens to the in-process bus itself.
   */
  publish?: (workspaceId: string, frame: string) => Promise<void>
}
