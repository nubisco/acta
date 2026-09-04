/**
 * REST client for a running Acta server. The importers write exclusively
 * through the batch endpoints (design-spec §4), so every mutation carries an
 * op_id and re-runs are idempotent. Batches are chunked to the server's
 * per-call op limits.
 */

import type {
  TBoardOp,
  TDocOp,
  TItemOp,
  TLabelOp,
  TOpResult,
} from '@nubisco/acta-shared'

export const DEFAULT_ACTA_URL = 'http://localhost:4460'

export class ActaHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`acta api ${status}: ${body}`)
  }
}

export interface IActaClientOptions {
  baseUrl?: string
  token?: string
  /** Injectable for tests (e.g. an in-process Hono app.request). */
  fetchImpl?: typeof fetch
}

export interface IOverviewList {
  id: string
  name: string
  role?: string
  items: number
}

export interface IOverview {
  workspace: { id: string; name: string }
  boards: {
    key: string
    name: string
    archived?: boolean
    lists: IOverviewList[]
  }[]
  labels: {
    group_name: string
    board_key: string | null
    id: string
    name: string
    color: string
  }[]
  actors: { id: string; handle: string; kind: string; name: string }[]
  doc_roots: { slug: string; title: string }[]
}

export interface IDocTreeNode {
  slug: string
  title: string
  depth: number
}

export interface IItemAttachment {
  id: string
  kind: string
  filename: string
  url: string | null
}

export interface IAttachmentInput {
  item?: string
  doc?: string
  filename: string
  mime?: string
  url?: string
  content_base64?: string
}

const ITEM_OPS_PER_CALL = 100
const SMALL_OPS_PER_CALL = 50

export class ActaClient {
  private baseUrl: string
  private token: string
  private fetchImpl: typeof fetch

  constructor(opts: IActaClientOptions = {}) {
    this.baseUrl = (
      opts.baseUrl ??
      process.env.ACTA_URL ??
      DEFAULT_ACTA_URL
    ).replace(/\/+$/, '')
    this.token = opts.token ?? process.env.ACTA_TOKEN ?? ''
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) throw new ActaHttpError(res.status, text)
    return JSON.parse(text)
  }

  async overview(): Promise<IOverview> {
    return (await this.request('GET', '/api/v1/overview')) as IOverview
  }

  async docTree(): Promise<IDocTreeNode[]> {
    const res = (await this.request('GET', '/api/v1/docs')) as {
      docs: IDocTreeNode[]
    }
    return res.docs
  }

  private async writeOps<T>(
    path: string,
    ops: T[],
    chunkSize: number,
  ): Promise<TOpResult[]> {
    const out: TOpResult[] = []
    for (let i = 0; i < ops.length; i += chunkSize) {
      const res = (await this.request('POST', path, {
        ops: ops.slice(i, i + chunkSize),
      })) as { results: TOpResult[] }
      out.push(...res.results)
    }
    return out
  }

  async writeBoards(ops: TBoardOp[]): Promise<TOpResult[]> {
    return this.writeOps('/api/v1/boards/write', ops, SMALL_OPS_PER_CALL)
  }

  async writeLabels(ops: TLabelOp[]): Promise<TOpResult[]> {
    return this.writeOps('/api/v1/labels/write', ops, SMALL_OPS_PER_CALL)
  }

  async writeItems(ops: TItemOp[]): Promise<TOpResult[]> {
    return this.writeOps('/api/v1/items/write', ops, ITEM_OPS_PER_CALL)
  }

  async writeDocs(ops: TDocOp[]): Promise<TOpResult[]> {
    return this.writeOps('/api/v1/docs/write', ops, SMALL_OPS_PER_CALL)
  }

  async addAttachment(input: IAttachmentInput): Promise<{ id: string }> {
    return (await this.request('POST', '/api/v1/attachments', input)) as {
      id: string
    }
  }

  /** Read attachments of existing items (attachment adds have no op_id). */
  async itemAttachments(
    keys: string[],
  ): Promise<Map<string, IItemAttachment[]>> {
    const out = new Map<string, IItemAttachment[]>()
    for (let i = 0; i < keys.length; i += 50) {
      const res = (await this.request('POST', '/api/v1/items/get', {
        keys: keys.slice(i, i + 50),
        include: ['attachments'],
      })) as { items: { key: string; attachments?: IItemAttachment[] }[] }
      for (const item of res.items) out.set(item.key, item.attachments ?? [])
    }
    return out
  }
}
