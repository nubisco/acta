/**
 * Enhanced-Markdown utilities (design-spec §2): frontmatter, the section map
 * used for diff-based doc updates, and cross-reference extraction.
 * Rendering lives in web/; this module only understands structure.
 */

import { slugify } from './keys'

// ---------------------------------------------------------------------------
// Content hashing (section conflict guards). FNV-1a 64-bit, hex. Not
// cryptographic; guards concurrent edits, not integrity.
// ---------------------------------------------------------------------------

export function contentHash(text: string): string {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const bytes = new TextEncoder().encode(text)
  for (const b of bytes) {
    h ^= BigInt(b)
    h = (h * prime) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

// ---------------------------------------------------------------------------
// Frontmatter: a flat YAML subset. Only string scalars and inline string
// lists ([a, b]) are supported; this is the whole contract.
// ---------------------------------------------------------------------------

export interface IFrontmatter {
  [key: string]: string | string[]
}

export interface IParsedDoc {
  frontmatter: IFrontmatter
  body: string
}

export function parseFrontmatter(raw: string): IParsedDoc {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw }
  const end = raw.indexOf('\n---', 4)
  if (end === -1) return { frontmatter: {}, body: raw }
  const header = raw.slice(4, end)
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1)
  const frontmatter: IFrontmatter = {}
  for (const line of header.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[2].trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      frontmatter[m[1]] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else {
      frontmatter[m[1]] = value
    }
  }
  return { frontmatter, body }
}

export function serializeFrontmatter(doc: IParsedDoc): string {
  const lines = Object.entries(doc.frontmatter).map(([k, v]) =>
    Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`,
  )
  if (lines.length === 0) return doc.body
  return `---\n${lines.join('\n')}\n---\n${doc.body}`
}

// ---------------------------------------------------------------------------
// Section map: a section is a heading plus its content up to the next heading
// of equal or higher level. Identified by slugified heading text, with ~2,
// ~3... suffixes for duplicates. Fenced code blocks are opaque.
// ---------------------------------------------------------------------------

export interface ISection {
  slug: string
  heading: string
  level: number
  /** Line index (0-based) of the heading line. */
  startLine: number
  /** Line index one past the last line of the section. */
  endLine: number
  hash: string
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE_RE = /^(```|~~~)/

export function sectionMap(body: string): ISection[] {
  const lines = body.split('\n')
  const headings: { level: number; text: string; line: number }[] = []
  let inFence = false
  let fenceMarker = ''
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE_RE.exec(lines[i])
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]
      } else if (lines[i].startsWith(fenceMarker)) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const m = HEADING_RE.exec(lines[i])
    if (m) headings.push({ level: m[1].length, text: m[2], line: i })
  }

  const seen = new Map<string, number>()
  const sections: ISection[] = []
  for (let h = 0; h < headings.length; h++) {
    const { level, text, line } = headings[h]
    let end = lines.length
    for (let j = h + 1; j < headings.length; j++) {
      if (headings[j].level <= level) {
        end = headings[j].line
        break
      }
    }
    const base = slugify(text) || 'section'
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    const slug = count === 1 ? base : `${base}~${count}`
    sections.push({
      slug,
      heading: text,
      level,
      startLine: line,
      endLine: end,
      hash: contentHash(lines.slice(line, end).join('\n')),
    })
  }
  return sections
}

/** Extract a section's text (heading line included). */
export function sectionText(body: string, section: ISection): string {
  return body.split('\n').slice(section.startLine, section.endLine).join('\n')
}

export type TSectionMode = 'replace' | 'append' | 'insert_after'

export function applySectionEdit(
  body: string,
  section: ISection,
  content: string,
  mode: TSectionMode,
): string {
  const lines = body.split('\n')
  const before = lines.slice(
    0,
    mode === 'append' ? section.endLine : section.startLine,
  )
  const after = lines.slice(section.endLine)
  const middle =
    mode === 'replace'
      ? [content]
      : mode === 'append'
        ? [content]
        : [...lines.slice(section.startLine, section.endLine), content]
  return [...before, ...middle, ...after].join('\n')
}

// ---------------------------------------------------------------------------
// Cross-references: [[SW-142]], [[board:DOOD]], [[doc:manual/vision|label]],
// [[@handle]], and embeds ![[query: ...]]. Code spans and fences are skipped.
// ---------------------------------------------------------------------------

export type TRefType = 'item' | 'board' | 'doc' | 'actor' | 'query'

export interface IRef {
  type: TRefType
  /** Item key, board key, doc slug, actor handle, or raw query string. */
  target: string
  alias?: string
  /** Character offset of the reference in the body. */
  offset: number
  raw: string
}

const REF_RE = /(!?)\[\[([^\][]+)\]\]/g

function stripCode(body: string): string {
  // Blank out fenced blocks and inline code so offsets are preserved.
  return body
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
}

export function extractRefs(body: string): IRef[] {
  const clean = stripCode(body)
  const refs: IRef[] = []
  for (const m of clean.matchAll(REF_RE)) {
    const raw = m[0]
    const inner = m[2].trim()
    const offset = m.index
    if (m[1] === '!') {
      if (inner.startsWith('query:')) {
        refs.push({ type: 'query', target: inner.slice(6).trim(), offset, raw })
      }
      continue
    }
    const [targetPart, alias] = splitAlias(inner)
    if (targetPart.startsWith('@')) {
      refs.push({ type: 'actor', target: targetPart.slice(1), offset, raw })
    } else if (targetPart.startsWith('board:')) {
      refs.push({
        type: 'board',
        target: targetPart.slice(6),
        alias,
        offset,
        raw,
      })
    } else if (targetPart.startsWith('doc:')) {
      refs.push({
        type: 'doc',
        target: targetPart.slice(4),
        alias,
        offset,
        raw,
      })
    } else if (/^[A-Z][A-Z0-9]{1,4}-\d+$/.test(targetPart)) {
      refs.push({ type: 'item', target: targetPart, alias, offset, raw })
    }
  }
  return refs
}

function splitAlias(inner: string): [string, string | undefined] {
  const idx = inner.indexOf('|')
  if (idx === -1) return [inner.trim(), undefined]
  return [inner.slice(0, idx).trim(), inner.slice(idx + 1).trim() || undefined]
}

// ---------------------------------------------------------------------------
// Embed query grammar (design-spec §2): key=value pairs, fixed key set.
// ---------------------------------------------------------------------------

export interface IEmbedQuery {
  board?: string
  list?: string
  label?: string
  assignee?: string
  state?: 'open' | 'done' | 'archived'
}

const EMBED_KEYS = new Set(['board', 'list', 'label', 'assignee', 'state'])

export function parseEmbedQuery(query: string): IEmbedQuery | null {
  const out: Record<string, string> = {}
  for (const pair of query.split(/\s+/).filter(Boolean)) {
    const idx = pair.indexOf('=')
    if (idx === -1) return null
    const key = pair.slice(0, idx)
    const value = pair.slice(idx + 1)
    if (!EMBED_KEYS.has(key) || !value) return null
    out[key] = value
  }
  if (out.state && !['open', 'done', 'archived'].includes(out.state))
    return null
  return out as IEmbedQuery
}
