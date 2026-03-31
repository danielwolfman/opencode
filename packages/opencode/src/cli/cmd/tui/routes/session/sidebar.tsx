import { useSync } from "@tui/context/sync"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { Installation } from "@/installation"
import { TuiPluginRuntime } from "../../plugin"
import { useCodexUsage } from "../../util/codex-usage"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const [usage] = useCodexUsage()

  const color = (value: number) => {
    if (value >= 90) return theme.error
    if (value >= 70) return theme.warning
    return theme.textMuted
  }

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <TuiPluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </TuiPluginRuntime.Slot>
            <Show when={(usage() ?? []).length > 0}>
              <box gap={0}>
                <text fg={theme.text}>
                  <b>Codex usage</b>
                </text>
                <For each={usage()}>
                  {(item) => (
                    <text fg={theme.textMuted} wrapMode="word">
                      <span>{item.id.replace("openai-profile-", "")}: </span>
                      <Show when={!item.error} fallback={<span>unavailable</span>}>
                        <span>
                          5h <span style={{ fg: color(item.primary) }}>{item.primary}%</span>
                          <span> · 7d </span>
                          <span style={{ fg: color(item.secondary ?? 0) }}>{item.secondary ?? 0}%</span>
                        </span>
                      </Show>
                    </text>
                  )}
                </For>
              </box>
            </Show>
            <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{Installation.VERSION}</span>
            </text>
          </TuiPluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
