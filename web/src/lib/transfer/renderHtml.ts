/**
 * A page as a self-contained HTML document: the reader's rendering, the
 * reader's styles, and nothing that needs the app or the network to read.
 *
 * The markup comes from `MarkdownView` itself, mounted off screen for one
 * synchronous render, so a callout, a toggle or a table is exactly what the
 * reader draws. The reader then decorates asynchronously (highlighting,
 * formulas, diagrams, link cards), and an export cannot wait on a component's
 * timers, so those decorations are applied here with the same functions the
 * reader calls, and awaited.
 *
 * Styles are the rules in the app's own stylesheets that match something in
 * the export, so a page carries the few kilobytes it uses rather than the
 * whole application.
 */
import { createApp } from 'vue'
import MarkdownView from '@/components/MarkdownView.vue'
import { highlight, resolveLanguage } from '@/components/decorations/highlight'
import { renderMath } from '@/components/decorations/katex'
import { renderDiagram } from '@/components/decorations/mermaid'
import {
  bareUrlParagraph,
  linkCardHtml,
  type ILinkPreview,
} from '@/components/decorations/linkCards'
import { PRINT_CSS } from './print'

export interface IRenderAttachment {
  id: string
  filename: string
  mime?: string
  size?: number
  url: string
}

export interface IRenderDeps {
  /** Bytes for an uploaded file, so a picture can be inlined. */
  attachmentData?: (
    id: string,
  ) => Promise<{ bytes: Uint8Array; mime: string } | null>
  /** Link card metadata for bare URLs. Without it they stay plain links. */
  linkPreviews?: (urls: string[]) => Promise<ILinkPreview[]>
  /** The address relative links are made absolute against. */
  origin?: string
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

/** The reader's markup for `source`, from one synchronous render. */
export function readerMarkup(
  source: string,
  attachments: IRenderAttachment[],
): string {
  const host = document.createElement('div')
  const app = createApp(MarkdownView, { source, attachments })
  // Mounted outside the app, so the router and the shell are not provided.
  // Nothing this render reaches needs them, and the warnings are noise.
  app.config.warnHandler = () => {}
  app.mount(host)
  const markup = host.innerHTML
  // Unmounted before the reader's own decorations, which wait a tick, can
  // start on markup that is about to be thrown away.
  app.unmount()
  return markup
}

/**
 * A container in a document of its own. Markup parsed into the live document
 * starts loading every picture it names, and nothing here is for display.
 */
function inertContainer(markup: string): HTMLElement {
  const doc = document.implementation.createHTMLDocument('')
  const root = doc.createElement('div')
  root.innerHTML = markup
  doc.body.append(root)
  return root
}

/** The id in a served attachment address, or null. */
function attachmentIdFromUrl(src: string): string | null {
  const match = /\/api\/v1\/attachments\/([A-Za-z0-9_-]+)(?:[?#].*)?$/.exec(src)
  return match ? match[1] : null
}

/**
 * Applies what the reader applies after rendering, and makes the result
 * independent of this instance: pictures inlined, links absolute, controls
 * that only work inside the app removed.
 */
export async function finishMarkup(
  markup: string,
  deps: IRenderDeps = {},
): Promise<string> {
  const root = inertContainer(markup)
  const origin = deps.origin ?? window.location.origin

  root
    .querySelectorAll('.md__anchor, .md__code-copy, .md-wrap__toggle')
    .forEach((el) => el.remove())

  for (const pre of Array.from(root.querySelectorAll<HTMLElement>('pre'))) {
    if (pre.classList.contains('md__mermaid')) {
      const source = pre.textContent ?? ''
      const result = await renderDiagram(source).catch(() => ({
        error: 'failed',
      }))
      if ('svg' in result) {
        const figure = root.ownerDocument.createElement('div')
        figure.className = 'md__diagram-figure'
        figure.setAttribute('role', 'img')
        // The source travels with the picture, so an import of this file
        // gets the diagram back rather than a drawing of it.
        figure.setAttribute('data-mermaid', source)
        figure.innerHTML = result.svg
        pre.replaceWith(figure)
      }
      continue
    }
    const code = pre.querySelector('code')
    if (!code) continue
    const written = /language-([\w+#-]+)/.exec(code.className)?.[1] ?? ''
    const source = code.textContent ?? ''
    pre.classList.add('md__code')
    if (written) pre.setAttribute('data-language', written)
    const bar = root.ownerDocument.createElement('div')
    bar.className = 'md__code-bar'
    const label = root.ownerDocument.createElement('span')
    label.className = 'md__code-lang'
    label.textContent = written || 'text'
    bar.append(label)
    pre.prepend(bar)
    if (!resolveLanguage(written)) continue
    const highlighted = await highlight(source, written).catch(() => null)
    if (!highlighted) continue
    const holder = root.ownerDocument.createElement('div')
    holder.innerHTML = highlighted
    const replacement = holder.querySelector('code')
    if (replacement) {
      replacement.classList.add(`language-${written}`)
      code.replaceWith(replacement)
    }
  }

  for (const el of Array.from(
    root.querySelectorAll<HTMLElement>('[data-math]'),
  )) {
    const latex = el.getAttribute('data-math') ?? ''
    const result = await renderMath(latex, el.hasAttribute('data-math-block'))
    if ('html' in result) el.innerHTML = result.html
  }

  const cards = new Map<string, HTMLElement[]>()
  for (const p of Array.from(root.querySelectorAll<HTMLElement>('p'))) {
    const url = bareUrlParagraph(p)
    if (!url) continue
    p.setAttribute('data-link-card', url)
    cards.set(url, [...(cards.get(url) ?? []), p])
  }
  if (cards.size > 0 && deps.linkPreviews) {
    const previews = await deps.linkPreviews([...cards.keys()]).catch(() => [])
    for (const preview of previews) {
      if (preview.status !== 'ok') continue
      for (const p of cards.get(preview.url) ?? []) {
        p.classList.add('md__card-slot')
        p.innerHTML = `<span class="md__card-hold">${linkCardHtml(preview.url, preview)}</span>`
      }
    }
  }

  for (const img of Array.from(
    root.querySelectorAll<HTMLImageElement>('img'),
  )) {
    img.removeAttribute('loading')
    const src = img.getAttribute('src') ?? ''
    const id = attachmentIdFromUrl(src)
    if (id && deps.attachmentData) {
      const data = await deps.attachmentData(id).catch(() => null)
      if (data) {
        img.setAttribute(
          'src',
          `data:${data.mime};base64,${toBase64(data.bytes)}`,
        )
        continue
      }
    }
    if (src.startsWith('/')) img.setAttribute('src', `${origin}${src}`)
  }

  for (const anchor of Array.from(
    root.querySelectorAll<HTMLAnchorElement>('a[href]'),
  )) {
    const href = anchor.getAttribute('href') ?? ''
    if (anchor.classList.contains('md__file')) {
      const name = anchor.querySelector('.md__file-name')?.textContent
      if (name) anchor.setAttribute('data-filename', name)
    }
    if (href.startsWith('/')) anchor.setAttribute('href', `${origin}${href}`)
  }

  return root.innerHTML
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/** Selectors whose rules only ever describe the dark theme. */
const DARK = /(^|[\s,(])\.dark\b|data-theme=['"]?dark/

const KEEP_ROOT_PROPS =
  /^(--|font|color$|background-color$|line-height$|-webkit-font-smoothing$|text-rendering$)/

function splitSelectors(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/** A selector with its state and pseudo-element parts removed, for matching. */
function staticSelector(selector: string): string {
  return selector
    .replace(
      /::?(before|after|marker|placeholder|selection|backdrop|details-content|first-line|first-letter|-webkit-[\w-]+|-moz-[\w-]+)(\([^)]*\))?/g,
      '',
    )
    .replace(
      /:(hover|focus|focus-visible|focus-within|active|visited|link|target|checked|disabled|enabled|indeterminate|open|popover-open|placeholder-shown)\b/g,
      '',
    )
    .trim()
}

function isRootSelector(selector: string): boolean {
  return (
    /^(:root|html|body)\b/.test(selector) &&
    !/\s/.test(selector.replace(/^(:root|html|body)/, '').trim())
  )
}

function matchesExport(selector: string, sandbox: HTMLElement): boolean {
  const stripped = staticSelector(selector)
  if (!stripped) return true
  try {
    return sandbox.querySelector(stripped) !== null || sandbox.matches(stripped)
  } catch {
    // A selector this engine cannot parse is kept rather than guessed about.
    return true
  }
}

function filterRules(
  rules: CSSRuleList,
  sandbox: HTMLElement,
  fonts: CSSFontFaceRule[],
): string {
  let css = ''
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const selectors = splitSelectors(rule.selectorText).filter(
        (s) => !DARK.test(s),
      )
      if (selectors.length === 0) continue
      const roots = selectors.filter(isRootSelector)
      if (roots.length > 0) {
        const declarations: string[] = []
        for (let i = 0; i < rule.style.length; i++) {
          const name = rule.style.item(i)
          if (KEEP_ROOT_PROPS.test(name))
            declarations.push(`${name}:${rule.style.getPropertyValue(name)}`)
        }
        if (declarations.length > 0)
          css += `${roots.join(',')}{${declarations.join(';')}}\n`
      }
      const kept = selectors.filter(
        (s) => !isRootSelector(s) && matchesExport(s, sandbox),
      )
      if (kept.length > 0) {
        const body = rule.cssText.slice(rule.cssText.indexOf('{'))
        css += `${kept.join(',')}${body}\n`
      }
      continue
    }
    if (rule instanceof CSSMediaRule) {
      if (/prefers-color-scheme:\s*dark/.test(rule.conditionText)) continue
      const inner = filterRules(rule.cssRules, sandbox, fonts)
      if (inner) css += `@media ${rule.conditionText}{${inner}}\n`
      continue
    }
    if (
      typeof CSSSupportsRule !== 'undefined' &&
      rule instanceof CSSSupportsRule
    ) {
      const inner = filterRules(rule.cssRules, sandbox, fonts)
      if (inner) css += `@supports ${rule.conditionText}{${inner}}\n`
      continue
    }
    if (rule instanceof CSSFontFaceRule) {
      if (/KaTeX/.test(rule.style.getPropertyValue('font-family')))
        fonts.push(rule)
      continue
    }
    const nested = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules
    if (nested) css += filterRules(nested, sandbox, fonts)
  }
  return css
}

/** KaTeX's own fonts, inlined, so a formula renders the same offline. */
async function inlineFonts(fonts: CSSFontFaceRule[]): Promise<string> {
  let css = ''
  for (const rule of fonts) {
    const src = rule.style.getPropertyValue('src')
    const woff2 = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(src)?.[1]
    if (!woff2) continue
    try {
      const base = rule.parentStyleSheet?.href ?? window.location.href
      const res = await fetch(new URL(woff2, base))
      if (!res.ok) continue
      const bytes = new Uint8Array(await res.arrayBuffer())
      const family = rule.style.getPropertyValue('font-family')
      const weight = rule.style.getPropertyValue('font-weight') || 'normal'
      const style = rule.style.getPropertyValue('font-style') || 'normal'
      css += `@font-face{font-family:${family};font-weight:${weight};font-style:${style};src:url(data:font/woff2;base64,${toBase64(bytes)}) format("woff2")}\n`
    } catch {
      // The formula still renders in a fallback face.
    }
  }
  return css
}

/**
 * Every rule in the page's stylesheets that applies to `markup`, plus the
 * theme tokens those rules read. Dark-theme rules are left out: a file handed
 * to somebody else, or a sheet of paper, is read in the light.
 */
export async function collectCss(markup: string): Promise<string> {
  const sandbox = inertContainer(markup)
  const fonts: CSSFontFaceRule[] = []
  let css = ''
  for (const sheet of Array.from(document.styleSheets)) {
    // The print rules are embedded on their own, whole.
    if ((sheet.ownerNode as Element | null)?.hasAttribute?.('data-acta-print'))
      continue
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    css += filterRules(rules, sandbox, fonts)
  }
  if (sandbox.querySelector('.katex')) css += await inlineFonts(fonts)
  return css
}

/** Layout for the exported document itself, independent of the app. */
export const DOCUMENT_CSS = `
:root{color-scheme:light}
html{background:#fff}
body{margin:0;background:#fff;color:#1b1f24;font-family:var(--nb-font-family-sans,"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif)}
.export{max-width:52rem;margin:0 auto;padding:48px 24px 96px}
.export__page{margin:0 0 64px}
.export__title{margin:0 0 16px;font-size:2rem;line-height:1.25}
.export .md img{max-width:100%;height:auto}
.export details.md__details[open]>summary{margin-bottom:8px}
.export .md__card-plain{overflow-wrap:anywhere}
`

export interface IHtmlPage {
  title: string
  /** Finished markup from `finishMarkup`. */
  markup: string
}

/** The complete document. `css` comes from `collectCss`. */
export function buildHtmlDocument(
  title: string,
  pages: IHtmlPage[],
  css: string,
): string {
  const sections = pages
    .map(
      (page) =>
        `<section class="export__page"><h1 class="export__title">${escapeHtml(page.title)}</h1>${page.markup}</section>`,
    )
    .join('\n')
  // Opening every toggle before printing is the one behaviour paper needs
  // that CSS alone cannot give in every browser.
  const script =
    "window.addEventListener('beforeprint',function(){document.querySelectorAll('details').forEach(function(d){d.open=true})})"
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Acta">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
<style>${DOCUMENT_CSS}</style>
<style>${PRINT_CSS}</style>
</head>
<body>
<main class="export">
${sections}
</main>
<script>${script}</script>
</body>
</html>
`
}
