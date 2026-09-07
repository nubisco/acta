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
          return `<span class="md__embed" data-query="${esc(target.slice(6).trim())}">Live item list (${esc(target.slice(6).trim())}) renders here soon</span>`
        return esc(raw)
      }
      if (target.startsWith('@'))
        return `<span class="md__mention">${esc(target)}</span>`
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
  else if (refType === 'doc') void router.push(`/docs/${ref}`)
}
</script>

<style scoped lang="scss">
.md {
  line-height: 1.65;

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
    margin-block: var(--nb-spacing-16);
    margin-inline: 0;
    padding: var(--nb-spacing-12) var(--nb-spacing-16);
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

  :deep(.md__mention) {
    color: var(--nb-c-primary);
    font-weight: var(--nb-type-label-lg-weight, 600);
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
