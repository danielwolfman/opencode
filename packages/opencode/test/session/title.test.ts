import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Command } from "../../src/command"
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
        })

        expect(await Session.shouldAutoTitle({ sessionID: auto.id, title: auto.title })).toBe(true)

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
})
