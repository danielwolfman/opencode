import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { tmpdir } from "../fixture/fixture"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

describe("session title management", () => {
  test("keeps auto-managed titles updating until manually renamed", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        expect(await Session.shouldAutoTitle({ sessionID: session.id, title: session.title })).toBe(true)

        const auto = await Session.setTitle({
          sessionID: session.id,
          title: "Auto title",
          auto: true,
          turn: 1,
        })

        expect(await Session.shouldAutoTitle({ sessionID: auto.id, title: auto.title })).toBe(true)
        expect(await Session.titleState(session.id)).toEqual({ auto: true, turn: 1 })

        const manual = await Session.setTitle({
          sessionID: session.id,
          title: "Manual title",
          auto: false,
        })

        expect(await Session.shouldAutoTitle({ sessionID: manual.id, title: manual.title })).toBe(false)

        await Session.remove(session.id)
      },
    })
  })

  test("registers summarize command", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cmds = await Command.list()
        expect(cmds.some((cmd) => cmd.name === Command.Default.SUMMARIZE)).toBe(true)
      },
    })
  })

  test("only refreshes titles every configured number of turns", () => {
    expect(SessionPrompt.titleDue({ turns: 1, interval: 10 })).toBe(true)
    expect(SessionPrompt.titleDue({ turns: 10, interval: 10, state: { turn: 1 } })).toBe(false)
    expect(SessionPrompt.titleDue({ turns: 11, interval: 10, state: { turn: 1 } })).toBe(true)
  })

  test("accepts title refresh interval in config", () => {
    const parsed = Config.Info.parse({
      title: {
        interval: 7,
      },
    })

    expect(parsed.title?.interval).toBe(7)
  })

  test("uses whole short conversation for title context", () => {
    const sid = SessionID.make("ses_test")
    const mk = (id: string, role: "user" | "assistant", text: string) =>
      ({
        info: {
          id: MessageID.make(id),
          sessionID: sid,
          role,
          time: { created: 0 },
        },
        parts: [
          {
            id: PartID.make(`prt_${id}`),
            messageID: MessageID.make(id),
            sessionID: sid,
            type: "text",
            text,
            time: { start: 0, end: 0 },
          },
        ],
      }) as MessageV2.WithParts

    const text = SessionPrompt.titleText([
      mk("msg_1", "user", "hello"),
      mk("msg_2", "assistant", "Greeting"),
      mk("msg_3", "user", "lets talk about weather"),
      mk("msg_4", "assistant", "Weather can be sunny or rainy"),
      mk("msg_5", "user", "tell me about basketball teams"),
      mk("msg_6", "assistant", "Basketball teams play indoors"),
      mk("msg_7", "user", "tell me about olympics"),
      mk("msg_8", "assistant", "The Olympics are a major sports event"),
    ])

    expect(text).toContain("user: lets talk about weather")
    expect(text).toContain("user: tell me about basketball teams")
    expect(text).toContain("user: tell me about olympics")
  })
})
