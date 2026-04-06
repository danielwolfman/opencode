import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Bus } from "../../src/bus"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "../../src/util/token"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { Plugin } from "../../src/plugin"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider/provider"
import * as ProviderModule from "../../src/provider/provider"
import * as SessionProcessorModule from "../../src/session/processor"

Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(() => {
  mock.restore()
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

async function user(sessionID: SessionID, text: string) {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
}

async function assistant(sessionID: SessionID, parentID: MessageID, root: string) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      output: 0,
      input: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  await Session.updateMessage(msg)
  return msg
}

async function tool(sessionID: SessionID, messageID: MessageID, tool: string, output: string) {
  return Session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool",
    callID: crypto.randomUUID(),
    tool,
    state: {
      status: "completed",
      input: {},
      output,
      title: "done",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  })
}

function fake(
  input: Parameters<(typeof SessionProcessorModule.SessionProcessor)["create"]>[0],
  result: "continue" | "compact",
) {
  const msg = input.assistantMessage
  return {
    get message() {
      return msg
    },
    abort: Effect.fn("TestSessionProcessor.abort")(() => Effect.void),
    partFromToolCall() {
      return {
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "tool",
        callID: "fake",
        tool: "fake",
        state: { status: "pending", input: {}, raw: "" },
      }
    },
    process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed(result)),
  } satisfies SessionProcessorModule.SessionProcessor.Handle
}

function mockProcessor(result: "continue" | "compact") {
  return spyOn(SessionProcessorModule.SessionProcessor, "create").mockImplementation(async (input) => {
    const msg = input.assistantMessage
    return {
      message: msg,
      partFromToolCall() {
        return undefined
      },
      async process() {
        return result
      },
    }
  })
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("session.compaction.isOverflow", () => {
  test("returns true when token count exceeds usable context", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("returns false when token count within usable context", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 200_000, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("includes cache.read in token count", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 60_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("respects input limit for input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("returns false when input/output are within input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        const tokens = { input: 200_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("returns false when output within limit with input caps", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
        const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  // ─── Bug reproduction tests ───────────────────────────────────────────
  // These tests demonstrate that when limit.input is set, isOverflow()
  // does not subtract any headroom for the next model response. This means
  // compaction only triggers AFTER we've already consumed the full input
  // budget, leaving zero room for the next API call's output tokens.
  //
  // Compare: without limit.input, usable = context - output (reserves space).
  // With limit.input, usable = limit.input (reserves nothing).
  //
  // Related issues: #10634, #8089, #11086, #12621
  // Open PRs: #6875, #12924

  test("BUG: no headroom when limit.input is set — compaction should trigger near boundary but does not", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Simulate Claude with prompt caching: input limit = 200K, output limit = 32K
        const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })

        // We've used 198K tokens total. Only 2K under the input limit.
        // On the next turn, the full conversation (198K) becomes input,
        // plus the model needs room to generate output — this WILL overflow.
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 180K + 3K + 15K = 198K
        // usable = limit.input = 200K (no output subtracted!)
        // 198K > 200K = false → no compaction triggered

        // WITHOUT limit.input: usable = 200K - 32K = 168K, and 198K > 168K = true ✓
        // WITH limit.input: usable = 200K, and 198K > 200K = false ✗

        // With 198K used and only 2K headroom, the next turn will overflow.
        // Compaction MUST trigger here.
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(true)
      },
    })
  })

  test("BUG: without limit.input, same token count correctly triggers compaction", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Same model but without limit.input — uses context - output instead
        const model = createModel({ context: 200_000, output: 32_000 })

        // Same token usage as above
        const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } }
        // count = 198K
        // usable = context - output = 200K - 32K = 168K
        // 198K > 168K = true → compaction correctly triggered

        const result = await SessionCompaction.isOverflow({ tokens, model })
        expect(result).toBe(true) // ← Correct: headroom is reserved
      },
    })
  })

  test("BUG: asymmetry — limit.input model allows 30K more usage before compaction than equivalent model without it", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Two models with identical context/output limits, differing only in limit.input
        const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
        const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })

        // 170K total tokens — well above context-output (168K) but below input limit (200K)
        const tokens = { input: 166_000, output: 10_000, reasoning: 0, cache: { read: 5_000, write: 0 } }

        const withLimit = await SessionCompaction.isOverflow({ tokens, model: withInputLimit })
        const withoutLimit = await SessionCompaction.isOverflow({ tokens, model: withoutInputLimit })

        // Both models have identical real capacity — they should agree:
        expect(withLimit).toBe(true) // should compact (170K leaves no room for 32K output)
        expect(withoutLimit).toBe(true) // correctly compacts (170K > 168K)
      },
    })
  })

  test("returns false when model context limit is 0", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 0, output: 32_000 })
        const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })

  test("returns false when compaction.auto is disabled", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            compaction: { auto: false },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = createModel({ context: 100_000, output: 32_000 })
        const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } }
        expect(await SessionCompaction.isOverflow({ tokens, model })).toBe(false)
      },
    })
  })
})

describe("session.compaction.create", () => {
  test("creates a compaction user message and part", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        await SessionCompaction.create({
          sessionID: session.id,
          agent: "build",
          model: ref,
          auto: true,
          overflow: true,
        })

        const msgs = await Session.messages({ sessionID: session.id })
        expect(msgs).toHaveLength(1)
        expect(msgs[0].info.role).toBe("user")
        expect(msgs[0].parts).toHaveLength(1)
        expect(msgs[0].parts[0]).toMatchObject({
          type: "compaction",
          auto: true,
          overflow: true,
        })
      },
    })
  })
})

describe("session.compaction.prune", () => {
  test("compacts old completed tool output", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const a = await user(session.id, "first")
        const b = await assistant(session.id, a.id, tmp.path)
        await tool(session.id, b.id, "bash", "x".repeat(200_000))
        await user(session.id, "second")
        await user(session.id, "third")

        await SessionCompaction.prune({ sessionID: session.id })

        const msgs = await Session.messages({ sessionID: session.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        expect(part?.type).toBe("tool")
        expect(part?.state.status).toBe("completed")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeNumber()
        }
      },
    })
  })

  test("skips protected skill tool output", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const a = await user(session.id, "first")
        const b = await assistant(session.id, a.id, tmp.path)
        await tool(session.id, b.id, "skill", "x".repeat(200_000))
        await user(session.id, "second")
        await user(session.id, "third")

        await SessionCompaction.prune({ sessionID: session.id })

        const msgs = await Session.messages({ sessionID: session.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        expect(part?.type).toBe("tool")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeUndefined()
        }
      },
    })
  })
})

describe("session.compaction.process", () => {
  test("publishes compacted event on continue", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const msgs = await Session.messages({ sessionID: session.id })
        const done = defer()
        let seen = false
        const create = mockProcessor("continue")
        const unsub = Bus.subscribe(SessionCompaction.Event.Compacted, (evt) => {
          if (evt.properties.sessionID !== session.id) return
          seen = true
          done.resolve()
        })
        try {
          const result = await SessionCompaction.process({
            parentID: msg.id,
            messages: msgs,
            sessionID: session.id,
            abort: new AbortController().signal,
            auto: false,
          })

          await Promise.race([
            done.promise,
            wait(500).then(() => {
              throw new Error("timed out waiting for compacted event")
            }),
          ])
          expect(result).toBe("continue")
          expect(seen).toBe(true)
        } finally {
          unsub()
          create.mockRestore()
        }
      },
    })
  })

  test("marks summary message as errored on compact result", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const create = mockProcessor("compact")
        try {
          const msgs = await Session.messages({ sessionID: session.id })
          const result = await SessionCompaction.process({
            parentID: msg.id,
            messages: msgs,
            sessionID: session.id,
            abort: new AbortController().signal,
            auto: false,
          })

          const summary = (await Session.messages({ sessionID: session.id })).find(
            (msg) => msg.info.role === "assistant" && msg.info.summary,
          )

          expect(result).toBe("stop")
          expect(summary?.info.role).toBe("assistant")
          if (summary?.info.role === "assistant") {
            expect(summary.info.finish).toBe("error")
            expect(JSON.stringify(summary.info.error)).toContain("Session too large to compact")
          }
        } finally {
          create.mockRestore()
        }
      },
    })
  })

  test("adds synthetic continue prompt when auto is enabled", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const create = mockProcessor("continue")
        try {
          const msgs = await Session.messages({ sessionID: session.id })
          const result = await SessionCompaction.process({
            parentID: msg.id,
            messages: msgs,
            sessionID: session.id,
            abort: new AbortController().signal,
            auto: true,
          })

          const all = await Session.messages({ sessionID: session.id })
          const last = all.at(-1)

          expect(result).toBe("continue")
          expect(last?.info.role).toBe("user")
          expect(last?.parts[0]).toMatchObject({
            type: "text",
            synthetic: true,
          })
          if (last?.parts[0]?.type === "text") {
            expect(last.parts[0].text).toContain("Continue if you have next steps")
          }
        } finally {
          create.mockRestore()
        }
      },
    })
  })

  test("folds the previous summary into the next compaction prompt", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        let seen: Parameters<SessionProcessorModule.SessionProcessor.Info["process"]>[0] | undefined
        const create = spyOn(SessionProcessorModule.SessionProcessor, "create").mockImplementation(async (input) => {
          const msg = input.assistantMessage
          return {
            message: msg,
            partFromToolCall() {
              return undefined
            },
            async process(value) {
              seen = value
              return "continue"
            },
          }
        })

        try {
          const session = await Session.create({})
          const old = await user(session.id, "very old unique directive")
          const sum = await Session.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            parentID: old.id,
            sessionID: session.id,
            mode: "compaction",
            agent: "compaction",
            summary: true,
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now() },
            finish: "end_turn",
          })
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: sum.id,
            sessionID: session.id,
            type: "text",
            text: "merged context from old phase",
          })
          const cur = await user(session.id, "recent unique request")
          const msgs = await Session.messages({ sessionID: session.id })

          const result = await SessionCompaction.process({
            parentID: cur.id,
            messages: msgs,
            sessionID: session.id,
            abort: new AbortController().signal,
            auto: false,
          })

          const text = JSON.stringify(seen?.messages ?? [])

          expect(result).toBe("continue")
          expect(create).toHaveBeenCalled()
          expect(text).toContain("merged context from old phase")
          expect(text).toContain("Earlier conversation summary")
          expect(text).toContain("recent unique request")
          expect(text).not.toContain("very old unique directive")
        } finally {
          create.mockRestore()
        }
      },
    })
  })

  test("replays the prior user turn on overflow when earlier context exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        await user(session.id, "root")
        const replay = await user(session.id, "image")
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: replay.id,
          sessionID: session.id,
          type: "file",
          mime: "image/png",
          filename: "cat.png",
          url: "https://example.com/cat.png",
        })
        const msg = await user(session.id, "current")
        const create = mockProcessor("continue")
        try {
          const msgs = await Session.messages({ sessionID: session.id })
          const result = await SessionCompaction.process({
            parentID: msg.id,
            messages: msgs,
            sessionID: session.id,
            abort: new AbortController().signal,
            auto: true,
            overflow: true,
          })

          const last = (await Session.messages({ sessionID: session.id })).at(-1)

          expect(result).toBe("continue")
          expect(last?.info.role).toBe("user")
          expect(last?.parts.some((part) => part.type === "file")).toBe(false)
          expect(
            last?.parts.some((part) => part.type === "text" && part.text.includes("Attached image/png: cat.png")),
          ).toBe(true)
        } finally {
          create.mockRestore()
        }
      },
    })
  })

  test("falls back to overflow guidance when no replayable turn exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        await user(session.id, "earlier")
        const msg = await user(session.id, "current")

        const create = mockProcessor("continue")
        try {
          const msgs = await Session.messages({ sessionID: session.id })
          const result = await SessionCompaction.process({
            parentID: msg.id,
            messages: msgs,
            sessionID: session.id,
            abort: new AbortController().signal,
            auto: true,
            overflow: true,
          })

          const last = (await Session.messages({ sessionID: session.id })).at(-1)

          expect(result).toBe("continue")
          expect(last?.info.role).toBe("user")
          if (last?.parts[0]?.type === "text") {
            expect(last.parts[0].text).toContain("previous request exceeded the provider's size limit")
          }
        } finally {
          create.mockRestore()
        }
      },
    })
  })

  test("stops quickly when aborted during retry backoff", async () => {
    const ready = defer()

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const msgs = await Session.messages({ sessionID: session.id })
        const abort = new AbortController()
        const create = spyOn(SessionProcessorModule.SessionProcessor, "create").mockImplementation(async (input) => ({
          message: input.assistantMessage,
          partFromToolCall() {
            return undefined
          },
          async process() {
            await SessionStatus.set(session.id, {
              type: "retry",
              attempt: 1,
              message: "boom",
              next: Date.now() + 10_000,
            })
            ready.resolve()
            await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }))
            input.assistantMessage.error = new MessageV2.AbortedError({ message: "aborted" }).toObject()
            return "continue"
          },
        }))
        let run: Promise<"continue" | "stop"> | undefined
        try {
          run = SessionCompaction.process({
            parentID: msg.id,
            messages: msgs,
            sessionID: session.id,
            abort: abort.signal,
            auto: false,
          })

          await Promise.race([
            ready.promise,
            wait(1000).then(() => {
              throw new Error("timed out waiting for retry status")
            }),
          ])

          const start = Date.now()
          abort.abort()
          const result = await Promise.race([
            run.then((value) => ({ kind: "done" as const, value, ms: Date.now() - start })),
            wait(250).then(() => ({ kind: "timeout" as const })),
          ])

          expect(result.kind).toBe("done")
          if (result.kind === "done") {
            expect(result.value).toBe("stop")
            expect(result.ms).toBeLessThan(250)
          }
        } finally {
          abort.abort()
          create.mockRestore()
          await run?.catch(() => undefined)
        }
      },
    })
  })

  test("does not leave a summary assistant when aborted before processor setup", async () => {
    const ready = defer()

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        spyOn(ProviderModule.Provider, "getModel").mockResolvedValue(createModel({ context: 100_000, output: 32_000 }))

        const session = await Session.create({})
        const msg = await user(session.id, "hello")
        const msgs = await Session.messages({ sessionID: session.id })
        const abort = new AbortController()
        const create = mockProcessor("continue")
        const trigger = spyOn(Plugin, "trigger").mockImplementation(async (name, _input, output) => {
          if (name !== "experimental.session.compacting") return output
          ready.resolve()
          await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }))
          return output
        })
        let run: Promise<"continue" | "stop"> | undefined
        try {
          run = SessionCompaction.process({
            parentID: msg.id,
            messages: msgs,
            sessionID: session.id,
            abort: abort.signal,
            auto: false,
          })

          await Promise.race([
            ready.promise,
            wait(1000).then(() => {
              throw new Error("timed out waiting for compaction hook")
            }),
          ])

          abort.abort()
          expect(await run).toBe("stop")

          const all = await Session.messages({ sessionID: session.id })
          expect(all.some((msg) => msg.info.role === "assistant" && msg.info.summary)).toBe(false)
        } finally {
          abort.abort()
          trigger.mockRestore()
          create.mockRestore()
          await run?.catch(() => undefined)
        }
      },
    })
  })
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("session.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      },
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("subtracts cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // AI SDK v6 normalizes inputTokens to include cached tokens for all providers
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("separates reasoning tokens from output tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        reasoningTokens: 100,
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(400)
    expect(result.tokens.reasoning).toBe(100)
    expect(result.tokens.total).toBe(1500)
  })

  test("does not double count reasoning tokens in cost", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 0,
        output: 15,
        cache: { read: 0, write: 0 },
      },
    })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 0,
        outputTokens: 1_000_000,
        totalTokens: 1_000_000,
        reasoningTokens: 250_000,
      },
    })

    expect(result.tokens.output).toBe(750_000)
    expect(result.tokens.reasoning).toBe(250_000)
    expect(result.cost).toBe(15)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
      },
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "computes total from components for %s models",
    (npm) => {
      const model = createModel({ context: 100_000, output: 32_000, npm })
      // AI SDK v6: inputTokens includes cached tokens for all providers
      const usage = {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      }
      if (npm === "@ai-sdk/amazon-bedrock") {
        const result = Session.getUsage({
          model,
          usage,
          metadata: {
            bedrock: {
              usage: {
                cacheWriteInputTokens: 300,
              },
            },
          },
        })

        // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
        expect(result.tokens.input).toBe(500)
        expect(result.tokens.cache.read).toBe(200)
        expect(result.tokens.cache.write).toBe(300)
        // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
        expect(result.tokens.total).toBe(1500)
        return
      }

      const result = Session.getUsage({
        model,
        usage,
        metadata: {
          anthropic: {
            cacheCreationInputTokens: 300,
          },
        },
      })

      // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
      expect(result.tokens.input).toBe(500)
      expect(result.tokens.cache.read).toBe(200)
      expect(result.tokens.cache.write).toBe(300)
      // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
      expect(result.tokens.total).toBe(1500)
    },
  )

  test("extracts cache write tokens from vertex metadata key", () => {
    const model = createModel({ context: 100_000, output: 32_000, npm: "@ai-sdk/google-vertex/anthropic" })
    const result = Session.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedInputTokens: 200,
      },
      metadata: {
        vertex: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.input).toBe(500)
    expect(result.tokens.cache.read).toBe(200)
    expect(result.tokens.cache.write).toBe(300)
  })
})
