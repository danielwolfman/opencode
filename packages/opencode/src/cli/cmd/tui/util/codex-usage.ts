import { Auth } from "@/auth"
import { createResource, onCleanup } from "solid-js"

const endpoint = "https://chatgpt.com/backend-api/wham/usage"
const interval = 30_000

interface Window {
  used_percent: number
}

interface Limit {
  primary_window: Window
  secondary_window: Window | null
}

interface Payload {
  rate_limit: Limit
}

export interface CodexUsage {
  id: string
  primary: number
  secondary: number | null
  error?: string
}

export async function loadCodexUsage() {
  const auth = await Auth.all()
  const list = Object.entries(auth).flatMap(([id, value]) => {
    if (value.type !== "oauth") return []
    if (!id.startsWith("openai-profile-") && id !== "openai") return []
    if (!value.access || !value.accountId) return []
    return [[id, value] as const]
  })

  const usage = await Promise.all(
    list.map(async ([id, value]) => {
      const response = await fetch(endpoint, {
        headers: {
          accept: "*/*",
          authorization: `Bearer ${value.access}`,
          "chatgpt-account-id": value.accountId ?? "",
          "oai-language": "en-US",
          referer: "https://chatgpt.com/codex/settings/usage",
          "user-agent": "opencode-codex-usage/1.0",
        },
      }).catch(() => undefined)

      if (!response || !response.ok) {
        return {
          id,
          primary: 0,
          secondary: null,
          error: "unavailable",
        } satisfies CodexUsage
      }

      const data = (await response.json()) as Payload
      return {
        id,
        primary: data.rate_limit.primary_window.used_percent,
        secondary: data.rate_limit.secondary_window?.used_percent ?? null,
      } satisfies CodexUsage
    }),
  )

  return usage.toSorted((a, b) => a.id.localeCompare(b.id))
}

export function useCodexUsage() {
  const [usage, controls] = createResource(loadCodexUsage)
  const timer = setInterval(() => void controls.refetch(), interval)
  timer.unref?.()
  onCleanup(() => clearInterval(timer))
  return [usage, controls] as const
}
