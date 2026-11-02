import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
  : path.join(os.homedir(), ".config", "opencode")

export const CONFIG_PATH =
  process.env.OPENCODE_RATE_LIMITS_CONFIG || path.join(PACKAGE_DIR, "config.json")
export const LEDGER_PATH =
  process.env.OPENCODE_RATE_LIMITS_LEDGER || path.join(CONFIG_DIR, "token_ledger.json")

export function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    const raw = fs.readFileSync(file, "utf8").trim()
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
    fs.renameSync(tmp, file)
  } catch {
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
    } catch {}
    try {
      fs.unlinkSync(tmp)
    } catch {}
  }
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

function modelNames(model) {
  const names = []
  const add = (value) => {
    if (value) names.push(String(value))
  }
  add(model?.id)
  add(model?.api?.id)
  if (model?.providerID && model?.id) add(`${model.providerID}/${model.id}`)
  if (model?.providerID && model?.api?.id) add(`${model.providerID}/${model.api.id}`)
  return [...new Set(names)]
}

function poolModels(pool) {
  return pool?.models && typeof pool.models === "object" ? pool.models : {}
}

function poolName(pool) {
  if (typeof pool?.name === "string" && pool.name.trim()) return pool.name.trim()
  const id = String(pool?.id ?? "pool")
  return id.charAt(0).toUpperCase() + id.slice(1)
}

export function getPools(config) {
  if (config?.pools && typeof config.pools === "object") {
    return Object.entries(config.pools)
      .filter(([, value]) => value && typeof value === "object")
      .map(([id, value]) => ({ id, ...value }))
  }

  if (config?.models && typeof config.models === "object") {
    return Object.entries(config.models)
      .filter(([, value]) => value && typeof value === "object")
      .map(([id, value]) => ({
        id,
        budget_usd: value.budget_usd ?? value.budget,
        models: { [id]: value },
      }))
  }

  return []
}

export function resolveModelEntry(model, config) {
  const candidates = modelNames(model).map(normalize).filter(Boolean)
  if (candidates.length === 0) return null

  const entries = []
  for (const pool of getPools(config)) {
    for (const [modelId, modelConfig] of Object.entries(poolModels(pool))) {
      if (!modelConfig || typeof modelConfig !== "object") continue
      const names = [modelId, ...(Array.isArray(modelConfig.aliases) ? modelConfig.aliases : [])]
        .map(normalize)
        .filter(Boolean)
      entries.push({ pool, modelId, modelConfig, names })
    }
  }

  for (const entry of entries) {
    if (entry.names.some((name) => candidates.includes(name))) {
      return {
        poolId: entry.pool.id,
        pool: entry.pool,
        modelId: entry.modelId,
        model: entry.modelConfig,
      }
    }
  }

  const ordered = entries.slice().sort((a, b) => {
    const aMax = Math.max(...a.names.map((name) => name.length), 0)
    const bMax = Math.max(...b.names.map((name) => name.length), 0)
    return bMax - aMax
  })

  for (const entry of ordered) {
    for (const name of entry.names) {
      if (name.length < 3) continue
      if (candidates.some((candidate) => candidate.includes(name) || name.includes(candidate))) {
        return {
          poolId: entry.pool.id,
          pool: entry.pool,
          modelId: entry.modelId,
          model: entry.modelConfig,
        }
      }
    }
  }

  return null
}

export function currentModel(messages) {
  if (!Array.isArray(messages)) return null

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

export function calculateCost(tokens, pricing, fallback) {
  const fallbackCost = Number(fallback) || 0
  if (!pricing || typeof pricing !== "object") return fallbackCost

  const inputRate = numberOrNull(pricing.input)
  const outputRate = numberOrNull(pricing.output)
  if (inputRate === null || outputRate === null) return fallbackCost

  const cachedRate = numberOrNull(pricing.cached ?? pricing.cache_read ?? pricing.cacheRead) ?? inputRate
  const cacheWriteRate =
    numberOrNull(pricing.cached_write ?? pricing.cache_write ?? pricing.cacheWrite) ?? cachedRate

  const input = Number(tokens?.input) || 0
  const output = Number(tokens?.output) || 0
  const reasoning = Number(tokens?.reasoning) || 0
  const cacheRead = Number(tokens?.cache?.read) || 0
  const cacheWrite = Number(tokens?.cache?.write) || 0

  return (
    (input * inputRate +
      cacheRead * cachedRate +
      cacheWrite * cacheWriteRate +
      (output + reasoning) * outputRate) /
    1_000_000
  )
}

export function windowDefinition(poolConfig, windowConfig) {
  const budget = numberOrNull(poolConfig?.budget_usd ?? poolConfig?.budget)
  const ratio = numberOrNull(windowConfig?.ratio)
  const ms = numberOrNull(windowConfig?.ms)
  if (budget === null || budget <= 0) return null
  if (ratio === null || ratio <= 0) return null
  if (ms === null || ms <= 0) return null
  return { budget, ratio, ms, cap: budget * ratio }
}

export function entriesInWindow(history, ms, now) {
  return history
    .filter((entry) => {
      const timestamp = Number(entry?.timestamp)
      return Number.isFinite(timestamp) && now - timestamp <= ms
    })
    .map((entry) => ({
      timestamp: Number(entry.timestamp),
      cost: Number(entry.cost) || 0,
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

export function resetAt(entries, ms, cap) {
  let total = entries.reduce((sum, entry) => sum + entry.cost, 0)
  if (total < cap) return null
  for (const entry of entries) {
    total -= entry.cost
    if (total < cap) return entry.timestamp + ms
  }
  return null
}

export function entryBelongsToPool(entry, pool) {
  if (!entry || typeof entry !== "object") return false
  if (entry.pool) return entry.pool === pool.id
  if (!entry.model) return false

  const target = normalize(entry.model)
  return Object.keys(poolModels(pool)).some((modelId) => normalize(modelId) === target)
}

export function checkLimits(model, config, ledger) {
  const resolved = resolveModelEntry(model, config)
  if (!resolved) return

  const windows = config?.windows
  if (!windows || typeof windows !== "object") return

  const now = Date.now()
  const history = ledger.filter((entry) => entryBelongsToPool(entry, resolved.pool))

  for (const [name, windowConfig] of Object.entries(windows)) {
    const definition = windowDefinition(resolved.pool, windowConfig)
    if (!definition) continue

    const entries = entriesInWindow(history, definition.ms, now)
    const spent = entries.reduce((sum, entry) => sum + entry.cost, 0)
    if (spent < definition.cap) continue

    const reset = resetAt(entries, definition.ms, definition.cap)
    const resetText = reset ? ` Window reopens around ${new Date(reset).toISOString()}.` : ""
    const percent = (definition.ratio * 100).toFixed(0)
    const label = poolName(resolved.pool)

    throw new Error(
      `[RATE-LIMIT BLOCKED] Pool ${label} reached the ${name} window. ` +
        `Model ${resolved.modelId} is blocked. ` +
        `Spent $${spent.toFixed(4)} / allowed $${definition.cap.toFixed(4)} ` +
        `(${percent}% of $${definition.budget.toFixed(2)}).${resetText}`,
    )
  }
}

export function retentionMs(config) {
  const windows = Object.values(config?.windows || {})
    .map((windowConfig) => numberOrNull(windowConfig?.ms) || 0)
    .filter((ms) => ms > 0)
  return Math.max(...windows, 31 * 24 * 60 * 60 * 1000)
}

export function loadSnapshot(now = Date.now()) {
  const config = readJson(CONFIG_PATH, null)
  const ledger = readJson(LEDGER_PATH, [])
  const snapshot = {
    generatedAt: now,
    configPath: CONFIG_PATH,
    ledgerPath: LEDGER_PATH,
    pools: [],
  }

  if (!config || typeof config !== "object") return snapshot

  const windows = config.windows && typeof config.windows === "object" ? config.windows : {}
  const entries = Array.isArray(ledger) ? ledger : []

  for (const pool of getPools(config)) {
    const budget = numberOrNull(pool.budget_usd ?? pool.budget)
    if (budget === null || budget <= 0) continue

    const models = Object.keys(poolModels(pool))
    const history = entries.filter((entry) => entryBelongsToPool(entry, pool))
    const rows = []

    for (const [windowName, windowConfig] of Object.entries(windows)) {
      if (!windowConfig || typeof windowConfig !== "object") continue

      const ms = numberOrNull(windowConfig.ms)
      const ratio = numberOrNull(windowConfig.ratio)
      if (ms === null || ms <= 0 || ratio === null || ratio <= 0) continue

      const cap = budget * ratio
      const active = entriesInWindow(history, ms, now)
      const spent = active.reduce((sum, entry) => sum + entry.cost, 0)
      const percent = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0
      const reset = resetAt(active, ms, cap)

      rows.push({
        name: windowName,
        ms,
        ratio,
        cap,
        spent,
        remaining: Math.max(0, cap - spent),
        percent,
        resetAt: reset,
      })
    }

    snapshot.pools.push({
      id: pool.id,
      name: poolName(pool),
      budget,
      models,
      windows: rows,
    })
  }

  return snapshot
}

export function formatCompact(snapshot) {
  const pools = snapshot?.pools ?? []
  const all = pools.flatMap((pool) => pool.windows.map((window) => ({ pool, window })))
  if (all.length === 0) return "No limits configured"

  const worst = all.reduce((a, b) => (b.window.percent > a.window.percent ? b : a))
  const primary = worst.pool
  const windows = primary.windows
  const fiveHour = windows.find((window) => window.name === "5h") ?? windows[0]
  const monthly = windows.find((window) => window.name === "30d") ?? windows[windows.length - 1]

  const parts = []
  if (fiveHour) parts.push(`${fiveHour.name} ${fiveHour.percent.toFixed(0)}%`)
  if (monthly && monthly !== fiveHour) parts.push(`${monthly.name} ${monthly.percent.toFixed(0)}%`)

  const spent = monthly ? monthly.spent : fiveHour ? fiveHour.spent : 0
  return `${primary.name} ${parts.join(" · ")} ($${spent.toFixed(4)}/$${primary.budget.toFixed(2)})`
}

export function formatTable(snapshot) {
  const rows = []
  for (const pool of snapshot?.pools ?? []) {
    for (const window of pool.windows) {
      rows.push({
        pool: pool.name,
        models: String(pool.models.length),
        window: window.name,
        cap: `$${window.cap.toFixed(2)}`,
        spent: `$${window.spent.toFixed(4)}`,
        used: `${window.percent.toFixed(1)}%`,
        reset: window.resetAt
          ? new Date(window.resetAt).toISOString().replace("T", " ").slice(0, 19)
          : "-",
      })
    }
  }

  if (rows.length === 0) return "No rate-limit pools configured."

  const headers = {
    pool: "Pool",
    models: "Models",
    window: "Window",
    cap: "Cap",
    spent: "Spent",
    used: "Used",
    reset: "Next reset (UTC)",
  }
  const columns = ["pool", "models", "window", "cap", "spent", "used", "reset"]
  const widths = {}
  for (const column of columns) {
    widths[column] = Math.max(headers[column].length, ...rows.map((row) => String(row[column]).length))
  }

  const rule = (left, middle, right) =>
    left + columns.map((column) => "─".repeat(widths[column] + 2)).join(middle) + right
  const render = (row) =>
    "│ " + columns.map((column) => String(row[column]).padEnd(widths[column])).join(" │ ") + " │"

  return [
    rule("┌", "┬", "┐"),
    render(headers),
    rule("├", "┼", "┤"),
    ...rows.map(render),
    rule("└", "┴", "┘"),
  ].join("\n")
}
