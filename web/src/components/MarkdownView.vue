<template>
  <!-- Sanitized: markdown-it renders with html disabled; only our own
       extension transforms emit markup. -->
  <!-- eslint-disable vue/no-v-html -->
  <div
    class="md"
    :class="{ 'md--wide': wide }"
    @click="onClick"
    v-html="html"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>

<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt from 'markdown-it'
import { useRouter } from 'vue-router'
import { useInspector } from '@/stores/workspace'

const props = defineProps<{ source: string; wide?: boolean }>()

const router = useRouter()
const inspector = useInspector()

const md = new MarkdownIt({ html: false, linkify: true, breaks: false })

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
          return `<span class="md__embed" data-query="${esc(target.slice(6).trim())}">${esc(target)}</span>`
        return esc(raw)
      }
      if (target.startsWith('@'))
        return `<span class="md__mention">${esc(target)}</span>`
      if (target.startsWith('board:'))
        return `<a class="md__ref" data-ref-type="board" data-ref="${esc(target.slice(6))}" href="/b/${esc(target.slice(6))}">${esc(alias ?? target.slice(6))}</a>`
      if (target.startsWith('doc:'))
        return `<a class="md__ref" data-ref-type="doc" data-ref="${esc(target.slice(4))}" href="/docs/${esc(target.slice(4))}">${esc(alias ?? target.slice(4))}</a>`
      if (/^[A-Z][A-Z0-9]{1,4}-\d+$/.test(target))
        return `<a class="md__ref md__ref--item" data-ref-type="item" data-ref="${esc(target)}" href="#">${esc(alias ?? target)}</a>`
      return esc(raw)
    },
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
      return `<blockquote class="md__callout md__callout--${kind}">${heading}<p>`
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

/** Intercept internal links so refs stay in-app. */
function onClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement).closest('a.md__ref')
  if (!target) return
  event.preventDefault()
  const refType = target.getAttribute('data-ref-type')
  const ref = target.getAttribute('data-ref') ?? ''
  if (refType === 'item') inspector.open(ref)
  else if (refType === 'board') void router.push(`/b/${ref}`)
  else if (refType === 'doc') void router.push(`/docs/${ref}`)
}
</script>

<style lang="scss">
.md {
  max-width: 72ch;
  line-height: 1.6;

  &--wide {
    max-width: 100%;
  }

  h1,
  h2,
  h3 {
    margin-top: calc(var(--nb-base-unit) * 3);
    margin-bottom: var(--nb-base-unit);
  }

  pre {
    overflow-x: auto;
    padding: var(--nb-base-unit);
    border-radius: 8px;
    background: color-mix(in srgb, currentColor 6%, transparent);
  }

  table {
    border-collapse: collapse;

    th,
    td {
      border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
      padding: calc(var(--nb-base-unit) / 2) var(--nb-base-unit);
    }
  }

  &__callout {
    margin: var(--nb-base-unit) 0;
    padding: var(--nb-base-unit) calc(var(--nb-base-unit) * 1.5);
    border-left: 3px solid var(--nb-c-primary, currentColor);
    border-radius: 6px;
    background: color-mix(
      in srgb,
      var(--nb-c-primary, currentColor) 7%,
      transparent
    );

    &--warning,
    &--danger {
      border-left-color: var(--nb-c-danger, #c33);
      background: color-mix(in srgb, var(--nb-c-danger, #c33) 7%, transparent);
    }

    &--tip {
      border-left-color: var(--nb-c-success, #2a2);
      background: color-mix(in srgb, var(--nb-c-success, #2a2) 7%, transparent);
    }
  }

  &__callout-title {
    display: block;
    margin-bottom: calc(var(--nb-base-unit) / 2);
  }

  &__details {
    margin: var(--nb-base-unit) 0;
    border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    border-radius: 8px;
    padding: var(--nb-base-unit);

    summary {
      cursor: pointer;
      font-weight: 600;
    }
  }

  &__ref {
    color: var(--nb-c-primary, inherit);
    text-decoration: none;
    border-bottom: 1px dashed currentColor;

    &--item {
      font-family: var(--nb-font-mono, monospace);
      font-size: 0.9em;
    }
  }

  &__mention {
    color: var(--nb-c-primary, inherit);
    font-weight: 600;
  }

  &__embed {
    display: block;
    font-family: var(--nb-font-mono, monospace);
    font-size: 0.85em;
    opacity: 0.7;
    border: 1px dashed color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 6px;
    padding: var(--nb-base-unit);
  }
}
</style>
