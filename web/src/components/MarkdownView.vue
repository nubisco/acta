<template>
  <!-- Sanitized: markdown-it renders with html disabled; only our own
       extension transforms emit markup. -->
  <!-- eslint-disable vue/no-v-html -->
  <div
    ref="rootEl"
    class="md"
    :class="{ 'md--wide': wide }"
    @click="onClick"
    v-html="html"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import { useRouter } from 'vue-router'
import { useDocPreview, useInspector, useWorkspace } from '@/stores/workspace'
import { useRefCards } from '@/stores/refs'
import { chartColorFor } from '@/lib/colors'
import { DOC_NAV_KEY } from '@/lib/keys'

const props = defineProps<{ source: string; wide?: boolean }>()

const router = useRouter()
const inspector = useInspector()
const docPreview = useDocPreview()
const refCards = useRefCards()
const ws = useWorkspace()
const rootEl = ref<HTMLElement | null>(null)
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

const CALLOUT_TYPES: Record<string, string> = {
  INFO: 'info',
  NOTE: 'note',
  TIP: 'tip',
  WARNING: 'warning',
  DANGER: 'danger',
}

/* Phosphor regular glyphs (fill=currentColor, so they take the accent). */
const CALLOUT_ICONS: Record<string, string> = {
  info: '<path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z"/>',
  note: '<path d="M229.66,58.34l-32-32a8,8,0,0,0-11.32,0l-96,96A8,8,0,0,0,88,128v32a8,8,0,0,0,8,8h32a8,8,0,0,0,5.66-2.34l96-96A8,8,0,0,0,229.66,58.34ZM124.69,152H104V131.31l64-64L188.69,88ZM200,76.69,179.31,56,192,43.31,212.69,64ZM224,128v80a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V48A16,16,0,0,1,48,32h80a8,8,0,0,1,0,16H48V208H208V128a8,8,0,0,1,16,0Z"/>',
  tip: '<path d="M176,232a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h80A8,8,0,0,1,176,232Zm40-128a87.55,87.55,0,0,1-33.64,69.21A16.24,16.24,0,0,0,176,186v6a16,16,0,0,1-16,16H96a16,16,0,0,1-16-16v-6a16,16,0,0,0-6.23-12.66A87.59,87.59,0,0,1,40,104.49C39.74,56.83,78.26,17.14,125.88,16A88,88,0,0,1,216,104Zm-16,0a72,72,0,0,0-73.74-72c-39,.92-70.47,33.39-70.26,72.39a71.65,71.65,0,0,0,27.64,56.3A32,32,0,0,1,96,186v6h64v-6a32.15,32.15,0,0,1,12.47-25.35A71.65,71.65,0,0,0,200,104Zm-16.11-9.34a57.6,57.6,0,0,0-46.56-46.55,8,8,0,0,0-2.66,15.78c16.57,2.79,30.63,16.85,33.44,33.45A8,8,0,0,0,176,104a9,9,0,0,0,1.35-.11A8,8,0,0,0,183.89,94.66Z"/>',
  warning:
    '<path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM222.93,203.8a8.5,8.5,0,0,1-7.48,4.2H40.55a8.5,8.5,0,0,1-7.48-4.2,7.59,7.59,0,0,1,0-7.72L120.52,44.21a8.75,8.75,0,0,1,15,0l87.45,151.87A7.59,7.59,0,0,1,222.93,203.8ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z"/>',
  danger:
    '<path d="M120,136V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0ZM232,91.55v72.9a15.86,15.86,0,0,1-4.69,11.31l-51.55,51.55A15.86,15.86,0,0,1,164.45,232H91.55a15.86,15.86,0,0,1-11.31-4.69L28.69,175.76A15.86,15.86,0,0,1,24,164.45V91.55a15.86,15.86,0,0,1,4.69-11.31L80.24,28.69A15.86,15.86,0,0,1,91.55,24h72.9a15.86,15.86,0,0,1,11.31,4.69l51.55,51.55A15.86,15.86,0,0,1,232,91.55Zm-16,0L164.45,40H91.55L40,91.55v72.9L91.55,216h72.9L216,164.45ZM128,160a12,12,0,1,0,12,12A12,12,0,0,0,128,160Z"/>',
}

function calloutIcon(kind: string): string {
  return `<svg class="md__callout-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${CALLOUT_ICONS[kind]}</svg>`
}

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
      if (target.startsWith('board:'))
        return `<a class="md__ref" data-ref-type="board" data-ref="${esc(target.slice(6))}" href="/b/${esc(target.slice(6))}">${esc(alias ?? target.slice(6))}</a>`
      if (target.startsWith('doc:'))
        return `<a class="md__ref" data-ref-type="doc" data-ref="${esc(target.slice(4))}" href="/docs/${esc(target.slice(4))}">${esc(alias ?? target.slice(4))}</a>`
      if (/^[A-Z][A-Z0-9]{1,4}-\d+$/.test(target))
        return `<button type="button" class="md__ref md__ref--item" data-ref-type="item" data-ref="${esc(target)}">${esc(alias ?? target)}</button>`
      return esc(raw)
    },
  )
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
  return html.replace(
    /<blockquote>\s*<p>\[!(INFO|NOTE|TIP|WARNING|DANGER)\]([^<\n]*)/g,
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
  // Mermaid fences render as marked code blocks for now (diagram rendering
  // is a follow-up; the source stays intact and legible).
  out = out.replace(
    /<pre><code class="language-mermaid">/g,
    '<pre class="md__mermaid"><code>',
  )
  return out
})

/**
 * Item refs are buttons that open the inspector. Board/doc refs are real
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
  if (refType === 'board') void router.push(`/b/${ref}`)
  else if (refType === 'doc') {
    if (docNav) docNav(ref)
    else docPreview.open(ref)
  }
}

/**
 * Card refs hydrate into live chips after render: the markdown pass emits a
 * bare [[KEY]] button, then the shared ref cache fills in title and state,
 * and re-fills them whenever board events land. v-html rewrites wipe the
 * patched DOM, so hydration re-runs on both the html and the cache version.
 */
function hydrateItemRefs(): void {
  const root = rootEl.value
  if (!root) return
  for (const el of root.querySelectorAll<HTMLElement>('.md__ref--item')) {
    const key = el.getAttribute('data-ref') ?? ''
    refCards.request(key)
    const card = refCards.cards.get(key)
    if (card === undefined) continue
    if (card === null) {
      el.classList.add('md__ref--chip', 'md__ref--gone')
      el.title = 'This card no longer exists'
      el.textContent = key
      continue
    }
    el.classList.add('md__ref--chip')
    el.classList.toggle('md__ref--done', !!card.done)
    el.classList.toggle('md__ref--archived', !!card.archived)
    el.title = card.archived ? `${card.list} · archived` : card.list
    el.innerHTML =
      `<span class="md__chip-dot" aria-hidden="true"></span>` +
      `<span class="md__chip-key">${esc(card.key)}</span>` +
      `<span class="md__chip-title">${esc(card.title)}</span>`
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

watch(
  [() => html.value, () => refCards.version.value, () => ws.overview.value],
  () =>
    void nextTick(() => {
      hydrateItemRefs()
      hydrateMentions()
    }),
  { immediate: true, flush: 'post' },
)
</script>

<style scoped lang="scss">
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
    margin-block: var(--nb-spacing-32, 2rem) var(--nb-spacing-8);
  }

  /* A rule is a breath, not a line squeezed between paragraphs. */
  :deep(hr) {
    border: 0;
    border-block-start: 1px solid var(--nb-c-border);
    margin-block: var(--nb-spacing-32, 2rem);
  }

  :deep(pre) {
    overflow-x: auto;
    padding: var(--nb-spacing-12);
    border-radius: var(--nb-radius-sm, 8px);
    background: var(--nb-c-surface);
    border: 1px solid var(--nb-c-border);
    font-family: var(--nb-font-family-mono);
    font-size: var(--nb-type-code-sm-size);
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
  :deep(.md__callout) {
    --callout-accent: var(--nb-c-info);
    position: relative;
    margin-block: var(--nb-spacing-16);
    margin-inline: 0;
    padding: var(--nb-spacing-12) var(--nb-spacing-16);
    padding-inline-start: calc(var(--nb-spacing-16) * 2 + 20px);
    border: 0;
    border-inline-start: 3px solid var(--callout-accent);
    border-radius: var(--nb-radius-xs, 2px);
    background: color-mix(in srgb, var(--callout-accent) 9%, transparent);
    color: var(--nb-c-text);

    p:first-of-type {
      margin-block-start: 0;
    }

    p:last-child {
      margin-block-end: 0;
    }
  }

  :deep(.md__callout-icon) {
    position: absolute;
    inset-block-start: calc(var(--nb-spacing-12) + 0.2em);
    inset-inline-start: var(--nb-spacing-16);
    inline-size: 20px;
    block-size: 20px;
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
    border-radius: var(--nb-radius-sm, 8px);
    padding: var(--nb-spacing-8);

    summary {
      cursor: pointer;
      font-weight: var(--nb-type-label-lg-weight, 600);
    }
  }

  :deep(.md__ref) {
    color: var(--nb-c-primary);
    text-decoration: none;
    border-block-end: 1px dashed currentColor;
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
      outline: 1px solid var(--nb-c-focus-ring, var(--nb-c-primary));
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
    background: var(--nb-c-bg-soft, transparent);
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
      font-size: var(--nb-font-size-13, 13px);
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
    font-weight: var(--nb-type-label-lg-weight, 600);

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
      font-weight: var(--nb-type-label-lg-weight, 600);
      color: var(--nb-c-bg);
    }
  }

  :deep(.md__embed) {
    display: block;
    font-size: var(--nb-type-body-sm-size);
    color: var(--nb-c-text-muted);
    border: 1px dashed var(--nb-c-border);
    border-radius: var(--nb-radius-sm, 8px);
    padding: var(--nb-spacing-8);
  }
}
</style>
