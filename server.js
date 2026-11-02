import {
  CONFIG_PATH,
  LEDGER_PATH,
  readJson,
  writeJson,
  resolveModelEntry,
  calculateCost,
  checkLimits,
  retentionMs,
} from "./core.mjs"

const PLUGIN_ID = "venice-rate-limiter"

async function createHooks() {
  const messageModels = new Map()
  const recordedParts = new Set()

  function rememberMessage(info) {
    if (!info || info.role !== "assistant" || !info.id) return
    messageModels.set(info.id, {
      id: info.modelID,
      providerID: info.providerID,
      api: { id: info.modelID },
    })
    if (messageModels.size > 5000) {
      const oldest = messageModels.keys().next().value
      if (oldest !== undefined) messageModels.delete(oldest)
    }
  }

  function recordStep(part) {
    if (!part || part.type !== "step-finish" || !part.id) return
    if (recordedParts.has(part.id)) return

    const model = messageModels.get(part.messageID)
    if (!model) return

    const config = readJson(CONFIG_PATH, null)
    if (!config) return

    const resolved = resolveModelEntry(model, config)
    if (!resolved) return

    const ledger = readJson(LEDGER_PATH, [])
    const history = Array.isArray(ledger) ? ledger : []

    if (history.some((entry) => entry && entry.partID === part.id)) {
      recordedParts.add(part.id)
      return
    }

    const tokens = part.tokens || {}
    const cost = calculateCost(tokens, resolved.model.pricing, part.cost)
    const cutoff = Date.now() - retentionMs(config)

    history.push({
      timestamp: Date.now(),
      pool: resolved.poolId,
      model: resolved.modelId,
      partID: part.id,
      tokens: {
        input: Number(tokens.input) || 0,
        output: Number(tokens.output) || 0,
        reasoning: Number(tokens.reasoning) || 0,
        cache: {
          read: Number(tokens.cache?.read) || 0,
          write: Number(tokens.cache?.write) || 0,
        },
      },
      cost,
    })

    writeJson(
      LEDGER_PATH,
      history.filter((entry) => entry && Number(entry.timestamp) > cutoff),
    )

    recordedParts.add(part.id)
    if (recordedParts.size > 5000) {
      const oldest = recordedParts.values().next().value
      if (oldest !== undefined) recordedParts.delete(oldest)
    }
  }

  return {
    "chat.params": async (input) => {
      const config = readJson(CONFIG_PATH, null)
      if (!config) return
      const ledger = readJson(LEDGER_PATH, [])
      checkLimits(input.model, config, Array.isArray(ledger) ? ledger : [])
    },

    event: async ({ event }) => {
      if (!event || !event.type) return

      if (event.type === "message.updated") {
        rememberMessage(event.properties?.info)
        return
      }

      if (event.type === "message.part.updated") {
        recordStep(event.properties?.part)
      }
    },
  }
}

export default {
  id: PLUGIN_ID,
  server: createHooks,
}
