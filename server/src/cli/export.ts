/**
 * Export (mvp F13): a human-readable second backup. Docs become a markdown
 * directory tree mirroring slugs; boards become JSONL; labels/actors JSON;
 * attachments are copied by id. Usage:
 *   bun src/cli/export.ts [--data ./data] [--out ./export]
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { serializeFrontmatter } from '@nubisco/acta-shared'
import { openDb } from '../db'

function arg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag)
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback
}

const dataDir = arg('--data', './data')
const outDir = arg('--out', './export')

const db = openDb(`${dataDir}/acta.sqlite`)
mkdirSync(outDir, { recursive: true })

// Docs → markdown tree ------------------------------------------------------
const docs = db.query<{
  id: string
  slug: string
  title: string
  layout: string
  tags: string
  body: string
  archived: number
}>('SELECT id, slug, title, layout, tags, body, archived FROM document')
mkdirSync(join(outDir, 'docs'), { recursive: true })
for (const doc of docs) {
  const frontmatter: Record<string, string | string[]> = {
    id: doc.id,
    title: doc.title,
  }
  if (doc.layout !== 'default') frontmatter.layout = doc.layout
  const tags = JSON.parse(doc.tags) as string[]
  if (tags.length > 0) frontmatter.tags = tags
  if (doc.archived === 1) frontmatter.archived = 'true'
  const path = join(outDir, 'docs', `${doc.slug}.md`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeFrontmatter({ frontmatter, body: doc.body }))
}

// Boards → JSONL ------------------------------------------------------------
const boards = db.query<{
  id: string
  key: string
  name: string
  description: string
  archived: number
}>('SELECT id, key, name, description, archived FROM board')
mkdirSync(join(outDir, 'boards'), { recursive: true })
let itemTotal = 0
for (const board of boards) {
  const lists = db.query<{
    id: string
    name: string
    role: string
    pos: number
    archived: number
  }>(
    'SELECT id, name, role, pos, archived FROM list WHERE board_id = ? ORDER BY pos',
    [board.id],
  )
  const items = db.query<{
    id: string
    key: string
    title: string
    description: string
    list_id: string
    pos: number
    due: number | null
    completed: number
    archived: number
    created_at: number
    updated_at: number
  }>('SELECT * FROM item WHERE board_id = ? ORDER BY key', [board.id])
  const lines: string[] = [
    JSON.stringify({
      kind: 'board',
      key: board.key,
      name: board.name,
      description: board.description,
      archived: board.archived === 1,
      lists: lists.map((l) => ({
        name: l.name,
        role: l.role,
        archived: l.archived === 1,
      })),
    }),
  ]
  for (const item of items) {
    itemTotal++
    const listName = lists.find((l) => l.id === item.list_id)?.name
    const labels = db
      .query<{ name: string }>(
        'SELECT lb.name FROM item_label il JOIN label lb ON lb.id = il.label_id WHERE il.item_id = ?',
        [item.id],
      )
      .map((r) => r.name)
    const assignees = db
      .query<{ handle: string }>(
        'SELECT a.handle FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id WHERE ia.item_id = ?',
        [item.id],
      )
      .map((r) => r.handle)
    const comments = db.query<{
      body: string
      created_at: number
      handle: string
    }>(
      'SELECT c.body, c.created_at, a.handle FROM comment c JOIN actor a ON a.id = c.actor_id WHERE c.item_id = ? ORDER BY c.created_at',
      [item.id],
    )
    const checklists = db
      .query<{ id: string; name: string }>(
        'SELECT id, name FROM checklist WHERE item_id = ? ORDER BY pos',
        [item.id],
      )
      .map((cl) => ({
        name: cl.name,
        items: db
          .query<{ text: string; done: number }>(
            'SELECT text, done FROM checklist_item WHERE checklist_id = ? ORDER BY pos',
            [cl.id],
          )
          .map((ci) => ({ text: ci.text, done: ci.done === 1 })),
      }))
    lines.push(
      JSON.stringify({
        kind: 'item',
        key: item.key,
        title: item.title,
        list: listName,
        description: item.description,
        labels,
        assignees,
        due: item.due,
        completed: item.completed === 1,
        archived: item.archived === 1,
        created_at: item.created_at,
        updated_at: item.updated_at,
        comments,
        checklists,
      }),
    )
  }
  writeFileSync(
    join(outDir, 'boards', `${board.key}.jsonl`),
    lines.join('\n') + '\n',
  )
}

// Labels, actors, attachments ----------------------------------------------
writeFileSync(
  join(outDir, 'labels.json'),
  JSON.stringify(
    db.query(
      `SELECT g.name AS group_name, b.key AS board_key, l.name, l.color
         FROM label l JOIN label_group g ON g.id = l.group_id LEFT JOIN board b ON b.id = g.board_id`,
    ),
    null,
    2,
  ),
)
writeFileSync(
  join(outDir, 'actors.json'),
  JSON.stringify(
    db.query('SELECT handle, name, kind, email, role, disabled FROM actor'),
    null,
    2,
  ),
)
if (existsSync(join(dataDir, 'attachments'))) {
  cpSync(join(dataDir, 'attachments'), join(outDir, 'attachments'), {
    recursive: true,
  })
}

console.log(
  `exported ${docs.length} docs, ${boards.length} boards, ${itemTotal} items to ${outDir}`,
)
