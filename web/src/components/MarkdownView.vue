<template>
  <div class="md-wrap">
    <!-- Sanitized: markdown-it renders with html disabled; only our own
         extension transforms emit markup. -->
    <!-- eslint-disable vue/no-v-html -->
    <div
      ref="rootEl"
      class="md"
      :class="{ 'md--wide': wide, 'md--clamped': clampedNow }"
      :style="clampedNow ? { maxBlockSize: `${clamp}rem` } : undefined"
      @click="onClick"
      v-html="html"
    />
    <!-- eslint-enable vue/no-v-html -->

    <!-- Only when the content actually overflows. A "Show more" under three
         lines of text is a button that lies about there being more. -->
    <button
      v-if="clamp && overflows"
      type="button"
      class="md-wrap__toggle"
      :aria-expanded="!clampedNow"
      @click="expanded = !expanded"
    >
      <NbIcon :name="clampedNow ? 'caret-down' : 'caret-up'" :size="14" />
      {{ clampedNow ? 'Show more' : 'Show less' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'
import MarkdownIt from 'markdown-it'
import { useRouter } from 'vue-router'
import { useDocPreview, useInspector, useWorkspace } from '@/stores/workspace'
import { useRefCards } from '@/stores/refs'
import { chartColorFor } from '@/lib/colors'
import { DOC_NAV_KEY } from '@/lib/keys'
import { wpath } from '@/lib/paths'
import { safeUrl } from '@/lib/safeUrl'
import { sectionMap } from '@nubisco/acta-shared'
import { CALLOUT_TYPES, calloutIconSvg as calloutIcon } from '@/lib/callouts'
import { isDarkColor, parseColor } from '@/components/decorations/colors'
import { highlight, resolveLanguage } from '@/components/decorations/highlight'
import {
  itemChip,
  itemChipHtml,
  refIconSvg,
} from '@/components/decorations/refs'
import {
  DRIVE_COLORS,
  DRIVE_LABELS,
  parseDriveUrl,
  type TDriveKind,
} from '@/lib/drive'

const props = defineProps<{
  source: string
  wide?: boolean
  /**
   * Attachments on the thing being rendered, so `attachment:<id>` embeds can
   * be resolved. Without them an embed still renders, as an image pointing at
   * the served URL, which is right for the common case and wrong only for a
   * non-image, where the mime is what decides between a picture and a chip.
   */
  attachments?: {
    id: string
    filename: string
    mime?: string
    size?: number
    url: string
  }[]
  /**
   * Collapse to this many rem and fade the cut, with a toggle underneath.
   * Omitted, the block renders at its natural height, which is right for a
   * document but wrong for a card whose description runs to a page and
   * pushes the conversation off the screen.
   */
  clamp?: number
}>()

const router = useRouter()
const inspector = useInspector()
const docPreview = useDocPreview()
const refCards = useRefCards()
const ws = useWorkspace()
const rootEl = ref<HTMLElement | null>(null)

const expanded = ref(false)
const overflows = ref(false)
/** Clamped only while there is a clamp, it is not expanded, and the content
 *  genuinely exceeds it. */
const clampedNow = computed(
  () => !!props.clamp && !expanded.value && overflows.value,
)

/**
 * Measured, not estimated. Character counts and line counts both lie: a table
 * or an image is one "line" and half a screen tall, and the same markdown is
 * a different height in the panel than in the modal.
 */
async function measure(): Promise<void> {
  if (!props.clamp) {
    overflows.value = false
    return
  }
  // Measure unclamped, or the max-height we applied last time is what gets
  // measured and the block latches to "overflowing" forever.
  const wasExpanded = expanded.value
  expanded.value = true
  await nextTick()
  const el = rootEl.value
  const limit =
    props.clamp *
    parseFloat(getComputedStyle(document.documentElement).fontSize || '16')
  overflows.value = !!el && el.scrollHeight > limit + 1
  expanded.value = wasExpanded
}
// Surfaces that ARE the docs space navigate on doc refs; everywhere else a
// doc ref opens the quick-look modal so the reader keeps their context.
const docNav = inject(DOC_NAV_KEY, null)

// `breaks: true` because every surface this renders is typed text, not a
// prose document: card descriptions, comments, and imported Trello bodies all
// separate fields with single newlines. CommonMark would join those into one
// paragraph, so "**From:** a\n**Email:** b" ran together on one line. Trello,
// Slack and GitHub comments all break on a single newline for the same reason.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

/**
 * Enhanced-Markdown extensions (design-spec §2), applied as source and output
 * transforms around a stock CommonMark+GFM-ish renderer:
 * callouts, :::details, [[refs]], ![[query]] placeholders, mermaid fences.
 */

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderRefs(html: string): string {
  return html.replace(
    /(!?)\[\[([^\][<>]+)\]\]/g,
    (raw, bang: string, inner: string) => {
      const [target, alias] = inner.split('|').map((s) => s.trim())
      if (bang === '!') {
        if (target.startsWith('query:'))
          return `<span class="md__embed" data-query="${esc(target.slice(6).trim())}">Live item list (${esc(target.slice(6).trim())}) renders here soon</span>`
        return esc(raw)
      }
      if (target.startsWith('@'))
        return `<span class="md__mention" data-handle="${esc(target.slice(1))}">${esc(target)}</span>`
      if (target.startsWith('space:'))
        return `<a class="md__ref md__ref--link" data-ref-type="space" data-ref="${esc(target.slice(6))}" href="${esc(wpath(`/s/${target.slice(6)}`))}">${refIconSvg('space')}<span>${esc(alias ?? target.slice(6))}</span></a>`
      if (target.startsWith('doc:'))
        return `<a class="md__ref md__ref--link" data-ref-type="doc" data-ref="${esc(target.slice(4))}" href="${esc(wpath(`/docs/${target.slice(4)}`))}">${refIconSvg('doc')}<span>${esc(alias ?? target.slice(4))}</span></a>`
      if (/^[A-Z][A-Z0-9]{1,4}-\d+$/.test(target))
        return `<button type="button" class="md__ref md__ref--item" data-ref-type="item" data-ref="${esc(target)}">${esc(alias ?? target)}</button>`
      return esc(raw)
    },
  )
}

/**
 * Google Drive links become pills.
 *
 * Applied to the rendered HTML rather than the markdown source, so it catches
 * both `[text](url)` links and bare URLs that linkify turned into anchors,
 * without having to re-implement either.
 *
 * A link whose text is not the URL is left alone: somebody who wrote
 * "[the Q3 plan](https://docs.google.com/...)" has already said what it is,
 * and replacing their words with "Google Doc" would lose information. Only
 * the naked URL, which reads as forty characters of noise, is worth
 * replacing.
 */
function renderDriveLinks(html: string): string {
  return html.replace(
    /<a href="([^"]+)"([^>]*)>([^<]*)<\/a>/g,
    (raw, href: string, attrs: string, text: string) => {
      const link = parseDriveUrl(decodeHtml(href))
      if (!link) return raw
      const bare = decodeHtml(text).replace(/\/$/, '')
      const target = decodeHtml(href).replace(/\/$/, '')
      if (bare !== target) return raw
      const label = DRIVE_LABELS[link.kind]
      return (
        `<a class="md__drive" href="${esc(decodeHtml(href))}"` +
        ` target="_blank" rel="noopener noreferrer"` +
        ` data-drive-kind="${link.kind}" data-drive-id="${esc(link.id)}"` +
        ` title="Opens ${label} in a new tab"${attrs}>` +
        `${driveGlyph(link.kind)}<span class="md__drive-label">${label}</span>` +
        `</a>`
      )
    },
  )
}

/** markdown-it escapes attribute values, so they come back out before parsing. */
function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * A filled rounded square in the app's own colour, with the sheet-corner cut
 * every Drive icon shares. Inline rather than an image so it inherits the
 * text size and needs no network request.
 */
function driveGlyph(kind: TDriveKind): string {
  return (
    `<svg class="md__drive-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<path fill="${DRIVE_COLORS[kind]}" d="M14 2H6.5A1.5 1.5 0 0 0 5 3.5v17A1.5 1.5 0 0 0 6.5 22h11a1.5 1.5 0 0 0 1.5-1.5V7l-5-5Z"/>` +
    `<path fill="#fff" fill-opacity=".35" d="M14 2l5 5h-5V2Z"/>` +
    `</svg>`
  )
}

/**
 * `![alt](attachment:<id>)` becomes the file it names.
 *
 * The markdown stores an id rather than a URL on purpose: a URL is wrong the
 * moment the instance moves host, and these live in documents that outlast
 * any deployment. Resolution happens here, at render time.
 *
 * An image is shown. Anything else becomes a chip you can download, because
 * an `<img>` pointing at a PDF is a broken image icon and tells the reader
 * nothing about what is attached.
 */
function renderAttachments(html: string): string {
  return html.replace(
    /<img([^>]*?)src="attachment:([^"]+)"([^>]*)>/g,
    (_raw, before: string, id: string, after: string) => {
      const meta = (props.attachments ?? []).find((a) => a.id === id.trim())
      // A link attachment's URL is whatever somebody sent to the API, and a
      // valid URL can still be `javascript:`. markdown-it filters those for
      // links written in a document, but this builds an anchor itself and so
      // has to do its own checking.
      const url = safeUrl(meta?.url) ?? `/api/v1/attachments/${id.trim()}`
      const mime = meta?.mime
      if (mime && !mime.startsWith('image/')) {
        const name = meta?.filename ?? 'Attachment'
        return (
          `<a class="md__file" href="${esc(url)}" download>` +
          `<span class="md__file-name">${esc(name)}</span>` +
          `<span class="md__file-hint">${esc(formatSize(meta?.size))}</span>` +
          `</a>`
        )
      }
      return `<img${before}src="${esc(url)}"${after} loading="lazy">`
    },
  )
}

/** A size a person can read, or an empty string when it is not known. */
function formatSize(bytes: number | undefined): string {
  if (!bytes) return 'Download'
  const units = ['B', 'kB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Code blocks get a language label, a copy button, and highlighting.
 *
 * Applied to the rendered DOM rather than the markdown, because the language
 * is already on the element as the class markdown-it puts there, and because
 * highlighting arrives asynchronously and must be able to land on a block
 * that is already on screen.
 *
 * Copy is the part worth having whatever else happens: it works before any
 * grammar has loaded, and it copies the source rather than the highlighted
 * markup.
 */
async function hydrateCodeBlocks(): Promise<void> {
  const root = rootEl.value
  if (!root) return
  for (const pre of root.querySelectorAll<HTMLElement>('pre')) {
    if (pre.dataset.decorated === '1') continue
    if (pre.classList.contains('md__mermaid')) continue
    const code = pre.querySelector('code')
    if (!code) continue
    pre.dataset.decorated = '1'
    pre.classList.add('md__code')

    const written = /language-([\w+#-]+)/.exec(code.className)?.[1] ?? ''
    const source = code.textContent ?? ''

    const bar = document.createElement('div')
    bar.className = 'md__code-bar'
    // A fence with no language still gets a bar, because the copy button is
    // the reason most people look at one.
    const label = document.createElement('span')
    label.className = 'md__code-lang'
    label.textContent = written || 'text'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'md__code-copy'
    button.textContent = 'Copy'
    button.setAttribute('aria-label', 'Copy code')
    button.addEventListener('click', () => {
      void navigator.clipboard.writeText(source).then(
        () => {
          button.textContent = 'Copied'
          setTimeout(() => (button.textContent = 'Copy'), 1500)
        },
        () => (button.textContent = 'Press ctrl+C'),
      )
    })
    bar.append(label, button)
    pre.prepend(bar)

    const lang = resolveLanguage(written)
    if (!lang) continue
    const html = await highlight(source, lang)
    // The block may have been replaced while the grammar was in flight, in
    // which case this result belongs to a document nobody is looking at.
    if (!html || !pre.isConnected) continue
    const holder = document.createElement('div')
    holder.innerHTML = html
    const highlighted = holder.querySelector('code')
    if (highlighted) code.replaceWith(highlighted)
  }
}

/**
 * Headings get an id and a link you can copy.
 *
 * The slug comes from the shared `sectionMap`, which is the same one
 * `doc_write patch_section` addresses sections by, including how it
 * de-duplicates a repeated heading with `~2`. Computing a second slug here
 * would produce links that look right and point at a section the API does not
 * recognise, which is worse than having no anchors.
 */
function hydrateHeadings(): void {
  const root = rootEl.value
  if (!root) return
  const sections = sectionMap(props.source)
  const headings = root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')
  headings.forEach((el, index) => {
    if (el.dataset.anchored === '1') return
    const section = sections[index]
    if (!section) return
    el.dataset.anchored = '1'
    el.id = section.slug
    el.classList.add('md__heading')

    const link = document.createElement('button')
    link.type = 'button'
    link.className = 'md__anchor'
    link.title = 'Copy link to this section'
    link.setAttribute('aria-label', `Copy link to ${section.heading}`)
    link.textContent = '#'
    link.addEventListener('click', () => {
      const url = `${window.location.origin}${window.location.pathname}#${section.slug}`
      void navigator.clipboard.writeText(url).then(() => {
        link.classList.add('md__anchor--copied')
        setTimeout(() => link.classList.remove('md__anchor--copied'), 1200)
      })
    })
    el.append(link)
  })
}

function renderTaskLists(html: string): string {
  // GFM task syntax: "- [ ] text" / "- [x] text". markdown-it leaves the
  // brackets as literal text at the start of the list item.
  return html.replace(
    /<li>(<p>)?\[([ xX])\]\s?/g,
    (_m, p: string | undefined, mark: string) =>
      `<li class="md__task">${p ?? ''}<input type="checkbox" disabled${
        mark.trim() ? ' checked' : ''
      }> `,
  )
}

function renderCallouts(html: string): string {
  // markdown-it renders "> [!INFO] Title\n> body" as a blockquote whose first
  // paragraph starts with [!INFO]. Rewrite those blockquotes.
  // The trailing `<br>` is consumed with the marker. With `breaks: true`,
  // `> [!NOTE]\n> Body` is ONE paragraph holding a hard break, so leaving the
  // break behind opened every callout with a blank line and stranded the icon
  // on a row of its own.
  return html.replace(
    /<blockquote>\s*<p>\[!(INFO|NOTE|TIP|IMPORTANT|WARNING|CAUTION|DANGER)\]([^<\n]*)(?:\s*<br>\s*)?/g,
    (_m, type: string, title: string) => {
      const kind = CALLOUT_TYPES[type]
      const heading = title.trim()
        ? `<strong class="md__callout-title">${title.trim()}</strong>`
        : ''
      return `<blockquote class="md__callout md__callout--${kind}">${calloutIcon(kind)}${heading}<p>`
    },
  )
}

const html = computed(() => {
  const source = props.source
  // :::details handling: split into segments.
  const parts: string[] = []
  const lines = source.split('\n')
  let buffer: string[] = []
  let details: { title: string; lines: string[] } | null = null
  const flush = () => {
    if (buffer.length > 0) parts.push(md.render(buffer.join('\n')))
    buffer = []
  }
  for (const line of lines) {
    const open = /^:::details\s+(.*)$/.exec(line)
    if (open && !details) {
      flush()
      details = { title: open[1], lines: [] }
    } else if (line.trim() === ':::' && details) {
      parts.push(
        `<details class="md__details"><summary>${esc(details.title)}</summary>${md.render(details.lines.join('\n'))}</details>`,
      )
      details = null
    } else if (details) {
      details.lines.push(line)
    } else {
      buffer.push(line)
    }
  }
  if (details) buffer.push(`:::details ${details.title}`, ...details.lines)
  flush()
  let out = parts.join('')
  out = renderTaskLists(out)
  out = renderCallouts(out)
  out = renderRefs(out)
  out = renderDriveLinks(out)
  out = renderAttachments(out)
  // Mermaid fences render as marked code blocks for now (diagram rendering
  // is a follow-up; the source stays intact and legible).
  out = out.replace(
    /<pre><code class="language-mermaid">/g,
    '<pre class="md__mermaid"><code>',
  )
  return out
})

/**
 * Item refs are buttons that open the inspector. Space/doc refs are real
 * links: plain left-clicks route in-app, modified clicks keep native
 * behavior (new tab, etc.).
 */
function onClick(event: MouseEvent): void {
  const el = (event.target as HTMLElement).closest('.md__ref')
  if (!el) return
  // A ref click is fully handled here; surfaces that treat clicks as "start
  // editing" (the inspector description) must not also react to it.
  event.stopPropagation()
  const refType = el.getAttribute('data-ref-type')
  const ref = el.getAttribute('data-ref') ?? ''
  if (refType === 'item') {
    inspector.open(ref)
    return
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
    return
  event.preventDefault()
  if (refType === 'space') void router.push(wpath(`/s/${ref}`))
  else if (refType === 'doc') {
    if (docNav) docNav(ref)
    else docPreview.open(ref)
  }
}

/**
 * Card refs hydrate into live chips after render: the markdown pass emits a
 * bare [[KEY]] button, then the shared ref cache fills in title and state,
 * and re-fills them whenever space events land. v-html rewrites wipe the
 * patched DOM, so hydration re-runs on both the html and the cache version.
 */
function hydrateItemRefs(): void {
  const root = rootEl.value
  if (!root) return
  for (const el of root.querySelectorAll<HTMLElement>('.md__ref--item')) {
    const key = el.getAttribute('data-ref') ?? ''
    refCards.request(key)
    const view = itemChip(key, refCards.cards.get(key))
    if (!view) continue
    if (view.gone) {
      el.classList.add(...view.classes)
      el.title = view.title
      el.textContent = key
      continue
    }
    el.classList.add(...view.classes)
    el.title = view.title
    el.innerHTML = itemChipHtml(view)
  }
}

/**
 * @mentions render as avatar + display name (the @handle is storage, never
 * presentation): a tiny initials-or-image disc from the same actor data the
 * rest of the app uses.
 */
function hydrateMentions(): void {
  const root = rootEl.value
  const actors = ws.overview.value?.actors
  if (!root || !actors) return
  for (const el of root.querySelectorAll<HTMLElement>('.md__mention')) {
    const handle = el.getAttribute('data-handle')
    if (!handle || el.dataset.hydrated === '1') continue
    const actor = actors.find((a) => a.handle === handle)
    if (!actor) continue
    el.dataset.hydrated = '1'
    const initials = actor.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase()
    const disc = actor.avatar_url
      ? `<img class="md__mention-avatar" src="${esc(actor.avatar_url)}" alt="">`
      : `<span class="md__mention-avatar" style="background:${esc(chartColorFor(handle))}">${esc(initials)}</span>`
    el.innerHTML = `${disc}${esc(actor.name)}`
    el.title = `@${handle}`
  }
}

/**
 * Inline code holding a colour gets the colour shown next to it.
 *
 * A page of hex values is unreadable as text, which is exactly the situation
 * on the Icon System page. The detection is deliberately strict, because this
 * looks at every code span in the document and `#include` must not get a
 * swatch. The value itself is left as written: it is the thing being
 * documented, and the swatch is an addition rather than a replacement.
 */
function hydrateColors(): void {
  const root = rootEl.value
  if (!root) return
  for (const el of root.querySelectorAll<HTMLElement>('code')) {
    if (el.dataset.swatch === '1') continue
    // Never inside a fence: that is source, and a line of CSS would sprout
    // dots down the side of the block.
    if (el.closest('pre')) continue
    const color = parseColor(el.textContent ?? '')
    if (!color) continue
    el.dataset.swatch = '1'
    el.classList.add('md__color')
    const dark = isDarkColor(color)
    const dot = document.createElement('span')
    dot.className = 'md__color-dot'
    dot.setAttribute('aria-hidden', 'true')
    dot.style.background = color
    if (dark === false) dot.classList.add('md__color-dot--light')
    el.prepend(dot)
  }
}

watch(
  [() => html.value, () => refCards.version.value, () => ws.overview.value],
  () =>
    void nextTick(() => {
      hydrateItemRefs()
      hydrateMentions()
      hydrateColors()
      void hydrateCodeBlocks()
      hydrateHeadings()
      void measure()
    }),
  { immediate: true, flush: 'post' },
)

// A narrower column wraps to more lines, so the same text can start or stop
// overflowing without the text itself changing.
onMounted(() => {
  if (!props.clamp || typeof ResizeObserver === 'undefined') return
  const el = rootEl.value
  if (!el) return
  const ro = new ResizeObserver(() => void measure())
  ro.observe(el)
  onBeforeUnmount(() => ro.disconnect())
})
</script>

<style scoped lang="scss">
.md-wrap {
  min-inline-size: 0;

  &__toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--nb-spacing-4);
    inline-size: 100%;
    margin-block-start: var(--nb-spacing-4);
    padding-block: var(--nb-spacing-8);
    background: none;
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
    color: var(--nb-c-text-subtle);
    font: inherit;
    font-size: var(--nb-type-body-sm-size);
    cursor: pointer;

    &:hover {
      color: var(--nb-c-text);
      background: var(--nb-c-surface-hover);
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 2px;
    }
  }
}

.md--clamped {
  overflow: hidden;
  /* Faded rather than cut: a hard edge mid-sentence reads as a rendering
     fault, where a fade reads as "there is more". The mask is on the block
     itself so it follows whatever background it happens to sit on. */
  mask-image: linear-gradient(to bottom, #000 60%, transparent 100%);
}

.md {
  line-height: 1.65;

  /* Prose never set a size, so it inherited the browser's 16px and came out
   * the same size as a card's own title. It is supporting text: body-md puts
   * it below the title and level with the rest of the interface. */
  font-size: var(--nb-type-body-md-size);

  /* User content contains things with no break opportunity: a pasted URL, a
   * stack frame, a run of x's from a load test. Without this they push past
   * the column and overlap whatever sits beside them, rather than wrapping. */
  overflow-wrap: anywhere;

  :deep(p),
  :deep(li),
  :deep(blockquote) {
    max-width: 68ch;
  }

  :deep(p) {
    margin-block: var(--nb-spacing-12);
  }

  :deep(h1),
  :deep(h2),
  :deep(h3) {
    margin-block: var(--nb-spacing-32) var(--nb-spacing-8);
  }

  /* A rule is a breath, not a line squeezed between paragraphs. */
  :deep(hr) {
    border: 0;
    border-block-start: 1px solid var(--nb-c-border);
    margin-block: var(--nb-spacing-32);
  }

  :deep(pre) {
    overflow-x: auto;
    padding: var(--nb-spacing-12);
    border-radius: var(--nb-radius-sm);
    background: var(--nb-c-surface);
    border: 1px solid var(--nb-c-border);
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
  }

  /* A colour written as inline code carries the colour beside it. The value
     stays exactly as written, because it is the thing being documented. */
  /* An embedded image is content, so it gets the column and nothing more.
     Constrained to the text width and never taller than a screen, or one
     large upload pushes the rest of the document out of view. */
  :deep(.md img) {
    max-inline-size: 100%;
    max-block-size: 80vh;
    block-size: auto;
    border-radius: var(--nb-radius-sm);
  }

  /* A non-image attachment: a chip that says what it is and downloads. An
     <img> pointing at a PDF is a broken image icon, which tells the reader
     nothing about what is attached. */
  :deep(.md__file) {
    display: inline-flex;
    align-items: baseline;
    gap: var(--nb-spacing-8);
    padding: var(--nb-spacing-4) var(--nb-spacing-12);
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
    background: var(--nb-c-surface);
    color: var(--nb-c-text);
    text-decoration: none;

    &:hover {
      background: var(--nb-c-surface-hover);
    }
  }

  :deep(.md__file-hint) {
    color: var(--nb-c-text-subtle);
    font-size: var(--nb-type-body-sm-size);
  }

  :deep(.md__color) {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4em;
  }

  :deep(.md__color-dot) {
    align-self: center;
    inline-size: 0.85em;
    block-size: 0.85em;
    flex: none;
    border-radius: var(--nb-radius-xs);
    /* Its own border, because a swatch of the page's background colour would
       otherwise be an invisible chip that looks like a rendering fault. */
    box-shadow: inset 0 0 0 1px
      color-mix(in srgb, currentColor 35%, transparent);
  }

  :deep(.md__color-dot--light) {
    box-shadow: inset 0 0 0 1px
      color-mix(in srgb, currentColor 55%, transparent);
  }

  /* The bar sits inside the block so it scrolls with nothing and stays put
     when the code scrolls sideways. */
  /* The anchor appears on hover or focus, so a heading reads as a heading
     until somebody wants the link. It stays visible once focused, or it
     cannot be reached from the keyboard. */
  :deep(.md__heading) {
    scroll-margin-block-start: var(--nb-spacing-32);
  }

  :deep(.md__anchor) {
    margin-inline-start: var(--nb-spacing-8);
    padding: 0 var(--nb-spacing-4);
    background: none;
    border: 0;
    color: var(--nb-c-text-subtle);
    font: inherit;
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms ease;

    &:focus-visible {
      opacity: 1;
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 2px;
    }
  }

  :deep(.md__heading:hover) .md__anchor {
    opacity: 1;
  }

  :deep(.md__anchor--copied) {
    opacity: 1;
    color: var(--nb-c-success);
  }

  :deep(.md__code) {
    position: relative;
    padding-block-start: var(--nb-spacing-32);
  }

  :deep(.md__code-bar) {
    position: absolute;
    inset-block-start: 0;
    inset-inline: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--nb-spacing-8);
    padding: var(--nb-spacing-4) var(--nb-spacing-8);
    border-block-end: 1px solid var(--nb-c-border);
    background: var(--nb-c-surface);
    border-start-start-radius: var(--nb-radius-sm);
    border-start-end-radius: var(--nb-radius-sm);
  }

  :deep(.md__code-lang) {
    color: var(--nb-c-text-subtle);
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
  }

  :deep(.md__code-copy) {
    padding: 0 var(--nb-spacing-8);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--nb-radius-xs);
    color: var(--nb-c-text-subtle);
    font: inherit;
    font-size: var(--nb-type-body-sm-size);
    cursor: pointer;

    &:hover {
      color: var(--nb-c-text);
      border-color: var(--nb-c-border);
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 1px;
    }
  }

  /* Shiki emits both themes as custom properties, so the same markup follows
     the page into dark mode without being highlighted again. */
  :deep(.shiki),
  :deep(.shiki span) {
    color: var(--nb-shiki-light);
    background-color: transparent;
  }

  @media (prefers-color-scheme: dark) {
    :deep(.shiki),
    :deep(.shiki span) {
      color: var(--nb-shiki-dark);
    }
  }

  :root[data-theme='dark'] & {
    :deep(.shiki),
    :deep(.shiki span) {
      color: var(--nb-shiki-dark);
    }
  }

  :deep(code) {
    font-family: var(--nb-font-family-mono);
  }

  :deep(table) {
    border-collapse: collapse;

    th,
    td {
      border: 1px solid var(--nb-c-border);
      padding: var(--nb-spacing-4) var(--nb-spacing-8);
    }
  }

  /* Drive links read as one object rather than forty characters of URL.
     Inline-flex so the pill sits on the text baseline inside a sentence and
     never breaks across two lines mid-pill. */
  :deep(.md__drive) {
    display: inline-flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    padding: 1px var(--nb-spacing-8) 1px var(--nb-spacing-4);
    border: 1px solid var(--nb-c-border);
    border-radius: 999px;
    background: var(--nb-c-surface);
    color: var(--nb-c-text);
    text-decoration: none;
    vertical-align: baseline;
    white-space: nowrap;
    font-size: var(--nb-type-body-sm-size);

    &:hover {
      background: var(--nb-c-surface-hover);
      border-color: var(--nb-c-border-strong, var(--nb-c-border));
    }

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 2px;
    }
  }

  :deep(.md__drive-glyph) {
    inline-size: 1em;
    block-size: 1em;
    flex: none;
  }

  :deep(.md__task) {
    list-style: none;
    margin-inline-start: calc(var(--nb-spacing-16) * -1);

    input[type='checkbox'] {
      accent-color: var(--nb-c-primary);
      margin-inline-end: var(--nb-spacing-4);
      vertical-align: -2px;
    }
  }

  /* Callouts wear their kind: a solid accent bar and a soft tint of the
   * same hue, the way Confluence panels read. */
  /* A grid rather than absolute positioning, so the icon belongs to the
     first line instead of floating at a guessed offset from the top. The
     icon occupies row 1 of its own column and everything else stacks in
     column 2, which keeps several paragraphs, lists and code inside a
     callout laying out normally. */
  :deep(.md__callout) {
    --callout-accent: var(--nb-c-info);
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: var(--nb-spacing-12);
    align-items: start;
    margin-block: var(--nb-spacing-16);
    margin-inline: 0;
    padding: var(--nb-spacing-12) var(--nb-spacing-16);
    border: 0;
    border-inline-start: 3px solid var(--callout-accent);
    border-radius: var(--nb-radius-xs);
    background: color-mix(in srgb, var(--callout-accent) 9%, transparent);
    color: var(--nb-c-text);

    > :not(.md__callout-icon) {
      grid-column: 2;
      min-inline-size: 0;
    }

    p:first-of-type {
      margin-block-start: 0;
    }

    p:last-child {
      margin-block-end: 0;
    }
  }

  /* The box is one line tall, the glyph is 20px. An SVG letterboxes rather
     than stretching, so the artwork sits optically centred on the first line
     whatever the callout's height: centred-looking when there is one line,
     and level with the first line when there are ten. The old rule nudged a
     20px box down by 0.2em, which was right at one font size only. */
  :deep(.md__callout-icon) {
    grid-column: 1;
    grid-row: 1;
    align-self: start;
    inline-size: 20px;
    block-size: 1.65em;
    color: var(--callout-accent);
  }

  :deep(.md__callout--note) {
    --callout-accent: var(--nb-c-primary);
  }

  :deep(.md__callout--tip) {
    --callout-accent: var(--nb-c-success);
  }

  :deep(.md__callout--warning) {
    --callout-accent: var(--nb-c-warning);
  }

  :deep(.md__callout--danger) {
    --callout-accent: var(--nb-c-danger);
  }

  :deep(.md__callout-title) {
    display: block;
    margin-block-end: var(--nb-spacing-4);
    color: var(--callout-accent);
  }

  :deep(.md__details) {
    margin-block: var(--nb-spacing-8);
    border: 1px solid var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
    padding: var(--nb-spacing-8);

    summary {
      cursor: pointer;
      font-weight: var(--nb-type-label-lg-weight);
    }
  }

  :deep(.md__ref) {
    color: var(--nb-c-primary);
    text-decoration: none;
    border-block-end: 1px dashed currentColor;
  }

  /* A doc or space reference is a link, so it says so: a glyph, the pointer,
     and a shape that matches the card chips beside it. It used to render as
     a bare underlined word, indistinguishable from prose. */
  :deep(.md__ref--link) {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3em;
    cursor: pointer;
    border-block-end: 1px solid
      color-mix(in srgb, currentColor 40%, transparent);
  }

  :deep(.md__ref-icon) {
    align-self: center;
    inline-size: 0.95em;
    block-size: 0.95em;
    flex: none;
  }

  :deep(button.md__ref) {
    background: none;
    border: 0;
    border-block-end: 1px dashed currentColor;
    padding: 0;
    cursor: pointer;
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);

    &:focus-visible {
      outline: 1px solid var(--nb-c-focus-ring);
      outline-offset: 2px;
    }
  }

  /* A hydrated card ref: inline chip with the list as a colored dot, the key
   * in mono and the live title, the Confluence smart-link mental model. */
  :deep(.md__ref.md__ref--chip) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-inline-size: 34ch;
    padding: 1px 8px;
    border: 1px solid var(--nb-c-border);
    border-block-end: 1px solid var(--nb-c-border);
    border-radius: 999px;
    background: var(--nb-c-bg-soft);
    color: var(--nb-c-text);
    vertical-align: -0.35em;

    .md__chip-dot {
      flex: none;
      inline-size: 7px;
      block-size: 7px;
      border-radius: 50%;
      background: var(--nb-c-primary);
    }

    .md__chip-key {
      flex: none;
      font-family: var(--nb-font-family-mono);
      font-size: var(--nb-type-code-sm-size);
      color: var(--nb-c-text-muted);
    }

    .md__chip-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--nb-font-family-sans);
      font-size: var(--nb-font-size-13);
    }

    &.md__ref--done .md__chip-dot {
      background: var(--nb-c-success);
    }

    &.md__ref--archived {
      opacity: 0.65;

      .md__chip-dot {
        background: var(--nb-c-text-muted);
      }

      .md__chip-title {
        text-decoration: line-through;
      }
    }

    &.md__ref--gone {
      opacity: 0.6;
      cursor: default;
      text-decoration: line-through;
    }
  }

  :deep(.md__mention) {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    vertical-align: -0.3em;
    color: var(--nb-c-primary);
    font-weight: var(--nb-type-label-lg-weight);

    .md__mention-avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      inline-size: 16px;
      block-size: 16px;
      border-radius: 50%;
      overflow: hidden;
      object-fit: cover;
      flex: none;
      font-size: 8px;
      font-weight: var(--nb-type-label-lg-weight);
      color: var(--nb-c-bg);
    }
  }

  :deep(.md__embed) {
    display: block;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-muted);
    border: 1px dashed var(--nb-c-border);
    border-radius: var(--nb-radius-sm);
    padding: var(--nb-spacing-8);
  }
}
</style>
