import { newId } from '@nubisco/acta-shared'
import type { ICtx } from './ctx'
import { now } from './ctx'

export interface IEvent {
  id: string
  workspace_id: string
  ts: number
  actor_id: string
  actor_kind: string
  on_behalf_of?: string
  verb: string
  entity: string
  entity_id: string
  summary: string
  payload?: unknown
  caused_by?: string
}

type TListener = (event: IEvent) => void

/** In-process pub/sub feeding SSE, webhooks, and the rules kernel. */
const listeners = new Set<TListener>()

export function onEvent(listener: TListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitEvent(
  ctx: ICtx,
  verb: string,
  entity: string,
  entityId: string,
  summary: string,
  payload?: unknown,
): IEvent {
  const event: IEvent = {
    id: newId('evt'),
    workspace_id: ctx.workspaceId,
    ts: now(),
    actor_id: ctx.actor.id,
    actor_kind: ctx.actor.kind,
    on_behalf_of: ctx.actor.onBehalfOf,
    verb,
    entity,
    entity_id: entityId,
    summary,
    payload,
    caused_by: ctx.causedBy,
  }
  ctx.db.run(
    `INSERT INTO event (id, workspace_id, ts, actor_id, actor_kind, on_behalf_of, verb, entity, entity_id, summary, payload, caused_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.workspace_id,
      event.ts,
      event.actor_id,
      event.actor_kind,
      event.on_behalf_of ?? null,
      event.verb,
      event.entity,
      event.entity_id,
      event.summary,
      event.payload ? JSON.stringify(event.payload) : null,
      event.caused_by ?? null,
    ],
  )
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // Listeners must never break the write path.
    }
  }
  return event
}
