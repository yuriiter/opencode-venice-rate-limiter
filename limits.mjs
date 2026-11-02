import { formatTable, loadSnapshot } from "./core.mjs"

process.stdout.write(formatTable(loadSnapshot()) + "\n")
