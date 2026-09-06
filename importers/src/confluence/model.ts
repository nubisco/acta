/**
 * Input shapes for the Confluence importer (mvp F12). Accepts both the
 * Confluence REST shape (body.storage.value, ancestors, version, history,
 * metadata.properties) and a simplified flat shape, normalized to one record.
 */

import { z } from 'zod'

const zId = z.union([z.string(), z.number()]).transform(String)

const zConfluenceCommentRaw = z.object({
  id: zId,
  /** Comment body in storage (XHTML) format. */
  body: z.string(),
  author: z.string().nullish(),
  created_at: z.string().nullish(),
  /** The highlighted text an inline comment anchors to. */
  inline_context: z.string().nullish(),
})

export const zConfluencePageRaw = z.object({
  id: zId,
  title: z.string().min(1),
  body: z.union([
    z.string(),
    z.object({ storage: z.object({ value: z.string() }) }),
  ]),
  parentId: zId.nullish(),
  ancestors: z.array(z.object({ id: zId })).nullish(),
  space: z.union([z.string(), z.object({ key: z.string() })]).nullish(),
  layout: z.enum(['default', 'wide']).nullish(),
  metadata: z.unknown().nullish(),
  version: z
    .union([
      z.number(),
      z.object({
        number: z.number().nullish(),
        when: z.string().nullish(),
        by: z.object({ displayName: z.string().nullish() }).nullish(),
      }),
    ])
    .nullish(),
  history: z
    .object({
      createdBy: z.object({ displayName: z.string().nullish() }).nullish(),
      createdDate: z.string().nullish(),
    })
    .nullish(),
  comments: z.array(zConfluenceCommentRaw).nullish(),
})

export interface IConfluenceComment {
  id: string
  body: string
  author: string | null
  createdAt: string | null
  inlineContext: string | null
}

export interface IConfluencePage {
  id: string
  title: string
  storage: string
  parentId: string | null
  spaceKey: string | null
  wide: boolean
  versionCount: number | null
  updatedAt: string | null
  authorName: string | null
  createdAt: string | null
  comments: IConfluenceComment[]
}

function metadataWide(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null) return false
  const properties = (metadata as Record<string, unknown>).properties
  if (typeof properties !== 'object' || properties === null) return false
  for (const key of [
    'content-appearance-published',
    'content-appearance-draft',
  ]) {
    const prop = (properties as Record<string, unknown>)[key]
    if (typeof prop === 'object' && prop !== null) {
      const value = (prop as Record<string, unknown>).value
      if (value === 'full-width') return true
    }
    if (prop === 'full-width') return true
  }
  return false
}

export function normalizePage(raw: unknown): IConfluencePage {
  const page = zConfluencePageRaw.parse(raw)
  const version = page.version
  return {
    id: page.id,
    title: page.title,
    storage:
      typeof page.body === 'string' ? page.body : page.body.storage.value,
    parentId:
      page.parentId ??
      (page.ancestors && page.ancestors.length > 0
        ? page.ancestors[page.ancestors.length - 1].id
        : null),
    spaceKey:
      typeof page.space === 'string' ? page.space : (page.space?.key ?? null),
    wide: page.layout === 'wide' || metadataWide(page.metadata),
    versionCount:
      typeof version === 'number' ? version : (version?.number ?? null),
    updatedAt: typeof version === 'object' ? (version?.when ?? null) : null,
    authorName:
      (typeof version === 'object' ? version?.by?.displayName : undefined) ??
      page.history?.createdBy?.displayName ??
      null,
    createdAt: page.history?.createdDate ?? null,
    comments: (page.comments ?? []).map((comment) => ({
      id: comment.id,
      body: comment.body,
      author: comment.author ?? null,
      createdAt: comment.created_at ?? null,
      inlineContext: comment.inline_context ?? null,
    })),
  }
}
