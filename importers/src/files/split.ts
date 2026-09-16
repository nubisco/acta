/**
 * One long document into a tree of pages, cut at its headings.
 *
 * Works on markdown rather than on the HTML it may have come from, so the
 * same rule applies whatever the source was: an HTML file, a Word document,
 * or a markdown file somebody wants broken up.
 *
 * With a level of 2, every `#` and `##` heading starts a page. A `##` page
 * sits under the `#` page before it, and a `###` stays inside the page it
 * belongs to. Headings inside a code fence, a formula or a toggle are content,
 * not structure, and never cut anything.
 */

export interface ISplitPage {
  title: string
  body: string
  children: ISplitPage[]
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** The text of a heading with its inline markup taken off, for a page title. */
export function plainHeading(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\\])[*_](.+?)[*_]/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>$&:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function trimBlankLines(lines: string[]): string {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end).join('\n')
}

/**
 * Cuts `markdown` at every heading of `level` or shallower.
 *
 * The result is rooted at a page titled `rootTitle` holding whatever came
 * before the first cut. When that preamble is empty and exactly one page sits
 * under it, the one page is returned instead: a document that opens with its
 * own title as a heading should not import as an empty page wrapped around
 * itself.
 */
export function splitByHeadings(
  markdown: string,
  level: number,
  rootTitle: string,
): ISplitPage {
  const depth = Math.min(6, Math.max(1, Math.floor(level)))
  const root: ISplitPage = { title: rootTitle, body: '', children: [] }
  const stack: { page: ISplitPage; level: number; lines: string[] }[] = [
    { page: root, level: 0, lines: [] },
  ]
  const settle = (entry: { page: ISplitPage; lines: string[] }) => {
    entry.page.body = trimBlankLines(entry.lines)
  }

  let fence: string | null = null
  let maths = false
  let toggles = 0
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const current = stack[stack.length - 1]
    const trimmed = line.trim()
    const opening = FENCE.exec(line)
    if (fence !== null) {
      if (
        opening &&
        opening[1][0] === fence[0] &&
        opening[1].length >= fence.length
      )
        fence = null
      current.lines.push(line)
      continue
    }
    if (opening) {
      fence = opening[1]
      current.lines.push(line)
      continue
    }
    if (maths || trimmed === '$$') {
      if (trimmed === '$$') maths = !maths
      current.lines.push(line)
      continue
    }
    if (/^:::details(\s|$)/.test(trimmed)) toggles++
    else if (trimmed === ':::' && toggles > 0) toggles--

    const heading = toggles === 0 ? HEADING.exec(line) : null
    if (!heading || heading[1].length > depth) {
      current.lines.push(line)
      continue
    }

    const headingLevel = heading[1].length
    while (stack.length > 1 && stack[stack.length - 1].level >= headingLevel)
      settle(stack.pop()!)
    const page: ISplitPage = {
      title: plainHeading(heading[2]) || 'Untitled',
      body: '',
      children: [],
    }
    stack[stack.length - 1].page.children.push(page)
    stack.push({ page, level: headingLevel, lines: [] })
  }
  while (stack.length > 0) settle(stack.pop()!)

  if (root.body === '' && root.children.length === 1) return root.children[0]
  return root
}
