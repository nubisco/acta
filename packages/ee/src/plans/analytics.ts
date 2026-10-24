// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * Billing events for Nubisco Analytics, sent from the server when an
 * entitlement changes, so they are counted even when nobody has the page open
 * (a trial converting at night). Nothing personal is sent: the visitor is the
 * workspace id.
 */

import { LIST_PRICE_USD } from './catalogue'
import type { IPlansConfig } from './config'
import type { IEntitlement } from './client'
import type { IPlanRow } from './store'

interface IBillingEvent {
  name: 'Trial Started' | 'Purchase' | 'Subscription Cancelled'
  props: Record<string, string | number>
  revenue?: { amount: string; currency: 'USD' }
}

/** Which events a change from `before` to `after` stands for. */
export function billingEvents(
  before: IPlanRow | null,
  after: IEntitlement,
): IBillingEvent[] {
  const events: IBillingEvent[] = []
  const sub = after.subscription
  const wasPaid = before?.state === 'active' && before.source === 'subscription'
  const wasTrial = before?.state === 'trialing'
  const billing = sub?.billing ?? 'monthly'
  const props = {
    plan: after.plan,
    billing,
    extra_members: sub?.extra_members ?? 0,
  }
  if (
    after.source === 'subscription' &&
    after.state === 'trialing' &&
    !wasTrial
  )
    events.push({ name: 'Trial Started', props })
  if (after.source === 'subscription' && after.state === 'active' && !wasPaid) {
    const price = LIST_PRICE_USD[billing]
    const amount = price.base + price.member * (sub?.extra_members ?? 0)
    events.push({
      name: 'Purchase',
      props,
      revenue: { amount: amount.toFixed(2), currency: 'USD' },
    })
  }
  const endsNow = Boolean(sub?.ends_at)
  const endedBefore = Boolean(before?.subscription?.ends_at)
  const fellToFree =
    after.plan === 'free' && before !== null && before.plan !== 'free'
  if ((endsNow && !endedBefore) || (fellToFree && !endedBefore))
    events.push({ name: 'Subscription Cancelled', props })
  return events
}

export async function sendBillingEvents(
  cfg: IPlansConfig,
  workspaceId: string,
  events: IBillingEvent[],
): Promise<void> {
  const a = cfg.analytics
  if (!a || events.length === 0) return
  try {
    await cfg.fetchImpl(`${a.url}/api/v1/events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${a.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        events.map((e) => ({
          domain: a.domain,
          url: `https://${a.domain}/settings/billing`,
          visitorId: workspaceId,
          eventType: 'custom',
          eventName: e.name,
          props: e.props,
          ...(e.revenue ? { revenue: e.revenue } : {}),
        })),
      ),
      signal: AbortSignal.timeout(5_000),
    })
  } catch (err) {
    // Analytics never fails a billing change.
    console.error('plans: analytics event not sent', err)
  }
}
