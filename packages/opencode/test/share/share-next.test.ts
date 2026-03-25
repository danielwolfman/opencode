import { test, expect, mock } from "bun:test"
import { ShareNext } from "../../src/share/share-next"
import { AccessToken, Account, AccountID, OrgID } from "../../src/account"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Session } from "../../src/session"

test("ShareNext.request uses legacy share API without active org account", async () => {
  const originalActive = Account.active
  const originalConfigGet = Config.get

  Account.active = mock(async () => undefined)
  Config.get = mock(async () => ({ enterprise: { url: "https://legacy-share.example.com" } }))

  try {
    const req = await ShareNext.request()

    expect(req.api.create).toBe("/api/share")
    expect(req.api.sync("shr_123")).toBe("/api/share/shr_123/sync")
    expect(req.api.remove("shr_123")).toBe("/api/share/shr_123")
    expect(req.api.data("shr_123")).toBe("/api/share/shr_123/data")
    expect(req.baseUrl).toBe("https://legacy-share.example.com")
    expect(req.headers).toEqual({})
  } finally {
    Account.active = originalActive
    Config.get = originalConfigGet
  }
})

test("ShareNext.request uses org share API with auth headers when account is active", async () => {
  const originalActive = Account.active
  const originalToken = Account.token

  Account.active = mock(async () => ({
    id: AccountID.make("account-1"),
    email: "user@example.com",
    url: "https://control.example.com",
    active_org_id: OrgID.make("org-1"),
  }))
  Account.token = mock(async () => AccessToken.make("st_test_token"))

  try {
    const req = await ShareNext.request()

    expect(req.api.create).toBe("/api/shares")
    expect(req.api.sync("shr_123")).toBe("/api/shares/shr_123/sync")
    expect(req.api.remove("shr_123")).toBe("/api/shares/shr_123")
    expect(req.api.data("shr_123")).toBe("/api/shares/shr_123/data")
    expect(req.baseUrl).toBe("https://control.example.com")
    expect(req.headers).toEqual({
      authorization: "Bearer st_test_token",
      "x-org-id": "org-1",
    })
  } finally {
    Account.active = originalActive
    Account.token = originalToken
  }
})

test("ShareNext.request fails when org account has no token", async () => {
  const originalActive = Account.active
  const originalToken = Account.token

  Account.active = mock(async () => ({
    id: AccountID.make("account-1"),
    email: "user@example.com",
    url: "https://control.example.com",
    active_org_id: OrgID.make("org-1"),
  }))
  Account.token = mock(async () => undefined)

  try {
    await expect(ShareNext.request()).rejects.toThrow("No active account token available for sharing")
  } finally {
    Account.active = originalActive
    Account.token = originalToken
  }
})

test("ShareNext.init handles session.updated from event info", async () => {
  const originalSubscribe = Bus.subscribe
  const originalTimeout = globalThis.setTimeout
  const subs = new Map<string, (event: { properties: unknown }) => unknown>()

  Bus.subscribe = mock((def, cb) => {
    subs.set(def.type, cb as (event: { properties: unknown }) => unknown)
    return () => {}
  }) as typeof Bus.subscribe
  globalThis.setTimeout = mock(() => 0 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout

  try {
    await ShareNext.init()
    const sub = subs.get(Session.Event.Updated.type)

    expect(sub).toBeDefined()
    await expect(
      Promise.resolve(
        sub!({
          properties: {
            info: {
              id: "ses_1234567890abcdef1234567890",
            },
          },
        }),
      ),
    ).resolves.toBeUndefined()
  } finally {
    Bus.subscribe = originalSubscribe
    globalThis.setTimeout = originalTimeout
  }
})
