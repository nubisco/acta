/**
 * The browser's platform accounts, for the account menu.
 *
 * The platform keeps every account signed in on this browser in its own
 * session, and lists them at `/api/auth/identities`. That is a credentialed
 * cross-origin call, allowed because Acta's origin is in the platform's
 * ACCOUNT_MENU_ORIGINS, which covers only those two routes. Whenever the call
 * fails, `accountsUnknown` is set and NbUserMenu shows a single "Switch
 * account" that lets the platform ask instead. Locally it always fails, with
 * a CORS error, because only the deployed origins are allowed.
 *
 * Switching is always a fresh sign-in through Acta's own /auth/sso/start,
 * with a login hint or a prompt. That is the only thing that re-issues Acta's
 * session for the other person: the platform's session alone does not change
 * who Acta thinks is signed in.
 *
 * Follows prelo/web/src/stores/accounts.ts, which cms and verba share.
 */

import { ref } from 'vue'
import type { IUserMenuAccount } from '@nubisco/ui'
import { auth } from '@/api/client'
import type { IMe } from '@/stores/workspace'

interface IPlatformIdentity {
  sub: string
  email: string
  name?: string | null
}

const accounts = ref<IUserMenuAccount[]>([])
const accountsUnknown = ref(true)

function isCurrent(identity: IPlatformIdentity, me: IMe | null): boolean {
  // By platform id when this session has one. Email is the fallback for a
  // person provisioned before the id was bound, and is the weaker test: an
  // address can be changed on the platform.
  if (me?.platform_user_id) return identity.sub === me.platform_user_id
  return identity.email.toLowerCase() === me?.email?.toLowerCase()
}

function returnPath(): string {
  return `${location.pathname}${location.search}`
}

export function useAccounts() {
  async function load(platformUrl: string | null, me: IMe | null) {
    if (!platformUrl) {
      accounts.value = []
      accountsUnknown.value = true
      return
    }
    try {
      const res = await fetch(new URL('/api/auth/identities', platformUrl), {
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`identities: ${res.status}`)
      const data = (await res.json()) as { identities?: IPlatformIdentity[] }
      accounts.value = (data.identities ?? []).map((identity) => ({
        id: identity.sub,
        email: identity.email,
        name: identity.name ?? undefined,
        current: isCurrent(identity, me),
        removable: !isCurrent(identity, me),
      }))
      accountsUnknown.value = false
    } catch {
      accounts.value = []
      accountsUnknown.value = true
    }
  }

  function switchTo(account: IUserMenuAccount): void {
    location.assign(auth.signInUrl(returnPath(), { loginHint: account.email }))
  }

  function chooseAccount(): void {
    location.assign(auth.signInUrl(returnPath(), { prompt: 'select_account' }))
  }

  function addAccount(): void {
    location.assign(auth.signInUrl(returnPath(), { prompt: 'login' }))
  }

  async function remove(
    account: IUserMenuAccount,
    platformUrl: string | null,
    me: IMe | null,
  ): Promise<void> {
    if (!platformUrl) return
    await fetch(new URL('/api/auth/identities/remove', platformUrl), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: account.id }),
    }).catch(() => undefined)
    await load(platformUrl, me)
  }

  return {
    accounts,
    accountsUnknown,
    load,
    switchTo,
    chooseAccount,
    addAccount,
    remove,
  }
}
