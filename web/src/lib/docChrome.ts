/**
 * The document chrome's per-viewer preferences.
 *
 * Focus mode and whether the table of contents is open are how one person
 * likes to read, not facts about the document. So they live in this browser
 * and nowhere else: never in the markdown, never in a doc write, never on the
 * server. Two people reading the same page each get their own.
 *
 * Page width is the exception and is deliberately NOT here. It is the
 * document's stored `layout`, chosen by its editors for everyone.
 *
 * Module state rather than per-component state, because the app frame has to
 * hear about page focus too: it is App.vue that owns the rail and the topbar
 * page focus hides.
 */
import { computed, reactive, watch } from 'vue'

export const DOC_CHROME_STORAGE_KEY = 'acta:doc-chrome'

export interface IDocChromePrefs {
  /** Dim every block except the one holding the caret, while editing. */
  dimBlocks: boolean
  /** Hide the app frame around the document. */
  page: boolean
  /** The reader closed the table of contents. */
  tocClosed: boolean
}

const DEFAULTS: IDocChromePrefs = {
  dimBlocks: false,
  page: false,
  tocClosed: false,
}

/**
 * Storage can be missing (a locked-down browser, private mode on some
 * engines) or hold something a previous version wrote. Either way the answer
 * is the defaults, never an exception on page load.
 */
export function loadDocChromePrefs(): IDocChromePrefs {
  try {
    const raw = window.localStorage.getItem(DOC_CHROME_STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<IDocChromePrefs>
    return {
      dimBlocks: parsed.dimBlocks === true,
      page: parsed.page === true,
      tocClosed: parsed.tocClosed === true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(prefs: IDocChromePrefs): void {
  try {
    window.localStorage.setItem(DOC_CHROME_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Not persisted, still applied for this visit.
  }
}

const prefs = reactive<IDocChromePrefs>(loadDocChromePrefs())
/**
 * How many document surfaces that honour page focus are mounted. The frame
 * hides only while one is, so a preference left on does not strip the rail
 * off the board view the reader navigates to next.
 */
const surfaces = reactive({ count: 0 })

watch(prefs, (value) => save({ ...value }), { deep: true })

export function useDocChrome() {
  return {
    prefs,
    /** Whether the app frame should be hidden right now. */
    frameHidden: computed(() => prefs.page && surfaces.count > 0),
    attachSurface(): () => void {
      surfaces.count++
      let attached = true
      return () => {
        if (!attached) return
        attached = false
        surfaces.count--
      }
    },
    /** Re-read storage, for tests that simulate a reload. */
    reload(): void {
      Object.assign(prefs, loadDocChromePrefs())
    },
  }
}

/** True for the platform's command key: Cmd on Apple, Ctrl elsewhere. */
export function isModKey(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey
}

/** Mod+Shift+F. `code`, not `key`, so Shift and keyboard layout do not matter. */
export function isPageFocusShortcut(event: KeyboardEvent): boolean {
  return (
    isModKey(event) && event.shiftKey && !event.altKey && event.code === 'KeyF'
  )
}

/**
 * Mod+Alt+F. `code` again, because on a Mac Option+F types a character and
 * `key` would be that character rather than F.
 */
export function isDimBlocksShortcut(event: KeyboardEvent): boolean {
  return (
    isModKey(event) && event.altKey && !event.shiftKey && event.code === 'KeyF'
  )
}
