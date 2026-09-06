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

export type {
  IOverview,
  IBoardItemRow,
  IItemDetail,
  IDocNode,
  IDocDetail,
  IEventRow,
  ISearchResult,
  ILiveEvent,
} from '@/types/api'
import type {
  IOverview,
  IBoardItemRow,
  IItemDetail,
  IDocNode,
  IDocDetail,
  IEventRow,
  ISearchResult,
  ILiveEvent,
} from '@/types/api'

// -- Auth -------------------------------------------------------------------

export const auth = {
  me: () =>
    req<{
      id: string
      handle: string
      kind: string
      role: string
      scopes: string[]
      email?: string
      name?: string
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
    req<{ results: ISearchResult[] }>(
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

  workspaces: () =>
    req<{ workspaces: { id: string; name: string; current: boolean }[] }>(
      '/workspaces',
    ),

  createMember: (member: {
    email: string
    handle: string
    name: string
    role: 'admin' | 'member'
  }) =>
    req<{ id: string; handle: string }>('/members', {
      method: 'POST',
      body: JSON.stringify(member),
    }),
  updateMember: (
    id: string,
    patch: { role?: 'admin' | 'member'; disabled?: boolean; name?: string },
  ) =>
    req<{ ok: boolean }>(`/members/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  createIngestToken: (name: string, board: string, list?: string) =>
    req<{ token: string; actor_id: string }>('/ingest_tokens', {
      method: 'POST',
      body: JSON.stringify({ name, board, list }),
    }),

  // -- Attachments ----------------------------------------------------------

  attachmentAddUrl: (owner: { item?: string; doc?: string }, url: string) =>
    req<{ id: string; filename: string; url?: string }>('/attachments', {
      method: 'POST',
      body: JSON.stringify({
        ...owner,
        filename: url.split('/').pop()?.split('?')[0] || url,
        url,
      }),
    }),

  attachmentUpload: async (
    owner: { item?: string; doc?: string },
    file: File,
  ) => {
    const params = new URLSearchParams({ filename: file.name })
    if (owner.item) params.set('item', owner.item)
    if (owner.doc) params.set('doc', owner.doc)
    if (file.type) params.set('mime', file.type)
    const res = await fetch(`${BASE}/attachments/raw?${params}`, {
      method: 'POST',
      credentials: 'include',
      body: file,
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new ApiHttpError(res.status, body)
    return body as { id: string; filename: string; size: number }
  },

  attachmentDelete: (id: string) =>
    req<{ ok: boolean }>(`/attachments/${id}`, { method: 'DELETE' }),
}

/** Download/view href for a stored attachment. */
export function attachmentHref(id: string): string {
  return `${BASE}/attachments/${id}`
}

// -- SSE --------------------------------------------------------------------

export function subscribeEvents(
  handler: (event: ILiveEvent) => void,
  onHealth?: (down: boolean) => void,
): () => void {
  const source = new EventSource(`${BASE}/events/stream`)
  source.onopen = () => onHealth?.(false)
  source.onerror = () => onHealth?.(true)
  source.onmessage = (msg) => {
    try {
      handler(JSON.parse(msg.data) as ILiveEvent)
    } catch {
      // ignore malformed frames
    }
  }
  return () => source.close()
}
