/**
 * Outbound email, over Resend's HTTP API.
 *
 * `fetch` and nothing else, because the same code has to run on Bun and on
 * workerd, and an SMTP client runs on neither of those the same way. This
 * mirrors the rest of the fleet: `platform/src/identity/lib/email.ts` and
 * `licenses/src/email.ts` are the same shape, down to the transactional
 * template, so a Nubisco email looks like a Nubisco email wherever it came
 * from.
 *
 * Self-hosted Acta has no key and sends nothing. That is a supported
 * configuration and not a degraded one: the bell still works, and the digest
 * simply has no channel to leave by.
 */

const RESEND_API = 'https://api.resend.com/emails'

export interface IEmail {
  to: string
  subject: string
  html: string
  text: string
}

/** Anything that can put an email in front of a person. */
export type TEmailSender = (message: IEmail) => Promise<void>

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * A sender that posts to Resend.
 *
 * `from` is an argument, with no default anywhere, because Acta is open
 * source and most instances of it are not ours. An address baked in here
 * would be the wrong sender on every one of them.
 */
export function resendSender(apiKey: string, from: string): TEmailSender {
  return async ({ to, subject, html, text }) => {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    })
    if (!res.ok) {
      throw new Error(`Resend error ${res.status}: ${await res.text()}`)
    }
  }
}

interface ILine {
  /** What happened, already in the words the activity feed would use. */
  summary: string
  /** Why it reached this person. */
  reason: string
  /** Where it opens, absolute. */
  url: string | null
  /**
   * Whether `G-12` in this summary names a goal. Only the server's own goal
   * sentences say so, because a card titled "Fix the G-12 cable" must not
   * grow a link to a goal it has nothing to do with.
   */
  goals?: boolean
}

/** A card key, the shape `zItemKey` accepts. */
const ITEM_KEY = /\b[A-Z][A-Z0-9]{1,4}-\d+\b/g
/** A goal key. A card key needs two letters, so the two never collide. */
const GOAL_KEY = /\bG-(\d+)\b/g

const LINK_STYLE = 'color:#5b4fe0;font-weight:600;text-decoration:underline;'

/**
 * The summary with every card key, and every goal key on a goal line, as a
 * link to the thing it names.
 *
 * Escaped first and linked second. The keys are letters, digits and a dash,
 * so the replacement can never meet anything the escaping produced.
 */
function linkKeys(
  summary: string,
  goals: boolean,
  refs: IRefLinks,
): { html: string; linked: boolean } {
  let linked = false
  let html = escapeHtml(summary).replace(ITEM_KEY, (key) => {
    const url = refs.item(key)
    if (!url) return key
    linked = true
    return `<a href="${escapeHtml(url)}" style="${LINK_STYLE}">${key}</a>`
  })
  if (goals) {
    html = html.replace(GOAL_KEY, (key, number: string) => {
      const url = refs.goal(Number(number))
      if (!url) return key
      linked = true
      return `<a href="${escapeHtml(url)}" style="${LINK_STYLE}">${key}</a>`
    })
  }
  return { html, linked }
}

/** Where a card or a goal opens, or null when there is nowhere absolute to send anybody. */
export interface IRefLinks {
  item: (key: string) => string | null
  goal: (number: number) => string | null
}

/**
 * The digest body.
 *
 * One email listing everything, never one email per notification. A busy
 * card can produce a dozen notifications inside the window, and twelve
 * separate emails about one conversation is precisely the behaviour that
 * teaches people to filter a sender into a folder they never open.
 */
export function digestEmail(
  opts: {
    name: string | null
    workspace: string
    /**
     * The workspace's own address, absolute, or null when the instance does
     * not know where it lives. Null drops the button rather than sending a
     * relative link, which a mail client resolves against its own domain.
     */
    appUrl: string | null
    /** Builds the links behind card and goal keys. Absent means no links. */
    refs?: IRefLinks
    /**
     * How many notifications this covers, which is not `lines.length`:
     * repeats are folded into one line with a count, and the subject should
     * still say what is actually waiting.
     */
    total?: number
  },
  lines: ILine[],
): { subject: string; html: string; text: string } {
  const greeting = opts.name ? `Hi ${opts.name.split(' ')[0]},` : 'Hi,'
  const total = opts.total ?? lines.length
  // Agrees with what follows: one thing, or a list of them.
  const waiting =
    total === 1
      ? 'this is waiting for you and has not been opened yet.'
      : 'these are waiting for you and have not been opened yet.'
  const subject =
    total === 1
      ? lines[0].summary
      : `${total} things waiting in ${opts.workspace}`

  const noRefs: IRefLinks = { item: () => null, goal: () => null }
  const rows = lines
    .map((line) => {
      const label = escapeHtml(line.reason)
      const { html: body, linked } = linkKeys(
        line.summary,
        line.goals ?? false,
        opts.refs ?? noRefs,
      )
      // Keys that link go to their own card. A line naming nothing linkable
      // (a document page) links as a whole, as it always did.
      const inner =
        !linked && line.url
          ? `<a href="${escapeHtml(line.url)}" style="${LINK_STYLE}">${body}</a>`
          : `<span style="color:#111;font-weight:600;">${body}</span>`
      return `<tr>
        <td style="padding:12px 0;border-bottom:1px solid #eeedec;">
          <p style="margin:0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#888;">${label}</p>
          <p style="margin:4px 0 0;font-size:15px;line-height:1.5;">${inner}</p>
        </td>
      </tr>`
    })
    .join('')

  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /></head>
  <body style="margin:0;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
      <tr>
        <td style="background:#1a1a1a;padding:24px 32px;border-radius:8px 8px 0 0;">
          <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">${escapeHtml(opts.workspace)}</span>
        </td>
      </tr>
      <tr>
        <td style="background:#fff;padding:24px 32px 0;">
          <p style="margin:0;font-size:15px;color:#555;line-height:1.6;">
            ${escapeHtml(greeting)} ${waiting}
          </p>
        </td>
      </tr>
      <tr>
        <td style="background:#fff;padding:8px 32px 0;">
          <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td>
      </tr>
      ${
        // The product, not the workspace: the button opens Acta, and "Open
        // Nubisco" read as a link to the company's website.
        opts.appUrl
          ? `<tr>
        <td style="background:#fff;padding:24px 32px 32px;">
          <a href="${escapeHtml(opts.appUrl)}"
             style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;">
            Open Acta
          </a>
        </td>
      </tr>`
          : '<tr><td style="background:#fff;padding:0 32px 24px;"></td></tr>'
      }
      <tr>
        <td style="background:#f7f6f5;padding:16px 32px;border-radius:0 0 8px 8px;border-top:1px solid #e8e7e6;">
          <p style="margin:0;font-size:12px;color:#999;">
            You are getting this because these notifications were still unread.
            Change how long that takes, or turn it off, in Settings under Notifications.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`

  const text = [
    greeting,
    '',
    waiting.charAt(0).toUpperCase() + waiting.slice(1),
    '',
    ...lines.map(
      (l) => `${l.reason}: ${l.summary}${l.url ? `\n  ${l.url}` : ''}`,
    ),
    ...(opts.appUrl ? ['', `Open Acta: ${opts.appUrl}`] : []),
    '',
    'Change how long this takes, or turn it off, in Settings under Notifications.',
  ].join('\n')

  return { subject, html, text }
}
