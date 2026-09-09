import { createApp, type Plugin } from 'vue'
import { createI18n } from 'vue-i18n'
import { createRouter, createWebHistory } from 'vue-router'
import NubiscoUI, {
  configureTheme,
  dismissConfirms,
  NbCommandPalettePlugin,
  useToast,
} from '@nubisco/ui'
import 'unfonts.css'
import './styles/index.scss'
import App from './App.vue'
import { registerActaIcons } from './lib/icons'
import { setWorkspaceSlug } from './api/client'
import { useWorkspace } from './stores/workspace'

configureTheme({ storageKey: 'acta.theme' })
registerActaIcons()

// Acta ships no translated copy of its own yet; the catalog exists so
// @nubisco/ui components (NbUserMenu) can resolve their userMenu.* strings,
// falling back to their built-in en/pt defaults. Without this plugin those
// components throw vue-i18n's NOT_INSTALLED error during setup.
const i18n = createI18n({
  legacy: false,
  locale: typeof navigator !== 'undefined' ? navigator.language : 'en',
  fallbackLocale: 'en',
  messages: {
    // NbImageCropper reads these from the app's catalogue but ships no
    // defaults of its own, unlike NbUserMenu, so without them the cropper
    // renders "common.WIDTH" at people. Fixed upstream too; this keeps the
    // current release readable.
    en: {
      common: {
        X: 'X',
        Y: 'Y',
        WIDTH: 'Width',
        HEIGHT: 'Height',
        IMAGE: 'Image',
      },
    },
  },
  missingWarn: false,
  fallbackWarn: false,
})

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/LoginView.vue'),
      meta: { public: true, frameless: true, title: 'Sign in' },
    },
    {
      // The entry point, the way CMS and Verba have one. Skips straight
      // through when there is only one workspace to choose.
      path: '/',
      name: 'workspaces',
      component: () => import('./views/WorkspacesView.vue'),
      meta: { frameless: true, title: 'Workspaces' },
    },
    {
      // Every real route lives under the workspace, the way a repository
      // lives under an org on GitHub.
      path: '/:workspace',
      children: [
        {
          path: '',
          name: 'home',
          component: () => import('./views/HomeView.vue'),
          meta: { title: 'Home' },
        },
        {
          path: 'b/:boardKey',
          name: 'board',
          component: () => import('./views/BoardView.vue'),
          props: true,
          meta: { crumb: 'board' },
        },
        {
          path: 'docs/:slug(.*)?',
          name: 'docs',
          component: () => import('./views/DocsView.vue'),
          props: true,
          meta: { crumb: 'docs', title: 'Docs' },
        },
        {
          path: 'search',
          name: 'search',
          component: () => import('./views/SearchView.vue'),
          meta: { title: 'Search' },
        },
        {
          path: 'activity',
          name: 'activity',
          component: () => import('./views/ActivityView.vue'),
          meta: { title: 'Activity' },
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('./views/SettingsView.vue'),
          meta: { title: 'Settings' },
        },
      ],
    },
  ],
})

/**
 * URLs minted before workspaces existed, and anything a person has
 * bookmarked. `/b/SU?item=SU-5` has to keep working, so an unprefixed path is
 * sent to the same place under the workspace rather than 404ing.
 */
const LEGACY_PREFIXES = ['/b/', '/docs', '/search', '/activity', '/settings']

router.beforeEach(async (to) => {
  dismissConfirms()
  const ws = useWorkspace()
  if (to.meta.public) return true

  const legacy = LEGACY_PREFIXES.some(
    (p) => to.path === p || to.path.startsWith(p),
  )
  if (legacy) {
    const slug = await ws.defaultWorkspaceSlug()
    if (slug) return `/${slug}${to.fullPath}`
    // More than one workspace and no way to tell which this link meant, so
    // the picker asks. The destination rides along rather than being thrown
    // away: answering "which workspace" should not also cost you the card you
    // were opening.
    return { name: 'workspaces', query: { to: to.fullPath } }
  }

  // The workspace has to be set before anything asks the API for data, since
  // every scoped call reads it.
  const slug = String(to.params.workspace ?? '')
  if (slug) setWorkspaceSlug(slug)

  if (ws.me.value && (!slug || ws.workspaceSlug.value === slug)) return true

  const ok = await ws.loadMe()
  if (!ok) return { name: 'login', query: { to: to.fullPath } }
  if (!slug) return true

  // Entering a workspace, or moving between two. A refresh that 404s means
  // this session has no actor there, which is the server's way of saying it
  // is not yours to open.
  const entered = await ws.enterWorkspace(slug)
  if (!entered) return { name: 'workspaces' }
  ws.connect()
  return true
})

router.afterEach((to) => {
  useToast().dismissTransient()
  const title = typeof to.meta.title === 'string' ? `${to.meta.title} · ` : ''
  document.title = `${title}Acta`
})

createApp(App)
  .use(NubiscoUI as unknown as Plugin)
  .use(i18n as unknown as Plugin)
  .use(router)
  .use(NbCommandPalettePlugin as unknown as Plugin)
  .mount('#app')
