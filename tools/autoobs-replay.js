#!/usr/bin/env node
// Прогон записи GSI через режиссёр автообсерва без игры — для подбора порогов.
//
//   node tools/autoobs-replay.js recordings/gsi-20261026-201500.jsonl
//   node tools/autoobs-replay.js <файл> --config autoobs.json   (другой конфиг)
//   node tools/autoobs-replay.js <файл> --recorded               (камера как в записи, без симуляции)
//   node tools/autoobs-replay.js <файл> --why                    (печатать и причины удержания)
//
// По умолчанию камера «слушается» режиссёра: после каждого решения через 150 мс
// наблюдаемым становится выбранный игрок (как если бы агент нажал цифру).

const fs = require("fs")
const path = require("path")
const readline = require("readline")
const { DEFAULTS, deepMerge } = require("../server/autoobs/config.js")
const { createSignals } = require("../server/autoobs/signals.js")
const { createDirector } = require("../server/autoobs/director.js")
const { slotKey } = require("../server/autoobs/switcher.js")

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith("--"))
if (!file) { console.error("Укажи файл записи: node tools/autoobs-replay.js recordings/<файл>.jsonl"); process.exit(1) }
const cfgIdx = args.indexOf("--config")
const cfgFile = cfgIdx >= 0 ? args[cfgIdx + 1] : path.join(__dirname, "..", "autoobs.json")
const followRecorded = args.includes("--recorded")
const showWhy = args.includes("--why")

let cfg = DEFAULTS
if (fs.existsSync(cfgFile)) cfg = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(cfgFile, "utf8")))

const signals = createSignals()
const director = createDirector()
let t0 = null, virtualObs = null, pendingObs = null, lastWhy = ""
const counts = {}
let decisions = 0, packets = 0

const fmt = ms => {
  const s = ms / 1000
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`
}

const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
rl.on("line", line => {
  if (!line.trim()) return
  let rec
  try { rec = JSON.parse(line) } catch { return }
  const now = rec.t, state = rec.s
  if (t0 == null) t0 = now
  packets++

  const recordedObs = state.player?.steamid ? String(state.player.steamid) : null
  if (followRecorded || virtualObs == null) virtualObs = recordedObs
  if (pendingObs && now >= pendingObs.at) { virtualObs = pendingObs.sid; pendingObs = null }
  const simState = followRecorded ? state : { ...state, player: { ...(state.player || {}), steamid: virtualObs } }

  const players = signals.update(simState, now, cfg)
  const d = director.decide(players, simState, now, cfg, virtualObs)
  if (d.action) {
    decisions++
    const lvl = (d.action.reason.match(/^(P\d|DEATH|PRE-ROUND)/) || ["?"])[0]
    counts[lvl] = (counts[lvl] || 0) + 1
    console.log(`${fmt(now - t0)}  ${d.action.reason} (клавиша ${slotKey(d.action.slot)})`)
    if (!followRecorded) pendingObs = { sid: d.action.sid, at: now + 150 }
  } else if (showWhy && d.why && d.why !== lastWhy) {
    console.log(`${fmt(now - t0)}    · ${d.why}  [${d.level_name} ${d.label}]`)
  }
  lastWhy = d.why
})
rl.on("close", () => {
  console.log(`\nпакетов: ${packets}, переключений: ${decisions}`)
  console.log("по уровням: " + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", "))
})
