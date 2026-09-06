/** Shapes mirrored from the compact server responses (conventions/types.md). */

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

export type TOverviewBoard = IOverview['boards'][number]

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
  imported?: IImportedMeta
  comments?: ICommentRow[]
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
  imported?: IImportedMeta
  sections?: { slug: string; level: number; hash: string }[]
  backlinks?: { src_kind: string; src_id: string }[]
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
  board?: string
}

export interface ILiveEvent {
  id: string
  verb: string
  entity: string
  entity_id: string
  actor_kind: string
}

export type TViewState = 'loading' | 'error' | 'forbidden' | 'ready'
