import type { IOverview } from '@/types/api'

export type TBadgeVariant =
  'grey' | 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'primary'

/** Server label colors map onto the closed NbBadge variant set. */
const COLOR_TO_VARIANT: Record<string, TBadgeVariant> = {
  red: 'red',
  green: 'green',
  blue: 'blue',
  sky: 'blue',
  yellow: 'orange',
  orange: 'orange',
  purple: 'purple',
  pink: 'purple',
  lime: 'green',
  black: 'grey',
  grey: 'grey',
  gray: 'grey',
}

/** One server colour as a badge variant. The palette is wider than the set. */
export function colorVariant(color: string): TBadgeVariant {
  return COLOR_TO_VARIANT[color.split('_')[0]] ?? 'grey'
}

export function labelVariants(
  overview: IOverview | null,
): Map<string, TBadgeVariant> {
  const map = new Map<string, TBadgeVariant>()
  for (const label of overview?.labels ?? [])
    map.set(label.name, colorVariant(label.color))
  return map
}

/** One label, with everything a caller needs to show it as the field it is. */
export interface ILabelEntry {
  id: string
  name: string
  color: string
  /** The group's id, which is its identity. The name is for reading. */
  groupId: string
  group: string
  space: string | null
  exclusive: boolean
}

/** A group and its labels, in the order the catalogue gave them. */
export interface ILabelGroup {
  /**
   * The group's own id, which is how a write names it.
   *
   * Not the name: a group is scoped to a space so each product board can
   * carry its own versions, so two boards both having a "Fixes version" is
   * the expected shape rather than an edge case. The server refuses an
   * ambiguous name rather than guessing, and this is how to avoid asking it
   * an ambiguous question in the first place.
   */
  id: string
  name: string
  space: string | null
  exclusive: boolean
  labels: ILabelEntry[]
}

function entryOf(label: NonNullable<IOverview['labels']>[number]): ILabelEntry {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    groupId: label.group_id,
    group: label.group_name,
    space: label.space_key,
    exclusive: label.exclusive === true,
  }
}

/** Every label by id, so a card's `label_ids` resolve to the right group. */
export function labelsById(
  overview: IOverview | null,
): Map<string, ILabelEntry> {
  const map = new Map<string, ILabelEntry>()
  for (const label of overview?.labels ?? []) map.set(label.id, entryOf(label))
  return map
}

/**
 * The catalogue grouped, in catalogue order.
 *
 * The server already returns labels by group name and then by each group's
 * own arrangement, which is the whole point of ordered labels: 1.9.0 comes
 * before 1.11.0 and sorting by name says otherwise. So this walks the array
 * and never sorts it.
 *
 * A group is identified by name AND space: two spaces may each have a
 * "Fixes version", and they are different groups.
 */
export function labelGroups(
  overview: IOverview | null,
  space?: string,
): ILabelGroup[] {
  const out = new Map<string, ILabelGroup>()
  for (const label of overview?.labels ?? []) {
    if (
      space !== undefined &&
      label.space_key !== null &&
      label.space_key !== space
    )
      continue
    // Keyed by the group's id now that the catalogue carries it. Name plus
    // space was the only key available before, and it would fold two groups
    // together the moment a workspace had two with one name.
    const key = label.group_id
    let group = out.get(key)
    if (!group) {
      group = {
        id: label.group_id,
        name: label.group_name,
        space: label.space_key,
        exclusive: label.exclusive === true,
        labels: [],
      }
      out.set(key, group)
    }
    group.labels.push(entryOf(label))
  }
  return [...out.values()]
}

/** The stable identity of a group, which its name alone is not. */
export function groupKey(group: {
  name: string
  space: string | null
}): string {
  return `${group.name}\u0000${group.space ?? ''}`
}

/**
 * Group headings inside a select.
 *
 * `NbSelect` takes a flat option list and has no notion of a group, so a
 * heading travels as a disabled option: disabled rows are inert on click and
 * carry `aria-disabled`, which is the closest the library gets to an
 * `optgroup` today. The prefix is a NUL so it can never collide with a label
 * id. See the gap note in the report: the library already has an
 * `IOptionGroup` type, no component consumes it.
 */
const HEADING = '\u0000group:'

export function headingOption(group: ILabelGroup): {
  label: string
  value: string
  disabled: true
} {
  return { label: group.name, value: HEADING + groupKey(group), disabled: true }
}

export function headingName(value: string): string | null {
  if (!value.startsWith(HEADING)) return null
  return value.slice(HEADING.length).split('\u0000')[0]
}

/**
 * A card's labels, as the thing to render.
 *
 * Prefers the ids, because a name no longer identifies a label: a card
 * carrying 1.12.0 from both the affects group and the fixes group would
 * otherwise draw the same chip twice and say nothing about which is which.
 * The names are the fallback for a payload that predates `label_ids`.
 */
export function rowLabels(row: {
  labels?: string[]
  label_ids?: string[]
}): { key: string; id?: string; name?: string }[] {
  if (row.label_ids) return row.label_ids.map((id) => ({ key: id, id }))
  return (row.labels ?? []).map((name) => ({ key: name, name }))
}

/**
 * How a label reads on its own, away from its group's heading. A group that
 * names a single answer is a field, so its value says which field it answers.
 */
export function labelText(entry: ILabelEntry): string {
  return entry.exclusive ? `${entry.group}: ${entry.name}` : entry.name
}
