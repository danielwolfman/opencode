export const OPENAI_PROFILE_PREFIX = "openai-profile-"

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export function toOpenAIProfileProviderID(value?: string) {
  const name = slug(value ?? "")
  if (!name || name === "default") return "openai"
  return `${OPENAI_PROFILE_PREFIX}${name}`
}

export function isOpenAIProfileProviderID(value: string) {
  return value.startsWith(OPENAI_PROFILE_PREFIX)
}

export function openAIProfileName(value: string) {
  if (!isOpenAIProfileProviderID(value)) return
  return value.slice(OPENAI_PROFILE_PREFIX.length)
}

export function openAIBaseProviderID(value: string) {
  if (isOpenAIProfileProviderID(value)) return "openai"
  return value
}
