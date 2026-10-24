/**
 * MCP over Streamable HTTP (stateless mode): POST /mcp with JSON-RPC 2.0.
 * Authenticated with the same bearer tokens as the REST API; the agent is a
 * first-class actor and every mutation is attributed to it.
 */

import { Hono } from 'hono'
import { ApiError, type IActorCtx, type ICtx } from '../core/ctx'
import type { ISqlDriver } from '../db'
import type { AttachmentStore } from '../services/attachments'
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

async function handleRequest(
  ctx: ICtx,
  tools: IMcpTool[],
  req: IJsonRpcRequest,
): Promise<unknown> {
  const id = req.id ?? null
  switch (req.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'acta', version: '0.1.0' },
        instructions:
          'Acta manages kanban spaces and markdown documents. Start with workspace_overview to orient. All writes are batch ops with client op_ids: they are idempotent and safe to retry. Prefer patch_section/append for document edits and updated_since/since cursors for delta reads.',
      })
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: toolInputSchema(tool),
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
        const result = await tool.handler(ctx, parsed.data)
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          // A batch whose ops hit the plan's caps is an error the model must
          // notice, not a success with a failure buried in it (LA-399).
          ...(hitPlanLimit(result) ? { isError: true } : {}),
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

/** Whether a batch write's results include a plan_limit refusal. */
function hitPlanLimit(result: unknown): boolean {
  const results = (result as { results?: unknown })?.results
  if (!Array.isArray(results)) return false
  return results.some(
    (r) =>
      (r as { ok?: boolean })?.ok === false &&
      (r as { current?: { error?: string } })?.current?.error === 'plan_limit',
  )
}

function toolError(text: string) {
  return { content: [{ type: 'text', text }], isError: true }
}

export function mcpRoutes(store: AttachmentStore): Hono<IMcpEnv> {
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
    const requests = Array.isArray(body) ? body : [body]
    const responses: unknown[] = []
    for (const r of requests) {
      const response = await handleRequest(ctx, tools, r as IJsonRpcRequest)
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
