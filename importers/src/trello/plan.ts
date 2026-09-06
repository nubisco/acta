/**
 * Pure Trello-export → Acta plan converter (mvp F11). No I/O: takes parsed
 * board exports plus workspace context, returns the batch ops to send and the
 * per-board source counts for reconciliation. Every op_id derives from the
 * Trello source id, so applying the plan twice cannot duplicate anything.
 */

import { BOARD_KEY_RE, slugify } from '@nubisco/acta-shared'
import type {
  TBoardOp,
  TImportedMeta,
  TItemOp,
  TLabelOp,
} from '@nubisco/acta-shared'
import type { ISkipEntry } from '../lib/report'
import type {
  TTrelloAction,
  TTrelloBoard,
  TTrelloCard,
  TTrelloLabel,
} from './model'
import { trelloIdToDate } from './model'

export type TItemCreate = Extract<TItemOp, { op: 'create' }>

const TITLE_MAX = 500
const DESC_MAX = 100_000
const COMMENT_MAX = 50_000

// ---------------------------------------------------------------------------
// Board keys: --key flag wins; otherwise a prompt-free heuristic (uppercase
// initials for multi-word names, first two letters for single words), unique
// among existing + planned keys, always matching BOARD_KEY_RE.
// ---------------------------------------------------------------------------

export function boardKeyFor(name: string, taken: Set<string>): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
  let base =
    words.length >= 2
      ? words
          .map((w) => w[0])
          .join('')
          .slice(0, 5)
      : (words[0] ?? '').slice(0, 2)
  if (base.length < 2) base = `${base}X`.slice(0, 2)
  if (!/^[A-Z]/.test(base)) base = `B${base}`.slice(0, 5)
  let key = base
  let n = 2
  while (taken.has(key) || !BOARD_KEY_RE.test(key)) {
    key = `${base.slice(0, 4)}${n}`
    n += 1
    if (n > 99) throw new Error(`cannot derive a unique board key for ${name}`)
  }
  taken.add(key)
  return key
}

// ---------------------------------------------------------------------------
// List roles inferred from the house list names (mvp F11).
// ---------------------------------------------------------------------------

export type TRole =
  'backlog' | 'active' | 'blocked' | 'review' | 'done' | 'inbox' | 'none'

export function inferListRole(name: string): TRole {
  const n = name.toLowerCase()
  if (n.includes('inbox')) return 'inbox'
  if (n.includes('backlog') || n.includes('to do') || n.includes('todo'))
    return 'backlog'
  if (n.includes('progress') || n.includes('doing') || n.includes('triag'))
    return 'active'
  if (n.includes('blocked') || n.includes('waiting')) return 'blocked'
  if (n.includes('review') || n.includes('testing')) return 'review'
  if (n.includes('done') || n.includes('published') || n.includes('shipped'))
    return 'done'
  return 'none'
}

// ---------------------------------------------------------------------------
// Plan shapes
// ---------------------------------------------------------------------------

export interface ITrelloPlanInput {
  board: TTrelloBoard
  file?: string
  forcedKey?: string
}

export interface ITrelloPlanOptions {
  /** trello username → acta handle. Unknown members are skipped + reported. */
  memberMap: Record<string, string>
  /** Lowercased names of labels already in workspace groups (reused as-is). */
  existingWorkspaceLabels: Set<string>
  /** Board keys already present on the server (collision avoidance). */
  existingBoardKeys: Set<string>
  /** When known, mapped handles are validated against this set. */
  existingActorHandles?: Set<string>
  /** true = every board; a Set restricts to those board keys. */
  doneAsArchived: boolean | Set<string>
}

export interface IPlannedAttachment {
  trelloId: string
  filename: string
  url: string
  upload: boolean
  bytes: number | null
  mime: string | null
}

export interface IPlannedComment {
  opId: string
  body: string
  meta: TImportedMeta
}

export interface IPlannedItem {
  cardId: string
  shortLink: string
  createdAt: string | null
  listName: string
  create: TItemCreate
  /** Same provenance as the create op, re-sent by run as set_meta so items
   *  that already exist from an earlier import get enriched too. */
  meta: TImportedMeta
  comments: IPlannedComment[]
  complete: boolean
  archive: boolean
  attachments: IPlannedAttachment[]
  checklistCount: number
}

export interface ITrelloBoardPlan {
  sourceId: string
  file?: string
  key: string
  name: string
  boardOps: TBoardOp[]
  items: IPlannedItem[]
  counts: Record<string, number>
  skips: ISkipEntry[]
  notes: string[]
}

export interface ITrelloPlan {
  labelOps: TLabelOp[]
  boards: ITrelloBoardPlan[]
}

// ---------------------------------------------------------------------------

function baseColor(color: string | null | undefined): string | null {
  if (!color) return null
  return color.split('_')[0]
}

function truncate(
  text: string,
  max: number,
  notes: string[],
  what: string,
): string {
  if (text.length <= max) return text
  notes.push(`${what} truncated from ${text.length} to ${max} chars`)
  return text.slice(0, max)
}

/** Labels attached to a card, resolved from either shape of the export. */
function cardLabels(card: TTrelloCard, byId: Map<string, TTrelloLabel>) {
  if (card.labels.length > 0) return card.labels
  return card.idLabels
    .map((id) => byId.get(id))
    .filter((l): l is TTrelloLabel => l !== undefined)
}

export function planTrelloImport(
  inputs: ITrelloPlanInput[],
  opts: ITrelloPlanOptions,
): ITrelloPlan {
  const takenKeys = new Set(opts.existingBoardKeys)
  const labelOps: TLabelOp[] = []
  const plannedWorkspaceLabels = new Set<string>()
  const boards: ITrelloBoardPlan[] = []

  for (const input of inputs) {
    const source = input.board
    let key = input.forcedKey
    if (key) {
      if (!BOARD_KEY_RE.test(key))
        throw new Error(`--key ${key} is not a valid board key (2-5 A-Z0-9)`)
      takenKeys.add(key)
    } else {
      key = boardKeyFor(source.name, takenKeys)
    }

    const skips: ISkipEntry[] = []
    const notes: string[] = []
    const boardOps: TBoardOp[] = [
      {
        op: 'create',
        op_id: `trello:${source.id}`,
        key,
        name: source.name,
        description: source.desc || undefined,
        template: 'none',
      },
    ]

    // Lists: keep Trello order, dedupe names (items address lists by name).
    const lists = [...source.lists].sort((a, b) => a.pos - b.pos)
    const listNameById = new Map<string, string>()
    const usedNames = new Set<string>()
    for (const list of lists) {
      let name = list.name
      let n = 2
      while (usedNames.has(name.toLowerCase())) {
        name = `${list.name} (${n})`
        n += 1
      }
      if (name !== list.name)
        notes.push(`duplicate list name "${list.name}" imported as "${name}"`)
      usedNames.add(name.toLowerCase())
      listNameById.set(list.id, name)
      if (list.closed)
        notes.push(`Trello list "${name}" was archived; imported as open list`)
      boardOps.push({
        op: 'list_create',
        op_id: `trello:${list.id}`,
        board: key,
        name,
        role: inferListRole(list.name),
        pos: list.pos,
      })
    }

    // Labels: named ones merge into the workspace "Type" group (reusing the
    // seeded taxonomy by name); color-only ones become board-scoped
    // color-<color> labels in a "<KEY> Colors" board group.
    const labelById = new Map(source.labels.map((l) => [l.id, l]))
    const labelRef = new Map<string, string | null>()
    let colorGroupCreated = false
    const plannedBoardColors = new Set<string>()
    const allCardLabels = source.cards.flatMap((c) => cardLabels(c, labelById))
    for (const label of [...source.labels, ...allCardLabels]) {
      if (labelRef.has(label.id)) continue
      const color = baseColor(label.color)
      if (label.name) {
        labelRef.set(label.id, label.name)
        const lower = label.name.toLowerCase()
        if (
          !opts.existingWorkspaceLabels.has(lower) &&
          !plannedWorkspaceLabels.has(lower)
        ) {
          plannedWorkspaceLabels.add(lower)
          labelOps.push({
            op: 'label_create',
            op_id: `trello:label:${slugify(label.name) || label.id}`,
            group: 'Type',
            name: label.name.slice(0, 100),
            color: color ?? 'gray',
          })
        }
      } else if (color) {
        const name = `color-${color}`
        labelRef.set(label.id, name)
        if (!colorGroupCreated) {
          colorGroupCreated = true
          labelOps.push({
            op: 'group_create',
            op_id: `trello:${source.id}:colors`,
            name: `${key} Colors`,
            board: key,
          })
        }
        if (!plannedBoardColors.has(name)) {
          plannedBoardColors.add(name)
          labelOps.push({
            op: 'label_create',
            op_id: `trello:${source.id}:label:${name}`,
            group: `${key} Colors`,
            name,
            color,
          })
        }
      } else {
        labelRef.set(label.id, null)
        skips.push({
          kind: 'labels',
          id: label.id,
          reason: 'label has neither name nor color; dropped',
        })
      }
    }

    // Cards: stable order (list by list, by position) so server-side sequence
    // keys are deterministic on a fresh board.
    const checklistsByCard = new Map<string, typeof source.checklists>()
    for (const checklist of source.checklists) {
      const bucket = checklistsByCard.get(checklist.idCard) ?? []
      bucket.push(checklist)
      checklistsByCard.set(checklist.idCard, bucket)
    }
    const commentsByCard = new Map<string, TTrelloAction[]>()
    for (const action of source.actions) {
      if (action.type !== 'commentCard') continue
      const cardId = action.data.card?.id
      if (!cardId) continue
      const bucket = commentsByCard.get(cardId) ?? []
      bucket.push(action)
      commentsByCard.set(cardId, bucket)
    }

    const doneAsArchived =
      opts.doneAsArchived === true ||
      (opts.doneAsArchived instanceof Set && opts.doneAsArchived.has(key))

    const items: IPlannedItem[] = []
    const counts: Record<string, number> = {
      lists: lists.length,
      items_open: 0,
      items_archived: 0,
      comments: 0,
      checklists: 0,
      attachments: 0,
    }

    const orderedCards = [...source.cards].sort((a, b) => {
      const la = lists.findIndex((l) => l.id === a.idList)
      const lb = lists.findIndex((l) => l.id === b.idList)
      if (la !== lb) return la - lb
      return a.pos - b.pos
    })

    for (const card of orderedCards) {
      const listName = listNameById.get(card.idList)
      if (!listName) {
        skips.push({
          kind: card.closed ? 'items_archived' : 'items_open',
          id: card.id,
          reason: `card list ${card.idList} not present in export`,
        })
        counts[card.closed ? 'items_archived' : 'items_open'] += 1
        continue
      }

      const labels: string[] = []
      for (const label of cardLabels(card, labelById)) {
        const ref = labelRef.get(label.id)
        if (ref && !labels.includes(ref)) labels.push(ref)
      }

      const assignees: string[] = []
      for (const memberId of card.idMembers) {
        const member = source.members.find((m) => m.id === memberId)
        const username = member?.username ?? memberId
        const handle = opts.memberMap[username]
        if (!handle) {
          skips.push({
            kind: 'assignees',
            id: `${card.id}/${username}`,
            reason: `no member-map entry for trello user ${username}`,
          })
          continue
        }
        if (
          opts.existingActorHandles &&
          !opts.existingActorHandles.has(handle)
        ) {
          skips.push({
            kind: 'assignees',
            id: `${card.id}/${username}`,
            reason: `mapped handle ${handle} does not exist in the workspace`,
          })
          continue
        }
        if (!assignees.includes(handle)) assignees.push(handle)
      }

      const checklists = (checklistsByCard.get(card.id) ?? [])
        .sort((a, b) => a.pos - b.pos)
        .map((cl) => ({
          name: cl.name,
          items: [...cl.checkItems]
            .sort((a, b) => a.pos - b.pos)
            .map((ci) => ({ text: ci.name, done: ci.state === 'complete' })),
        }))
      counts.checklists += checklists.length

      const actions = (commentsByCard.get(card.id) ?? []).sort((a, b) =>
        a.date.localeCompare(b.date),
      )
      const comments: IPlannedComment[] = actions.map((action) => {
        const author =
          action.memberCreator?.fullName ||
          action.memberCreator?.username ||
          'unknown'
        const body = `**[imported]** ${author} · ${action.date}:\n\n${action.data.text ?? ''}`
        return {
          opId: `trello:${card.id}:comment:${action.id}`,
          body: truncate(body, COMMENT_MAX, notes, `comment on ${card.id}`),
          meta: {
            source: 'trello',
            author,
            created_at: action.date || undefined,
          },
        }
      })
      const knownComments = Math.max(card.badges?.comments ?? 0, actions.length)
      counts.comments += knownComments
      if (knownComments > actions.length) {
        skips.push({
          kind: 'comments',
          id: card.id,
          reason: `${knownComments - actions.length} comment(s) missing from the export's action window`,
          n: knownComments - actions.length,
        })
      }

      const attachments: IPlannedAttachment[] = card.attachments
        .filter((a) => a.url)
        .map((a) => ({
          trelloId: a.id,
          filename: a.name || a.url.split('/').pop() || a.id,
          url: a.url,
          upload: a.isUpload,
          bytes: a.bytes ?? null,
          mime: a.mimeType ?? null,
        }))
      for (const att of card.attachments.filter((a) => !a.url)) {
        skips.push({
          kind: 'attachments',
          id: att.id,
          reason: 'attachment has no url in the export',
        })
      }
      counts.attachments += card.attachments.length

      const due = card.due ? Date.parse(card.due) : Number.NaN
      const role = inferListRole(listName)
      const archive = card.closed || (doneAsArchived && role === 'done')
      counts[archive ? 'items_archived' : 'items_open'] += 1

      const meta: TImportedMeta = {
        source: 'trello',
        url: card.shortLink
          ? `https://trello.com/c/${card.shortLink}`
          : undefined,
      }
      items.push({
        cardId: card.id,
        shortLink: card.shortLink,
        createdAt: trelloIdToDate(card.id)?.toISOString() ?? null,
        listName,
        create: {
          op: 'create',
          op_id: `trello:${card.id}`,
          board: key,
          list: listName,
          title: truncate(card.name, TITLE_MAX, notes, `title of ${card.id}`),
          description: card.desc
            ? truncate(card.desc, DESC_MAX, notes, `description of ${card.id}`)
            : undefined,
          labels: labels.length > 0 ? labels : undefined,
          assignees: assignees.length > 0 ? assignees : undefined,
          due: Number.isFinite(due) ? due : undefined,
          checklists: checklists.length > 0 ? checklists : undefined,
          imported_meta: meta,
        },
        meta,
        comments,
        complete: card.dueComplete,
        archive,
        attachments,
        checklistCount: checklists.length,
      })
    }

    if (doneAsArchived)
      notes.push('done-role lists imported as archived items (per flag)')

    boards.push({
      sourceId: source.id,
      file: input.file,
      key,
      name: source.name,
      boardOps,
      items,
      counts,
      skips,
      notes,
    })
  }

  return { labelOps, boards }
}
