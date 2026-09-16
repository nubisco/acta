/**
 * A set of files into a tree of pages.
 *
 * The layout this reads is the one the markdown export writes, and the one
 * Notion, Obsidian and most static-site tools already use:
 *
 *     Handbook.md             the page
 *     Handbook/               its children
 *       Onboarding.md
 *       Onboarding/
 *         First week.md
 *     attachments/logo.png    referenced from a page, never a page itself
 *
 * A folder with no page file beside it still becomes a page, because a folder
 * is how a person groups things: `index.md` or `README.md` inside it supplies
 * the body when there is one, and otherwise the page is an empty parent. A
 * folder holding no markdown at all is a folder of files and becomes nothing.
 */

import { readFrontmatter, type IPageMeta } from './frontmatter'
import { basename, dirname, extname, stem } from './paths'
import { plainHeading } from './split'

/** One markdown document ready to be placed, whatever format it started as. */
export interface IMarkdownSource {
  /** Where it sat in the input, which decides its place in the tree. */
  path: string
  markdown: string
  /** A title the source stated outright, such as an HTML `<title>`. */
  title?: string
  /**
   * Pages already cut out of this source (heading splitting). When present,
   * they become the children of this source's own page.
   */
  children?: IPlannedPage[]
}

export interface IPlannedPage {
  title: string
  body: string
  tags: string[]
  /** The folder relative links in the body are resolved against. */
  baseDir: string
  /** The file the page came from, for links between imported pages. */
  sourcePath?: string
  order?: number
  children: IPlannedPage[]
}

export const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'txt'])

const INDEX_NAMES = new Set(['index', 'readme', '_index'])

/**
 * A title from a filename. Notion appends a 32-character id to every name it
 * exports, which is noise to a reader, so it is removed.
 */
export function titleFromFilename(path: string): string {
  const name = stem(basename(path))
    .replace(/\s+[0-9a-f]{32}$/i, '')
    .replace(/[_]+/g, ' ')
    .trim()
  return name || 'Untitled'
}

/**
 * The title and body of one markdown document.
 *
 * Frontmatter wins, then a title the source stated, then a first-line `# `
 * heading, then the filename. A heading used as the title is removed from the
 * body, or the page would show its name twice. A heading is only removed when
 * nothing else supplied the title, so a page that genuinely opens with a
 * heading keeps it after an export and an import.
 */
export function pageFromMarkdown(
  source: IMarkdownSource,
): Omit<IPlannedPage, 'children'> {
  const { meta, body } = readFrontmatter(source.markdown)
  let title = meta.title ?? source.title?.trim()
  let text = body
  if (!meta.title) {
    const lines = text.replace(/^\s*\n/, '').split('\n')
    const first = /^#\s+(.+?)\s*#*\s*$/.exec(lines[0] ?? '')
    const heading = first ? plainHeading(first[1]) : ''
    if (first && (!title || heading === title)) {
      title = heading
      text = lines
        .slice(1)
        .join('\n')
        .replace(/^\s*\n/, '')
    }
  }
  return {
    title: (title || titleFromFilename(source.path)).slice(0, 300),
    body: text.replace(/\s+$/, ''),
    tags: meta.tags ?? [],
    order: (meta as IPageMeta).order,
    baseDir: dirname(source.path),
    sourcePath: source.path,
  }
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function sortPages(pages: IPlannedPage[]): IPlannedPage[] {
  return pages.sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY
    const bo = b.order ?? Number.POSITIVE_INFINITY
    if (ao !== bo) return ao - bo
    return naturalCompare(a.title, b.title)
  })
}

/** Places every source in a tree following the folder layout above. */
export function planPageTree(sources: IMarkdownSource[]): IPlannedPage[] {
  const byDir = new Map<string, IMarkdownSource[]>()
  const dirs = new Set<string>([''])
  for (const source of sources) {
    const dir = dirname(source.path)
    const list = byDir.get(dir) ?? []
    list.push(source)
    byDir.set(dir, list)
    let walk = dir
    while (walk) {
      dirs.add(walk)
      walk = dirname(walk)
    }
  }

  const build = (dir: string): IPlannedPage[] => {
    const pages = new Map<string, IPlannedPage>()
    const files = byDir.get(dir) ?? []
    const childDirs = [...dirs].filter((d) => d && dirname(d) === dir)

    for (const source of files) {
      const own = pageFromMarkdown(source)
      const page: IPlannedPage = { ...own, children: source.children ?? [] }
      pages.set(stem(basename(source.path)).toLowerCase(), page)
    }

    for (const childDir of childDirs) {
      const name = basename(childDir)
      const key = name.toLowerCase()
      const nested = build(childDir)
      const existing = pages.get(key)
      if (existing) {
        existing.children.push(...nested)
        sortPages(existing.children)
        continue
      }
      // An index file inside the folder is the folder's own page, and so is
      // a file named after the folder (`Guide/guide.md`).
      const indexAt = nested.findIndex((page) => {
        if (!page.sourcePath || dirname(page.sourcePath) !== childDir)
          return false
        const own = stem(basename(page.sourcePath)).toLowerCase()
        return INDEX_NAMES.has(own) || own === key
      })
      if (indexAt !== -1) {
        const [index] = nested.splice(indexAt, 1)
        const titled =
          index.title === titleFromFilename(index.sourcePath ?? '')
            ? { ...index, title: titleFromFilename(name) }
            : index
        pages.set(key, {
          ...titled,
          children: sortPages([...titled.children, ...nested]),
        })
        continue
      }
      if (nested.length === 0) continue
      pages.set(key, {
        title: titleFromFilename(name),
        body: '',
        tags: [],
        baseDir: childDir,
        children: nested,
      })
    }
    return sortPages([...pages.values()])
  }

  return build('')
}

/** True for a path that holds a markdown page. */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(path))
}

/** Every page in the tree, parents before their children. */
export function flattenPages(pages: IPlannedPage[]): IPlannedPage[] {
  const out: IPlannedPage[] = []
  const walk = (list: IPlannedPage[]) => {
    for (const page of list) {
      out.push(page)
      walk(page.children)
    }
  }
  walk(pages)
  return out
}
