import { defineNubiscoDocs } from '@nubisco/docs-sdk'

export default defineNubiscoDocs({
  title: 'Acta',
  description:
    'Kanban boards and a Markdown wiki in one self-hostable server, co-managed by humans and AI agents with full attribution.',
  base: '/acta/',
  hostname: 'https://docs.nubisco.io/acta/',
  repo: 'nubisco/acta',

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
          { text: 'Goals', link: '/users/goals' },
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
          { text: 'Data safety', link: '/developers/data-safety' },
        ],
      },
    ],
  },

  footer: {
    message:
      'Core released under the <a href="https://github.com/nubisco/acta/blob/master/LICENSE">AGPL-3.0-or-later</a>. · <a href="https://github.com/sponsors/joseporto">♥ Sponsor this project</a>',
    copyright: 'Copyright © 2026 <a href="https://nubisco.io">Nubisco</a>',
  },

  vitepress: {
    ignoreDeadLinks: [/^http:\/\/localhost/],
    head: [
      [
        'meta',
        {
          name: 'keywords',
          content:
            'project management, kanban, wiki, mcp, model context protocol, self-hosted, oidc, trello alternative, confluence alternative',
        },
      ],
    ],
  },
})
