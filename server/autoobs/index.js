// ── Автообсерв: сборка модуля ────────────────────────────────────────────────
//   config.js   — пороги и времена (autoobs.json, горячая перезагрузка)
//   signals.js  — сигналы по разнице снимков GSI (стрельба, урон, киллы, кто кого убил, движение)
//   director.js — уровни P0–P4, кластеры контактов, правила удержания → кого показывать
//   switcher.js — способ переключения (агент жмёт цифры; позже — консоль)
//   recorder.js — запись потока GSI для прогона без игры (tools/autoobs-replay.js)
//
// Агент (tools/autoobs-agent.ps1) на ПК с CS2 подключается по Socket.IO,
// нажимает цифры скан-кодами, ловит хоткеи Ctrl+Shift+PageUp / PageDown
// и сообщает о ручном управлении (свои нажатия отличает по флагу injected).

const fs = require("fs")
const path = require("path")
const { createConfig } = require("./config.js")
const { createSignals } = require("./signals.js")
const { createDirector } = require("./director.js")
const { createSwitcher, AGENT_NS } = require("./switcher.js")
const { createRecorder } = require("./recorder.js")
const { createSpawns } = require("./spawns.js")
const { createFlyover } = require("./flyover.js")
const { parseVec } = require("./signals.js")

const LOG_SIZE = 60

function createAutoObserve({ baseDir, loadSettings, saveSettings, io }) {
  const config = createConfig(baseDir)
  const cfg = () => config.get()
  const signals = createSignals()
  const director = createDirector()
  const switcher = createSwitcher(io, cfg)
  const recorder = createRecorder(baseDir)

  const st = {
    pausedUntil: 0,
    pauseReason: "",
    observedSid: null,
    lastDecision: null,
    log: [],
    agents: new Map(),     // socket.id → { host, version, cs2, connectedAt, lastSeen }
    lastPacketAt: 0,
    lastState: null,
    lastPlayers: [],
    draft: { side: "T", id: "", keyframes: [] },   // запись пролётки по точкам
  }

  // disabled в autoobs.json — функция отключена целиком: не включается ни кнопкой, ни хоткеем
  const disabled = () => !!cfg().disabled
  const enabled = () => !disabled() && !!loadSettings().autoobs?.enabled
  const paused = () => Date.now() < st.pausedUntil

  // ── Журнал ───────────────────────────────────────────────────────────────
  function log(line) {
    const at = Date.now()
    st.log.unshift({ at, line })
    if (st.log.length > LOG_SIZE) st.log.length = LOG_SIZE
    console.log("[autoobs] " + line)
    const file = cfg().log.file
    if (file) {
      const d = new Date(at)
      const ts = d.toLocaleTimeString("ru-RU", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0")
      fs.appendFile(path.join(baseDir, file), `${d.toISOString().slice(0, 10)} ${ts}  ${line}\n`, () => {})
    }
  }

  function broadcastState() {
    io.of(AGENT_NS).emit("agent:state", { enabled: enabled(), paused: paused() })
    io.emit("autoobs", { enabled: enabled(), paused: paused() })
  }

  // ── Пролётки ────────────────────────────────────────────────────────────
  const spawns = createSpawns(baseDir)
  const NO_RETURN = new Set(["запущена другая пролётка", "автообсерв выключен / пауза", "ручное управление", "выключено хоткеем"])
  const flyover = createFlyover({
    baseDir, spawns, io, log, getCfg: cfg, agentNs: AGENT_NS,
    // после пролётки — нажатием цифры на игрока (вид от первого лица)
    onEnd(fly, reason) {
      if (fly.preview || NO_RETURN.has(reason) || !enabled() || paused() || !st.lastState) return
      const target = director.preRoundTarget(st.lastPlayers, st.lastState, Date.now(), cfg())
      if (!target) return
      const r = switcher().switchTo(target)
      director.markOwn(target.sid, Date.now())
      if (r.ok) log(`FLYOVER → ${target.name} (клавиша ${r.key})`)
    },
  })

  // ── Вкл / выкл / пауза ──────────────────────────────────────────────────
  function setEnabled(on, source) {
    if (on && disabled()) {
      log(`включение отклонено (${source}): автообсерв отключён в autoobs.json — "disabled": true`)
      broadcastState()
      return
    }
    const s = loadSettings()
    saveSettings({ ...s, autoobs: { ...(s.autoobs || {}), enabled: !!on } })
    st.pausedUntil = 0
    st.pauseReason = ""
    director.markOwn(st.observedSid, Date.now())   // текущую камеру считаем своей
    if (!on) { flyover.stop("выключено хоткеем"); switcher().releaseAll() }
    log(`АВТООБСЕРВ ${on ? "ВКЛ" : "ВЫКЛ"} (${source})`)
    broadcastState()
  }

  function pause(reason) {
    if (!enabled()) return
    const ms = cfg().timing.manual_pause_ms
    const wasPaused = paused()
    st.pausedUntil = Date.now() + ms
    st.pauseReason = reason
    if (!wasPaused) log(`ПАУЗА ${Math.round(ms / 1000)} с: ${reason}`)
    broadcastState()
  }

  function resume(source) {
    st.pausedUntil = 0
    st.pauseReason = ""
    director.markOwn(st.observedSid, Date.now())
    log(`ПАУЗА СНЯТА (${source})`)
    broadcastState()
  }

  // ── Главный цикл: каждый пакет GSI ───────────────────────────────────────
  let wasPaused = false
  function onState(state) {
    const now = Date.now()
    st.lastPacketAt = now
    recorder.write(state, now)
    const c = cfg()
    const players = signals.update(state, now, c)
    st.lastState = state
    st.lastPlayers = players
    spawns.observe(state)
    // Что GSI говорит о камере зрителя (в свободной камере — её позиция; нужно для записи пролёток)
    const pl = state.player || {}
    st.camera = { steamid: pl.steamid || null, name: pl.name || "", activity: pl.activity || "",
                  spectarget: pl.spectarget ?? null, observer_slot: pl.observer_slot ?? null,
                  position: pl.position || null, forward: pl.forward || null }

    // Ручное переключение камеры (не нашей командой и не автопереход с погибшего)
    const obs = state.player?.steamid ? String(state.player.steamid) : null
    if (obs !== st.observedSid) {
      const prev = players.find(p => p.sid === st.observedSid)
      const cmd = director.lastCommand()
      const ours = cmd.sid === obs && now - cmd.at < c.timing.command_grace_ms * 3
      const pending = now - cmd.at < c.timing.command_grace_ms
      const flying = flyover.recentlyActive(2500)   // камера в пролётке — это мы, а не оператор
      if (enabled() && !paused() && !flying && st.observedSid && obs && !ours && !pending && !(prev && !prev.alive)) {
        const who = players.find(p => p.sid === obs)
        pause(`ручное переключение на ${who?.name || obs}`)
      }
      st.observedSid = obs
    }

    // Пауза истекла — возвращаемся сами
    const isPaused = paused()
    if (wasPaused && !isPaused && enabled()) { director.markOwn(obs, now); log("ПАУЗА ЗАКОНЧИЛАСЬ — автомат снова работает"); broadcastState() }
    wasPaused = isPaused

    const active = enabled() && !isPaused
    flyover.onState(state, now, active)
    const d = director.decide(players, state, now, c, obs, !active || !!flyover.active())
    st.lastDecision = { ...d, at: now }
    if (active && d.action) {
      const r = switcher().switchTo(d.action)
      if (r.ok) log(`${d.action.reason} (клавиша ${r.key})`)
      else log(`НЕ ПЕРЕКЛЮЧИЛ: ${r.error} — ${d.action.reason}`)
      if (r.ok && !agentList().length) log("агент не подключён — нажатие никто не выполнит")
    }
  }

  // ── Агенты (Socket.IO) ───────────────────────────────────────────────────
  function agentList() {
    return [...st.agents.values()].map(a => ({ host: a.host, version: a.version, cs2_focus: a.cs2, fly: a.fly, fly_error: a.flyError,
                                               connected_s: Math.round((Date.now() - a.connectedAt) / 1000) }))
  }

  io.of(AGENT_NS).on("connection", socket => {
    socket.on("agent:hello", info => {
      st.agents.set(socket.id, { host: String(info?.host || "?").slice(0, 60), version: String(info?.version || ""), cs2: !!info?.cs2,
                                 fly: !!info?.fly, flyError: String(info?.fly_error || ""), connectedAt: Date.now() })
      log(`агент подключён: ${info?.host || "?"}`)
      socket.emit("agent:state", { enabled: enabled(), paused: paused() })
    })
    socket.on("agent:hotkey", m => {
      if (m?.action === "on") { if (enabled()) resume("Ctrl+Shift+PageUp"); else setEnabled(true, "Ctrl+Shift+PageUp") }
      if (m?.action === "off") setEnabled(false, "Ctrl+Shift+PageDown")
    })
    socket.on("agent:manual", m => {
      if (flyover.active()) flyover.end(flyover.active().seq, "ручное управление")
      pause(String(m?.reason || "ручное управление"))
    })
    socket.on("agent:fly_end", m => { if (flyover.active()) flyover.end(Number(m?.seq), String(m?.reason || "агент закончил")) })
    socket.on("agent:focus", m => { const a = st.agents.get(socket.id); if (a) a.cs2 = !!m?.cs2 })
    socket.on("agent:pressed", m => { if (m?.skipped) log(`агент пропустил нажатие ${m.key}: ${m.skipped}`) })
    socket.on("disconnect", () => {
      const a = st.agents.get(socket.id)
      if (a) { st.agents.delete(socket.id); log(`агент отключён: ${a.host}`) }
    })
  })

  // ── Статус для отладочной страницы ──────────────────────────────────────
  function status() {
    const now = Date.now()
    const d = st.lastDecision
    return {
      enabled: enabled(),
      disabled: disabled(),
      paused: paused(),
      pause_left_ms: Math.max(0, st.pausedUntil - now),
      pause_reason: st.pauseReason,
      gsi_age_ms: st.lastPacketAt ? now - st.lastPacketAt : null,
      observed: st.observedSid,
      camera: st.camera || null,
      decision: d ? {
        level: d.level_name, label: d.label, current_level: d.current_level, why: d.why,
        action: d.action, holds: d.holds, entities: d.entities, quiet: d.quiet, ago_ms: now - d.at,
      } : null,
      agents: agentList(),
      log: st.log.map(l => ({ ago_ms: now - l.at, line: l.line })),
      recording: recorder.status(),
      config_file: path.relative(baseDir, config.file),
      config_error: config.error(),
      switch_method: cfg().switch.method,
      flyover: { ...flyover.status(), enabled: !!cfg().flyover.enabled, map: String(st.lastState?.map?.name || ""),
                 spawns: (() => { const m = String(st.lastState?.map?.name || ""); const r = {}
                   for (const side of ["T", "CT"]) { const sp = spawns.get(m, side); r[side] = sp ? { points: sp.points.length, rounds: sp.rounds || 0 } : null }
                   return r })(),
                 draft: { side: st.draft.side, id: st.draft.id, points: st.draft.keyframes.length } },
    }
  }

  function registerRoutes(app, express) {
    app.get("/api/autoobs/status", (req, res) => res.json(status()))
    app.post("/api/autoobs/config", express.json(), (req, res) => {
      const b = req.body || {}
      if (b.enabled !== undefined) setEnabled(!!b.enabled, "админка")
      if (b.resume) resume("админка")
      if (b.record === true) log("запись GSI: " + recorder.start())
      if (b.record === false) { recorder.stop(); log("запись GSI остановлена") }
      res.json(status())
    })
    app.get("/api/autoobs/config-file", (req, res) => res.type("text/plain").send(config.raw()))
    app.post("/api/autoobs/config-file", express.text({ type: "*/*", limit: "200kb" }), (req, res) => {
      try { config.save(String(req.body || "")); log("конфиг сохранён из админки"); res.json({ ok: true }) }
      catch (e) { res.status(400).json({ ok: false, error: e.message }) }
    })
  }

  // ── API пролёток ─────────────────────────────────────────────────────────
  function registerFlyoverRoutes(app, express) {
    const curMap = () => String(st.lastState?.map?.name || "")
    app.get("/api/autoobs/flyover/paths", (req, res) => {
      const map = String(req.query.map || curMap())
      const out = {}
      for (const side of ["T", "CT"]) {
        out[side] = flyover.pathsFor(map, side).map(p => {
          const b = require("./flyover.js").buildFrames(p, cfg().flyover)
          return { id: p.id, generated: !!p.generated, keyframes: p.keyframes.length,
                   dur_ms: b?.dur_ms, length: b?.length, max_speed: b?.max_speed, max_turn_dps: b?.max_turn_dps }
        })
      }
      res.json({ map, paths: out })
    })
    app.post("/api/autoobs/flyover/play", express.json(), (req, res) => {
      const b = req.body || {}
      if (disabled()) return res.json({ ok: false, error: "автообсерв отключён в autoobs.json (\"disabled\": true)" })
      res.json(flyover.play(String(b.map || curMap()), b.side === "CT" ? "CT" : "T", b.id || null, null, "предпросмотр из админки", true))
    })
    app.post("/api/autoobs/flyover/stop", (req, res) => { flyover.stop("остановлено из админки"); res.json({ ok: true }) })
    app.get("/api/autoobs/spawns", (req, res) => res.json(spawns.all()))
    app.delete("/api/autoobs/spawns", (req, res) => { spawns.clear(String(req.query.map || "")); res.json({ ok: true }) })

    // Запись пролётки по точкам: позиция и взгляд камеры из GSI (player.position / forward в свободной камере)
    app.post("/api/autoobs/flyover/record", express.json(), (req, res) => {
      const b = req.body || {}
      const d = st.draft
      if (b.action === "start") { st.draft = { side: b.side === "CT" ? "CT" : "T", id: String(b.id || "rec1"), keyframes: [] }; return res.json({ ok: true, draft: st.draft }) }
      if (b.action === "clear") { d.keyframes = []; return res.json({ ok: true, draft: d }) }
      if (b.action === "add") {
        const pos = parseVec(st.camera?.position), fwd = parseVec(st.camera?.forward)
        if (!pos || !fwd) return res.json({ ok: false, error: "GSI не присылает позицию камеры (player.position / forward)" })
        const yaw = Math.atan2(fwd[1], fwd[0]) * 180 / Math.PI
        const pitch = -Math.asin(Math.max(-1, Math.min(1, fwd[2]))) * 180 / Math.PI
        const t = d.keyframes.length ? d.keyframes[d.keyframes.length - 1].t + Number(b.gap_s || 2.5) : 0
        d.keyframes.push({ pos: pos.map(v => Math.round(v * 10) / 10), ang: [Math.round(pitch * 100) / 100, Math.round(yaw * 100) / 100], t })
        return res.json({ ok: true, draft: d })
      }
      if (b.action === "save") {
        if (d.keyframes.length < 2) return res.json({ ok: false, error: "нужно минимум 2 точки" })
        const map = curMap()
        let all = {}
        try { all = JSON.parse(fs.readFileSync(flyover.recordedFile, "utf8")) || {} } catch {}
        const list = ((all[map] = all[map] || {})[d.side] = all[map][d.side] || [])
        const i = list.findIndex(p => p.id === d.id)
        const entry = { id: d.id, keyframes: d.keyframes }
        if (i >= 0) list[i] = entry; else list.push(entry)
        fs.writeFileSync(flyover.recordedFile, JSON.stringify(all, null, 2))
        log(`пролётка записана: ${map} ${d.side} ${d.id} (${d.keyframes.length} точек)`)
        return res.json({ ok: true, draft: d })
      }
      res.json({ ok: false, error: "action: start | add | clear | save" })
    })
  }

  const baseRegister = registerRoutes
  function registerAll(app, express) { baseRegister(app, express); registerFlyoverRoutes(app, express) }

  return { onState, registerRoutes: registerAll, status }
}

module.exports = { createAutoObserve }
