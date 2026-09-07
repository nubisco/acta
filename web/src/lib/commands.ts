/**
 * View-scoped command registration for the cmd+k palette. A view declares
 * the actions its UI already offers ("Add card", "Delete page") and they
 * appear in the palette only while that view's route context is active,
 * disappearing when the component unmounts. App.vue keeps the palette's
 * active context in sync with the route name.
 */
import { onScopeDispose } from 'vue'
import { useCommandPalette, type ICommand } from '@nubisco/ui'

export function useViewCommands(
  context: string,
  commands: Omit<ICommand, 'context'>[],
): void {
  const palette = useCommandPalette()
  const scoped = commands.map((command) => ({ ...command, context }))
  palette.registerMany(scoped)
  onScopeDispose(() => {
    for (const command of scoped) palette.unregister(command.id)
  })
}
