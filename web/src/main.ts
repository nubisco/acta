import { createApp, type Plugin } from 'vue'
import { createI18n } from 'vue-i18n'
import { createRouter, createWebHistory } from 'vue-router'
import NubiscoUI, {
  configureTheme,
  dismissConfirms,
  NbCommandPalettePlugin,
  useToast,
} from '@nubisco/ui'
import '@nubisco/ui/dist/ui.css'
import 'unfonts.css'
import './styles/index.scss'
import App from './App.vue'
import { useWorkspace } from './stores/workspace'

configureTheme({ storageKey: 'acta.theme' })

// Acta ships no translated copy of its own yet; the catalog exists so
// @nubisco/ui components (NbUserMenu) can resolve their userMenu.* strings,
// falling back to their built-in en/pt defaults. Without this plugin those
// components throw vue-i18n's NOT_INSTALLED error during setup.
const i18n = createI18n({
  legacy: false,
  locale: typeof navigator !== 'undefined' ? navigator.language : 'en',
  fallbackLocale: 'en',
  messages: {},
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
      path: '/',
      name: 'home',
      component: () => import('./views/HomeView.vue'),
      meta: { title: 'Home' },
    },
    {
      path: '/b/:boardKey',
      name: 'board',
      component: () => import('./views/BoardView.vue'),
      props: true,
      meta: { crumb: 'board' },
    },
    {
      path: '/docs/:slug(.*)?',
      name: 'docs',
      component: () => import('./views/DocsView.vue'),
      props: true,
      meta: { crumb: 'docs', title: 'Docs' },
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('./views/SearchView.vue'),
      meta: { title: 'Search' },
    },
    {
      path: '/activity',
      name: 'activity',
      component: () => import('./views/ActivityView.vue'),
      meta: { title: 'Activity' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
      meta: { title: 'Settings' },
    },
  ],
})

router.beforeEach(async (to) => {
  dismissConfirms()
  const ws = useWorkspace()
  if (to.meta.public) return true
  if (ws.me.value) return true
  const ok = await ws.loadMe()
  if (!ok) return { name: 'login', query: { to: to.fullPath } }
  await ws.refresh()
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
