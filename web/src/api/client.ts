/**
 * Typed REST client. Session cookie auth (credentials included); every write
 * goes through the batch op endpoints with client-generated op_ids.
 */

import type {
  TBoardOp,
  TDocOp,
  TItemOp,
  TLabelOp,
  TOpResult,
} from '@nubisco/acta-shared'

const BASE = '/api/v1'

export class ApiHttpError extends Error {
  status: number
  body: unknown

  constructor(status: number, body: unknown) {
    super(
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `http ${status}`,
    )
    this.status = status
    this.body = body
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  })
  const body = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) throw new ApiHttpError(res.status, body)
  return body as T
}

export function newOpId(): string {
  return `web:${crypto.randomUUID()}`
}

// -- Types mirrored from the compact server responses -----------------------

export interface IOverview {
  workspace: { id: string; name: string }
  boards: {
    key: string
    name: string
    archived?: boolean
    lists: { id: string; name: string; role?: string; items: number }[]
  }[]
  labels: {
    group_name: string
    board_key: string | null
    id: string
    name: string
    color: string
  }[]
  actors: { id: string; handle: string; kind: string; name: string }[]
  doc_roots: { slug: string; title: string; children: number }[]
}

export interface IBoardItemRow {
  key: string
  title: string
  list: string
  labels?: string[]
  assignees?: string[]
  due?: number
  done?: boolean
  archived?: boolean
  cmts?: number
  chk?: string
  rev: number
  updated: number
  pos: number
  description?: string
}

export interface IItemDetail {
  key: string
  board: string
  list: string
  title: string
  description: string
  labels?: string[]
  assignees?: string[]
  due?: number
  done?: boolean
  archived?: boolean
  rev: number
  created: number
  updated: number
  comments?: {
    id: string
    by: string
    agent?: boolean
    ts: number
    body: string
  }[]
  checklists?: { name: string; items: { text: string; done: boolean }[] }[]
  links?: {
    out: { ref_type: string; target: string }[]
    in: { src_kind: string; src_id: string }[]
  }
  attachments?: {
    id: string
    kind: string
    filename: string
    url: string | null
    size: number | null
  }[]
  activity?: { ts: number; verb: string; summary: string; actor_kind: string }[]
}

export interface IDocNode {
  slug: string
  title: string
  depth: number
  rev: number
  updated: number
}

export interface IDocDetail {
  slug: string
  title: string
  layout?: 'wide'
  tags: string[]
  rev: number
  updated: number
  body: string
  sections?: { slug: string; level: number; hash: string }[]
  backlinks?: { src_kind: string; src_id: string }[]
  versions?: { rev: number; created_at: number; handle: string }[]
}

export interface IEventRow {
  id: string
  ts: number
  actor_id: string
  actor_kind: string
  on_behalf_of: string | null
  verb: string
  entity: string
  entity_id: string
  summary: string
  caused_by: string | null
}

// -- Auth -------------------------------------------------------------------

export const auth = {
  me: () =>
    req<{
      id: string
      handle: string
      kind: string
      role: string
      scopes: string[]
    }>('/auth/me'),
  requestOtp: (email: string) =>
    req<{ ok: boolean }>('/auth/otp', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  verifyOtp: (email: string, code: string) =>
    req<{ ok: boolean }>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),
  logout: () =>
    req<{ ok: boolean }>('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
}

// -- Reads ------------------------------------------------------------------

export const api = {
  overview: () => req<IOverview>('/overview'),

  boardGet: (board: string, params: Record<string, string> = {}) =>
    req<{
      board: { key: string; name: string }
      items: IBoardItemRow[]
      cursor?: string
    }>(`/boards/${board}?${new URLSearchParams(params)}`),

  itemGet: (keys: string[], include?: string[]) =>
    req<{ items: IItemDetail[] }>('/items/get', {
      method: 'POST',
      body: JSON.stringify({ keys, include }),
    }),

  docTree: () => req<{ docs: IDocNode[] }>('/docs'),

  docGet: (slug: string, include?: string[], atVersion?: number) =>
    req<IDocDetail>(
      `/docs/${slug}?${new URLSearchParams({
        ...(include ? { include: include.join(',') } : {}),
        ...(atVersion !== undefined ? { at_version: String(atVersion) } : {}),
      })}`,
    ),

  search: (q: string, types?: string[]) =>
    req<{
      results: {
        type: string
        ref: string
        title: string
        snippet: string
        board?: string
      }[]
    }>(
      `/search?${new URLSearchParams({ q, ...(types ? { types: types.join(',') } : {}) })}`,
    ),

  activity: (params: Record<string, string> = {}) =>
    req<{ events: IEventRow[]; cursor?: string }>(
      `/activity?${new URLSearchParams(params)}`,
    ),

  // -- Writes ---------------------------------------------------------------

  itemWrite: (ops: TItemOp[], defaultBoard?: string) =>
    req<{ results: TOpResult[] }>('/items/write', {
      method: 'POST',
      body: JSON.stringify({ ops, default_board: defaultBoard }),
    }),

  boardWrite: (ops: TBoardOp[]) =>
    req<{ results: TOpResult[] }>('/boards/write', {
      method: 'POST',
      body: JSON.stringify({ ops }),
    }),

  docWrite: (ops: TDocOp[]) =>
    req<{ results: TOpResult[] }>('/docs/write', {
      method: 'POST',
      body: JSON.stringify({ ops }),
    }),

  labelWrite: (ops: TLabelOp[]) =>
    req<{ results: TOpResult[] }>('/labels/write', {
      method: 'POST',
      body: JSON.stringify({ ops }),
    }),

  webhooks: () =>
    req<{
      webhooks: {
        id: string
        url: string
        events: string[]
        enabled: boolean
        failures: number
      }[]
    }>('/webhooks'),
  webhookWrite: (ops: unknown[]) =>
    req<{ results: TOpResult[] }>('/webhooks/write', {
      method: 'POST',
      body: JSON.stringify({ ops }),
    }),

  rules: () =>
    req<{
      rules: {
        id: string
        name: string
        trigger: string
        condition?: string
        action: unknown
        enabled: boolean
      }[]
    }>('/rules'),
  ruleWrite: (ops: unknown[]) =>
    req<{ results: TOpResult[] }>('/rules/write', {
      method: 'POST',
      body: JSON.stringify({ ops }),
    }),

  createAgentToken: (name: string, scopes: string[], onBehalfOf?: string) =>
    req<{ actor_id: string; token: string }>('/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, scopes, on_behalf_of: onBehalfOf }),
    }),
  revokeAgentToken: (actorId: string) =>
    req<{ ok: boolean }>(`/tokens/${actorId}`, { method: 'DELETE' }),

  createIngestToken: (name: string, board: string, list?: string) =>
    req<{ token: string; actor_id: string }>('/ingest_tokens', {
      method: 'POST',
      body: JSON.stringify({ name, board, list }),
    }),
}

// -- SSE --------------------------------------------------------------------

export interface ILiveEvent {
  id: string
  verb: string
  entity: string
  entity_id: string
  actor_kind: string
}

export function subscribeEvents(
  handler: (event: ILiveEvent) => void,
): () => void {
  const source = new EventSource(`${BASE}/events/stream`)
  source.onmessage = (msg) => {
    try {
      handler(JSON.parse(msg.data) as ILiveEvent)
    } catch {
      // ignore malformed frames
    }
  }
  return () => source.close()
}
