/** Shapes mirrored from the compact server responses (conventions/types.md). */

import type { IAnchor, TAnchorStatus } from '@nubisco/acta-shared'

export interface IOverview {
  workspace: { id: string; name: string }
  spaces: {
    key: string
    name: string
    archived?: boolean
    starred?: boolean
    lists: { id: string; name: string; role?: string; items: number }[]
  }[]
  labels: {
    group_name: string
    space_key: string | null
    id: string
    name: string
    color: string
  }[]
  actors: {
    id: string
    handle: string
    kind: string
    name: string
    role: string
    avatar_url?: string | null
  }[]
  doc_roots: { slug: string; title: string; children: number }[]
}

export type TOverviewSpace = IOverview['spaces'][number]

/** Provenance carried across from a migration source. */
export interface IImportedMeta {
  source: string
  author?: string
  created_at?: string
  updated_at?: string
  url?: string
  versions?: number
}

export interface ICommentRow {
  id: string
  by: string
  agent?: boolean
  ts: number
  body: string
  imported?: IImportedMeta
  /** Document comments only: the text an inline comment is anchored to. */
  anchor?: IAnchor
  /** Whether that text is still in the document. Absent on page comments. */
  anchor_status?: TAnchorStatus
  /** Set once resolved. A resolved comment is kept, just not highlighted. */
  resolved?: { ts: number; by?: string }
}

export interface ISpaceItemRow {
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
  created?: number
  pos: number
  description?: string
}

export interface IDependencyRef {
  key: string
  title: string
  done: boolean
}

export interface IItemDetail {
  key: string
  space: string
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
  imported?: IImportedMeta
  /** Unitless estimate used by the sequence view. */
  size?: number
  is_milestone?: boolean
  /** Cards that must finish before this one. */
  blocked_by?: IDependencyRef[]
  /** Cards waiting on this one. */
  blocks?: IDependencyRef[]
  comments?: ICommentRow[]
  checklists?: { name: string; items: { text: string; done: boolean }[] }[]
  links?: {
    out: { ref_type: string; target: string }[]
    in: { src_kind: string; src_id: string }[]
  }
  attachments?: IAttachment[]
  activity?: { ts: number; verb: string; summary: string; actor_kind: string }[]
}

/**
 * One attachment, as every read returns it.
 *
 * `url` is never null now: a link attachment reports its own address and an
 * uploaded file reports the one it is served from, so a caller can display
 * what it can see listed. `mime` is what decides between an image and a
 * download chip, which an id cannot answer.
 */
export interface IAttachment {
  id: string
  kind: string
  filename: string
  mime?: string
  size?: number
  url: string
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
  imported?: IImportedMeta
  /** Always returned: a body can embed one, so a reader needs the list. */
  attachments?: IAttachment[]
  sections?: { slug: string; level: number; hash: string }[]
  backlinks?: {
    src_kind: string
    src_id: string
    /** The card key or document slug, when the source still exists. */
    ref?: string | null
    /** Its title. A comment borrows the title of the card it is on. */
    label?: string | null
  }[]
  versions?: { rev: number; created_at: number; handle: string }[]
  comments?: ICommentRow[]
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

export interface ISearchResult {
  type: string
  ref: string
  title: string
  snippet: string
  space?: string
}

export interface ILiveEvent {
  id: string
  verb: string
  entity: string
  entity_id: string
  actor_kind: string
}

export type TViewState = 'loading' | 'error' | 'forbidden' | 'ready'

/** One row in the Home queue. Shaped by the server so every bucket matches. */
export interface IMyWorkItem {
  key: string
  title: string
  space: string
  space_key: string
  list: string
  due?: number
  overdue?: boolean
  completed?: boolean
  reason?: string
  at?: number
}
