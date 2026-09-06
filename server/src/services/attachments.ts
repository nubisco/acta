import { newId } from '@nubisco/acta-shared'
import { z } from 'zod'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { emitEvent, flushPendingEvents } from '../core/events'
import { docBySlug, itemByKey } from '../core/store'

export const zAttachmentAdd = z
  .object({
    item: z.string().optional(),
    doc: z.string().optional(),
    filename: z.string().min(1).max(300),
    mime: z.string().max(100).optional(),
    url: z.url().optional(),
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
    url: input.url ?? undefined,
  }
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
  return { id, filename: input.filename, size: bytes.byteLength }
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
