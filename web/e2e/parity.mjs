/**
 * Reader and editor parity, measured in a real browser.
 *
 * jsdom has no layout, so it cannot see a document reflow when somebody clicks
 * Edit. This loads one document in a headless Chromium, records every
 * top-level block's geometry and computed styles in reader mode, switches to
 * edit mode, records the same, and prints what differs.
 *
 * Not part of `pnpm test`: it needs a running server, a signed-in cookie jar
 * and a seeded document. The recipe:
 *
 *   1. `cd web && npx vite build`, then copy `web/dist` somewhere of its own.
 *   2. Start the server with a scratch ACTA_DATA_DIR, a free ACTA_PORT and
 *      ACTA_WEB_DIST pointing at that copy.
 *   3. Sign in over the API: POST /api/v1/auth/otp, read the code from the
 *      server log, POST /api/v1/auth/verify with `curl -c jar.txt`.
 *   4. Seed a document with every block type through POST /api/v1/docs/write.
 *
 * Every block of that document is compared on its left edge, width, height,
 * top offset from the first block, line count, the words each line starts and
 * ends with, computed typography, box styles and decoration details.
 *
 * Usage:
 *   node web/e2e/parity.mjs --base http://localhost:4811 --cookies jar.txt \
 *     --slug parity --out ./out [--width 1440 --height 900] [--label before]
 *
 * PLAYWRIGHT points at playwright's index.mjs when it is not resolvable from
 * here (this repository does not depend on it).
 *
 * Exit code: 0 when the only differences are the allowed ones, 1 otherwise.
 */
/* Node for the driver, and the browser for the functions it evaluates in the
   page. */
/* global process, console, URL, window, document, getComputedStyle, NodeFilter */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map((pair) => pair.trim().split(/\s+/))
    .map(([key, ...value]) => [key, value.join(' ')]),
)
const BASE = args.base ?? 'http://localhost:4811'
const SLUG = args.slug ?? 'parity'
const OUT = args.out ?? '.'
const WIDTH = Number(args.width ?? 1440)
const HEIGHT = Number(args.height ?? 900)
const LABEL = args.label ?? 'run'
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright')

mkdirSync(OUT, { recursive: true })

/* Netscape cookie jar, as curl writes it. */
const cookies = readFileSync(args.cookies, 'utf8')
  .split('\n')
  .filter((l) => l && (!l.startsWith('#') || l.startsWith('#HttpOnly_')))
  .map((l) => l.replace(/^#HttpOnly_/, '').split('\t'))
  .filter((p) => p.length >= 7)
  .map(([domain, , path, secure, expires, name, value]) => ({
    name,
    value,
    domain: domain.replace(/^\./, ''),
    path,
    secure: secure === 'TRUE',
    expires: Number(expires) || -1,
    httpOnly: true,
  }))

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
})
await context.addCookies(cookies)
const page = await context.newPage()

await page.goto(BASE + '/')
await page.waitForLoadState('networkidle')
const workspace = new URL(page.url()).pathname.split('/').filter(Boolean)[0]
await page.goto(`${BASE}/${workspace}/docs/${SLUG}`)
await page.waitForLoadState('networkidle')
await page.waitForTimeout(1500)
/* A new account gets a welcome dialog, and after it a guided tour. */
for (const name of ['Skip for now', 'Skip tour']) {
  const skip = page.getByRole('button', { name })
  if (await skip.count()) {
    await skip.click()
    await page.waitForTimeout(800)
  }
}
/* KaTeX, Shiki and Mermaid all arrive asynchronously. */
await page.waitForTimeout(2500)

/** Everything measured, for one surface. Runs in the page. */
function measure(rootSelector) {
  const root = document.querySelector(rootSelector)
  if (!root) return null
  const TYPE = [
    'fontSize',
    'lineHeight',
    'fontWeight',
    'letterSpacing',
    'color',
    'fontFamily',
  ]
  const BOX = [
    'marginTop',
    'marginBottom',
    'paddingTop',
    'paddingBottom',
    'paddingLeft',
    'paddingRight',
    'borderLeftWidth',
    'borderLeftColor',
    'borderTopWidth',
    'borderTopColor',
    'backgroundColor',
    'borderRadius',
  ]
  const pick = (el, keys) => {
    const cs = getComputedStyle(el)
    return Object.fromEntries(keys.map((k) => [k, cs[k]]))
  }
  const LEAF = 'p, li, h1, h2, h3, h4, h5, h6, td, th, summary'
  /* The lines of visible text under `n`, as { mid, left, text }. Controls (a
     heading's copy-link button, a table grip, a code block's bar) are not
     text, and a trailing space is not a character anybody sees. With `own`,
     only text whose nearest text block is `n` itself. */
  const textLines = (n, own) => {
    const found = []
    const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const parent = t.parentElement
      if (
        !parent ||
        parent.closest(
          'button, [aria-hidden="true"], .katex-mathml, .md__code-bar',
        )
      )
        continue
      if (!parent.checkVisibility()) continue
      if (own && parent.closest(LEAF) !== n) continue
      for (let i = 0; i < t.data.length; i++) {
        if (/\s/.test(t.data[i])) continue
        range.setStart(t, i)
        range.setEnd(t, i + 1)
        const r = range.getBoundingClientRect()
        if (r.width === 0) continue
        let line = found.find(
          (l) => Math.abs(l.mid - (r.top + r.bottom) / 2) < 8,
        )
        if (!line)
          found.push(
            (line = { mid: (r.top + r.bottom) / 2, left: r.left, text: '' }),
          )
        line.left = Math.min(line.left, r.left)
        line.text += t.data[i]
      }
    }
    return found.sort((a, b) => a.mid - b.mid)
  }
  const lines = (block) => textLines(block, false).length
  /* A block's kind, independent of the surface's wrapper markup. */
  const kind = (el) => {
    const cls =
      el.className && typeof el.className === 'string' ? el.className : ''
    for (const c of [
      'md__callout',
      'md__details',
      'md__math',
      'md__diagram',
      'md__mermaid',
      'md__card-slot',
      'md__code',
      'md__img',
    ]) {
      if (cls.split(/\s+/).includes(c)) return c
    }
    if (el.querySelector(':scope > .md__card, :scope .md__card-slot'))
      return 'md__card-slot'
    if (el.matches('p') && el.querySelector(':scope > img.md__img'))
      return 'md__img'
    if (
      el.matches('p') &&
      el.children.length === 1 &&
      el.firstElementChild.matches('.md__img')
    )
      return 'md__img'
    if (el.matches('pre')) return 'md__code'
    if (
      el.matches('ul') &&
      el.querySelector('input[type=checkbox], [data-checked]')
    )
      return 'tasklist'
    return el.tagName.toLowerCase()
  }
  /* The element that is the block, past markup only one surface has: the
     editor's table wrapper, the reader's paragraph around an image or a link
     card. */
  const unwrap = (el) => {
    if (el.matches('.tableWrapper') && el.querySelector(':scope > table'))
      return el.querySelector(':scope > table')
    if (
      el.matches('p') &&
      el.children.length === 1 &&
      el.firstElementChild.matches('img.md__img') &&
      !el.textContent.trim()
    ) {
      return el.firstElementChild
    }
    if (el.matches('.md__card-slot')) return el.querySelector('.md__card') ?? el
    return el
  }
  const blocks = [...root.children]
    .filter(
      (el) =>
        el.getBoundingClientRect().height > 0 &&
        !el.matches('.ProseMirror-gapcursor'),
    )
    .map(unwrap)
  const first = blocks[0]?.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  const detail = (el) => {
    const out = {}
    /* Rendered descendants only: the editor keeps a diagram's source in the
       document and hides it. */
    const q = (sel) =>
      [...el.querySelectorAll(sel)].find(
        (n) => n.getClientRects().length > 0,
      ) ?? null
    const code = el.matches('pre') ? el : q('pre')
    if (code)
      out.pre = pick(code, [...BOX, 'fontSize', 'fontFamily', 'lineHeight'])
    const inline = [...el.querySelectorAll('code')].find(
      (c) => !c.closest('pre'),
    )
    if (inline) out.code = pick(inline, [...TYPE, ...BOX])
    const cell = q('td')
    if (cell) out.td = pick(cell, [...TYPE, ...BOX, 'textAlign'])
    const head = q('th')
    if (head) out.th = pick(head, [...TYPE, ...BOX, 'textAlign'])
    const icon = q('.md__callout-icon')
    if (icon) {
      const r = icon.getBoundingClientRect()
      out.calloutIcon = {
        w: r.width,
        h: r.height,
        color: getComputedStyle(icon).color,
      }
    }
    /* Where every line of text starts and ends, for each text leaf. Two
       blocks with the same height can still wrap at different words. */
    /* Each line as "left:first..last", per text block, so the comparison is
       indifferent to whether a surface wraps an item's text in a paragraph. */
    const leaves = [el, ...el.querySelectorAll(LEAF)].filter(
      (n) => n.matches(LEAF) || n === el,
    )
    out.wraps = leaves
      .map((n) => textLines(n, n !== el || el.matches(LEAF)))
      .filter((found) => found.length > 0)
      .map((found) =>
        found
          .map(
            (l) =>
              `${Math.round(l.left - rootRect.left)}:${l.text.slice(0, 6)}..${l.text.slice(-6)}`,
          )
          .join(' | '),
      )
    const summary = q('.md__details-summary')
    if (summary) out.summary = pick(summary, TYPE)
    const li = q('li')
    if (li) {
      const r = li.getBoundingClientRect()
      out.li = {
        ...pick(li, [...TYPE, 'marginTop', 'marginBottom']),
        left: Math.round(r.left - rootRect.left),
      }
    }
    const dot = q('.md__color-dot')
    if (dot) {
      const r = dot.getBoundingClientRect()
      out.swatch = {
        w: Math.round(r.width),
        h: Math.round(r.height),
        left: Math.round(r.left - rootRect.left),
        top: Math.round(r.top - el.getBoundingClientRect().top),
      }
    }
    const img = el.matches('img') ? el : q('img')
    if (img) {
      const r = img.getBoundingClientRect()
      out.img = {
        w: Math.round(r.width),
        h: Math.round(r.height),
        left: Math.round(r.left - rootRect.left),
        ...pick(img, ['borderRadius']),
      }
    }
    const katex = q('.katex')
    if (katex) {
      const r = katex.getBoundingClientRect()
      out.katex = {
        w: Math.round(r.width),
        h: Math.round(r.height),
        left: Math.round(r.left - rootRect.left),
      }
    }
    return out
  }
  return {
    rootLeft: Math.round(rootRect.left),
    rootWidth: Math.round(rootRect.width),
    firstTop: first ? Math.round(first.top + window.scrollY) : null,
    blocks: blocks.map((el) => {
      const r = el.getBoundingClientRect()
      /* Text-bearing element for the line count: a callout's paragraph rather
         than its grid, a toggle's summary rather than its border. */
      return {
        kind: kind(el),
        text: (el.textContent ?? '').trim().slice(0, 32),
        left: Math.round(r.left - rootRect.left),
        width: Math.round(r.width),
        height: Math.round(r.height),
        top: Math.round(r.top - first.top),
        lines: lines(el),
        type: pick(el, TYPE),
        box: pick(el, BOX),
        detail: detail(el),
      }
    }),
  }
}

async function chrome() {
  return page.evaluate(() => {
    const title = document.querySelector('.docs__doc > h1')
    const bodyH1 = document.querySelector('.docs__doc :is(.md, .tiptap) h1')
    const toc = document.querySelector('.docs__toc')
    const box = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
      }
    }
    return {
      title: box(title),
      bodyH1: box(bodyH1),
      toc: box(toc),
      tocOverlay: !!document.querySelector('.docs--toc-overlay'),
      tocLinks: document.querySelectorAll(
        '.docs__toc a, .docs__toc [role=link]',
      ).length,
    }
  })
}

const reader = await page.evaluate(measure, '.docs__doc .md')
const readerChrome = await chrome()
await page.screenshot({ path: `${OUT}/${LABEL}-${WIDTH}-reader.png` })

await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
await page.waitForTimeout(2500)
/* The caret goes to the start of the document on autofocus. Blur so the
   measured page is the one somebody sees before typing. */
await page.evaluate(() => document.activeElement?.blur())
await page.mouse.move(0, HEIGHT - 1)
await page.waitForTimeout(500)
const editor = await page.evaluate(measure, '.docs__doc .tiptap')
const editorChrome = await chrome()
await page.screenshot({ path: `${OUT}/${LABEL}-${WIDTH}-editor.png` })
await browser.close()

/* The diff. */
const diffs = []
const add = (where, what, a, b) =>
  diffs.push({ where, what, reader: a, editor: b })
const px = (v) => Number.parseFloat(v)
const same = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) <= 1
  if (/^-?[\d.]+px$/.test(a ?? '') && /^-?[\d.]+px$/.test(b ?? ''))
    return Math.abs(px(a) - px(b)) <= 0.5
  return JSON.stringify(a) === JSON.stringify(b)
}
const compare = (where, a, b) => {
  for (const key of new Set([
    ...Object.keys(a ?? {}),
    ...Object.keys(b ?? {}),
  ])) {
    const x = a?.[key]
    const y = b?.[key]
    if (x && typeof x === 'object' && y && typeof y === 'object')
      compare(`${where}.${key}`, x, y)
    else if (!same(x, y)) add(where, key, x, y)
  }
}

if (!reader || !editor) {
  console.log('could not find a surface', {
    reader: !!reader,
    editor: !!editor,
  })
  process.exit(2)
}
if (
  reader.rootLeft !== editor.rootLeft ||
  reader.rootWidth !== editor.rootWidth
) {
  add(
    'root',
    'left/width',
    [reader.rootLeft, reader.rootWidth],
    [editor.rootLeft, editor.rootWidth],
  )
}
if (!same(reader.firstTop, editor.firstTop))
  add('root', 'firstTop', reader.firstTop, editor.firstTop)
if (reader.blocks.length !== editor.blocks.length) {
  add('root', 'blockCount', reader.blocks.length, editor.blocks.length)
}
/* Differences that are structure rather than appearance, each with why. */
const ALLOWED = [
  {
    kind: 'md__details',
    where: 'box',
    what: 'paddingLeft',
    why: 'The reader insets a native <details> to make room for its drawn caret, the editor lays a caret button beside the content in a flex row. The title and body positions are compared through `wraps`.',
  },
]
const n = Math.min(reader.blocks.length, editor.blocks.length)
for (let i = 0; i < n; i++) {
  const a = reader.blocks[i]
  const b = editor.blocks[i]
  const where = `#${i} ${a.kind}${a.kind === b.kind ? '' : `/${b.kind}`} "${a.text}"`
  compare(
    where,
    {
      left: a.left,
      width: a.width,
      height: a.height,
      top: a.top,
      lines: a.lines,
    },
    {
      left: b.left,
      width: b.width,
      height: b.height,
      top: b.top,
      lines: b.lines,
    },
  )
  compare(`${where} type`, a.type, b.type)
  const box = { ...a.box }
  const boxB = { ...b.box }
  for (const rule of ALLOWED) {
    if (rule.kind === a.kind && rule.where === 'box') {
      delete box[rule.what]
      delete boxB[rule.what]
    }
  }
  compare(`${where} box`, box, boxB)
  compare(`${where} detail`, a.detail, b.detail)
}

const report = {
  width: WIDTH,
  height: HEIGHT,
  readerChrome,
  editorChrome,
  diffs,
  reader,
  editor,
}
writeFileSync(`${OUT}/${LABEL}-${WIDTH}.json`, JSON.stringify(report, null, 2))
console.log(
  `viewport ${WIDTH}x${HEIGHT}, blocks reader=${reader.blocks.length} editor=${editor.blocks.length}`,
)
console.log('chrome reader', JSON.stringify(readerChrome))
console.log('chrome editor', JSON.stringify(editorChrome))
for (const d of diffs) {
  console.log(
    `${d.where} :: ${d.what}: reader=${JSON.stringify(d.reader)} editor=${JSON.stringify(d.editor)}`,
  )
}
console.log(`differences: ${diffs.length}`)
process.exit(diffs.length === 0 ? 0 : 1)
