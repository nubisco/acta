<template>
  <div
    ref="host"
    class="doc-diff"
    role="region"
    aria-label="Differences between versions"
  ></div>
</template>

<script setup lang="ts">
/**
 * Monaco-powered read-only diff between two document versions. No diff
 * component exists in @nubisco/ui, and Monaco is already the code-surface
 * standard in other Nubisco products. The whole module (and its worker) is
 * code-split behind this component; DocsView loads it on demand.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { useTheme } from '@nubisco/ui'

;(
  self as typeof self & { MonacoEnvironment?: monaco.Environment }
).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

const props = defineProps<{
  original: string
  modified: string
}>()

const host = ref<HTMLElement | null>(null)
const theme = useTheme()

let editor: monaco.editor.IStandaloneDiffEditor | null = null
let originalModel: monaco.editor.ITextModel | null = null
let modifiedModel: monaco.editor.ITextModel | null = null

function monacoTheme(): string {
  return theme.resolved.value === 'dark' ? 'vs-dark' : 'vs'
}

onMounted(() => {
  if (!host.value) return
  originalModel = monaco.editor.createModel(props.original, 'markdown')
  modifiedModel = monaco.editor.createModel(props.modified, 'markdown')
  editor = monaco.editor.createDiffEditor(host.value, {
    readOnly: true,
    renderSideBySide: false,
    automaticLayout: true,
    wordWrap: 'on',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderOverviewRuler: false,
    fontFamily: 'Fira Code, ui-monospace, monospace',
    fontSize: 13,
    theme: monacoTheme(),
    hideUnchangedRegions: { enabled: true },
  })
  editor.setModel({ original: originalModel, modified: modifiedModel })
})

watch(
  () => [props.original, props.modified],
  ([original, modified]) => {
    originalModel?.setValue(original)
    modifiedModel?.setValue(modified)
  },
)

watch(theme.resolved, () => {
  monaco.editor.setTheme(monacoTheme())
})

onBeforeUnmount(() => {
  editor?.dispose()
  originalModel?.dispose()
  modifiedModel?.dispose()
})
</script>

<style scoped lang="scss">
.doc-diff {
  block-size: 28rem;
  border: 1px solid var(--nb-c-border);
  border-radius: var(--nb-radius-md);
  overflow: hidden;
}
</style>
