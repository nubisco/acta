/**
 * HTML into Acta's markdown dialect.
 *
 * Works on a plain element tree rather than on a DOM, so it runs anywhere:
 * the browser hands it what `DOMParser` built, and a test or a CLI can hand it
 * what the Confluence storage parser builds. The tree type is that parser's.
 *
 * Mapped where the mapping is clean:
 *
 *  - headings 1 to 4, paragraphs, hard breaks, bold, italic, strikethrough,
 *    inline code, links, horizontal rules
 *  - lists, nested lists, ordered lists with a start, task lists
 *  - blockquotes, and callouts from three shapes: Acta's own export, GitHub's
 *    alert markup, and a quotation opening with a `[!NOTE]` marker
 *  - `<details>` toggles, fenced code with its language, Mermaid diagrams
 *  - tables with a header row and column alignment
 *  - images with alignment and width, and formulas carried as TeX (Acta's own
 *    `data-math`, KaTeX's annotation, or MathML's)
 *  - Acta's references, mentions and link cards, so an HTML export imports
 *    back into the same dialect
 *
 * Everything else keeps its text and is reported in `issues`, never dropped
 * without a word.
 */

import type {
  IXmlElement as IHtmlElement,
  TXmlNode,
} from '../confluence/storage'

export type THtmlNode = TXmlNode
export type { IHtmlElement }

export interface IHtmlConvertResult {
  markdown: string
  /** A document title the HTML stated, from `<title>`. */
  title?: string
  /** Human-readable notes about what could not be mapped cleanly. */
  issues: string[]
}

const CALLOUT_KEYWORDS: Record<string, string> = {
  info: 'INFO',
  note: 'NOTE',
  tip: 'TIP',
  important: 'INFO',
  warning: 'WARNING',
  caution: 'DANGER',
  danger: 'DANGER',
  error: 'DANGER',
  success: 'TIP',
}

const SKIP_TAGS = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'button',
  'nav',
  'form',
  'select',
  'textarea',
  'option',
  'link',
  'meta',
  'object',
  'embed',
  'canvas',
  'map',
  'svg',
])

const SKIP_CLASSES = [
  'md__code-bar',
  'md__anchor',
  'md__callout-icon',
  'md-wrap__toggle',
  'md__diagram-error',
]

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'center',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'html',
  'iframe',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'ul',
  'video',
  'audio',
])

function classes(el: IHtmlElement): string[] {
  return (el.attrs['class'] ?? '').split(/\s+/).filter(Boolean)
}

function hasClass(el: IHtmlElement, name: string): boolean {
  return classes(el).includes(name)
}

function textOf(node: THtmlNode): string {
  if (node.kind === 'text') return node.text
  if (node.tag === 'br') return '\n'
  return node.children.map(textOf).join('')
}

function findFirst(
  node: THtmlNode,
  test: (el: IHtmlElement) => boolean,
): IHtmlElement | null {
  if (node.kind === 'text') return null
  if (test(node)) return node
  for (const child of node.children) {
    const found = findFirst(child, test)
    if (found) return found
  }
  return null
}

function isElement(node: THtmlNode, tag?: string): node is IHtmlElement {
  return node.kind === 'element' && (tag === undefined || node.tag === tag)
}

function prefixLines(text: string, first: string, rest = first): string {
  return text
    .split('\n')
    .map((line, index) => {
      const prefix = index === 0 ? first : rest
      return line.length > 0 ? `${prefix}${line}` : prefix.trimEnd()
    })
    .join('\n')
}

function fence(code: string, language: string): string {
  let marker = '```'
  while (code.includes(marker)) marker += '`'
  return `${marker}${language}\n${code}\n${marker}`
}

function codeSpan(text: string): string {
  let marker = '`'
  while (text.includes(marker)) marker += '`'
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${marker}${pad}${text}${pad}${marker}`
}

/**
 * Text escaped so markdown reads it back as the same text.
 *
 * Generous rather than minimal. An escape markdown did not need is read back
 * as the character it escapes, and the editor's serializer then writes its
 * own canonical form, so over-escaping here costs nothing in the stored page.
 * Under-escaping turns somebody's asterisk into emphasis.
 */
function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>$~|]/g, '\\$&').replace(/&(?=#?\w+;)/g, '\\&')
}

/** Escapes what only means something at the start of a line. */
function escapeLineStarts(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^(\s*)([#>+=-])/, '$1\\$2')
        .replace(/^(\s*)(\d+)([.)])(\s|$)/, '$1$2\\$3$4')
        .replace(/^(\s*):::/, '$1\\:::'),
    )
    .join('\n')
}

function cssWidth(el: IHtmlElement): number | null {
  const attr = el.attrs['width']
  if (attr && /^\d+$/.test(attr.trim())) return Number(attr.trim())
  const style = el.attrs['style'] ?? ''
  const match = /(?:^|;)\s*(?:inline-size|width)\s*:\s*(\d+(?:\.\d+)?)px/i.exec(
    style,
  )
  return match ? Math.round(Number(match[1])) : null
}

function imageAlign(el: IHtmlElement): string | null {
  const declared = el.attrs['data-align']
  if (declared && ['left', 'center', 'right'].includes(declared))
    return declared
  for (const name of classes(el)) {
    const match = /^md__img--(left|center|right)$/.exec(name)
    if (match) return match[1]
  }
  const align = (el.attrs['align'] ?? '').toLowerCase()
  if (align === 'left' || align === 'right' || align === 'center') return align
  return null
}

class HtmlRenderer {
  issues = new Set<string>()

  note(message: string): void {
    this.issues.add(message)
  }

  skip(el: IHtmlElement): boolean {
    // An item reference is a button in the reader, and is content.
    if (hasClass(el, 'md__ref')) return false
    if (SKIP_TAGS.has(el.tag)) return true
    if (el.attrs['hidden'] !== undefined) return true
    if (el.attrs['aria-hidden'] === 'true' && el.tag !== 'span') return true
    return SKIP_CLASSES.some((name) => hasClass(el, name))
  }

  // -- blocks ---------------------------------------------------------------

  render(nodes: THtmlNode[]): string {
    return this.blocks(nodes).join('\n\n')
  }

  private blockCache = new WeakMap<IHtmlElement, boolean>()

  isBlock(node: THtmlNode): boolean {
    if (node.kind === 'text') return false
    const cached = this.blockCache.get(node)
    if (cached !== undefined) return cached
    const result = this.computeIsBlock(node)
    this.blockCache.set(node, result)
    return result
  }

  computeIsBlock(node: IHtmlElement): boolean {
    if (BLOCK_TAGS.has(node.tag)) return true
    if (hasClass(node, 'md__math') || node.attrs['data-math-block'] === '1')
      return true
    if (hasClass(node, 'katex-display')) return true
    if (node.tag === 'math' && node.attrs['display'] === 'block') return true
    // A wrapper that only exists to hold blocks is itself a block.
    return node.children.some((child) => this.isBlock(child))
  }

  blocks(nodes: THtmlNode[]): string[] {
    const out: string[] = []
    let inline: THtmlNode[] = []
    const flush = () => {
      if (inline.length === 0) return
      const text = this.paragraph(inline)
      if (text) out.push(text)
      inline = []
    }
    for (const node of nodes) {
      if (node.kind === 'element' && this.skip(node)) continue
      if (this.isBlock(node)) {
        flush()
        out.push(...this.block(node as IHtmlElement).filter(Boolean))
      } else {
        inline.push(node)
      }
    }
    flush()
    return out
  }

  paragraph(nodes: THtmlNode[]): string {
    // A paragraph that is only a URL linking to itself is a link card.
    const meaningful = nodes.filter(
      (node) => node.kind === 'element' || node.text.trim() !== '',
    )
    if (meaningful.length === 1 && isElement(meaningful[0], 'a')) {
      const anchor = meaningful[0]
      const href = anchor.attrs['href'] ?? ''
      if (/^https?:\/\//i.test(href) && textOf(anchor).trim() === href)
        return href
    }
    const text = this.inline(nodes)
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/^\n+|\n+$/g, '')
    return escapeLineStarts(text)
  }

  block(el: IHtmlElement): string[] {
    if (el.attrs['data-link-card']) return [el.attrs['data-link-card']]
    if (hasClass(el, 'md__card-slot')) {
      const anchor = findFirst(el, (node) => node.tag === 'a')
      const href = anchor?.attrs['href']
      if (href) return [href]
    }
    if (hasClass(el, 'md__math') || el.attrs['data-math-block'] === '1')
      return [this.displayMath(el)]
    if (
      hasClass(el, 'katex-display') ||
      (el.tag === 'math' && el.attrs['display'] === 'block')
    )
      return [this.displayMath(el)]
    if (hasClass(el, 'md__diagram-figure')) {
      const source = el.attrs['data-mermaid']
      if (source) return [fence(source, 'mermaid')]
      this.note('A diagram with no source was left out.')
      return []
    }
    if (hasClass(el, 'markdown-alert')) return [this.githubAlert(el)]

    switch (el.tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4': {
        const text = this.inline(el.children)
          .replace(/\s*\n\s*/g, ' ')
          .trim()
        return text ? [`${'#'.repeat(Number(el.tag[1]))} ${text}`] : []
      }
      case 'h5':
      case 'h6': {
        const text = this.inline(el.children)
          .replace(/\s*\n\s*/g, ' ')
          .trim()
        if (!text) return []
        this.note('Headings deeper than level 4 became bold paragraphs.')
        return [`**${text}**`]
      }
      case 'p':
        return [this.paragraph(el.children)]
      case 'hr':
        return ['---']
      case 'pre':
        return [this.pre(el)]
      case 'ul':
      case 'ol':
        return [this.list(el)]
      case 'blockquote':
        return [this.blockquote(el)]
      case 'details':
        return [this.details(el)]
      case 'table':
        return [this.table(el)]
      case 'dl':
        this.note('Definition lists became bold terms and paragraphs.')
        return this.blocks(el.children)
      case 'dt': {
        const text = this.inline(el.children).trim()
        return text ? [`**${text}**`] : []
      }
      case 'iframe':
      case 'video':
      case 'audio': {
        const src =
          el.attrs['src'] ??
          findFirst(el, (node) => node.tag === 'source')?.attrs['src']
        this.note('Embedded frames and media became links.')
        return src && /^https?:\/\//i.test(src) ? [src] : []
      }
      case 'figcaption':
        return [this.paragraph(el.children)]
      default:
        return this.blocks(el.children)
    }
  }

  displayMath(el: IHtmlElement): string {
    const latex = this.latexOf(el)
    if (latex) return `$$\n${latex}\n$$`
    this.note('A formula with no TeX source kept only its text.')
    return escapeText(textOf(el).trim())
  }

  latexOf(el: IHtmlElement): string | null {
    const carried = el.attrs['data-math']
    if (carried !== undefined && carried.trim()) return carried.trim()
    const annotation = findFirst(
      el,
      (node) =>
        node.tag === 'annotation' &&
        (node.attrs['encoding'] ?? '').toLowerCase() === 'application/x-tex',
    )
    if (annotation) return textOf(annotation).trim() || null
    const alt = el.tag === 'math' ? el.attrs['alttext'] : undefined
    return alt?.trim() || null
  }

  pre(el: IHtmlElement): string {
    const code = findFirst(el, (node) => node.tag === 'code') ?? el
    const source = textOf(code).replace(/\n$/, '')
    const declared =
      el.attrs['data-language'] ??
      el.attrs['data-lang'] ??
      code.attrs['data-language'] ??
      [...classes(code), ...classes(el)]
        .map((name) => /^(?:language|lang)-([\w+#-]+)$/.exec(name)?.[1])
        .find(Boolean) ??
      ''
    const language = hasClass(el, 'md__mermaid') ? 'mermaid' : declared
    return fence(source, language)
  }

  list(el: IHtmlElement, indent = ''): string {
    const ordered = el.tag === 'ol'
    let index = Number(el.attrs['start'] ?? '1')
    if (!Number.isFinite(index)) index = 1
    const lines: string[] = []
    for (const child of el.children) {
      if (!isElement(child)) continue
      if (child.tag === 'ul' || child.tag === 'ol') {
        // Invalid but common: a nested list as a direct child of a list.
        lines.push(this.list(child, `${indent}   `))
        continue
      }
      if (child.tag !== 'li') continue
      const marker = ordered ? `${index}.` : '-'
      index++

      const parts = [...child.children]
      let task = ''
      const firstElement = parts.findIndex((node) => isElement(node))
      const checkbox =
        firstElement !== -1 &&
        isElement(parts[firstElement], 'input') &&
        (parts[firstElement] as IHtmlElement).attrs['type'] === 'checkbox'
          ? (parts[firstElement] as IHtmlElement)
          : findFirst(
              {
                kind: 'element',
                tag: 'x',
                attrs: {},
                children: parts.slice(0, 2),
              },
              (node) =>
                node.tag === 'input' && node.attrs['type'] === 'checkbox',
            )
      if (
        checkbox ||
        hasClass(child, 'md__task') ||
        hasClass(child, 'task-list-item')
      ) {
        task =
          checkbox && checkbox.attrs['checked'] !== undefined ? '[x] ' : '[ ] '
      }

      const body = this.blocks(parts).join('\n\n')
      const width = marker.length + 1
      const pad = ' '.repeat(width)
      const first = `${indent}${marker} ${task}`
      lines.push(
        prefixLines(body || '', first, `${indent}${pad}`).trimEnd() ||
          first.trimEnd(),
      )
    }
    return lines.join('\n')
  }

  blockquote(el: IHtmlElement): string {
    for (const name of classes(el)) {
      const match = /^md__callout--(\w+)$/.exec(name)
      if (match) {
        const titleEl = findFirst(el, (node) =>
          hasClass(node, 'md__callout-title'),
        )
        const title = titleEl ? textOf(titleEl).replace(/\s+/g, ' ').trim() : ''
        const rest = el.children.filter((node) => node !== titleEl)
        return this.callout(CALLOUT_KEYWORDS[match[1]] ?? 'NOTE', title, rest)
      }
    }
    // `> [!NOTE] Title` pasted as HTML: the marker is the first text.
    const firstText = textOf(el).trimStart()
    const marker = /^\[!(\w+)\]([^\n]*)/.exec(firstText)
    if (marker && CALLOUT_KEYWORDS[marker[1].toLowerCase()]) {
      const body = this.render(el.children).replace(
        /^\\\[!\w+\\\][^\n]*\n?/,
        '',
      )
      const head = `> [!${CALLOUT_KEYWORDS[marker[1].toLowerCase()]}]${marker[2].trim() ? ` ${marker[2].trim()}` : ''}`
      return body.trim() ? `${head}\n${prefixLines(body.trim(), '> ')}` : head
    }
    const body = this.render(el.children)
    return body ? prefixLines(body, '> ') : ''
  }

  githubAlert(el: IHtmlElement): string {
    const kind = classes(el)
      .map((name) => /^markdown-alert-(\w+)$/.exec(name)?.[1])
      .find(Boolean)
    const titleEl = findFirst(el, (node) =>
      hasClass(node, 'markdown-alert-title'),
    )
    const rest = el.children.filter((node) => node !== titleEl)
    return this.callout(CALLOUT_KEYWORDS[kind ?? 'note'] ?? 'NOTE', '', rest)
  }

  callout(keyword: string, title: string, children: THtmlNode[]): string {
    const head = `> [!${keyword}]${title ? ` ${title}` : ''}`
    const body = this.render(children)
    return body ? `${head}\n${prefixLines(body, '> ')}` : head
  }

  details(el: IHtmlElement): string {
    const summary = el.children.find((node) => isElement(node, 'summary'))
    const title = summary ? textOf(summary).replace(/\s+/g, ' ').trim() : ''
    const body = this.render(el.children.filter((node) => node !== summary))
    return `:::details ${title || 'Details'}\n${body ? `${body}\n` : ''}:::`
  }

  table(el: IHtmlElement): string {
    const rows: { cells: IHtmlElement[]; head: boolean }[] = []
    const collect = (node: IHtmlElement, head: boolean) => {
      for (const child of node.children) {
        if (!isElement(child)) continue
        if (child.tag === 'tr') {
          const cells = child.children.filter(
            (cell): cell is IHtmlElement =>
              isElement(cell) && (cell.tag === 'td' || cell.tag === 'th'),
          )
          rows.push({
            cells,
            head:
              head || (cells.length > 0 && cells.every((c) => c.tag === 'th')),
          })
        } else if (['thead', 'tbody', 'tfoot'].includes(child.tag)) {
          collect(child, child.tag === 'thead')
        } else if (child.tag === 'caption') {
          this.note('Table captions were left out.')
        }
      }
    }
    collect(el, false)
    if (rows.length === 0) return ''

    const text: string[][] = rows.map((row) =>
      row.cells.flatMap((cell) => {
        if (cell.attrs['rowspan'] && cell.attrs['rowspan'] !== '1')
          this.note('Merged table cells were split into separate cells.')
        const span = Number(cell.attrs['colspan'] ?? '1')
        if (span > 1)
          this.note('Merged table cells were split into separate cells.')
        const content = this.cell(cell)
        return [content, ...Array<string>(Math.max(0, span - 1)).fill('')]
      }),
    )
    const width = Math.max(...text.map((row) => row.length), 1)
    const pad = (row: string[]) => [
      ...row,
      ...Array<string>(width - row.length).fill(''),
    ]
    const headerIndex = rows[0].head ? 0 : -1
    const header =
      headerIndex === 0 ? pad(text[0]) : Array<string>(width).fill('')
    const body = headerIndex === 0 ? text.slice(1) : text
    if (headerIndex === -1)
      this.note('A table without a header row was given an empty one.')

    const alignOf = (index: number): string => {
      const sample = rows[0].cells[index]
      const style = (sample?.attrs['style'] ?? '').toLowerCase()
      const align =
        (sample?.attrs['align'] ?? '').toLowerCase() ||
        /text-align\s*:\s*(left|center|right)/.exec(style)?.[1] ||
        ''
      if (align === 'center') return ':---:'
      if (align === 'right') return '---:'
      if (align === 'left') return ':---'
      return '---'
    }
    const line = (row: string[]) => `| ${pad(row).join(' | ')} |`
    return [
      line(header),
      `| ${Array.from({ length: width }, (_, i) => alignOf(i)).join(' | ')} |`,
      ...body.map(line),
    ].join('\n')
  }

  cell(el: IHtmlElement): string {
    const blocks = this.blocks(el.children)
    if (
      blocks.length > 1 ||
      blocks.some((block) => /^(\s*[-*>]|\s*\d+\.|```)/.test(block))
    )
      this.note('Lists and blocks inside table cells were flattened to text.')
    return blocks
      .join(' ')
      .replace(/\n+/g, ' ')
      .replace(/(^|[^\\])\|/g, '$1\\|')
      .trim()
  }

  // -- inline ---------------------------------------------------------------

  inline(nodes: THtmlNode[]): string {
    return nodes.map((node) => this.inlineNode(node)).join('')
  }

  wrap(marker: string, el: IHtmlElement): string {
    const inner = this.inline(el.children)
    const text = inner.trim()
    if (!text) return inner
    const lead = /^\s/.test(inner) ? ' ' : ''
    const trail = /\s$/.test(inner) ? ' ' : ''
    return `${lead}${marker}${text}${marker}${trail}`
  }

  inlineNode(node: THtmlNode): string {
    if (node.kind === 'text') return escapeText(node.text.replace(/\s+/g, ' '))
    const el = node
    if (this.skip(el)) return ''

    if (el.attrs['data-math'] !== undefined || hasClass(el, 'md__math-inline'))
      return this.inlineMath(el)
    if (hasClass(el, 'katex') || el.tag === 'math') return this.inlineMath(el)
    if (hasClass(el, 'md__mention') && el.attrs['data-handle'])
      return `[[@${el.attrs['data-handle']}]]`
    if (hasClass(el, 'md__embed') && el.attrs['data-query'])
      return `![[query:${el.attrs['data-query']}]]`
    if (hasClass(el, 'md__ref') && el.attrs['data-ref'])
      return this.reference(el)

    switch (el.tag) {
      case 'strong':
      case 'b':
        return this.wrap('**', el)
      case 'em':
      case 'i':
      case 'cite':
      case 'dfn':
        return this.wrap('*', el)
      case 's':
      case 'del':
      case 'strike':
        return this.wrap('~~', el)
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt': {
        const text = textOf(el).replace(/\s+/g, ' ')
        return text.trim() ? codeSpan(text) : text
      }
      case 'br':
        return '\n'
      case 'a':
        return this.anchor(el)
      case 'img':
        return this.image(el)
      case 'input':
        return ''
      case 'u':
      case 'sub':
      case 'sup':
      case 'mark':
      case 'small':
      case 'big':
      case 'ins':
        this.note(
          'Underline, subscript, superscript and highlight kept their text only.',
        )
        return this.inline(el.children)
      default:
        return this.inline(el.children)
    }
  }

  inlineMath(el: IHtmlElement): string {
    const latex = this.latexOf(el)
    if (latex && !latex.includes('$') && !latex.includes('\n'))
      return `$${latex}$`
    if (latex) return codeSpan(latex)
    this.note('A formula with no TeX source kept only its text.')
    return escapeText(textOf(el))
  }

  reference(el: IHtmlElement): string {
    const target = el.attrs['data-ref'] ?? ''
    const type = el.attrs['data-ref-type']
    const label = textOf(el).replace(/\s+/g, ' ').trim()
    if (type === 'doc' || type === 'space') {
      const alias = label && label !== target ? `|${label}` : ''
      return `[[${type}:${target}${alias}]]`
    }
    return `[[${target}]]`
  }

  anchor(el: IHtmlElement): string {
    const href = (el.attrs['href'] ?? '').trim()
    if (hasClass(el, 'md__file')) {
      const name =
        el.attrs['data-filename'] ??
        textOf(
          findFirst(el, (node) => hasClass(node, 'md__file-name')) ?? el,
        ).trim()
      return href ? `![${escapeText(name)}](${href})` : escapeText(name)
    }
    if (hasClass(el, 'md__drive') || hasClass(el, 'md__card')) return href
    const text = this.inline(el.children)
    if (!href || /^(javascript|vbscript|data):/i.test(href)) return text
    if (href.startsWith('#')) {
      this.note('Links to anchors inside the page kept their text only.')
      return text
    }
    if (!text.trim()) return ''
    if (textOf(el).trim() === href && /^https?:\/\//i.test(href)) return href
    const title = el.attrs['title']
      ? ` "${el.attrs['title'].replace(/"/g, '\\"')}"`
      : ''
    return `[${text.trim()}](${wrapHref(href)}${title})`
  }

  image(el: IHtmlElement): string {
    const src = (el.attrs['data-src'] ?? el.attrs['src'] ?? '').trim()
    if (!src) return ''
    const alt = escapeText((el.attrs['alt'] ?? '').replace(/\s+/g, ' ').trim())
    const attrs: string[] = []
    const align = imageAlign(el)
    if (align) attrs.push(`align=${align}`)
    const width = cssWidth(el)
    if (width && width > 0) attrs.push(`width=${width}`)
    return `![${alt}](${wrapHref(src)})${attrs.length > 0 ? `{${attrs.join(' ')}}` : ''}`
  }
}

function wrapHref(href: string): string {
  if (href.startsWith('data:'))
    return href.replace(/[\s()]/g, (ch) => encodeURIComponent(ch))
  if (/[\s<>]/.test(href))
    return `<${href.replace(/[<>]/g, (ch) => encodeURIComponent(ch))}>`
  return href.replace(/[()]/g, '\\$&')
}

/** The `<title>` of a document tree, if it has one. */
export function htmlTitle(nodes: THtmlNode[]): string | undefined {
  for (const node of nodes) {
    const found = findFirst(node, (el) => el.tag === 'title')
    if (found) {
      const text = textOf(found).replace(/\s+/g, ' ').trim()
      if (text) return text
    }
  }
  return undefined
}

/**
 * The markdown for a parsed HTML document.
 *
 * `nodes` is the whole document or a fragment. Only `<body>` is converted
 * when there is one, so a `<title>` never turns up as a stray paragraph.
 */
export function htmlToMarkdown(nodes: THtmlNode[]): IHtmlConvertResult {
  const renderer = new HtmlRenderer()
  let content = nodes
  for (const node of nodes) {
    const body = findFirst(node, (el) => el.tag === 'body')
    if (body) {
      content = body.children
      break
    }
  }
  const markdown = renderer
    .render(content)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { markdown, title: htmlTitle(nodes), issues: [...renderer.issues] }
}
