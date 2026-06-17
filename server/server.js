const express = require("express")
const bodyParser = require("body-parser")
const http = require("http")
const fs = require("fs")
const { Server } = require("socket.io")
const path = require("path")
const { getAvatar } = require("../steam/steam.js")

const BASE_DIR = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, "..")
const CS2_OVERVIEWS = path.join(BASE_DIR, "hud", "assets", "overviews", "radar")

function parseKV(text) {
  const result = {}
  const re = /"([^"\r\n]+)"\s+"([^"\r\n]+)"/g
  let m
  while ((m = re.exec(text)) !== null) {
    result[m[1]] = m[2]
  }
  return result
}

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
})

io.on("connection", socket => {
  if (Object.keys(gameState).length > 0) socket.emit("state", gameState)
  const veto = loadVeto()
  if (veto.maps && veto.maps.length > 0) socket.emit("veto", veto)
})

let gameState = {}
let prevAllplayers = {}
let prevRoundPhase = null
let recentKills = []

// Фазы, в которых происходят убийства
const LIVE_PHASES = new Set(["live", "planted", "defusing"])

// Летальные гранаты (могут убивать), отслеживаем бросок
const LETHAL_GRENADES = new Set(["hegrenade", "molotov", "incgrenade", "firebomb"])
// steamid → Map<weaponName, ticksAgo>  (все недавно брошенные гранаты)
const lastThrownGrenades = {}

function trackGrenadeThrows(curr, prev) {
  // Состариваем записи, удаляем просроченные (~5 секунд)
  for (const id in lastThrownGrenades) {
    const map = lastThrownGrenades[id]
    for (const [name, age] of map) {
      const newAge = age + 1
      if (newAge > 35) map.delete(name)
      else map.set(name, newAge)
    }
    if (map.size === 0) delete lastThrownGrenades[id]
  }
  for (const id in prev) {
    const pp = prev[id]
    const cp = curr[id]
    if (!pp || !cp) continue
    for (const slot in pp.weapons || {}) {
      const pw = pp.weapons[slot]
      if (!pw) continue
      const name = String(pw.name || "").replace(/^weapon_/i, "").toLowerCase()
      if (!LETHAL_GRENADES.has(name)) continue
      if ((pw.state || "").toLowerCase() !== "active") continue
      // Граната была активна в прошлом тике — проверяем, что она уже не активна
      const stillActive = Object.values(cp.weapons || {}).some(w =>
        w && String(w.name || "").replace(/^weapon_/i, "").toLowerCase() === name
          && (w.state || "").toLowerCase() === "active"
      )
      if (!stillActive) {
        if (!lastThrownGrenades[id]) lastThrownGrenades[id] = new Map()
        lastThrownGrenades[id].set(name, 0)
      }
    }
  }
}

function normalizeGSI(raw) {
  if (!raw || typeof raw !== "object") return {}
  const d = raw.payload || raw
  return {
    provider: d.provider ?? raw.provider,
    map: d.map ?? raw.map,
    round: d.round ?? raw.round,
    player: d.player ?? raw.player,
    allplayers: d.allplayers ?? raw.allplayers ?? {},
    phase_countdowns: d.phase_countdowns ?? raw.phase_countdowns,
    bomb: d.bomb ?? raw.bomb,
    auth: d.auth ?? raw.auth,
  }
}

function getActiveWeapon(weapons) {
  if (!weapons) return ""
  for (const slot in weapons) {
    const w = weapons[slot]
    if (!w) continue
    if ((w.state || "").toLowerCase() === "active") {
      return String(w.name || "").replace(/^weapon_/i, "").toLowerCase()
    }
  }
  return ""
}

function detectKills(curr, prev) {
  if (!curr || !prev) return []
  const kills = []

  // Игроки, чей HP стал 0 прямо в этом тике
  const newlyDead = []
  for (const vid in curr) {
    const cv = curr[vid]
    const pv = prev[vid]
    if (!cv || !cv.state) continue
    const currHP = cv.state.health ?? 100
    const prevHP = pv?.state?.health ?? 100
    if (currHP <= 0 && prevHP > 0) {
      newlyDead.push({
        steamid: vid,
        name: cv.name || vid,
        team: cv.team || "",
        // Жертва была слеплена — значит кто-то ей кинул флеш (flash assist)
        wasFlashed: (pv?.state?.flashing ?? 0) > 200,
      })
    }
  }

  // Ассисты: игроки, у которых в этом тике выросли assists
  const assistPool = {}
  for (const id in curr) {
    const cp = curr[id]
    const pp = prev[id]
    if (!cp?.match_stats) continue
    const delta = (cp.match_stats.assists ?? 0) - (pp?.match_stats?.assists ?? 0)
    if (delta > 0) {
      assistPool[id] = { name: cp.name || id, team: cp.team || "", remaining: delta }
    }
  }

  for (const id in curr) {
    const cp = curr[id]
    const pp = prev[id]
    if (!cp || !cp.match_stats) continue

    const currKills = cp.match_stats.kills ?? 0
    const prevKills = pp?.match_stats?.kills ?? 0
    if (currKills <= prevKills) continue

    const newKillCount = currKills - prevKills
    if (newKillCount > 3) continue

    // Основное оружие: активное в прошлом тике → текущем тике → недавно брошенная граната
    let weapon = getActiveWeapon(pp?.weapons) || getActiveWeapon(cp.weapons)
    const recentGrenades = lastThrownGrenades[id]
    if (recentGrenades && recentGrenades.size > 0 && !LETHAL_GRENADES.has(weapon)) {
      // Берём ту гранату, которая была брошена раньше всех (наибольший ticksAgo):
      // убийца обычно бросает убивающую гранату первой, затем переходит к следующей
      let bestGrenade = null
      let maxAge = -1
      for (const [name, age] of recentGrenades) {
        if (age > maxAge) { maxAge = age; bestGrenade = name }
      }
      if (bestGrenade) weapon = bestGrenade
    }
    const killerTeam = cp.team || ""

    const currHS = cp.state?.round_killhs ?? 0
    const prevHS = pp?.state?.round_killhs ?? 0
    const hsCount = Math.max(0, currHS - prevHS)

    // Убийца был слеплен (flashing > 200 в предыдущем тике)
    const blind = (pp?.state?.flashing ?? 0) > 200

    // Найти ассистента (тот же тим, не сам убийца)
    let assister = null
    for (const aid in assistPool) {
      if (aid === id) continue
      const a = assistPool[aid]
      if (a.team === killerTeam && a.remaining > 0) {
        assister = { steamid: aid, name: a.name, team: a.team }
        a.remaining--
        if (a.remaining <= 0) delete assistPool[aid]
        break
      }
    }

    for (let i = 0; i < newKillCount; i++) {
      const victim = newlyDead.shift() ?? null
      const isFlashAssist = !!(assister && victim?.wasFlashed)

      // Обогащаем данными от CSSharp плагина (прострел, noscope, смок)
      const cs = victim ? popCsharpKill(id, victim.steamid) : null

      kills.push({
        killer_steamid: id,
        killer_name: cp.name || id,
        killer_team: killerTeam,
        victim_steamid: victim?.steamid ?? null,
        victim_name: victim?.name ?? "?",
        victim_team: victim?.team ?? "",
        weapon,
        headshot:      i < hsCount,
        blind:         cs ? cs.blind         : blind,
        wallbang:      cs ? cs.penetrated    : false,
        noscope:       cs ? cs.noscope       : false,
        through_smoke: cs ? cs.through_smoke : false,
        assister_steamid: assister?.steamid ?? null,
        assister_name: assister?.name ?? null,
        assister_team: assister?.team ?? null,
        assist_type: assister ? (isFlashAssist ? "flash" : "damage") : null,
      })
    }
  }

  return kills
}

// steamid:steamid → { penetrated, noscope, through_smoke, blind, ts }
const csharpKills = {}

function csharpKey(killer, victim) { return `${killer}:${victim}` }

function popCsharpKill(killer, victim) {
  const key = csharpKey(killer, victim)
  const entry = csharpKills[key]
  if (!entry) return null
  delete csharpKills[key]
  return entry
}

function pruneCsharpKills() {
  const now = Date.now()
  for (const key in csharpKills) {
    if (now - csharpKills[key].ts > 10000) delete csharpKills[key]
  }
}

app.use(bodyParser.json())

// Endpoint для CSSharp плагина
app.post("/kill", (req, res) => {
  pruneCsharpKills()
  const b = req.body || {}
  if (b.killer_steamid && b.victim_steamid) {
    csharpKills[csharpKey(b.killer_steamid, b.victim_steamid)] = {
      penetrated:    !!b.penetrated,
      noscope:       !!b.noscope,
      through_smoke: !!b.through_smoke,
      blind:         !!b.blind,
      ts:            Date.now(),
    }
  }
  res.sendStatus(200)
})

app.post("/", (req, res) => {
  const body = req.body || {}
  const normalized = normalizeGSI(body)
  const curr = normalized.allplayers || {}
  const roundPhase = normalized.round?.phase

  if (roundPhase === "freezetime" || roundPhase === "warmup") {
    if (roundPhase === "freezetime") {
      recentKills = []
    }
    prevAllplayers = curr

  } else if (roundPhase === "over") {
    if (LIVE_PHASES.has(prevRoundPhase)) {
      trackGrenadeThrows(curr, prevAllplayers)
      const newKills = detectKills(curr, prevAllplayers)
      if (newKills.length > 0) recentKills = [...recentKills, ...newKills]
    }
    prevAllplayers = curr

  } else if (LIVE_PHASES.has(roundPhase)) {
    if (!LIVE_PHASES.has(prevRoundPhase)) {
      prevAllplayers = curr
    } else {
      trackGrenadeThrows(curr, prevAllplayers)
      const newKills = detectKills(curr, prevAllplayers)
      if (newKills.length > 0) recentKills = [...recentKills, ...newKills]
      prevAllplayers = curr
    }

  } else {
    prevAllplayers = curr
  }

  prevRoundPhase = roundPhase
  gameState = { ...normalized, recent_kills: recentKills }
  io.emit("state", gameState)
  res.sendStatus(200)
})

app.get("/api/state", (req, res) => {
  res.json(gameState)
})

// Map overview metadata from CS2 game files
app.get("/api/mapinfo/:mapname", (req, res) => {
  const mapname = req.params.mapname.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase()
  const txtPath = path.join(CS2_OVERVIEWS, mapname + ".txt")
  try {
    const text = fs.readFileSync(txtPath, "utf8")
    const kv = parseKV(text)
    res.json({
      pos_x: parseFloat(kv.pos_x ?? "0"),
      pos_y: parseFloat(kv.pos_y ?? "0"),
      scale: parseFloat(kv.scale ?? "1"),
    })
  } catch {
    res.status(404).json({ error: "not found" })
  }
})

// Radar image from project assets
app.get("/radar/:mapname", (req, res) => {
  const mapname = req.params.mapname.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase()
  for (const name of [mapname + "_radar_psd.png", mapname + "_radar.png", mapname + ".png"]) {
    const imgPath = path.join(CS2_OVERVIEWS, name)
    if (fs.existsSync(imgPath)) return res.sendFile(imgPath)
  }
  res.status(404).send("not found")
})

// Debug: dump CT players' weapons + state to check defuse kit fields
app.get("/api/debug/ct", (req, res) => {
  const players = gameState.allplayers || {}
  const ct = {}
  for (const id in players) {
    const p = players[id]
    const team = String(p.team || "").toUpperCase()
    if (team === "CT" || team === "COUNTER-TERRORIST") {
      ct[id] = { name: p.name, state: p.state, weapons: p.weapons }
    }
  }
  res.json(ct)
})

app.get("/api/test", (req, res) => {
  const sample = {
    map: { name: "de_dust2", team_ct: { score: 5, name: "Natus Vincere" }, team_t: { score: 3, name: "Vitality" } },
    round: { phase: "live" },
    phase_countdowns: { phase_ends_in: 95 },
    allplayers: {
      "76561198000000001": { name: "s1mple", steamid: "76561198000000001", team: "CT", state: { health: 100, armor: 100, helmet: true, round_kills: 1, round_killhs: 1 }, weapons: { "weapon_0": { name: "weapon_awp", type: "Sniper Rifle", state: "active" } }, match_stats: { kills: 5, deaths: 0, assists: 1 } },
      "76561198000000002": { name: "electronic", steamid: "76561198000000002", team: "CT", state: { health: 80, armor: 50 }, weapons: { "weapon_0": { name: "weapon_m4a1_silencer", type: "Rifle", state: "active" } }, match_stats: { kills: 2, deaths: 1, assists: 2 } },
      "76561198000000003": { name: "ZywOo", steamid: "76561198000000003", team: "T", state: { health: 0, armor: 0 }, weapons: {}, match_stats: { kills: 3, deaths: 1, assists: 0 } },
      "76561198000000004": { name: "apEX", steamid: "76561198000000004", team: "T", state: { health: 75, armor: 100 }, weapons: { "weapon_0": { name: "weapon_ak47", type: "Rifle", state: "active" } }, match_stats: { kills: 1, deaths: 2, assists: 1 } },
    },
    recent_kills: [
      { killer_steamid: "76561198000000001", killer_name: "s1mple", killer_team: "CT", victim_steamid: "76561198000000003", victim_name: "ZywOo", victim_team: "T", weapon: "awp", headshot: true },
      { killer_steamid: "76561198000000004", killer_name: "apEX", killer_team: "T", victim_steamid: "76561198000000002", victim_name: "electronic", victim_team: "CT", weapon: "ak47", headshot: false },
    ],
  }
  gameState = sample
  prevAllplayers = sample.allplayers
  recentKills = sample.recent_kills
  io.emit("state", sample)
  res.redirect("/")
})

app.get("/avatar/:steamid", async (req, res) => {
  const steamid = req.params.steamid
  if (!steamid) return res.sendStatus(400)
  try {
    const avatarUrl = await getAvatar(steamid)
    if (!avatarUrl) return res.sendStatus(404)
    res.redirect(302, avatarUrl)
  } catch (e) {
    res.sendStatus(502)
  }
})

// ── Map veto ─────────────────────────────────────────────────────────────────
const VETO_FILE = path.join(BASE_DIR, "veto.json")

function loadVeto() {
  try { return JSON.parse(fs.readFileSync(VETO_FILE, "utf8")) } catch { return { bo: "BO3", maps: [] } }
}
function saveVeto(data) {
  fs.writeFileSync(VETO_FILE, JSON.stringify(data, null, 2))
}

app.get("/api/veto", (req, res) => res.json(loadVeto()))

app.post("/api/veto", express.json(), (req, res) => {
  const { bo, maps } = req.body || {}
  if (!bo) return res.status(400).json({ error: "bo required" })
  const data = { bo, maps: maps || [] }
  saveVeto(data)
  io.emit("veto", data)
  res.json({ ok: true })
})

// ── Webcam mappings (steamid64 → vdo.ninja URL) ──────────────────────────────
const WEBCAMS_FILE = path.join(BASE_DIR, "webcams.json")

function loadWebcams() {
  try { return JSON.parse(fs.readFileSync(WEBCAMS_FILE, "utf8")) } catch { return {} }
}
function saveWebcams(data) {
  fs.writeFileSync(WEBCAMS_FILE, JSON.stringify(data, null, 2))
}

app.get("/api/webcams", (req, res) => {
  res.json(loadWebcams())
})

app.post("/api/webcams", express.json(), (req, res) => {
  const { steamid, url } = req.body || {}
  if (!steamid) return res.status(400).json({ error: "steamid required" })
  const data = loadWebcams()
  if (url) data[steamid] = url
  else delete data[steamid]
  saveWebcams(data)
  res.json({ ok: true })
})

// Admin page — serve from hud/admin.html
app.get("/admin", (req, res) => {
  res.sendFile(path.join(BASE_DIR, "hud", "admin.html"))
})

// Expose current allplayers for admin page
app.get("/api/players", (req, res) => {
  const all = gameState.allplayers || {}
  const players = Object.entries(all).map(([steamid, p]) => ({
    steamid,
    name: p.name || steamid,
    team: p.team || "",
  }))
  res.json(players)
})

app.use(express.static(path.join(BASE_DIR, "hud")))

server.listen(3000, () => {
  console.log("HUD server running on http://localhost:3000")
})
