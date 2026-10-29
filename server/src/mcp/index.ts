/**
 * MCP over Streamable HTTP (stateless mode): POST /mcp with JSON-RPC 2.0.
 * Authenticated with the same bearer tokens as the REST API; the agent is a
 * first-class actor and every mutation is attributed to it.
 */

import { Hono } from 'hono'
import { ApiError, type IActorCtx, type ICtx } from '../core/ctx'
import type { ISqlDriver } from '../db'
import type { AttachmentStore } from '../services/attachments'
import { urlTemplates, type IUrlTemplates } from '../core/links'
import { createMcpTools, toolInputSchema, type IMcpTool } from './tools'

const PROTOCOL_VERSION = '2025-06-18'

interface IMcpEnv {
  Variables: {
    db: ISqlDriver
    workspaceId: string
    actor: IActorCtx
  }
}

interface IJsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

function rpcResult(id: number | string | null, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result }
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: '2.0' as const, id, error: { code, message, data } }
}

const INSTRUCTIONS =
  'Acta manages kanban spaces and markdown documents. Start with workspace_overview to orient. All writes are batch ops with client op_ids: they are idempotent and safe to retry. Prefer patch_section/append for document edits and updated_since/since cursors for delta reads.'

interface IRequestEnv {
  /** Where this server is, for its own icon and site. */
  origin: string
  /** Null when the instance has no public address configured. */
  templates: () => Promise<IUrlTemplates | null>
}

/** The templates in words, for a model reading the instructions. */
function linkInstructions(t: IUrlTemplates): string {
  return ` To link to something in Acta, fill these templates: a card ${t.item} ({space} is the key before the dash, CM for CM-35), a goal ${t.goal} (12 for G-12), a document ${t.doc}. workspace_overview returns them as url_templates.`
}

/**
 * The server's own identity, so a client can show Acta's name and icon
 * rather than a generic one. Fields from MCP 2025-11-25, which a client on an
 * older revision ignores.
 */
function serverInfo(origin: string) {
  return {
    name: 'acta',
    title: 'Acta',
    version: '0.1.0',
    websiteUrl: origin,
    icons: [
      {
        src: `${origin}/acta-icon.svg`,
        mimeType: 'image/svg+xml',
        sizes: ['any'],
      },
      {
        src: `${origin}/icons/acta-192.png`,
        mimeType: 'image/png',
        sizes: ['192x192'],
      },
      {
        src: `${origin}/icons/acta-512.png`,
        mimeType: 'image/png',
        sizes: ['512x512'],
      },
    ],
  }
}

async function handleRequest(
  ctx: ICtx,
  tools: IMcpTool[],
  req: IJsonRpcRequest,
  env: IRequestEnv,
): Promise<unknown> {
  const id = req.id ?? null
  switch (req.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: serverInfo(env.origin),
        instructions: await env
          .templates()
          .then((t) => (t ? INSTRUCTIONS + linkInstructions(t) : INSTRUCTIONS)),
      })
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: toolInputSchema(tool),
          ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        })),
      })
    case 'tools/call': {
      const name = req.params?.name as string
      const tool = tools.find((t) => t.name === name)
      if (!tool) return rpcError(id, -32602, `unknown tool ${name}`)
      if (tool.write && !ctx.actor.scopes.includes('write')) {
        return rpcResult(
          id,
          toolError(`token lacks the write scope required by ${name}`),
        )
      }
      const parsed = tool.schema.safeParse(req.params?.arguments ?? {})
      if (!parsed.success) {
        return rpcResult(
          id,
          toolError(
            `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          ),
        )
      }
      try {
        let result = await tool.handler(ctx, parsed.data)
        // The bootstrap read says once where things open, rather than every
        // read carrying a url per row (see core/links.ts).
        if (tool.name === 'workspace_overview') {
          const templates = await env.templates()
          if (templates)
            result = { ...(result as object), url_templates: templates }
        }
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        })
      } catch (err) {
        if (err instanceof ApiError) {
          return rpcResult(
            id,
            toolError(
              JSON.stringify({
                error: err.message,
                current: err.current ?? undefined,
              }),
            ),
          )
        }
        throw err
      }
    }
    default:
      if (req.method.startsWith('notifications/')) return undefined
      return rpcError(id, -32601, `method not found: ${req.method}`)
  }
}

function toolError(text: string) {
  return { content: [{ type: 'text', text }], isError: true }
}

export function mcpRoutes(
  store: AttachmentStore,
  opts: { baseUrl?: string } = {},
): Hono<IMcpEnv> {
  const app = new Hono<IMcpEnv>()
  const tools = createMcpTools(store)

  app.post('/', async (c) => {
    const ctx: ICtx = {
      db: c.get('db'),
      workspaceId: c.get('workspaceId'),
      actor: c.get('actor'),
    }
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(rpcError(null, -32700, 'parse error'), 400)
    }
    // Links only from a configured address (ACTA_BASE_URL, which the Worker
    // defaults to its own origin), as outbound email does: the host a
    // request arrived on can be an internal one behind a proxy.
    const env: IRequestEnv = {
      origin:
        (opts.baseUrl ?? '').trim().replace(/\/+$/, '') ||
        new URL(c.req.url).origin,
      templates: async () => {
        if (!opts.baseUrl) return null
        const rows = await ctx.db.query<{ slug: string }>(
          'SELECT slug FROM workspace WHERE id = ?',
          [ctx.workspaceId],
        )
        return urlTemplates(opts.baseUrl, rows[0]?.slug)
      },
    }
    const requests = Array.isArray(body) ? body : [body]
    const responses: unknown[] = []
    for (const r of requests) {
      const response = await handleRequest(
        ctx,
        tools,
        r as IJsonRpcRequest,
        env,
      )
      if (response !== undefined) responses.push(response)
    }
    if (responses.length === 0) return c.body(null, 202)
    const payload = Array.isArray(body) ? responses : responses[0]
    return c.json(payload as Record<string, unknown>)
  })

  // Stateless mode: no server-initiated stream, no session to delete.
  app.get('/', (c) => c.json({ error: 'stateless server; POST JSON-RPC' }, 405))
  app.delete('/', (c) => c.body(null, 200))

  return app
}

/**
 * The answer to an MCP request that went over its rate limit.
 *
 * A tool call gets a successful JSON-RPC result with `isError: true` and a
 * sentence the model can act on, which is how every other refusal here is
 * reported (AGENTS.md "MCP servers"). A bare HTTP 429 would reach most
 * clients as a transport failure, and the agent would learn nothing about
 * waiting. Anything that is not a tool call has no result to carry that in,
 * so it gets a JSON-RPC error on a 429.
 */
export async function mcpRateLimited(
  retryAfterSec: number,
  req: Request,
): Promise<Response> {
  const message = `Rate limited: too many requests to Acta from this credential. Wait ${retryAfterSec} seconds, then retry. Writes are idempotent on op_id, so retrying the same batch is safe.`
  let body: unknown = null
  try {
    body = await req.clone().json()
  } catch {
    // Unreadable: answered as a single error below.
  }
  const requests = (
    Array.isArray(body) ? body : [body]
  ) as Array<Partial<IJsonRpcRequest> | null>
  let anyToolCall = false
  const answers = requests
    .filter((r) => !r?.method?.startsWith('notifications/'))
    .map((r) => {
      const id = r?.id ?? null
      if (r?.method === 'tools/call') {
        anyToolCall = true
        return rpcResult(id, toolError(message))
      }
      return rpcError(id, -32000, message)
    })
  const payload = Array.isArray(body) ? answers : (answers[0] ?? null)
  return new Response(JSON.stringify(payload), {
    status: anyToolCall ? 200 : 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': String(retryAfterSec),
    },
  })
}
