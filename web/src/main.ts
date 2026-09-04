import { createApp, type Plugin } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import NubiscoUI, { configureTheme, NbCommandPalettePlugin } from '@nubisco/ui'
import '@nubisco/ui/dist/ui.css'
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
      meta: { public: true },
    },
    {
      path: '/',
      name: 'home',
      component: () => import('./views/HomeView.vue'),
    },
    {
      path: '/b/:boardKey',
      name: 'board',
      component: () => import('./views/BoardView.vue'),
      props: true,
    },
    {
      path: '/docs/:slug(.*)?',
      name: 'docs',
      component: () => import('./views/DocsView.vue'),
      props: true,
    },
    {
      path: '/activity',
      name: 'activity',
      component: () => import('./views/ActivityView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
    },
  ],
})

router.beforeEach(async (to) => {
  const ws = useWorkspace()
  if (to.meta.public) return true
  if (ws.me.value) return true
  const ok = await ws.loadMe()
  if (!ok) return { name: 'login', query: { to: to.fullPath } }
  await ws.refresh()
  ws.connect()
  return true
})

// The linked @nubisco/ui carries its own vue type instance, so its plugin
// types do not unify with this app's Plugin type; runtime is a single vue.
createApp(App)
  .use(NubiscoUI as unknown as Plugin)
  .use(router)
  .use(NbCommandPalettePlugin as unknown as Plugin)
  .mount('#app')
