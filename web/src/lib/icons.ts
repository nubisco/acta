/**
 * Every icon Acta names at runtime rather than in a template literal.
 *
 * @nubisco/ui 4.0.0 resolves `<NbIcon name="check" />` at compile time, so a
 * page links the glyphs it actually draws instead of a 1,500-icon catalogue.
 * A name computed at runtime cannot be resolved that way: nav entries built
 * from an array, the editor toolbar, search-result kinds, command-palette
 * entries. Left alone the Vite plugin links the whole catalogue into each of
 * those files. Our set is bounded and small, so we declare it instead.
 *
 * Add a name here whenever you bind `:icon` or `:name` to anything but a
 * string literal or a ternary of string literals (the plugin handles those).
 */

import { registerIcons } from '@nubisco/ui'

import * as archive from '@nubisco/ui/icons/archive'
import * as bookOpen from '@nubisco/ui/icons/book-open'
import * as caretDown from '@nubisco/ui/icons/caret-down'
import * as chatCircle from '@nubisco/ui/icons/chat-circle'
import * as checkSquare from '@nubisco/ui/icons/check-square'
import * as clockCounterClockwise from '@nubisco/ui/icons/clock-counter-clockwise'
import * as code from '@nubisco/ui/icons/code'
import * as fileText from '@nubisco/ui/icons/file-text'
import * as house from '@nubisco/ui/icons/house'
import * as info from '@nubisco/ui/icons/info'
import * as kanban from '@nubisco/ui/icons/kanban'
import * as listBullets from '@nubisco/ui/icons/list-bullets'
import * as listNumbers from '@nubisco/ui/icons/list-numbers'
import * as magnifyingGlass from '@nubisco/ui/icons/magnifying-glass'
import * as moon from '@nubisco/ui/icons/moon'
import * as pencilSimple from '@nubisco/ui/icons/pencil-simple'
import * as plus from '@nubisco/ui/icons/plus'
import * as pulse from '@nubisco/ui/icons/pulse'
import * as quotes from '@nubisco/ui/icons/quotes'
import * as sidebarSimple from '@nubisco/ui/icons/sidebar-simple'
import * as textB from '@nubisco/ui/icons/text-b'
import * as textHThree from '@nubisco/ui/icons/text-h-three'
import * as textHTwo from '@nubisco/ui/icons/text-h-two'
import * as textItalic from '@nubisco/ui/icons/text-italic'
import * as textStrikethrough from '@nubisco/ui/icons/text-strikethrough'
import * as trash from '@nubisco/ui/icons/trash'
import * as warning from '@nubisco/ui/icons/warning'

export function registerActaIcons(): void {
  registerIcons({
    // Shell navigation and the collapsed rail's board menu (App.vue).
    house,
    'book-open': bookOpen,
    pulse,
    kanban,
    'magnifying-glass': magnifyingGlass,
    plus,
    'sidebar-simple': sidebarSimple,
    moon,
    // Editor toolbar and the `/` slash menu.
    'text-b': textB,
    'text-italic': textItalic,
    'text-strikethrough': textStrikethrough,
    code,
    'text-h-two': textHTwo,
    'text-h-three': textHThree,
    'list-bullets': listBullets,
    'list-numbers': listNumbers,
    quotes,
    warning,
    info,
    'caret-down': caretDown,
    'check-square': checkSquare,
    // Search results, by hit kind.
    'file-text': fileText,
    'chat-circle': chatCircle,
    // Command palette entries, drawn by the library's own component.
    archive,
    'pencil-simple': pencilSimple,
    trash,
    'clock-counter-clockwise': clockCounterClockwise,
  })
}
