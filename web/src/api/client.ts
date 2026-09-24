/**
 * Typed REST client. Session cookie auth (credentials included); every write
 * goes through the batch op endpoints with client-generated op_ids.
 */

import type {
  TSpaceOp,
  TDocOp,
  TItemOp,
  TLabelOp,
  TOpResult,
} from '@nubisco/acta-shared'

import type { ILinkPreview } from '@/components/decorations/linkCards'

const BASE = '/api/v1'

/**
 * The workspace every call is addressed to, as a URL segment.
 *
 * A session identifies the person, not the place, so the workspace has to
 * travel with the request. Holding it here rather than threading a slug
 * through thirty call sites keeps the change to one function, and means a
 * second tab on another workspace is just a second module instance with its
 * own value.
 */
let workspaceSlug = ''

export function setWorkspaceSlug(slug: string): void {
  workspaceSlug = slug
}

export function getWorkspaceSlug(): string {
  return workspaceSlug
}

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
  // Signing in and listing your workspaces happen before you have chosen one,
  // so those stay unprefixed. Everything else is scoped.
  const scoped =
    path.startsWith('/auth') || !workspaceSlug
      ? `${BASE}${path}`
      : `${BASE}/w/${encodeURIComponent(workspaceSlug)}${path}`
  const res = await fetch(scoped, {
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
  ISpaceItemRow,
  IItemDetail,
  IDocNode,
  IDocDetail,
  IEventRow,
  ISearchResult,
  ILiveEvent,
  IMyWorkItem,
} from '@/types/api'
import type {
  IOverview,
  ISpaceItemRow,
  IItemDetail,
  IDocNode,
  IDocDetail,
  IEventRow,
  ISearchResult,
  ILiveEvent,
  IMyWorkItem,
} from '@/types/api'

// -- Auth -------------------------------------------------------------------

export const auth = {
  /** Every workspace this session can open. Unprefixed by design. */
  workspaces: () =>
    req<{
      workspaces: { id: string; name: string; slug: string }[]
    }>('/auth/workspaces'),

  me: () =>
    req<{
      id: string
      handle: string
      kind: string
      role: string
      scopes: string[]
      email?: string
      name?: string
      /**
       * The avatar the provider published for this person, absent when they
       * have none. Already checked server-side to be on the issuer's origin.
       */
      picture?: string
      /** The provider's own id, so the account menu can mark which of the
          browser's signed-in accounts this session belongs to. */
      platform_user_id?: string
      /** False until the welcome has been dismissed once, by this person. */
      onboarded?: boolean
    }>('/auth/me'),

  /**
   * How this instance signs people in. Read once at boot: it decides whether
   * the account menu shows the platform's account actions and Profile, which
   * an instance pointed at another provider must not be told about.
   */
  config: () =>
    req<{
      sso: boolean
      otp: boolean
      sso_label?: string
      nubisco_platform?: boolean
      platform_url?: string
    }>('/auth/config'),

  /**
   * A fresh sign-in through Acta's own SSO start. Switching accounts is
   * always this, never local state: the provider's session alone does not
   * change who Acta thinks is signed in, only a new callback does.
   */
  signInUrl: (
    to?: string,
    opts: { loginHint?: string; prompt?: 'login' | 'select_account' } = {},
  ): string => {
    const url = new URL('/api/v1/auth/sso/start', location.origin)
    if (to) url.searchParams.set('to', to)
    if (opts.loginHint) url.searchParams.set('login_hint', opts.loginHint)
    if (opts.prompt) url.searchParams.set('prompt', opts.prompt)
    return url.toString()
  },

  markOnboarded: () =>
    req<{ ok: boolean }>('/auth/me/onboarded', { method: 'POST' }),

  /** Personal access tokens: MCP and the API acting as you, with your role. */
  tokens: () =>
    req<{
      tokens: {
        id: string
        label: string
        scopes: string[]
        created_at: number
        last_used_at?: number
      }[]
    }>('/auth/me/tokens'),

  createToken: (label: string, scopes: string[]) =>
    req<{ token: string; label: string; scopes: string[] }>('/auth/me/tokens', {
      method: 'POST',
      body: JSON.stringify({ label, scopes }),
    }),

  revokeToken: (id: string) =>
    req<{ ok: boolean }>(`/auth/me/tokens/${id}`, { method: 'DELETE' }),

  /**
   * Applications connected over OAuth: the claude.ai connector, ChatGPT, an
   * MCP client. Grouped per client rather than per grant, because
   * re-authorising produces a second grant for what a person thinks of as
   * one connection.
   */
  apps: () =>
    req<{
      apps: {
        client_id: string
        name: string
        scopes: string[]
        created_at: number
        last_used_at?: number
        expires_at: number
      }[]
    }>('/auth/me/apps'),

  revokeApp: (clientId: string) =>
    req<{ ok: boolean }>(`/auth/me/apps/${clientId}`, { method: 'DELETE' }),

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

  spaceGet: (space: string, params: Record<string, string> = {}) =>
    req<{
      space: { key: string; name: string }
      items: ISpaceItemRow[]
      cursor?: string
    }>(`/spaces/${space}?${new URLSearchParams(params)}`),

  /**
   * What is mine, across every space. Everything else is space-scoped, which
   * cannot answer the question Home opens with.
   */
  myWork: () =>
    req<{
      assigned: IMyWorkItem[]
      due: IMyWorkItem[]
      mentions: IMyWorkItem[]
      recent: IMyWorkItem[]
    }>('/me/work'),

  /**
   * Open Graph metadata for bare URLs, so each can render as a preview card.
   *
   * Batched, because the whole point is that opening a document costs one
   * round trip whatever it contains. The server answers from its own cache
   * where it can, and answers `status: 'none'` rather than failing when a
   * site has no metadata or is one it refuses to fetch.
   */
  linkPreviews: (urls: string[]) =>
    req<{ previews: ILinkPreview[] }>('/link-previews', {
      method: 'POST',
      body: JSON.stringify({ urls }),
    }),

  itemGet: (keys: string[], include?: string[]) =>
    req<{ items: IItemDetail[] }>('/items/get', {
      method: 'POST',
      body: JSON.stringify({ keys, include }),
    }),

  sequence: (space: string) =>
    req<{
      nodes: {
        key: string
        title: string
        list: string
        status: 'open' | 'done' | 'archived'
        assignees: string[]
        labels: string[]
        size: number | null
        is_milestone: boolean
        layer: number
        blocked_by: string[]
        blocks: string[]
        critical: boolean
        earliest_finish: number
      }[]
      layers: number
      critical_size: number
    }>(`/spaces/${encodeURIComponent(space)}/sequence`),

  notifications: () =>
    req<{
      notifications: {
        id: string
        reason: 'mention' | 'assigned' | 'involved'
        verb: string
        summary: string
        item_key: string | null
        doc_slug: string | null
        created_at: number
        read_at: number | null
        actor_handle: string | null
        actor_name: string | null
        actor_avatar_url: string | null
      }[]
      unread: number
    }>('/notifications'),

  /** No id marks everything read. */
  notificationRead: (id?: string) =>
    req<{ ok: boolean }>('/notifications/read', {
      method: 'POST',
      body: JSON.stringify(id ? { id } : {}),
    }),

  /** Seconds an unread notification waits before Acta emails about it. */
  notificationPrefs: () =>
    req<{ notify_after_seconds: number }>('/notifications/prefs'),

  setNotificationPrefs: (seconds: number) =>
    req<{ notify_after_seconds: number }>('/notifications/prefs', {
      method: 'PUT',
      body: JSON.stringify({ notify_after_seconds: seconds }),
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

  itemWrite: (ops: TItemOp[], defaultSpace?: string) =>
    req<{ results: TOpResult[] }>('/items/write', {
      method: 'POST',
      body: JSON.stringify({ ops, default_space: defaultSpace }),
    }),

  spaceWrite: (ops: TSpaceOp[]) =>
    req<{ results: TOpResult[] }>('/spaces/write', {
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
        format: 'generic' | 'slack'
        failures: number
      }[]
    }>('/webhooks'),
  webhookWrite: (ops: unknown[]) =>
    req<{ results: TOpResult[] }>('/webhooks/write', {
      method: 'POST',
      body: JSON.stringify({ ops }),
    }),

  connections: () =>
    req<{
      connections: {
        id: string
        provider: 'github'
        name: string
        space: string
        list: string | null
        enabled: boolean
        config: { labels?: string[]; repos?: string[] }
        last_event_at: number | null
        last_error: string | null
      }[]
    }>('/connections'),
  connectionWrite: (ops: unknown[]) =>
    req<{ results: TOpResult[] }>('/connections/write', {
      method: 'POST',
      body: JSON.stringify({ ops }),
    }),

  /**
   * Raw bytes rather than multipart: the blob is already cropped, and a body
   * that is exactly the image keeps the server free of form parsing.
   */
  uploadAvatar: (actorId: string, blob: Blob) =>
    req<{ ok: boolean; avatar_url: string }>(
      `/members/${encodeURIComponent(actorId)}/avatar`,
      {
        method: 'POST',
        headers: { 'content-type': blob.type || 'image/png' },
        body: blob,
      },
    ),

  removeAvatar: (actorId: string) =>
    req<{ ok: boolean }>(`/members/${encodeURIComponent(actorId)}/avatar`, {
      method: 'DELETE',
    }),

  starSpace: (key: string, starred: boolean) =>
    req<{ ok: boolean; starred: boolean }>(
      `/spaces/${encodeURIComponent(key)}/star`,
      { method: starred ? 'PUT' : 'DELETE' },
    ),

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

  ingestTokens: () =>
    req<{
      tokens: {
        id: string
        name: string
        handle: string
        space: string
        list: string | null
        created_at: number
        last_used_at: number | null
        items: number
      }[]
    }>('/ingest_tokens'),

  createIngestToken: (name: string, space: string, list?: string) =>
    req<{ token: string; actor_id: string }>('/ingest_tokens', {
      method: 'POST',
      body: JSON.stringify({ name, space, list }),
    }),

  revokeIngestToken: (id: string) =>
    req<{ ok: boolean }>(`/ingest_tokens/${id}`, { method: 'DELETE' }),

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

  /**
   * A picture on another site, copied by the server into an attachment on a
   * page. The import's fallback for images the browser may not read. Any
   * failure is one 422 with no reason given, on purpose.
   */
  attachmentFetchRemote: (owner: { doc: string }, url: string) =>
    req<{ id: string; filename: string; size: number; url: string }>(
      '/attachments/fetch',
      {
        method: 'POST',
        body: JSON.stringify({ doc: owner.doc, url }),
      },
    ),

  /** A stored file attachment's bytes, or null for a link or a failure. */
  attachmentBytes: async (
    id: string,
  ): Promise<{ bytes: Uint8Array; mime: string } | null> => {
    const res = await fetch(`${BASE}/attachments/${id}`, {
      credentials: 'include',
    })
    if (!res.ok || !res.headers.get('content-disposition')) return null
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime }
  },

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
    return body as {
      id: string
      filename: string
      size: number
      url: string
    }
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
  // The live stream is workspace-scoped like every other read; without the
  // segment a second tab would receive the first workspace's events.
  const source = new EventSource(
    workspaceSlug
      ? `${BASE}/w/${encodeURIComponent(workspaceSlug)}/events/stream`
      : `${BASE}/events/stream`,
  )
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
