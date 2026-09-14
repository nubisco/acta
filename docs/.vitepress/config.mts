import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Acta',
  description:
    'Kanban boards and a Markdown wiki in one self-hostable server, co-managed by humans and AI agents with full attribution.',

  base: '/acta/',

  head: [
    // Acta's own mark. The docs briefly carried Verba's favicon, copied in
    // with the rest of that site's public assets.
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/acta/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#16253a' }],
    [
      'meta',
      {
        name: 'keywords',
        content:
          'project management, kanban, wiki, mcp, model context protocol, self-hosted, oidc, trello alternative, confluence alternative',
      },
    ],
    ['script', { defer: '', src: 'https://analytics.nubisco.io/script.js' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Acta' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Kanban boards and a Markdown wiki in one self-hostable server, co-managed by humans and AI agents.',
      },
    ],
  ],

  sitemap: { hostname: 'https://docs.nubisco.io/acta/' },

  lastUpdated: true,

  ignoreDeadLinks: [/^http:\/\/localhost/],

  themeConfig: {
    siteTitle: 'Acta',
    logo: { src: '/logo.svg', width: 24, height: 24 },

    nav: [
      { text: 'Users', link: '/users/' },
      { text: 'Developers', link: '/developers/' },
      {
        text: 'Project',
        items: [
          { text: 'Repository', link: 'https://github.com/nubisco/acta' },
          {
            text: 'Contributing',
            link: 'https://github.com/nubisco/acta/blob/master/CONTRIBUTING.md',
          },
          {
            text: 'Security policy',
            link: 'https://github.com/nubisco/acta/blob/master/SECURITY.md',
          },
          { text: 'Sponsor', link: 'https://github.com/sponsors/joseporto' },
        ],
      },
      {
        text: 'Nubisco',
        items: [
          { text: 'nubisco.io', link: 'https://nubisco.io' },
          { text: 'Nubisco UI', link: 'https://docs.nubisco.io/ui/' },
          { text: 'Verba', link: 'https://docs.nubisco.io/verba/' },
          { text: 'Nubisco CMS', link: 'https://docs.nubisco.io/cms/' },
          { text: 'OpenBridge', link: 'https://github.com/nubisco/openbridge' },
        ],
      },
    ],

    // Two audiences, two sidebars. Someone using Acta and someone running it
    // want different halves of this site, and a single flat list of sections
    // made each of them read past the other's.
    sidebar: {
      '/users/': [
        {
          text: 'Using Acta',
          items: [
            { text: 'What Acta is', link: '/users/' },
            { text: 'Concepts', link: '/users/concepts' },
            { text: 'Working in Acta', link: '/users/working' },
            { text: 'Connect an agent', link: '/users/connect-an-agent' },
          ],
        },
        {
          text: 'Running it yourself',
          items: [{ text: 'For developers', link: '/developers/' }],
        },
      ],
      '/developers/': [
        {
          text: 'Start here',
          items: [{ text: 'Overview', link: '/developers/' }],
        },
        {
          text: 'Running Acta',
          items: [
            { text: 'Install', link: '/developers/install' },
            { text: 'Configuration', link: '/developers/configuration' },
            { text: 'Authentication', link: '/developers/authentication' },
          ],
        },
        {
          text: 'Migrating',
          items: [
            { text: 'From Trello', link: '/developers/migrate-trello' },
            { text: 'From Confluence', link: '/developers/migrate-confluence' },
          ],
        },
        {
          text: 'Model Context Protocol',
          items: [
            { text: 'The endpoint', link: '/developers/mcp' },
            { text: 'Tools', link: '/developers/mcp-tools' },
          ],
        },
        {
          text: 'Internals',
          items: [
            { text: 'Architecture', link: '/developers/architecture' },
            { text: 'The data model', link: '/developers/data-model' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/nubisco/acta' }],

    editLink: {
      pattern: 'https://github.com/nubisco/acta/edit/master/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: { provider: 'local' },

    footer: {
      message:
        'Released under the <a href="https://github.com/nubisco/acta/blob/master/LICENSE">MIT License</a>. · <a href="https://github.com/sponsors/joseporto">♥ Sponsor this project</a>',
      copyright: 'Copyright © 2026 <a href="https://nubisco.io">Nubisco</a>',
    },
  },
})
