/**
 * Export (mvp F13): a human-readable second backup. Docs become a markdown
 * directory tree mirroring slugs; spaces become JSONL; labels/actors JSON;
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

const db = await openDb(`${dataDir}/acta.sqlite`)
mkdirSync(outDir, { recursive: true })

// Docs → markdown tree ------------------------------------------------------
const docs = await db.query<{
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

// Spaces → JSONL ------------------------------------------------------------
const spaces = await db.query<{
  id: string
  key: string
  name: string
  description: string
  archived: number
}>('SELECT id, key, name, description, archived FROM space')
mkdirSync(join(outDir, 'spaces'), { recursive: true })
let itemTotal = 0
for (const space of spaces) {
  const lists = await db.query<{
    id: string
    name: string
    role: string
    pos: number
    archived: number
  }>(
    'SELECT id, name, role, pos, archived FROM list WHERE space_id = ? ORDER BY pos',
    [space.id],
  )
  const items = await db.query<{
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
  }>('SELECT * FROM item WHERE space_id = ? ORDER BY key', [space.id])
  const lines: string[] = [
    JSON.stringify({
      kind: 'space',
      key: space.key,
      name: space.name,
      description: space.description,
      archived: space.archived === 1,
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
    const labels = (
      await db.query<{ name: string }>(
        'SELECT lb.name FROM item_label il JOIN label lb ON lb.id = il.label_id WHERE il.item_id = ?',
        [item.id],
      )
    ).map((r) => r.name)
    const assignees = (
      await db.query<{ handle: string }>(
        'SELECT a.handle FROM item_assignee ia JOIN actor a ON a.id = ia.actor_id WHERE ia.item_id = ?',
        [item.id],
      )
    ).map((r) => r.handle)
    const comments = await db.query<{
      body: string
      created_at: number
      handle: string
    }>(
      'SELECT c.body, c.created_at, a.handle FROM comment c JOIN actor a ON a.id = c.actor_id WHERE c.item_id = ? ORDER BY c.created_at',
      [item.id],
    )
    const checklistRows = await db.query<{ id: string; name: string }>(
      'SELECT id, name FROM checklist WHERE item_id = ? ORDER BY pos',
      [item.id],
    )
    const checklists = []
    for (const cl of checklistRows) {
      checklists.push({
        name: cl.name,
        items: (
          await db.query<{ text: string; done: number }>(
            'SELECT text, done FROM checklist_item WHERE checklist_id = ? ORDER BY pos',
            [cl.id],
          )
        ).map((ci) => ({ text: ci.text, done: ci.done === 1 })),
      })
    }
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
    join(outDir, 'spaces', `${space.key}.jsonl`),
    lines.join('\n') + '\n',
  )
}

// Labels, actors, goals, attachments ----------------------------------------
// Awaited: these two used to stringify the pending promise, so every export
// wrote `{}` to both files.
writeFileSync(
  join(outDir, 'labels.json'),
  JSON.stringify(
    await db.query(
      `SELECT g.name AS group_name, b.key AS space_key, l.name, l.color
         FROM label l JOIN label_group g ON g.id = l.group_id LEFT JOIN space b ON b.id = g.space_id`,
    ),
    null,
    2,
  ),
)
writeFileSync(
  join(outDir, 'actors.json'),
  JSON.stringify(
    await db.query(
      'SELECT handle, name, kind, email, role, disabled FROM actor',
    ),
    null,
    2,
  ),
)
// Goals, with what they are made of: the cards linked to each (by key, so
// the file reads alongside the space exports), the check-ins and followers.
const goals = await db.query<{
  id: string
  number: number
  title: string
  description: string
  owner: string | null
  parent: number | null
  status: string
  start_date: number | null
  target_date: number | null
  metric_name: string | null
  metric_unit: string | null
  metric_start: number | null
  metric_target: number | null
  metric_current: number | null
  archived: number
}>(
  `SELECT g.id, g.number, g.title, g.description, o.handle AS owner, p.number AS parent,
          g.status, g.start_date, g.target_date, g.metric_name, g.metric_unit,
          g.metric_start, g.metric_target, g.metric_current, g.archived
     FROM goal g LEFT JOIN actor o ON o.id = g.owner_id LEFT JOIN goal p ON p.id = g.parent_id
    ORDER BY g.number`,
)
const goalExport = []
for (const { id, ...goal } of goals) {
  goalExport.push({
    ...goal,
    items: (
      await db.query<{ key: string }>(
        'SELECT i.key FROM goal_item gi JOIN item i ON i.id = gi.item_id WHERE gi.goal_id = ? ORDER BY i.key',
        [id],
      )
    ).map((r) => r.key),
    followers: (
      await db.query<{ handle: string }>(
        'SELECT a.handle FROM goal_follower f JOIN actor a ON a.id = f.actor_id WHERE f.goal_id = ?',
        [id],
      )
    ).map((r) => r.handle),
    check_ins: await db.query(
      `SELECT a.handle AS by, u.status, u.body, u.metric_value, u.created_at
         FROM goal_update u JOIN actor a ON a.id = u.actor_id
        WHERE u.goal_id = ? ORDER BY u.created_at`,
      [id],
    ),
  })
}
writeFileSync(join(outDir, 'goals.json'), JSON.stringify(goalExport, null, 2))

if (existsSync(join(dataDir, 'attachments'))) {
  cpSync(join(dataDir, 'attachments'), join(outDir, 'attachments'), {
    recursive: true,
  })
}

console.log(
  `exported ${docs.length} docs, ${spaces.length} spaces, ${itemTotal} items, ${goals.length} goals to ${outDir}`,
)
