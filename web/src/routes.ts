/**
 * Every route Acta has, apart from the guards that run on them (main.ts).
 * In a module of its own so the routing can be tested without booting the
 * app: old addresses have to keep landing, and a test is what keeps them.
 */
import type { RouteRecordRaw } from 'vue-router'

/**
 * The tabs of Your settings (PersonalSettingsView). Named here so the
 * workspace settings route can send an old link to one of them on.
 */
export const PERSONAL_TABS = ['notifications', 'walkthroughs', 'account']

export const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('./views/LoginView.vue'),
    meta: { public: true, frameless: true, title: 'Sign in' },
  },
  {
    // OAuth consent for MCP connectors, reached by redirect from the
    // server's GET /oauth/authorize. Public: it renders its own sign-in
    // prompt, because bouncing to /login would drop the request params.
    path: '/oauth/consent',
    name: 'oauth-consent',
    component: () => import('./views/OAuthConsentView.vue'),
    meta: { public: true, frameless: true, title: 'Connect' },
  },
  {
    // Accepting an invitation. Public: the person is not a member of
    // anything yet, and the page sends them through sign-in itself.
    path: '/invite/:token',
    name: 'invite',
    component: () => import('./views/InviteView.vue'),
    meta: { public: true, frameless: true, title: 'Invitation' },
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
        path: 's/:spaceKey',
        name: 'space',
        component: () => import('./views/SpaceView.vue'),
        props: true,
        meta: { crumb: 'space' },
      },
      {
        // The space's own configuration, the last entry of its group in the
        // rail (the fleet's child-level settings). A path of its own rather
        // than a query on the board, so the board's view and filters never
        // have to share a URL with it.
        path: 's/:spaceKey/settings',
        name: 'space-settings',
        component: () => import('./views/SpaceSettingsView.vue'),
        props: true,
        meta: { crumb: 'space-settings', title: 'Space settings' },
      },
      {
        // Not an alias: a redirect, so the address bar ends up saying what
        // the thing is called now. Bookmarks and anything printed before
        // the rename still land.
        path: 'b/:spaceKey',
        redirect: (to) => ({
          name: 'space',
          params: to.params,
          query: to.query,
        }),
      },
      {
        path: 'b/:spaceKey/settings',
        redirect: (to) => ({ name: 'space-settings', params: to.params }),
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
        path: 'goals',
        name: 'goals',
        component: () => import('./views/GoalsView.vue'),
        meta: { title: 'Goals' },
      },
      {
        // `12` or `G-12`, so a key pasted from anywhere still lands.
        path: 'goals/:goal',
        name: 'goal',
        component: () => import('./views/GoalView.vue'),
        props: (to) => ({
          number: Number(String(to.params.goal).replace(/^G-/i, '')),
        }),
        meta: { crumb: 'goal', title: 'Goal' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('./views/SettingsView.vue'),
        meta: { title: 'Settings' },
        // The workspace's settings are the gear at the foot of the rail.
        // What is yours alone moved to the user menu (the fleet's three
        // settings levels), so a bookmark or an old link to one of those
        // tabs still lands on it.
        beforeEnter: (to) => {
          const tab = to.query.tab
          if (typeof tab !== 'string' || !PERSONAL_TABS.includes(tab))
            return true
          return {
            name: 'personal-settings',
            params: to.params,
            query: { ...to.query, tab },
          }
        },
      },
      {
        path: 'me',
        name: 'personal-settings',
        component: () => import('./views/PersonalSettingsView.vue'),
        meta: { title: 'Your settings' },
      },
    ],
  },
]
