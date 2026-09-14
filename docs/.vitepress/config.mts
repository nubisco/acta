import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Acta',
  description:
    'Kanban boards and a Markdown wiki in one self-hostable server, co-managed by humans and AI agents with full attribution.',

  base: '/acta/',

  head: [
    ['meta', { name: 'theme-color', content: '#5c35c4' }],
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

    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'Self-hosting', link: '/self-hosting/' },
      { text: 'MCP', link: '/mcp/' },
      { text: 'Migrate', link: '/migrate/trello' },
      {
        text: 'Links',
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
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Getting started',
          items: [
            { text: 'What Acta is', link: '/guide/' },
            { text: 'Concepts', link: '/guide/concepts' },
            { text: 'Working in Acta', link: '/guide/using' },
          ],
        },
        {
          text: 'Next',
          items: [
            { text: 'Run your own instance', link: '/self-hosting/' },
            { text: 'Connect an agent', link: '/mcp/' },
          ],
        },
      ],
      '/self-hosting/': [
        {
          text: 'Running Acta',
          items: [
            { text: 'Install', link: '/self-hosting/' },
            { text: 'Configuration', link: '/self-hosting/configuration' },
            { text: 'Authentication', link: '/self-hosting/authentication' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'MCP endpoint', link: '/mcp/' },
            { text: 'Architecture', link: '/develop/' },
          ],
        },
      ],
      '/mcp/': [
        {
          text: 'Model Context Protocol',
          items: [
            { text: 'Overview', link: '/mcp/' },
            { text: 'Connecting a client', link: '/mcp/connecting' },
            { text: 'Tools', link: '/mcp/tools' },
          ],
        },
      ],
      '/migrate/': [
        {
          text: 'Migrating',
          items: [
            { text: 'From Trello', link: '/migrate/trello' },
            { text: 'From Confluence', link: '/migrate/confluence' },
          ],
        },
      ],
      '/develop/': [
        {
          text: 'Developing Acta',
          items: [
            { text: 'Architecture', link: '/develop/' },
            { text: 'The data model', link: '/develop/data-model' },
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
        'Released under the terms in the repository LICENSE. Contributions require a CLA.',
      copyright: 'Nubisco',
    },
  },
})
