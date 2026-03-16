import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

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

  test("summarize command queues session compaction", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const cmds = await Command.list()

        expect(cmds.some((cmd) => cmd.name === Command.Default.SUMMARIZE)).toBe(true)

        const msg = await SessionPrompt.command({
          sessionID: session.id,
          command: Command.Default.SUMMARIZE,
          arguments: "",
          model: "opencode/kimi-k2.5-free",
        })

        expect(msg.info.role).toBe("user")
        expect(msg.parts).toHaveLength(1)
        expect(msg.parts[0]?.type).toBe("compaction")
        if (msg.parts[0]?.type !== "compaction") throw new Error("expected compaction part")
        expect(msg.parts[0].auto).toBe(false)

        await Session.remove(session.id)
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

  test("builds title context from summary plus recent turns", () => {
    const sid = SessionID.make("ses_test")
    const mk = (id: string, role: "user" | "assistant", text: string, opts?: { summary?: boolean }) =>
      ({
        info: {
          id: MessageID.make(id),
          sessionID: sid,
          role,
          time: { created: 0 },
          ...(opts?.summary ? { summary: true, finish: "stop" } : {}),
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
      mk("msg_3", "assistant", "Conversation moved from weather to basketball and now to the Olympics.", {
        summary: true,
      }),
      mk("msg_4", "user", "tell me about olympics"),
    ])

    expect(text).toContain("Overall conversation summary:")
    expect(text).toContain("Conversation moved from weather to basketball and now to the Olympics.")
    expect(text).toContain("Recent turns:")
    expect(text).toContain("user: tell me about olympics")
  })
})
