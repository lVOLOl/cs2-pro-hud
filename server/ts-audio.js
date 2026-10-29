// ── Голос TeamSpeak с задержкой ──────────────────────────────────────────────
// ts/ts-listener.exe заходит на сервер TS двумя ботами (канал команды 1 и 2)
// и каждые 20 мс отдаёт в stdout микс голосов каждого канала:
//   'P', team (0|1), 960 сэмплов i16 LE mono 48 кГц
// Здесь звук держится в буфере на задержку трансляции (webcam_delay + сдвиг)
// и раздаётся странице /ts-audio.html (Browser Source в OBS).
// Какую команду слышно — решает режим: auto | a | b | both | off.

const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")

const FRAME_SAMPLES = 960
const FRAME_BYTES = 2 + FRAME_SAMPLES * 2
const MAX_KEEP_MS = 200 * 1000          // больше 3 минут буфер не держим
const MODES = ["auto", "a", "b", "both", "off"]

function createTsAudio({ baseDir, loadSettings, saveSettings, io, getState, loadTeams }) {
  const TS_DIR = path.join(baseDir, "ts")
  const EXE = path.join(TS_DIR, process.platform === "win32" ? "ts-listener.exe" : "ts-listener")
  const IDS = path.join(TS_DIR, "ts-identities.txt")

  let proc = null
  let procKey = ""
  let restartTimer = null
  let bots = [{ state: "off" }, { state: "off" }]
  const queues = [[], []]                // { t: ms, d: Buffer }
  let lastAuto = "both"
  let gains = { a: 0, b: 0, mode: "auto", live: "off" }
  let cfg = readCfg()

  function readCfg() {
    const s = loadSettings()
    const ts = s.ts || {}
    const offset = Number(ts.offset_ms) || 0
    return {
      enabled: !!ts.enabled,
      address: String(ts.address || "").trim(),
      password: String(ts.password || ""),
      channels: [String(ts.channel_a || "").trim(), String(ts.channel_b || "").trim()],
      mode: MODES.includes(ts.mode) ? ts.mode : "auto",
      volume: Math.max(0, Math.min(2, ts.volume == null ? 1 : Number(ts.volume) || 0)),
      offset,
      delayMs: Math.max(0, (Number(s.webcam_delay) || 0) * 1000 + offset),
    }
  }

  // ── процесс бота ──────────────────────────────────────────────────────────
  function stopProc() {
    clearTimeout(restartTimer)
    if (proc) { try { proc.kill() } catch {} }
    proc = null
  }

  function ensureProc() {
    const key = JSON.stringify([cfg.enabled, cfg.address, cfg.password, cfg.channels])
    if (key === procKey && (proc || restartTimer)) return
    procKey = key
    stopProc()
    queues[0].length = 0; queues[1].length = 0
    if (!cfg.enabled || !cfg.address || (!cfg.channels[0] && !cfg.channels[1])) {
      bots = [{ state: "off" }, { state: "off" }]
      emitStatus()
      return
    }
    if (!fs.existsSync(EXE)) {
      bots = [{ state: "error", error: "нет файла ts/ts-listener.exe" }, { state: "error", error: "нет файла ts/ts-listener.exe" }]
      emitStatus()
      return
    }
    const args = ["--address", cfg.address, "--ids", IDS,
      "--channel-a", cfg.channels[0], "--channel-b", cfg.channels[1],
      "--name-a", "HUD Listener 1", "--name-b", "HUD Listener 2"]
    if (cfg.password) args.push("--password", cfg.password)

    bots = cfg.channels.map(c => ({ state: c ? "connecting" : "off" }))
    emitStatus()
    const p = spawn(EXE, args, { cwd: TS_DIR, windowsHide: true })
    proc = p
    let pending = Buffer.alloc(0)

    p.stdout.on("data", chunk => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      let off = 0
      while (pending.length - off >= FRAME_BYTES) {
        if (pending[off] !== 0x50 || pending[off + 1] > 1) { off++; continue }   // ресинхронизация
        const team = pending[off + 1]
        queues[team].push({ t: Date.now(), d: Buffer.from(pending.subarray(off + 2, off + FRAME_BYTES)) })
        off += FRAME_BYTES
      }
      pending = off ? pending.subarray(off) : pending
    })

    let errLine = ""
    p.stderr.on("data", chunk => {
      errLine += chunk.toString("utf8")
      let i
      while ((i = errLine.indexOf("\n")) >= 0) {
        const line = errLine.slice(0, i).trim()
        errLine = errLine.slice(i + 1)
        if (!line) continue
        try {
          const m = JSON.parse(line)
          if (m.bot === 0 || m.bot === 1) {
            bots[m.bot] = { state: m.state, channel: m.channel ?? bots[m.bot].channel, error: m.error }
            emitStatus()
          }
        } catch { console.log("[ts]", line) }
      }
    })

    p.on("error", err => {
      bots = [{ state: "error", error: err.message }, { state: "error", error: err.message }]
      emitStatus()
    })
    p.on("exit", () => {
      if (proc !== p) return
      proc = null
      bots = bots.map(b => b.state === "off" ? b : { ...b, state: "stopped" })
      emitStatus()
      restartTimer = setTimeout(() => { restartTimer = null; procKey = ""; ensureProc() }, 5000)
    })
  }

  // ── кого слышно ───────────────────────────────────────────────────────────
  function autoSide() {
    const st = getState() || {}
    const sid = String(st.player?.steamid || "")
    if (sid) {
      const teams = loadTeams()
      const idx = teams.findIndex(t => (t.players || []).some(p => String(p.steamid || p) === sid))
      if (idx === 0) lastAuto = "a"
      else if (idx === 1) lastAuto = "b"
    }
    return lastAuto
  }

  function computeGains() {
    const live = cfg.mode === "auto" ? autoSide() : cfg.mode
    const v = cfg.volume
    const g = {
      a: live === "a" || live === "both" ? v : 0,
      b: live === "b" || live === "both" ? v : 0,
      mode: cfg.mode,
      live,
    }
    if (g.a !== gains.a || g.b !== gains.b || g.mode !== gains.mode || g.live !== gains.live) {
      gains = g
      io.to("ts-audio").emit("ts-mix", gains)
      emitStatus()
    }
  }

  // ── раздача с задержкой ──────────────────────────────────────────────────
  setInterval(() => {
    const now = Date.now()
    const due = now - cfg.delayMs
    for (let team = 0; team < 2; team++) {
      const q = queues[team]
      let n = 0
      while (n < q.length && q[n].t <= due) {
        // если задержку уменьшили — старое не выплёвываем пачкой, а пропускаем
        if (q[n].t >= due - 1000) io.to("ts-audio").emit("ts-pcm", team, q[n].d)
        n++
      }
      if (n) q.splice(0, n)
      let old = 0
      while (old < q.length && q[old].t < now - MAX_KEEP_MS) old++
      if (old) q.splice(0, old)
    }
  }, 20)

  setInterval(computeGains, 100)
  setInterval(() => { cfg = readCfg(); ensureProc() }, 1000)

  // ── статус ────────────────────────────────────────────────────────────────
  function status() {
    const buffered = queues.map(q => q.length ? Math.round((Date.now() - q[0].t) / 1000) : 0)
    return {
      running: !!proc,
      exe: fs.existsSync(EXE),
      bots,
      mode: cfg.mode,
      live: gains.live,
      delay_ms: cfg.delayMs,
      buffered_s: buffered,
      teams: loadTeams().map(t => t.name),
    }
  }
  let statusTimer = null
  function emitStatus() {
    if (statusTimer) return
    statusTimer = setTimeout(() => { statusTimer = null; io.emit("ts-status", status()) }, 100)
  }

  io.on("connection", socket => {
    socket.on("ts-join", () => {
      socket.join("ts-audio")
      socket.emit("ts-mix", gains)
    })
  })

  function registerRoutes(app, express) {
    app.get("/api/ts", (req, res) => {
      const ts = loadSettings().ts || {}
      res.json({ config: { ...ts, password: ts.password ? "••••" : "" }, status: status() })
    })
    app.post("/api/ts", express.json(), (req, res) => {
      const b = req.body || {}
      const s = loadSettings()
      const ts = { ...(s.ts || {}) }
      for (const k of ["address", "channel_a", "channel_b"]) if (k in b) ts[k] = String(b[k] || "").trim()
      if ("password" in b && b.password !== "••••") ts.password = String(b.password || "")
      if ("enabled" in b) ts.enabled = !!b.enabled
      if ("mode" in b && MODES.includes(b.mode)) ts.mode = b.mode
      if ("volume" in b) ts.volume = Math.max(0, Math.min(2, Number(b.volume) || 0))
      if ("offset_ms" in b) ts.offset_ms = Math.max(-30000, Math.min(30000, Math.round(Number(b.offset_ms) || 0)))
      const updated = { ...s, ts }
      saveSettings(updated)
      io.emit("settings", updated)
      cfg = readCfg()
      ensureProc()
      computeGains()
      res.json({ ok: true, status: status() })
    })
  }

  // при закрытии сервера бот тоже завершится: у него закроется stdout
  process.on("exit", stopProc)

  ensureProc()
  return { registerRoutes, status }
}

module.exports = { createTsAudio }
