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
    group_id: string
    group_name: string
    space_key: string | null
    id: string
    name: string
    color: string
    /**
     * At most one label from this group on a card. Absent means several,
     * which is how every group behaved before this existed.
     */
    exclusive?: true
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
  /** Every goal, compact, for chips and pickers. */
  goals?: IGoalRef[]
  /** Workspace-wide policy, as Settings shows it and the server enforces it. */
  policy?: { comment_delete: TCommentDeletePolicy }
}

/** Who may delete a comment: its author, or only an admin. */
export type TCommentDeletePolicy = 'author' | 'admin'

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
  /** When it was last edited. Absent means never edited. */
  edited?: number
  /**
   * The server has decided this person may edit, or delete, this comment.
   * Authoritative: the policy (author-only editing, and a workspace setting
   * for whether non-admins may delete) lives on the server so that no client
   * has to re-derive it from handles and roles and get it subtly wrong.
   */
  can_edit?: true
  can_delete?: true
}

export interface ISpaceItemRow {
  key: string
  title: string
  list: string
  /** Label names, position for position with `label_ids`. */
  labels?: string[]
  /**
   * The same labels as ids. A name does not identify a label any more:
   * "Affects version" and "Fixes version" both list 1.12.0, so a card
   * carrying both would otherwise show one chip twice and a filter on the
   * name would match either of them.
   */
  label_ids?: string[]
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
  /** The card this one is part of, when it is part of something. */
  parent_key?: string
  /** How many cards are part of this one, and how many of those are done.
   *  Absent rather than zero, so a card with no parts carries nothing. */
  parts_total?: number
  parts_done?: number
}

export interface IDependencyRef {
  key: string
  title: string
  done: boolean
}

/**
 * A card on either end of a "Part of" link.
 *
 * It names its space, which a dependency ref does not: a part may live on
 * another board, and that is the point of the relation rather than an edge
 * case, so the reader has to be told where they are being sent.
 */
export interface IPartRef {
  key: string
  title: string
  space: string
  done?: boolean
}

export interface IItemDetail {
  key: string
  space: string
  list: string
  title: string
  description: string
  labels?: string[]
  /**
   * The same labels by id, in the same order. A name no longer says which
   * group a value belongs to: "Affects version" and "Fixes version" both
   * list 1.12.0, so anything that cares about the group resolves through
   * these against the overview catalogue.
   */
  label_ids?: string[]
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
  /** The card this one is part of. A different relation from `blocked_by`:
   *  composition, not sequence, and the wording stays "Part of" throughout. */
  parent?: IPartRef
  /** The cards that are part of this one. Any depth, across spaces. */
  parts?: IPartRef[]
  /** The goals this card serves. `via` names the card the link is actually
   *  on, when that is something this card is part of. */
  goals?: (IGoalRef & { via?: string })[]
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
  /** Who made the card. */
  created_by?: string
  /** The card's history, newest first, when asked for with `activity`. */
  activity?: IItemEvent[]
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
  /**
   * The parent page's slug, or null at the top level. Read this rather than
   * the slug's path, which still describes where the page was created.
   */
  parent?: string | null
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
  /**
   * What the row opens, resolved by the server from `entity_id`, which is an
   * internal id and no use to a browser. Absent when the event is about
   * neither, such as a label or a space change.
   */
  item_key?: string
  doc_slug?: string
  goal_number?: number
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

/** The owner's judgement of a goal, as opposed to its measured progress. */
export type TGoalStatus =
  | 'pending'
  | 'on_track'
  | 'at_risk'
  | 'off_track'
  | 'done'
  | 'paused'
  | 'cancelled'

/** A goal as the overview lists it. */
export interface IGoalRef {
  number: number
  key: string
  title: string
  status: TGoalStatus | string
  parent?: number
  archived?: true
}

/** Measured from the cards that serve a goal, never stored. */
export interface IGoalProgress {
  cards_total: number
  cards_done: number
  cards_active: number
  cards_waiting: number
  cards_overdue: number
  weight_total: number
  weight_done: number
  /** Absent when there is nothing to measure. */
  percent?: number
}

export interface IGoalMetric {
  name: string
  unit?: string
  start: number
  target: number
  current: number
  percent: number
}

/** One goal in a list, everything a row needs to be drawn and judged. */
export interface IGoalRow {
  number: number
  key: string
  title: string
  status: TGoalStatus
  owner?: string
  parent?: number
  start_date?: number
  target_date?: number
  archived?: true
  metric?: IGoalMetric
  progress: IGoalProgress
  /** Cards linked to this goal itself. */
  linked: number
  sub_goals?: number
  /** How far through its date window, 0 to 100. */
  elapsed?: number
  overdue?: true
  /** In flight with nothing said about it for a month. */
  stale?: true
  last_check_in?: { ts: number; by: string; status?: TGoalStatus }
  following?: true
  rev: number
  updated: number
}

export interface IGoalSummary {
  total: number
  in_flight: number
  by_status: Record<TGoalStatus, number>
  overdue: number
  stale: number
  work: IGoalProgress
}

export interface IGoalCard {
  key: string
  title: string
  space: string
  list: string
  done?: true
  active?: true
  waiting?: true
  overdue?: true
  size: number
  linked?: true
  via?: string
}

export interface IGoalCheckIn {
  id: string
  by: string
  ts: number
  edited?: number
  status?: TGoalStatus
  body?: string
  metric_value?: number
  can_edit?: true
  can_delete?: true
}

export interface IGoalDetail extends IGoalRow {
  description: string
  created: number
  created_by?: string
  followers: string[]
  /** Its sub-goals, each with its own progress. */
  children: IGoalRow[]
  ancestors: { number: number; key: string; title: string }[]
  items?: IGoalCard[]
  check_ins?: IGoalCheckIn[]
}

/**
 * One thing that happened to a card. `changes` is what the event recorded,
 * with people as handles and labels as `Group/Name`; events written before
 * the history existed may carry nothing beyond `summary`.
 */
export interface IItemEvent {
  id: string
  ts: number
  verb: string
  summary: string
  by?: string
  actor_kind: string
  automated?: true
  changes?: Record<string, unknown>
}
