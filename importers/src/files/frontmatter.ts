/**
 * The frontmatter an exported page carries, and reading it back.
 *
 * A stored document has no frontmatter: its title, tags and position are
 * columns, not text. An export has only files, so those three travel in a
 * small header, and an import reads them back. Without it the title would have
 * to be guessed from the filename, which cannot hold a slash, or from the
 * first heading, which is ambiguous for a page that genuinely opens with one.
 *
 * Deliberately a flat subset of YAML: `key: value` and `key: [a, b]`, with a
 * double-quoted value for anything that would otherwise be misread.
 */

export interface IPageMeta {
  title?: string
  tags?: string[]
  /** Position among siblings, so an export re-imports in the same order. */
  order?: number
}

export interface IFrontmatterSplit {
  meta: IPageMeta
  /** Every key found, for callers that want more than the three above. */
  raw: Record<string, string | string[]>
  body: string
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'"))
    return trimmed.slice(1, -1).replace(/''/g, "'")
  return trimmed
}

/** Splits a leading `---` block off a file. A file without one is all body. */
export function readFrontmatter(text: string): IFrontmatterSplit {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const empty = { meta: {}, raw: {}, body: source }
  if (!source.startsWith('---\n')) return empty
  const end = source.indexOf('\n---', 3)
  if (end === -1) return empty
  const afterFence = source.indexOf('\n', end + 4)
  const closing = source.slice(
    end + 1,
    afterFence === -1 ? undefined : afterFence,
  )
  if (closing.trim() !== '---') return empty

  const raw: Record<string, string | string[]> = {}
  for (const line of source.slice(4, end).split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!match) continue
    const value = match[2].trim()
    raw[match[1]] =
      value.startsWith('[') && value.endsWith(']')
        ? value
            .slice(1, -1)
            .split(',')
            .map((part) => unquote(part))
            .filter(Boolean)
        : unquote(value)
  }

  const meta: IPageMeta = {}
  if (typeof raw.title === 'string' && raw.title.trim())
    meta.title = raw.title.trim()
  if (Array.isArray(raw.tags)) meta.tags = raw.tags
  else if (typeof raw.tags === 'string' && raw.tags.trim())
    meta.tags = [raw.tags.trim()]
  if (typeof raw.order === 'string' && /^-?\d+$/.test(raw.order))
    meta.order = Number(raw.order)

  const body = afterFence === -1 ? '' : source.slice(afterFence + 1)
  return { meta, raw, body: body.replace(/^\n+/, '') }
}

/** Quotes a value only when it would otherwise be read back differently. */
function scalar(value: string): string {
  const plain =
    value === value.trim() &&
    value.length > 0 &&
    !/^["'[\]{}#&*!|>%@`-]/.test(value) &&
    !/[\n"]|: |\s#/.test(value)
  return plain ? value : JSON.stringify(value)
}

/** The header block, ending in a blank line, or '' when there is nothing. */
export function writeFrontmatter(meta: IPageMeta): string {
  const lines: string[] = []
  if (meta.title) lines.push(`title: ${scalar(meta.title)}`)
  if (meta.tags && meta.tags.length > 0)
    lines.push(`tags: [${meta.tags.map((tag) => scalar(tag)).join(', ')}]`)
  if (typeof meta.order === 'number') lines.push(`order: ${meta.order}`)
  return lines.length > 0 ? `---\n${lines.join('\n')}\n---\n\n` : ''
}
