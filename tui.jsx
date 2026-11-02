/** @jsxImportSource @opentui/solid */
import { Show, createSignal } from "solid-js"
import {
  CONFIG_PATH,
  formatCompact,
  loadSnapshot,
  readJson,
  resolveModelEntry,
} from "./core.mjs"

function currentModel(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue

    if (message.role === "assistant" && message.modelID) {
      return {
        id: message.modelID,
        providerID: message.providerID,
        api: { id: message.modelID },
      }
    }

    if (message.role === "user" && message.model?.modelID) {
      return {
        id: message.model.modelID,
        providerID: message.model.providerID,
        api: { id: message.model.modelID },
      }
    }
  }

  return null
}

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
      session_prompt_right(ctx) {
        const visible = () => {
          snapshot()
          const model = currentModel(api.state.session.messages(ctx.session_id))
          if (!model) return false
          return Boolean(resolveModelEntry(model, readJson(CONFIG_PATH, null)))
        }

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
