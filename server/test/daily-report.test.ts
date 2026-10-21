/**
 * The daily progress report (LA-389).
 *
 * What has to be true for it to be trusted: it only ever names real cards,
 * goals and people; "what it opened up" means a card nothing holds up any
 * more, not one that still waits; it posts once a day at most, and nothing
 * on a day nothing happened; and a model that invents something never gets
 * its words into Slack.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import { spaceWrite } from '../src/services/spaces'
import { itemWrite } from '../src/services/items'
import { goalWrite } from '../src/services/goals'
import {
  AiConfigError,
  getAiSettings,
  resolveAiConfig,
  saveAiSettings,
} from '../src/services/ai'
import {
  checkReport,
  compose,
  dailyReportTick,
  gatherFacts,
  isEmpty,
  localClock,
  previewReport,
  renderPlain,
  saveReportConfig,
  toSlack,
  type IReportFacts,
} from '../src/services/dailyReport'
import type { ICtx } from '../src/core/ctx'

const DAY = 86_400_000
/** Wednesday 21 October 2026, 11:00 in Lisbon. */
const WED = Date.UTC(2026, 9, 21, 10, 0)
const SECRET = { secret: 'test-secret-for-the-ai-key' }

let db: BunSqliteDriver
let workspaceId: string
let jose: ICtx

const human = (id: string, handle: string, role: 'admin' | 'member'): ICtx => ({
  db,
  workspaceId,
  actor: {
    id,
    kind: 'human',
    handle,
    role,
    scopes: role === 'admin' ? ['read', 'write', 'admin'] : ['read', 'write'],
  },
})

/** Mark a card done at a moment of the test's choosing. */
async function finish(key: string, at: number): Promise<void> {
  await itemWrite(jose, [
    { op: 'move', op_id: `done-${key}-${at}`, key, list: 'Done' },
  ])
  await db.run('UPDATE item SET done_at = ? WHERE key = ?', [at, key])
}

/** A fetch that records what Slack would have received. */
function fakeSlack() {
  const posts: { url: string; body: { text: string; blocks: unknown[] } }[] = []
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response('ok')
  }) as typeof fetch
  return { posts, fetchImpl }
}

beforeEach(async () => {
  db = await openDb(':memory:')
  workspaceId = await bootstrapWorkspace(db, {
    workspaceName: 'Nubisco',
    adminEmail: 'jose@nubisco.io',
    adminHandle: 'jose',
    adminName: 'José Silva',
  })
  for (const [id, handle, name] of [
    ['act_ivan', 'ivan', 'Ivan Marjanovic'],
    ['act_daniela', 'daniela', 'Daniela Pinho'],
  ])
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES (?, ?, 'human', ?, ?, ?, 'member', ?)`,
      [id, workspaceId, handle, name, `${handle}@nubisco.io`, Date.now()],
    )
  const joseId = (
    await db.query<{ id: string }>("SELECT id FROM actor WHERE handle = 'jose'")
  )[0].id
  jose = human(joseId, 'jose', 'admin')

  await spaceWrite(jose, [
    { op: 'create', op_id: 's1', key: 'CM', name: 'CMS', template: 'kanban6' },
  ])
  await itemWrite(jose, [
    {
      op: 'create',
      op_id: 'c1',
      space: 'CM',
      list: 'To Do',
      title: 'Product bar release',
      assignees: ['jose'],
    },
    {
      op: 'create',
      op_id: 'c2',
      space: 'CM',
      list: 'To Do',
      title: 'Hero headline pick',
      assignees: ['ivan'],
    },
    {
      op: 'create',
      op_id: 'c3',
      space: 'CM',
      list: 'To Do',
      title: 'Copy cards',
      assignees: ['ivan'],
    },
    {
      op: 'create',
      op_id: 'c4',
      space: 'CM',
      list: 'To Do',
      title: 'Pricing table',
      assignees: ['daniela'],
    },
    // CM-2 waits on CM-1. CM-3 waits on CM-1 and on CM-4.
    { op: 'depends_on', op_id: 'd1', key: 'CM-2', blocker: 'CM-1' },
    { op: 'depends_on', op_id: 'd2', key: 'CM-3', blocker: 'CM-1' },
    { op: 'depends_on', op_id: 'd3', key: 'CM-3', blocker: 'CM-4' },
  ])
  await goalWrite(jose, [
    {
      op: 'create',
      op_id: 'g1',
      title: 'Stagewright, understood in 5 seconds',
      status: 'at_risk',
    },
  ])
  await goalWrite(jose, [
    { op: 'link', op_id: 'gl1', goal: 1, add: ['CM-1', 'CM-2', 'CM-3'] },
  ])
})

const window = (since: number, until = WED) => ({
  since,
  until,
  timezone: 'Europe/Lisbon',
  stallDays: 5,
})

describe('what moved', () => {
  it('counts a card done inside the window, and not one done before it', async () => {
    await finish('CM-1', WED - 2 * 3600_000)
    expect(
      (await gatherFacts(db, workspaceId, window(WED - DAY))).done.map(
        (c) => c.key,
      ),
    ).toEqual(['CM-1'])
    expect(
      (await gatherFacts(db, workspaceId, window(WED - 3600_000))).done,
    ).toEqual([])
  })

  it('names the goal a finished card serves', async () => {
    await finish('CM-1', WED - 3600_000)
    const facts = await gatherFacts(db, workspaceId, window(WED - DAY))
    expect(facts.done[0].goals).toEqual(['G-1'])
  })
})

describe('what it opened up', () => {
  it('frees the card whose only blocker finished, and says whose it is', async () => {
    await finish('CM-1', WED - 3600_000)
    const facts = await gatherFacts(db, workspaceId, window(WED - DAY))
    expect(facts.openedUp).toEqual([
      {
        done: 'CM-1',
        card: {
          key: 'CM-2',
          title: 'Hero headline pick',
          goals: ['G-1'],
          owners: ['ivan'],
        },
      },
    ])
  })

  it('does not claim a card is free while it still waits on another', async () => {
    await finish('CM-1', WED - 3600_000)
    const facts = await gatherFacts(db, workspaceId, window(WED - DAY))
    expect(facts.openedUp.map((o) => o.card.key)).not.toContain('CM-3')
  })

  it('shows the goal it moved, and its next free steps', async () => {
    await finish('CM-1', WED - 3600_000)
    const [goal] = (await gatherFacts(db, workspaceId, window(WED - DAY))).goals
    expect(goal.goal).toBe('G-1')
    expect(goal.status).toBe('at_risk')
    expect([goal.done, goal.total]).toEqual([1, 3])
    expect(goal.doneSince).toEqual(['CM-1'])
    expect(goal.next.map((c) => c.key)).toEqual(['CM-2'])
  })

  it('says when the last part of a card is finished', async () => {
    await itemWrite(jose, [
      {
        op: 'create',
        op_id: 'p1',
        space: 'CM',
        list: 'To Do',
        title: 'Launch',
      },
      { op: 'set_parent', op_id: 'p2', key: 'CM-1', parent: 'CM-5' },
    ])
    await finish('CM-1', WED - 3600_000)
    const facts = await gatherFacts(db, workspaceId, window(WED - DAY))
    expect(facts.partsComplete.map((c) => c.key)).toEqual(['CM-5'])
  })

  it('leaves archived cards out', async () => {
    await itemWrite(jose, [{ op: 'archive', op_id: 'a1', key: 'CM-2' }])
    await finish('CM-1', WED - 3600_000)
    const facts = await gatherFacts(db, workspaceId, window(WED - DAY))
    expect(facts.openedUp).toEqual([])
  })

  it('leaves cards in an archived space out', async () => {
    await finish('CM-1', WED - 3600_000)
    await db.run("UPDATE space SET archived = 1 WHERE key = 'CM'")
    const facts = await gatherFacts(db, workspaceId, window(WED - DAY))
    expect(facts.done).toEqual([])
    expect(isEmpty(facts)).toBe(true)
  })
})

describe('where each person might look', () => {
  it("picks each person's own free cards, and nobody's finished ones", async () => {
    await finish('CM-1', WED - 3600_000)
    const facts = await gatherFacts(db, workspaceId, window(WED - DAY))
    const focus = Object.fromEntries(
      facts.people.map((p) => [p.handle, p.focus.map((f) => f.key)]),
    )
    expect(focus.ivan).toContain('CM-2')
    // CM-3 still waits on CM-4, so it is not something Ivan can start.
    expect(focus.ivan).not.toContain('CM-3')
    expect(focus.daniela).toEqual(['CM-4'])
    // Jose's only card is done, so he has no block rather than an empty one.
    expect(focus.jose).toBeUndefined()
  })

  it("names a card held up by someone's untouched card", async () => {
    await finish('CM-1', WED - 3600_000)
    await db.run('UPDATE item SET updated_at = ? WHERE key = ?', [
      WED - 9 * DAY,
      'CM-4',
    ])
    const facts = await gatherFacts(db, workspaceId, window(WED - DAY))
    expect(facts.waiting).toEqual([
      expect.objectContaining({ blocker: 'CM-4', on: 'daniela', days: 9 }),
    ])
    expect(facts.waiting[0].card.key).toBe('CM-3')
  })
})

describe('goal changes', () => {
  it('reports a status change from the check-ins in the window', async () => {
    await goalWrite(jose, [
      { op: 'check_in', op_id: 'ci1', goal: 1, status: 'on_track' },
    ])
    await db.run('UPDATE goal_update SET created_at = ?', [WED - 5 * DAY])
    await goalWrite(jose, [
      { op: 'check_in', op_id: 'ci2', goal: 1, status: 'at_risk' },
    ])
    await db.run(
      "UPDATE goal_update SET created_at = ? WHERE status = 'at_risk'",
      [WED - 3600_000],
    )
    const facts = await gatherFacts(db, workspaceId, window(WED - DAY))
    expect(facts.goalChanges).toEqual([
      {
        goal: 'G-1',
        title: 'Stagewright, understood in 5 seconds',
        from: 'on_track',
        to: 'at_risk',
      },
    ])
    expect(isEmpty(facts)).toBe(false)
  })
})

describe('the words', () => {
  async function facts(): Promise<IReportFacts> {
    await finish('CM-1', WED - 3600_000)
    await db.run('UPDATE item SET updated_at = ? WHERE key = ?', [
      WED - 9 * DAY,
      'CM-4',
    ])
    return gatherFacts(db, workspaceId, window(WED - DAY))
  }

  it('only ever names cards, goals and people from the facts', async () => {
    const f = await facts()
    const text = renderPlain(f)
    expect(text).toContain(
      'CM-1 is done, so CM-2 Hero headline pick is no longer blocked. @ivan can pick it up.',
    )
    // The reasons keep the keys they name in their own case.
    expect(text).toContain('1) CM-4 Pricing table: blocks CM-3')
    expect(text).toContain('1) CM-2 Hero headline pick: G-1 at risk')
    expect(checkReport(text, f)).toEqual({ ok: true, problems: [] })
  })

  it('refuses a card, a goal or a person that is not in the facts', async () => {
    const f = await facts()
    expect(checkReport('CM-99 is done.', f).problems).toEqual([
      'unknown card CM-99',
    ])
    expect(checkReport('G-7 moved.', f).problems).toEqual(['unknown goal G-7'])
    expect(checkReport('@bob can start CM-2.', f).problems).toEqual([
      'unknown person @bob',
    ])
    expect(checkReport('See https://evil.test', f).ok).toBe(false)
    expect(checkReport('<!channel> CM-2', f).ok).toBe(false)
  })

  it("uses the model's words when they pass, and the plain ones when not", async () => {
    const f = await facts()
    await saveAiSettings(
      db,
      workspaceId,
      { provider: 'anthropic', apiKey: 'sk-ant-test-key-123456' },
      SECRET,
    )
    const replying = (text: string) =>
      (async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text }],
            usage: { input_tokens: 900, output_tokens: 200 },
          }),
        )) as unknown as typeof fetch

    const good = await compose(f, {
      db,
      workspaceId,
      secret: SECRET,
      aiWriting: true,
      fetchImpl: replying(
        '*Daily progress, Wednesday 21 Oct*\nCM-1 is done, so @ivan can start CM-2.',
      ),
    })
    expect(good.writer).toBe('ai')

    const invented = await compose(f, {
      db,
      workspaceId,
      secret: SECRET,
      aiWriting: true,
      fetchImpl: replying('CM-1 is done and the CM-77 release went out.'),
    })
    expect(invented.writer).toBe('plain')
    expect(invented.text).toBe(renderPlain(f))
    expect(invented.fallbackReason).toContain('unknown card CM-77')

    const usage = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM ai_usage_log',
    )
    expect(usage[0].n).toBe(2)
  })

  it('tells the model reasons are separate facts, not causes', async () => {
    const f = await facts()
    await saveAiSettings(
      db,
      workspaceId,
      { provider: 'anthropic', apiKey: 'sk-ant-test-key-123456' },
      SECRET,
    )
    let sent: { system: string; messages: { content: string }[] } | null = null
    await compose(f, {
      db,
      workspaceId,
      secret: SECRET,
      aiWriting: true,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body))
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'CM-2.' }] }),
        )
      }) as unknown as typeof fetch,
    })
    const request = sent as unknown as {
      system: string
      messages: { content: string }[]
    }
    expect(request.system).toContain('Never join them with "because"')
    // The person's reasons go over as a list under their own name.
    expect(request.messages[0].content).toContain('"reasons":[')
    expect(request.messages[0].content).not.toContain('"why"')
  })

  it('writes plain when there is no key, without calling anyone', async () => {
    const f = await facts()
    let called = false
    const composed = await compose(f, {
      db,
      workspaceId,
      secret: SECRET,
      aiWriting: true,
      fetchImpl: (async () => {
        called = true
        return new Response('{}')
      }) as unknown as typeof fetch,
    })
    expect(composed.writer).toBe('plain')
    expect(called).toBe(false)
  })

  it('mentions people Slack knows, and names the ones it does not', async () => {
    const f = await facts()
    const slack = toSlack(renderPlain(f), f, {
      baseUrl: 'https://acta.test',
      workspaceSlug: 'nubisco',
      slackIds: { ivan: 'U012IVAN' },
      names: { ivan: 'Ivan Marjanovic', daniela: 'Daniela Pinho' },
    })
    expect(slack).toContain('<@U012IVAN> can pick it up')
    expect(slack).toContain('(Daniela Pinho)')
    expect(slack).not.toContain('@daniela')
    expect(slack).toContain('<https://acta.test/nubisco/s/CM?item=CM-2|CM-2>')
    expect(slack).toContain('<https://acta.test/nubisco/goals/G-1|G-1>')
  })

  it('cannot be made into markup by a card title', async () => {
    await itemWrite(jose, [
      {
        op: 'update',
        op_id: 'u1',
        key: 'CM-2',
        title: '<!channel> & <https://x.test|click>',
      },
    ])
    const f = await facts()
    const slack = toSlack(renderPlain(f), f, { slackIds: {}, names: {} })
    expect(slack).not.toContain('<!channel>')
    expect(slack).toContain('&lt;!channel&gt; &amp;')
  })

  it("cannot be made into markup by a person's name either", async () => {
    const f = await facts()
    const slack = toSlack(renderPlain(f), f, {
      slackIds: {},
      names: { ivan: '<!channel> Ivan', daniela: 'Daniela' },
    })
    expect(slack).not.toContain('<!channel>')
    expect(slack).toContain('&lt;!channel&gt; Ivan')
  })
})

describe('the schedule', () => {
  async function enable(mode: 'preview' | 'post' = 'post') {
    await saveReportConfig(db, workspaceId, {
      enabled: true,
      mode,
      slackWebhookUrl: 'https://hooks.slack.com/services/T0/B0/xyz',
      aiWriting: false,
    })
  }

  it('posts once a day, however many times the cron fires', async () => {
    await enable()
    await finish('CM-1', WED - 3600_000)
    const slack = fakeSlack()
    for (let i = 0; i < 3; i++)
      await dailyReportTick(db, {
        secret: SECRET,
        fetchImpl: slack.fetchImpl,
        now: WED + i * 60_000,
      })
    expect(slack.posts).toHaveLength(1)
    expect(slack.posts[0].body.text).toBe('Daily progress, Wednesday 21 Oct')
    const runs = await db.query<{ status: string }>(
      'SELECT status FROM daily_report_run',
    )
    expect(runs).toEqual([{ status: 'posted' }])
  })

  it('waits for the hour, and skips weekends and holidays', async () => {
    await enable()
    await finish('CM-1', WED - 3600_000)
    const slack = fakeSlack()
    // 08:00 in Lisbon, before the default 09:00.
    await dailyReportTick(db, {
      secret: SECRET,
      fetchImpl: slack.fetchImpl,
      now: WED - 3 * 3600_000,
    })
    // Saturday.
    await dailyReportTick(db, {
      secret: SECRET,
      fetchImpl: slack.fetchImpl,
      now: WED + 3 * DAY,
    })
    await saveReportConfig(db, workspaceId, { holidays: ['2026-10-21'] })
    await dailyReportTick(db, {
      secret: SECRET,
      fetchImpl: slack.fetchImpl,
      now: WED,
    })
    expect(slack.posts).toHaveLength(0)
  })

  it('posts nothing on a day nothing happened', async () => {
    await enable()
    const slack = fakeSlack()
    await dailyReportTick(db, {
      secret: SECRET,
      fetchImpl: slack.fetchImpl,
      now: WED,
    })
    expect(slack.posts).toHaveLength(0)
    const runs = await db.query<{ status: string }>(
      'SELECT status FROM daily_report_run',
    )
    expect(runs).toEqual([{ status: 'skipped' }])
  })

  it('reads "since the last report" from the last one written', async () => {
    await enable()
    await finish('CM-1', WED - 3600_000)
    const slack = fakeSlack()
    await dailyReportTick(db, {
      secret: SECRET,
      fetchImpl: slack.fetchImpl,
      now: WED,
    })
    // Thursday: CM-4 was finished overnight. CM-1 was in Wednesday's report
    // and must not be in this one.
    await finish('CM-4', WED + 12 * 3600_000)
    await dailyReportTick(db, {
      secret: SECRET,
      fetchImpl: slack.fetchImpl,
      now: WED + DAY,
    })
    expect(slack.posts).toHaveLength(2)
    const thursday = JSON.stringify(slack.posts[1].body.blocks)
    expect(thursday).toContain('CM-4')
    expect(thursday).not.toContain('CM-1 Product bar release')
    const windows = await db.query<{ since_ts: number; until_ts: number }>(
      'SELECT since_ts, until_ts FROM daily_report_run ORDER BY until_ts',
    )
    expect(windows[1].since_ts).toBe(windows[0].until_ts)
  })

  it('in preview mode keeps the report and posts nothing', async () => {
    await enable('preview')
    await finish('CM-1', WED - 3600_000)
    const slack = fakeSlack()
    await dailyReportTick(db, {
      secret: SECRET,
      fetchImpl: slack.fetchImpl,
      now: WED,
    })
    expect(slack.posts).toHaveLength(0)
    const [run] = await db.query<{ status: string; text: string }>(
      'SELECT status, text FROM daily_report_run',
    )
    expect(run.status).toBe('preview')
    expect(run.text).toContain('CM-2')
  })

  it('previews without claiming the day', async () => {
    await enable()
    await finish('CM-1', WED - 3600_000)
    const preview = await previewReport(db, workspaceId, {
      secret: SECRET,
      now: WED,
    })
    expect(preview.empty).toBe(false)
    expect(preview.writer).toBe('plain')
    const runs = await db.query('SELECT 1 FROM daily_report_run')
    expect(runs).toHaveLength(0)
  })

  it("reads the local date and hour in the report's zone", () => {
    expect(localClock(WED, 'Europe/Lisbon')).toEqual({
      date: '2026-10-21',
      hour: 11,
      weekend: false,
    })
    expect(localClock(WED + 3 * DAY, 'Europe/Lisbon').weekend).toBe(true)
  })
})

describe('the provider key', () => {
  it('is stored encrypted and never handed back', async () => {
    const saved = await saveAiSettings(
      db,
      workspaceId,
      { provider: 'openai', apiKey: 'sk-proj-abcdefghijkl' },
      SECRET,
    )
    expect(saved).toEqual(
      expect.objectContaining({ provider: 'openai', hasKey: true }),
    )
    expect(JSON.stringify(saved)).not.toContain('sk-proj')
    const [row] = await db.query<{ api_key_encrypted: string }>(
      'SELECT api_key_encrypted FROM ai_settings',
    )
    expect(row.api_key_encrypted).not.toContain('sk-proj')
    const config = await resolveAiConfig(db, workspaceId, SECRET)
    expect(config).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-luna',
      apiKey: 'sk-proj-abcdefghijkl',
    })
  })

  it('cannot be stored without an encryption secret', async () => {
    let refused: unknown = null
    try {
      await saveAiSettings(
        db,
        workspaceId,
        { apiKey: 'sk-ant-abcdefghijkl' },
        {},
      )
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(AiConfigError)
    expect((await getAiSettings(db, workspaceId)).hasKey).toBe(false)
  })
})
