/** @jsxImportSource @opentui/solid */
import { Show, createMemo, createSignal } from "solid-js"
import {
  CONFIG_PATH,
  currentModel,
  formatCompact,
  loadSnapshot,
  readJson,
  resolveModelEntry,
} from "./core.mjs"

const tui = async (api) => {
  const [snapshot, setSnapshot] = createSignal(loadSnapshot())
  const refresh = () => setSnapshot(loadSnapshot())

  const timer = setInterval(refresh, 5000)
  const unsubscribe = api.event.on("message.updated", refresh)

  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    unsubscribe()
  })

  const label = () => formatCompact(snapshot())

  api.slots.register({
    order: 100,
    slots: {
      session_prompt_right(ctx, props) {
        const messages = createMemo(() => api.state.session.messages(props.session_id))
        const visible = createMemo(() => {
          snapshot()
          const model = currentModel(messages())
          if (!model) return false
          return Boolean(resolveModelEntry(model, readJson(CONFIG_PATH, null)))
        })

        return (
          <Show when={visible()}>
            <text fg={ctx.theme.current.textMuted}>{label()}</text>
          </Show>
        )
      },
    },
  })
}

export default {
  id: "venice-rate-limiter",
  tui,
}
