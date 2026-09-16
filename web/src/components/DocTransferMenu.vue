<template>
  <span ref="triggerEl" class="doc-transfer">
    <NbButton
      v-nb-tooltip="{ body: 'Import and export' }"
      size="sm"
      variant="secondary"
      icon="dots-three"
      aria-label="Import and export"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      :loading="busy"
      @click="toggleMenu"
    />
  </span>

  <NbMenu
    ref="menu"
    v-model:open="menuOpen"
    size="sm"
    :min-width="MENU_WIDTH"
    @close="menuOpen = false"
  >
    <NbSubmenu icon="download-simple" label="Export this page">
      <NbMenuItem
        icon="file-md"
        label="Markdown"
        @select="run('markdown', false)"
      />
      <NbMenuItem icon="file-html" label="HTML" @select="run('html', false)" />
      <NbMenuItem
        icon="printer"
        label="Print or save as PDF"
        @select="run('print', false)"
      />
    </NbSubmenu>
    <NbSubmenu icon="tree-structure" label="Export with subpages">
      <NbMenuItem
        icon="file-zip"
        label="Markdown"
        @select="run('markdown', true)"
      />
      <NbMenuItem icon="file-html" label="HTML" @select="run('html', true)" />
      <NbMenuItem
        icon="printer"
        label="Print or save as PDF"
        @select="run('print', true)"
      />
    </NbSubmenu>
    <NbMenuDivider />
    <NbMenuItem
      icon="upload-simple"
      label="Import pages"
      @select="importing = true"
    />
  </NbMenu>

  <DocImportModal
    :open="importing"
    :parent="doc"
    @close="importing = false"
    @imported="onImported"
  />
</template>

<script setup lang="ts">
/**
 * Import and export for one page, from the page's own actions.
 *
 * Everything heavy (the zip library, the Word converter, the renderer used for
 * HTML) loads only when one of these is chosen, so a page that is only read
 * pays nothing for them.
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useToast, type NbMenu } from '@nubisco/ui'
import DocImportModal from '@/components/DocImportModal.vue'
import { humanise } from '@/lib/state'
import { wpath } from '@/lib/paths'
import { installPrintStyles } from '@/lib/transfer/print'

const props = defineProps<{ doc: { slug: string; title: string } }>()

const MENU_WIDTH = 240

// The browser's own print command, pressed on this page, gets paper rules too.
installPrintStyles()

const toast = useToast()
const router = useRouter()
const triggerEl = ref<HTMLElement | null>(null)
const menu = ref<InstanceType<typeof NbMenu> | null>(null)
const menuOpen = ref(false)
const importing = ref(false)
const busy = ref(false)

function toggleMenu(): void {
  if (menuOpen.value) {
    menuOpen.value = false
    return
  }
  const rect = triggerEl.value?.getBoundingClientRect()
  if (rect && menu.value)
    menu.value.setPositionXY(
      Math.max(8, rect.right - MENU_WIDTH),
      rect.bottom + 4,
    )
  menuOpen.value = true
}

async function run(
  format: 'markdown' | 'html' | 'print',
  withChildren: boolean,
): Promise<void> {
  busy.value = true
  try {
    const exporter = await import('@/lib/transfer/exporter')
    const api = await exporter.browserExportApi()
    const tree = await exporter.collectTree(api, props.doc.slug, withChildren)
    if (format === 'print') {
      await exporter.printHtml(await exporter.exportHtmlDocument(api, tree))
      return
    }
    const result =
      format === 'markdown'
        ? await exporter.exportMarkdown(api, tree)
        : await exporter.exportHtml(api, tree)
    exporter.download(result)
    for (const warning of result.warnings)
      toast.warning(warning, { title: 'Check the export' })
  } catch (err) {
    toast.error(humanise(err), { title: 'Export failed' })
  } finally {
    busy.value = false
  }
}

function onImported(slug: string): void {
  importing.value = false
  void router.push(wpath(`/docs/${slug}`))
}
</script>

<style scoped lang="scss">
.doc-transfer {
  display: inline-flex;
}
</style>
