// Wrangler bundling stub: on Workers the bun:sqlite path is never executed
// (the D1 driver is used), but the bundler still needs the import to resolve.
export class Database {
  constructor() {
    throw new Error('bun:sqlite is not available on Cloudflare Workers')
  }
}
