import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { newId } from '@nubisco/acta-shared'
import { z } from 'zod'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { emitEvent } from '../core/events'
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

export class AttachmentStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  write(id: string, bytes: Uint8Array): void {
    writeFileSync(join(this.dir, id), bytes)
  }

  read(id: string): Uint8Array | null {
    const path = join(this.dir, id)
    if (!existsSync(path)) return null
    return readFileSync(path)
  }
}

export function attachmentAdd(
  ctx: ICtx,
  store: AttachmentStore,
  input: TAttachmentAdd,
) {
  const owner = input.item
    ? { kind: 'item' as const, row: itemByKey(ctx, input.item) }
    : { kind: 'doc' as const, row: docBySlug(ctx, input.doc!) }
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
    store.write(id, bytes)
    size = bytes.byteLength
  }
  ctx.db.run(
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
  emitEvent(
    ctx,
    'attachment.added',
    owner.kind,
    owner.row.id,
    `attached ${input.filename} to ${ownerRef}`,
  )
  return {
    id,
    filename: input.filename,
    size: size ?? undefined,
    url: input.url ?? undefined,
  }
}

export function attachmentGet(ctx: ICtx, store: AttachmentStore, id: string) {
  const rows = ctx.db.query<{
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
  const bytes = store.read(id)
  if (!bytes) throw new ApiError(404, `attachment ${id} content missing`)
  return { meta, bytes }
}
