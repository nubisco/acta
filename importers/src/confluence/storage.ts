/**
 * Confluence storage-format XHTML → enhanced Markdown (design-spec §2,
 * mvp F12). Hand-rolled parser over the ac:/ri: XML: a small tokenizer builds
 * an element tree, a renderer walks it. Anything outside the mapping is
 * preserved as text inside a NOTE callout and reported, never dropped.
 */

import { slugify } from '@nubisco/acta-shared'

// ---------------------------------------------------------------------------
// Tiny XML parser (storage format only; no external XML lib)
// ---------------------------------------------------------------------------

export interface IXmlElement {
  kind: 'element'
  tag: string
  attrs: Record<string, string>
  children: TXmlNode[]
}

export interface IXmlText {
  kind: 'text'
  text: string
}

export type TXmlNode = IXmlElement | IXmlText

const VOID_TAGS = new Set([
  'br',
  'hr',
  'img',
  'col',
  'ri:page',
  'ri:user',
  'ri:attachment',
  'ri:url',
  'ri:space',
  'ri:blog-post',
  'ri:shortcut',
  'ac:emoticon',
])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  middot: '·',
  times: '×',
  rarr: '→',
  larr: '←',
}

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (whole, ent: string) => {
      if (ent.startsWith('#x') || ent.startsWith('#X'))
        return String.fromCodePoint(Number.parseInt(ent.slice(2), 16))
      if (ent.startsWith('#'))
        return String.fromCodePoint(Number.parseInt(ent.slice(1), 10))
      return NAMED_ENTITIES[ent.toLowerCase()] ?? whole
    },
  )
}

export function parseStorage(xml: string): TXmlNode[] {
  const root: IXmlElement = {
    kind: 'element',
    tag: '#root',
    attrs: {},
    children: [],
  }
  const stack: IXmlElement[] = [root]
  const top = (): IXmlElement => stack[stack.length - 1]
  const pushText = (text: string, raw = false): void => {
    if (text.length === 0) return
    top().children.push({
      kind: 'text',
      text: raw ? text : decodeEntities(text),
    })
  }

  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) {
      pushText(xml.slice(i))
      break
    }
    if (lt > i) pushText(xml.slice(i, lt))
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt)
      pushText(end === -1 ? xml.slice(lt + 9) : xml.slice(lt + 9, end), true)
      i = end === -1 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt)
      i = end === -1 ? xml.length : end + 3
      continue
    }
    const gt = xml.indexOf('>', lt)
    if (gt === -1) {
      pushText(xml.slice(lt))
      break
    }
    const raw = xml.slice(lt + 1, gt).trim()
    i = gt + 1
    if (raw.startsWith('/')) {
      const tag = raw.slice(1).trim().toLowerCase()
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === tag) {
          stack.length = s
          break
        }
      }
      continue
    }
    if (raw.startsWith('!') || raw.startsWith('?')) continue
    const selfClosing = raw.endsWith('/')
    const inner = selfClosing ? raw.slice(0, -1) : raw
    const nameMatch = /^([\w:.-]+)([\s\S]*)$/.exec(inner.trim())
    if (!nameMatch) continue
    const tag = nameMatch[1].toLowerCase()
    const attrs: Record<string, string> = {}
    for (const m of nameMatch[2].matchAll(
      /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )) {
      attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? '')
    }
    const element: IXmlElement = { kind: 'element', tag, attrs, children: [] }
    top().children.push(element)
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element)
  }
  return root.children
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface IConversionIssues {
  unknownMacros: string[]
  unresolvedLinks: string[]
  skippedAttachments: string[]
}

export interface IStorageConvertOptions {
  /** Resolve a Confluence page title to a doc slug (null = unknown page). */
  resolvePage?: (title: string) => string | null
  /** Trello board shortlink → Acta board key ([[board:KEY]] refs). */
  trelloBoards?: Record<string, string>
}

export interface IStorageResult {
  markdown: string
  issues: IConversionIssues
}

const BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'blockquote',
  'hr',
  'pre',
  'div',
  'ac:structured-macro',
  'ac:macro',
  'ac:layout',
  'ac:layout-section',
  'ac:layout-cell',
  'ac:rich-text-body',
  'ac:task-list',
])

class Renderer {
  issues: IConversionIssues = {
    unknownMacros: [],
    unresolvedLinks: [],
    skippedAttachments: [],
  }

  constructor(private opts: IStorageConvertOptions) {}

  render(nodes: TXmlNode[]): string {
    return this.blocks(nodes).join('\n\n')
  }

  // -- block level ---------------------------------------------------------

  blocks(nodes: TXmlNode[]): string[] {
    const out: string[] = []
    let inline: TXmlNode[] = []
    const flush = (): void => {
      if (inline.length === 0) return
      const text = this.inline(inline).trim()
      if (text.length > 0) out.push(text)
      inline = []
    }
    for (const node of nodes) {
      if (node.kind === 'element' && BLOCK_TAGS.has(node.tag)) {
        flush()
        const rendered = this.block(node)
        if (rendered.length > 0) out.push(...rendered)
      } else if (node.kind === 'text' && node.text.trim().length === 0) {
        // whitespace between blocks
        if (inline.length > 0) inline.push(node)
      } else {
        inline.push(node)
      }
    }
    flush()
    return out
  }

  block(el: IXmlElement): string[] {
    switch (el.tag) {
      case 'p': {
        const text = this.inline(el.children).trim()
        return text.length > 0 ? [text] : []
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number(el.tag[1])
        const text = this.inline(el.children).trim().replace(/\n/g, ' ')
        return text.length > 0 ? [`${'#'.repeat(level)} ${text}`] : []
      }
      case 'ul':
      case 'ol':
        return [this.list(el, el.tag === 'ol', '')]
      case 'ac:task-list':
        return [this.taskList(el, '')]
      case 'table':
        return [this.table(el)]
      case 'blockquote':
        return [prefixLines(this.render(el.children), '> ')]
      case 'hr':
        return ['---']
      case 'pre': {
        const code = textContent(el).replace(/\n$/, '')
        return [fenced(code, '')]
      }
      case 'ac:structured-macro':
      case 'ac:macro':
        return this.macro(el)
      case 'div': {
        // ADF panels serialize as <div data-type="panel..."> in exported
        // HTML; map them to callouts. Every other div stays a flat container.
        if ((el.attrs['data-type'] ?? '').startsWith('panel')) {
          const type =
            {
              info: 'INFO',
              tip: 'TIP',
              success: 'TIP',
              note: 'NOTE',
              warning: 'WARNING',
              error: 'WARNING',
            }[el.attrs['data-panel-type'] ?? ''] ?? 'NOTE'
          return [callout(type, '', this.render(el.children))]
        }
        return this.blocks(el.children)
      }
      case 'ac:layout':
      case 'ac:layout-section':
      case 'ac:layout-cell':
      case 'ac:rich-text-body':
        return this.blocks(el.children)
      default:
        return this.blocks(el.children)
    }
  }

  // -- inline level --------------------------------------------------------

  inline(nodes: TXmlNode[]): string {
    return nodes.map((n) => this.inlineNode(n)).join('')
  }

  inlineNode(node: TXmlNode): string {
    if (node.kind === 'text') return node.text.replace(/\s+/g, ' ')
    const el = node
    switch (el.tag) {
      case 'strong':
      case 'b': {
        const text = this.inline(el.children).trim()
        return text.length > 0 ? `**${text}**` : ''
      }
      case 'em':
      case 'i': {
        const text = this.inline(el.children).trim()
        return text.length > 0 ? `*${text}*` : ''
      }
      case 's':
      case 'del':
      case 'strike': {
        const text = this.inline(el.children).trim()
        return text.length > 0 ? `~~${text}~~` : ''
      }
      case 'code':
      case 'tt': {
        const text = textContent(el).trim()
        if (text.length === 0) return ''
        return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
      }
      case 'br':
        return '\n'
      case 'a':
        return this.anchor(el)
      case 'ac:link':
        return this.acLink(el)
      case 'ac:image':
        return this.image(el)
      case 'time':
        return el.attrs['datetime'] ?? textContent(el)
      case 'ac:emoticon':
        return (
          el.attrs['ac:emoji-fallback'] ??
          (el.attrs['ac:name'] ? `:${el.attrs['ac:name']}:` : '')
        )
      case 'ac:placeholder':
        return ''
      case 'span':
      case 'u':
      case 'sub':
      case 'sup':
      case 'font':
        return this.inline(el.children)
      case 'ac:structured-macro':
      case 'ac:macro':
        // Inline occurrence of a macro (e.g. status inside a paragraph).
        return this.macro(el).join(' ')
      default:
        return this.inline(el.children)
    }
  }

  anchor(el: IXmlElement): string {
    const href = el.attrs['href'] ?? ''
    const text = this.inline(el.children).trim() || href
    const trello = /trello\.com\/b\/([A-Za-z0-9]+)/.exec(href)
    if (trello) {
      const key = this.opts.trelloBoards?.[trello[1]]
      if (key) {
        const plain = text === href || text.toLowerCase() === key.toLowerCase()
        return plain ? `[[board:${key}]]` : `[[board:${key}|${text}]]`
      }
      this.issues.unresolvedLinks.push(`trello board ${href}`)
    }
    if (!href) return text
    return `[${text}](${href})`
  }

  acLink(el: IXmlElement): string {
    const page = findChild(el, 'ri:page')
    const attachment = findChild(el, 'ri:attachment')
    const user = findChild(el, 'ri:user')
    const bodyEl =
      findChild(el, 'ac:plain-text-link-body') ?? findChild(el, 'ac:link-body')
    const text = bodyEl ? this.inline(bodyEl.children).trim() : ''
    if (page) {
      const title = page.attrs['ri:content-title'] ?? ''
      const resolved = this.opts.resolvePage?.(title) ?? null
      const target = resolved ?? slugifyTitle(title)
      if (!resolved) this.issues.unresolvedLinks.push(`page "${title}"`)
      return text && text !== title
        ? `[[doc:${target}|${text}]]`
        : `[[doc:${target}]]`
    }
    if (attachment) {
      const filename = attachment.attrs['ri:filename'] ?? 'attachment'
      this.issues.skippedAttachments.push(filename)
      return text || filename
    }
    if (user) return text || '@user'
    return text
  }

  image(el: IXmlElement): string {
    const url = findChild(el, 'ri:url')
    const attachment = findChild(el, 'ri:attachment')
    const alt = el.attrs['ac:alt'] ?? el.attrs['ac:title'] ?? ''
    if (url) return `![${alt}](${url.attrs['ri:value'] ?? ''})`
    if (attachment) {
      this.issues.skippedAttachments.push(
        attachment.attrs['ri:filename'] ?? 'image',
      )
      return ''
    }
    return ''
  }

  // -- macros --------------------------------------------------------------

  macro(el: IXmlElement): string[] {
    const name = (el.attrs['ac:name'] ?? '').toLowerCase()
    const title = macroParam(el, 'title') ?? ''
    const richBody = findChild(el, 'ac:rich-text-body')
    const plainBody = findChild(el, 'ac:plain-text-body')
    switch (name) {
      case 'info':
      case 'tip':
      case 'note':
      case 'warning':
      case 'panel': {
        const type = {
          info: 'INFO',
          tip: 'TIP',
          note: 'NOTE',
          warning: 'WARNING',
          panel: 'NOTE',
        }[name] as string
        const body = richBody ? this.render(richBody.children) : ''
        return [callout(type, title, body)]
      }
      case 'expand': {
        const body = richBody ? this.render(richBody.children) : ''
        return [`:::details ${title || 'Details'}\n${body}\n:::`]
      }
      case 'code': {
        const language = macroParam(el, 'language') ?? ''
        const code = (plainBody ? textContent(plainBody) : textContent(el))
          .replace(/^\n/, '')
          .replace(/\n$/, '')
        return [fenced(code, language)]
      }
      default: {
        this.issues.unknownMacros.push(name || 'unnamed')
        const body = richBody
          ? this.render(richBody.children)
          : plainBody
            ? textContent(plainBody).trim()
            : this.render(
                el.children.filter(
                  (c) => c.kind !== 'element' || c.tag !== 'ac:parameter',
                ),
              )
        return [
          callout(
            'NOTE',
            `Unmapped Confluence macro: ${name || 'unnamed'}`,
            body,
          ),
        ]
      }
    }
  }

  // -- lists ---------------------------------------------------------------

  list(el: IXmlElement, ordered: boolean, indent: string): string {
    const lines: string[] = []
    let idx = 1
    for (const child of el.children) {
      if (child.kind !== 'element' || child.tag !== 'li') continue
      const marker = ordered ? `${idx}.` : '-'
      idx += 1
      const sublists: IXmlElement[] = []
      const rest: TXmlNode[] = []
      for (const c of child.children) {
        if (c.kind === 'element' && (c.tag === 'ul' || c.tag === 'ol'))
          sublists.push(c)
        else rest.push(c)
      }
      const content = this.blocks(rest).join('\n').split('\n')
      const first = content.shift() ?? ''
      lines.push(`${indent}${marker} ${first}`.trimEnd())
      const contIndent = indent + ' '.repeat(marker.length + 1)
      for (const line of content) lines.push(`${contIndent}${line}`.trimEnd())
      for (const sub of sublists)
        lines.push(this.list(sub, sub.tag === 'ol', contIndent))
    }
    return lines.join('\n')
  }

  taskList(el: IXmlElement, indent: string): string {
    const lines: string[] = []
    for (const task of el.children) {
      if (task.kind !== 'element' || task.tag !== 'ac:task') continue
      const status = findChild(task, 'ac:task-status')
      const body = findChild(task, 'ac:task-body')
      const done = status ? textContent(status).trim() === 'complete' : false
      const text = body ? this.inline(body.children).trim() : ''
      lines.push(`${indent}- [${done ? 'x' : ' '}] ${text}`)
    }
    return lines.join('\n')
  }

  // -- tables --------------------------------------------------------------

  table(el: IXmlElement): string {
    const rows: string[][] = []
    const collectRows = (node: IXmlElement): void => {
      for (const child of node.children) {
        if (child.kind !== 'element') continue
        if (child.tag === 'tr') {
          const cells: string[] = []
          for (const cell of child.children) {
            if (
              cell.kind === 'element' &&
              (cell.tag === 'td' || cell.tag === 'th')
            ) {
              cells.push(this.cell(cell))
            }
          }
          rows.push(cells)
        } else if (
          ['thead', 'tbody', 'tfoot', 'colgroup'].includes(child.tag)
        ) {
          collectRows(child)
        }
      }
    }
    collectRows(el)
    if (rows.length === 0) return ''
    const width = Math.max(...rows.map((r) => r.length))
    const pad = (r: string[]): string[] =>
      r.length < width ? [...r, ...Array<string>(width - r.length).fill('')] : r
    const line = (r: string[]): string => `| ${pad(r).join(' | ')} |`
    const out = [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`]
    for (const row of rows.slice(1)) out.push(line(row))
    return out.join('\n')
  }

  cell(el: IXmlElement): string {
    return this.blocks(el.children)
      .join(' ')
      .replace(/\n+/g, ' ')
      .replace(/\|/g, '\\|')
      .trim()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findChild(el: IXmlElement, tag: string): IXmlElement | null {
  for (const child of el.children) {
    if (child.kind === 'element' && child.tag === tag) return child
  }
  return null
}

function macroParam(el: IXmlElement, name: string): string | null {
  for (const child of el.children) {
    if (
      child.kind === 'element' &&
      child.tag === 'ac:parameter' &&
      (child.attrs['ac:name'] ?? '').toLowerCase() === name
    ) {
      return textContent(child)
    }
  }
  return null
}

function textContent(node: TXmlNode): string {
  if (node.kind === 'text') return node.text
  return node.children.map(textContent).join('')
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : prefix.trimEnd()))
    .join('\n')
}

function callout(type: string, title: string, body: string): string {
  const head = title ? `> [!${type}] ${title}` : `> [!${type}]`
  if (!body) return head
  return `${head}\n${prefixLines(body, '> ')}`
}

function fenced(code: string, language: string): string {
  const marker = code.includes('```') ? '````' : '```'
  return `${marker}${language}\n${code}\n${marker}`
}

/** Same slugification as doc slugs (shared keys.slugify). */
function slugifyTitle(title: string): string {
  return slugify(title) || 'untitled'
}

// ---------------------------------------------------------------------------

export function storageToMarkdown(
  xml: string,
  opts: IStorageConvertOptions = {},
): IStorageResult {
  const renderer = new Renderer(opts)
  const markdown = renderer.render(parseStorage(xml))
  return { markdown, issues: renderer.issues }
}
