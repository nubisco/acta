import { newId } from '@nubisco/acta-shared'
import { z } from 'zod'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { emitEvent, flushPendingEvents } from '../core/events'
import { withOp } from '../core/ops'
import { docBySlug, itemByKey } from '../core/store'

export const zAttachmentAdd = z
  .object({
    item: z.string().optional(),
    doc: z.string().optional(),
    filename: z.string().min(1).max(300),
    mime: z.string().max(100).optional(),
    /*
     * Only a scheme a link is meant to use.
     *
     * `z.url()` alone accepts `javascript:`, `data:` and `vbscript:`, because
     * each is a valid URL. Stored and then rendered into an href, any of them
     * is script running on Acta's own origin with the session attached. The
     * client refuses them too, but this is what stops the data existing.
     */
    url: z
      .url()
      .refine(
        (value) => {
          try {
            const protocol = new URL(value).protocol
            return (
              protocol === 'http:' ||
              protocol === 'https:' ||
              protocol === 'mailto:'
            )
          } catch {
            return false
          }
        },
        { message: 'url must be http, https or mailto' },
      )
      .optional(),
    content_base64: z.string().max(1_400_000).optional(), // ~1 MB decoded
  })
  .refine((v) => (v.item ? !v.doc : !!v.doc), {
    message: 'exactly one of item or doc',
  })
  .refine((v) => (v.url ? !v.content_base64 : !!v.content_base64), {
    message: 'exactly one of url or content_base64',
  })
export type TAttachmentAdd = z.infer<typeof zAttachmentAdd>

/** Runtime-agnostic content store: filesystem on Bun, R2 on Workers. */
export interface IBlobStore {
  put(id: string, bytes: Uint8Array): Promise<void>
  get(id: string): Promise<Uint8Array | null>
  delete?(id: string): Promise<void>
}

/** Raw uploads bypass base64 and its 1 MB inline cap. */
export const UPLOAD_MAX_BYTES = 26_214_400 // 25 MB

export class AttachmentStore {
  constructor(private blobs: IBlobStore) {}

  write(id: string, bytes: Uint8Array): Promise<void> {
    return this.blobs.put(id, bytes)
  }

  read(id: string): Promise<Uint8Array | null> {
    return this.blobs.get(id)
  }

  remove(id: string): Promise<void> {
    return this.blobs.delete?.(id) ?? Promise.resolve()
  }
}

/**
 * Where an attachment is served from.
 *
 * Relative on purpose. A stored absolute URL is wrong the moment an instance
 * moves host, and these end up inside document markdown that outlives any
 * one deployment. Markdown should carry `attachment:<id>` and let the reader
 * resolve it, but callers that want a plain link get this.
 */
export function attachmentUrl(id: string): string {
  return `/api/v1/attachments/${id}`
}

/**
 * Types safe to render in the page rather than hand to the downloads folder.
 *
 * A safelist, not a blocklist. Anything not named here downloads, so a type
 * nobody considered cannot be talked into rendering as a document by a
 * creative `mime` on upload.
 */
const INLINE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'application/pdf',
])

/**
 * The headers an attachment is served with.
 *
 * Two problems are being solved. Nothing here set `nosniff`, so a `.png` whose
 * bytes are HTML could be sniffed as a document and run on the app's own
 * origin, taking the session with it. And an SVG *is* a document: it can carry
 * script, so serving one inline is stored XSS unless something stops it.
 *
 * The CSP is what stops it. `default-src 'none'` allows the image no scripts,
 * no network and no frames, and `sandbox` drops it into an opaque origin so
 * it cannot reach cookies even if a future change loosens the rest.
 */
export function attachmentHeaders(
  mime: string | null,
  filename: string,
): Record<string, string> {
  const type = mime ?? 'application/octet-stream'
  const inline = INLINE_MIMES.has(type)
  const headers: Record<string, string> = {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`,
  }
  if (type === 'image/svg+xml') {
    headers['content-security-policy'] =
      "default-src 'none'; style-src 'unsafe-inline'; sandbox"
  }
  return headers
}

export async function attachmentAdd(
  ctx: ICtx,
  store: AttachmentStore,
  input: TAttachmentAdd,
) {
  const owner = input.item
    ? { kind: 'item' as const, row: await itemByKey(ctx, input.item) }
    : { kind: 'doc' as const, row: await docBySlug(ctx, input.doc!) }
  const id = newId('att')
  let size: number | null = null
  if (input.content_base64) {
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(input.content_base64), (ch) =>
        ch.charCodeAt(0),
      )
    } catch {
      throw new ApiError(400, 'content_base64 is not valid base64')
    }
    if (bytes.byteLength > 1_048_576)
      throw new ApiError(
        413,
        'inline attachments are capped at 1 MB; use the REST upload endpoint',
      )
    await store.write(id, bytes)
    size = bytes.byteLength
  }
  await ctx.db.run(
    `INSERT INTO attachment (id, workspace_id, owner_kind, owner_id, kind, filename, mime, size, url, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ctx.workspaceId,
      owner.kind,
      owner.row.id,
      input.url ? 'url' : 'file',
      input.filename,
      input.mime ?? null,
      size,
      input.url ?? null,
      ctx.actor.id,
      now(),
    ],
  )
  const ownerRef = input.item ?? input.doc
  await emitEvent(
    ctx,
    'attachment.added',
    owner.kind,
    owner.row.id,
    `attached ${input.filename} to ${ownerRef}`,
  )
  flushPendingEvents()
  return {
    id,
    filename: input.filename,
    size: size ?? undefined,
    // A link attachment keeps its own address. An uploaded file gets the one
    // it is served from, so a caller can embed it without a second round trip
    // to work out where it went.
    url: input.url ?? attachmentUrl(id),
  }
}

/**
 * Several attachments in one call, each carrying its own op_id.
 *
 * Embedding an icon set means sixteen uploads. One at a time over MCP is
 * sixteen round trips, and a retry after a timeout re-uploads whatever
 * already landed, so a document ends up with duplicates nobody asked for.
 *
 * Idempotent through the same op log every other batch write uses: a replayed
 * op_id returns the recorded result rather than attaching a second copy.
 * Results are per op, so one bad file does not lose the fifteen good ones.
 */
export const zAttachmentAddBatch = z.object({
  ops: z
    .array(zAttachmentAdd.extend({ op_id: z.string().min(1).max(200) }))
    .min(1)
    .max(25),
})
export type TAttachmentAddBatch = z.infer<typeof zAttachmentAddBatch>

export async function attachmentAddBatch(
  ctx: ICtx,
  store: AttachmentStore,
  input: TAttachmentAddBatch,
) {
  const results = []
  for (const op of input.ops) {
    const { op_id: opId, ...rest } = op
    results.push(await withOp(ctx, opId, () => attachmentAdd(ctx, store, rest)))
  }
  return { results }
}

export const zAttachmentUpload = z
  .object({
    item: z.string().optional(),
    doc: z.string().optional(),
    filename: z.string().min(1).max(300),
    mime: z.string().max(100).optional(),
  })
  .refine((v) => (v.item ? !v.doc : !!v.doc), {
    message: 'exactly one of item or doc',
  })
export type TAttachmentUpload = z.infer<typeof zAttachmentUpload>

/** Binary upload path: the request body is the file itself. */
export async function attachmentUpload(
  ctx: ICtx,
  store: AttachmentStore,
  input: TAttachmentUpload,
  bytes: Uint8Array,
) {
  if (bytes.byteLength === 0) throw new ApiError(400, 'empty upload body')
  if (bytes.byteLength > UPLOAD_MAX_BYTES)
    throw new ApiError(413, 'uploads are capped at 25 MB')
  const owner = input.item
    ? { kind: 'item' as const, row: await itemByKey(ctx, input.item) }
    : { kind: 'doc' as const, row: await docBySlug(ctx, input.doc!) }
  const id = newId('att')
  await store.write(id, bytes)
  await ctx.db.run(
    `INSERT INTO attachment (id, workspace_id, owner_kind, owner_id, kind, filename, mime, size, url, actor_id, created_at)
     VALUES (?, ?, ?, ?, 'file', ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      ctx.workspaceId,
      owner.kind,
      owner.row.id,
      input.filename,
      input.mime ?? null,
      bytes.byteLength,
      ctx.actor.id,
      now(),
    ],
  )
  await emitEvent(
    ctx,
    'attachment.added',
    owner.kind,
    owner.row.id,
    `attached ${input.filename} to ${input.item ?? input.doc}`,
  )
  flushPendingEvents()
  return {
    id,
    filename: input.filename,
    size: bytes.byteLength,
    url: attachmentUrl(id),
  }
}

export async function attachmentDelete(
  ctx: ICtx,
  store: AttachmentStore,
  id: string,
) {
  const rows = await ctx.db.query<{
    id: string
    kind: string
    filename: string
    owner_kind: string
    owner_id: string
  }>(
    'SELECT id, kind, filename, owner_kind, owner_id FROM attachment WHERE workspace_id = ? AND id = ?',
    [ctx.workspaceId, id],
  )
  if (rows.length === 0) throw new ApiError(404, `attachment ${id} not found`)
  const meta = rows[0]
  await ctx.db.run('DELETE FROM attachment WHERE id = ?', [id])
  if (meta.kind === 'file') await store.remove(id)
  await emitEvent(
    ctx,
    'attachment.removed',
    meta.owner_kind as 'item' | 'doc',
    meta.owner_id,
    `removed attachment ${meta.filename}`,
  )
  flushPendingEvents()
  return { ok: true as const }
}

export async function attachmentGet(
  ctx: ICtx,
  store: AttachmentStore,
  id: string,
) {
  const rows = await ctx.db.query<{
    id: string
    kind: string
    filename: string
    mime: string | null
    url: string | null
  }>(
    'SELECT id, kind, filename, mime, url FROM attachment WHERE workspace_id = ? AND id = ?',
    [ctx.workspaceId, id],
  )
  if (rows.length === 0) throw new ApiError(404, `attachment ${id} not found`)
  const meta = rows[0]
  if (meta.kind === 'url') return { meta, bytes: null }
  const bytes = await store.read(id)
  if (!bytes) throw new ApiError(404, `attachment ${id} content missing`)
  return { meta, bytes }
}
