<template>
  <component :is="treebar.Outlet">
    <DocsTreePanel />
  </component>
</template>

<script setup lang="ts">
/**
 * The documents tree, contributed to the shell's contextbar.
 *
 * Its own component so the claim can be released. The shell keeps a region
 * open for as long as somebody holds a claim on it, and a claim is held for
 * the life of the component that called `useShellSlot`. Unmounting only the
 * outlet would leave an empty column where the tree was, which is exactly
 * what page focus mode is trying to take away.
 */
import { useShellSlot } from '@nubisco/ui'
import DocsTreePanel from '@/components/DocsTreePanel.vue'

const treebar = useShellSlot('contextbar')
</script>
