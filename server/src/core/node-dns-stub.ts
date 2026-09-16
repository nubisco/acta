// Wrangler bundling stub: Workers has no DNS resolver, but the bundler still
// needs `node:dns/promises` to resolve or the whole deploy fails to build.
//
// Throwing is the contract safeFetch expects. `defaultResolve` treats an error
// with no `code` property as "no resolver on this runtime" and falls through
// to DNS-over-HTTPS, which is a fetch to one fixed public endpoint rather than
// to anything a document chose. An error carrying a `code` would instead mean
// a real resolver answered "no such host", which is a different thing.
export function lookup(): Promise<{ address: string; family: number }[]> {
  return Promise.reject(new Error('node:dns is not available on Workers'))
}

export default { lookup }
