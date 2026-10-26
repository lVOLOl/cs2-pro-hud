// ── Запись потока GSI для прогона без игры ──────────────────────────────────
// recordings/gsi-YYYYMMDD-HHMMSS.jsonl — по строке на пакет: {"t": ms, "s": state}
// Прогон: node tools/autoobs-replay.js recordings/<файл>.jsonl
// Порядок: ~6 МБ в минуту при 10 пакетах в секунду.

const fs = require("fs")
const path = require("path")

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function createRecorder(baseDir) {
  const dir = path.join(baseDir, "recordings")
  let stream = null, file = "", count = 0, startedAt = 0

  return {
    start() {
      if (stream) return file
      fs.mkdirSync(dir, { recursive: true })
      file = path.join(dir, `gsi-${stamp()}.jsonl`)
      stream = fs.createWriteStream(file, { flags: "a" })
      count = 0
      startedAt = Date.now()
      return file
    },
    stop() {
      if (stream) stream.end()
      stream = null
    },
    write(state, now) {
      if (!stream) return
      stream.write(JSON.stringify({ t: now, s: state }) + "\n")
      count++
    },
    status() {
      return { active: !!stream, file: file ? path.relative(baseDir, file) : "", packets: count, seconds: stream ? Math.round((Date.now() - startedAt) / 1000) : 0 }
    },
  }
}

module.exports = { createRecorder }
