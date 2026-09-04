import { createApp, type Plugin } from 'vue'
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
  .use(router)
  .use(NbCommandPalettePlugin as unknown as Plugin)
  .mount('#app')
