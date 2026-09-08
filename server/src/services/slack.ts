/**
 * Slack rendering for outbound webhooks.
 *
 * Slack Incoming Webhooks accept `{text, blocks}` and reject anything else
 * with a 400, so Acta's own event envelope cannot be posted to one directly.
 * Rather than build a second delivery pipeline, a webhook carries a `format`
 * and this module supplies the body; retries, the delivery log and
 * auto-disable are unchanged.
 *
 * The wording comes from the event's own `summary`, which is already written
 * for a human ("moved MIG-3 to Review"). A per-verb phrasing table here would
 * be a second copy of that sentence, silently drifting from the first every
 * time a verb is added.
 */

import type { IEvent } from '../core/events'

export interface ISlackContext {
  /** Display name of whoever caused the event. */
  actorName?: string
  /** Card key, when the event is about an item, used for the deep link. */
  itemKey?: string
  /** Acta's own address, so the key can link back. Omit when unknown. */
  baseUrl?: string
}

/** Slack mrkdwn reserves these three; everything else is literal. */
function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function slackPayload(
  event: IEvent,
  context: ISlackContext = {},
): Record<string, unknown> {
  const who = context.actorName ?? 'Acta'
  const plain = `${who} ${event.summary}`

  // The summary already names the card. Turning that first mention into a
  // link keeps the sentence intact instead of appending a bare URL.
  let rich = escape(event.summary)
  if (context.itemKey && context.baseUrl) {
    const href = `${context.baseUrl.replace(/\/$/, '')}/?item=${encodeURIComponent(context.itemKey)}`
    rich = rich.replace(
      escape(context.itemKey),
      `<${href}|${escape(context.itemKey)}>`,
    )
  }

  const blocks: Record<string, unknown>[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${escape(who)}* ${rich}` },
    },
  ]

  const details: string[] = []
  if (event.actor_kind === 'agent') details.push('via an agent')
  if (event.caused_by) details.push('by a rule')
  if (details.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: details.join('  ·  ') }],
    })
  }

  // `text` is mandatory even alongside blocks: it is what Slack puts in the
  // notification preview and in clients that cannot render blocks. Omitting
  // it produces a notification that arrives empty.
  return { text: plain, blocks }
}
