/**
 * The subset of Trello's board-export JSON the importer reads (the shape of
 * trello.com board export and of
 * GET /1/boards/{id}?fields=all&cards=all&lists=all&labels=all&checklists=all
 *   &actions=commentCard&attachments=true).
 * Parsing is lenient: unknown fields are ignored, absent ones defaulted.
 */

import { z } from 'zod'

export const zTrelloLabel = z.object({
  id: z.string(),
  name: z.string().default(''),
  color: z.string().nullish(),
})
export type TTrelloLabel = z.infer<typeof zTrelloLabel>

export const zTrelloList = z.object({
  id: z.string(),
  name: z.string(),
  closed: z.boolean().default(false),
  pos: z.number().default(0),
})
export type TTrelloList = z.infer<typeof zTrelloList>

export const zTrelloAttachment = z.object({
  id: z.string(),
  name: z.string().default(''),
  url: z.string().default(''),
  isUpload: z.boolean().default(false),
  bytes: z.number().nullish(),
  mimeType: z.string().nullish(),
})
export type TTrelloAttachment = z.infer<typeof zTrelloAttachment>

export const zTrelloBadges = z
  .object({ comments: z.number().default(0) })
  .partial()

export const zTrelloCard = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string().default(''),
  closed: z.boolean().default(false),
  idList: z.string(),
  pos: z.number().default(0),
  due: z.string().nullish(),
  dueComplete: z.boolean().default(false),
  idLabels: z.array(z.string()).default([]),
  labels: z.array(zTrelloLabel).default([]),
  idMembers: z.array(z.string()).default([]),
  shortLink: z.string().default(''),
  badges: zTrelloBadges.nullish(),
  attachments: z.array(zTrelloAttachment).default([]),
})
export type TTrelloCard = z.infer<typeof zTrelloCard>

export const zTrelloCheckItem = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string().default('incomplete'),
  pos: z.number().default(0),
})

export const zTrelloChecklist = z.object({
  id: z.string(),
  idCard: z.string(),
  name: z.string(),
  pos: z.number().default(0),
  checkItems: z.array(zTrelloCheckItem).default([]),
})
export type TTrelloChecklist = z.infer<typeof zTrelloChecklist>

export const zTrelloAction = z.object({
  id: z.string(),
  type: z.string(),
  date: z.string().default(''),
  data: z
    .object({
      card: z.object({ id: z.string() }).nullish(),
      text: z.string().nullish(),
    })
    .default({}),
  memberCreator: z
    .object({
      username: z.string().default(''),
      fullName: z.string().default(''),
    })
    .nullish(),
})
export type TTrelloAction = z.infer<typeof zTrelloAction>

export const zTrelloMember = z.object({
  id: z.string(),
  username: z.string(),
  fullName: z.string().default(''),
})

export const zTrelloBoard = z.object({
  id: z.string(),
  name: z.string(),
  desc: z.string().default(''),
  shortLink: z.string().default(''),
  lists: z.array(zTrelloList).default([]),
  cards: z.array(zTrelloCard).default([]),
  labels: z.array(zTrelloLabel).default([]),
  checklists: z.array(zTrelloChecklist).default([]),
  actions: z.array(zTrelloAction).default([]),
  members: z.array(zTrelloMember).default([]),
})
export type TTrelloBoard = z.infer<typeof zTrelloBoard>

/** Creation timestamp recovered from the first 8 hex chars of a Trello id. */
export function trelloIdToDate(id: string): Date | null {
  const seconds = Number.parseInt(id.slice(0, 8), 16)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000)
}
