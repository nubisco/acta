# Plans and billing

Nubisco's hosted Acta has two self-serve plans, Free and Team, and deals
negotiated with sales. This is the Enterprise Edition's plans module
(`packages/ee/src/plans`). A self-hosted build has none of it: no limits, no
billing page.

## The plans

|                        | Free    | Team                                                              |
| ---------------------- | ------- | ----------------------------------------------------------------- |
| Spaces                 | 3       | 20                                                                |
| Members                | 5       | 10 included, extra ones up to 50 in all                           |
| Storage                | 1 GB    | 50 GB                                                             |
| File size              | 10 MB   | 25 MB                                                             |
| Agents and connections | 2       | 20                                                                |
| Rules                  | 10      | 100                                                               |
| Webhooks               | 3       | 25                                                                |
| History                | 90 days | 1 year                                                            |
| Cards                  | 50,000  | 50,000                                                            |
| Price, ex VAT          | free    | $39 a month or $390 a year, extra member $4 a month or $40 a year |

Every feature is on both plans. Team only raises the limits.

## Where the limits come from

- Spaces, members and storage are sold through Paddle, so they come from the
  licenses service in the workspace's entitlement. Acta keeps a copy in
  `workspace_plan`. A signed `entitlement.updated` webhook keeps it current,
  a missing or day-old copy is fetched on use, and the billing page fetches on
  open. A newer version always wins. A network error keeps the copy held, and
  a workspace licenses has never seen is Free.
- Everything else (file size, agents, rules, webhooks, history, the cards
  cap) is in `plan_limit`, so it changes without touching Paddle.

## What happens at a limit

- Creating past a cap is refused with `402 plan_limit {resource, limit,
current}`. A batch op carries the same in its result, and an MCP tool call
  that hit a cap returns `isError: true` with the reason. The app opens one
  upgrade prompt for any of these.
- On Team, the 11th member onwards is bought automatically when someone
  accepts an invitation or is enabled again, billed at the next renewal (no
  charge of its own). During the 14-day trial Paddle only lets an existing
  extra-member line change, so the first extra member waits for the trial to
  end or is chosen at checkout.
- A downgrade deletes nothing. The oldest spaces up to the cap stay writable
  and the rest read-only, until an admin archives some. Over the member cap,
  the people an admin marks under People keep write access, then admins, then
  the earliest to join. The rest can read.

## Deploying

1. Give any workspace that must not fall to Free an override in licenses first
   (`POST /v1/admin/billing/overrides`), Nubisco's own included. Otherwise it
   is held to Free the moment plans switch on.
2. In licenses, set `ENTITLEMENT_WEBHOOK_URL_ACTA` to
   `https://<acta host>/api/v1/billing/entitlement`.
3. In Acta, set the secrets `ACTA_LICENSES_SERVICE_TOKEN` and
   `ACTA_ENTITLEMENT_WEBHOOK_SECRET` (see [Configuration](/developers/configuration#plans-and-billing-enterprise-edition)).
