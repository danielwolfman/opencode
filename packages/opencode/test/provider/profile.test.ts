import { expect, test } from "bun:test"
import {
  isOpenAIProfileProviderID,
  openAIBaseProviderID,
  openAIProfileName,
  toOpenAIProfileProviderID,
} from "../../src/provider/profile"

test("toOpenAIProfileProviderID maps default profile to openai", () => {
  expect(toOpenAIProfileProviderID()).toBe("openai")
  expect(toOpenAIProfileProviderID("default")).toBe("openai")
})

test("toOpenAIProfileProviderID normalizes profile names", () => {
  expect(toOpenAIProfileProviderID("Account 1")).toBe("openai-profile-account-1")
  expect(toOpenAIProfileProviderID("  account_2  ")).toBe("openai-profile-account-2")
})

test("openai profile helper functions parse profile ids", () => {
  expect(isOpenAIProfileProviderID("openai-profile-account1")).toBe(true)
  expect(isOpenAIProfileProviderID("openai")).toBe(false)
  expect(openAIProfileName("openai-profile-account1")).toBe("account1")
  expect(openAIProfileName("openai")).toBeUndefined()
  expect(openAIBaseProviderID("openai-profile-account1")).toBe("openai")
  expect(openAIBaseProviderID("anthropic")).toBe("anthropic")
})
