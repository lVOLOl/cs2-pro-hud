const socket = io()

let lastProcessedKillCount = 0
let lastRecentKillsLength = 0
let lastState = null

function pick(obj, ...keys) {
  if (!obj) return undefined
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return undefined
}

function normalizeGameState(data) {
  if (!data || typeof data !== "object") return {}
  const map = data.map || data.Map
  const allplayersRaw = data.allplayers || data.allplayers_id || data.Allplayers || {}
  const allplayers = {}
  for (const id in allplayersRaw) {
    const p = allplayersRaw[id]
    if (!p || typeof p !== "object") continue
    const state = p.state || p.State || {}
    const weapons = p.weapons || p.Weapons || {}
    const matchStats = p.match_stats || p.Match_stats || {}
    const name = pick(p, "name", "Name", "player_name", "playerName", "username") || (p.clan ? String(p.clan).trim() + " " : "") || ("Player " + String(id).slice(-4))
    allplayers[id] = {
      name: String(name).trim() || "?",
      steamid: pick(p, "steamid", "SteamId", "steam_id") || id,
      team: (pick(p, "team", "Team") || "").toUpperCase().replace("TERRORIST", "T"),
      state: {
        health: pick(state, "health", "Health"),
        money: pick(state, "money", "Money"),
        position: pick(state, "position", "Position"),
        round_kills: pick(state, "round_kills", "round_killhs"),
      },
      weapons: weapons,
      match_stats: {
        kills: pick(matchStats, "kills", "Kills"),
        deaths: pick(matchStats, "deaths", "Deaths"),
        assists: pick(matchStats, "assists", "Assists"),
      },
    }
    if (allplayers[id].team !== "CT" && allplayers[id].team !== "T") allplayers[id].team = String(pick(p, "team", "Team")).startsWith("CT") ? "CT" : "T"
  }
  const phase = data.phase_countdowns || data.Phase_countdowns || {}
  const round = data.round || data.Round || {}
  const bomb = data.bomb || data.Bomb || {}
  const ct = map?.team_ct || map?.Team_ct
  const t = map?.team_t || map?.Team_t
  return {
    map: map ? {
      name: map.name || map.Name,
      team_ct: ct ? { score: ct.score ?? map.score_ct, name: ct.name } : { score: 0, name: "" },
      team_t: t ? { score: t.score ?? map.score_t, name: t.name } : { score: 0, name: "" },
    } : null,
    allplayers,
    phase_countdowns: Object.keys(phase).length ? { phase_ends_in: phase.phase_ends_in ?? phase.Phase_ends_in } : null,
    round: Object.keys(round).length ? { phase: pick(round, "phase", "Phase") } : null,
    bomb: Object.keys(bomb).length ? { countdown: bomb.countdown ?? bomb.Countdown, position: bomb.position ?? bomb.Position, state: bomb.state ?? bomb.State, defuse_countdown: bomb.defuse_countdown ?? bomb.defuseCountdown } : null,
    recent_kills: data.recent_kills,
    player: data.player || data.Player,
  }
}

function getPhaseEndsIn(data) {
  const phase = data.phase_countdowns || data.Phase_countdowns
  if (!phase) return null
  return phase.phase_ends_in ?? phase.phase_ends_in
}

socket.on("state", (data) => {
  const noDataEl = document.getElementById("no-data")
  if (noDataEl) noDataEl.classList.add("hidden")
  lastState = normalizeGameState(data)
  updateScore(lastState)
  updateRound(lastState)
  updateBomb(lastState)
  updatePlayers(lastState)
  updateObservedPlayer(lastState)
  updateKillfeed(lastState)
  updateTeamLogos(lastState)
})

function updateScore(data) {
  if (!data.map) return
  const ct = data.map.team_ct
  const t = data.map.team_t
  const ctEl = document.getElementById("ct_score")
  const tEl = document.getElementById("t_score")
  if (ctEl && ct) ctEl.innerText = ct.score != null ? ct.score : 0
  if (tEl && t) tEl.innerText = t.score != null ? t.score : 0
}

let timerTick = null
let timerSeconds = null
let timerBombMode = false

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m + ":" + String(s).padStart(2, "0")
}

function updateRound(data) {
  const el = document.getElementById("round_timer")
  if (!el) return
  const bomb = data.bomb
  const bombActive = bomb && (bomb.state === "planted" || bomb.State === "planted")
  const phase = data.phase_countdowns
  let countdown = null
  if (bombActive) countdown = Number(bomb.countdown ?? bomb.Countdown)
  else if (phase && phase.phase_ends_in != null) countdown = Number(phase.phase_ends_in)
  const newVal = countdown != null ? Math.floor(countdown) : null
  if (newVal != null) {
    const now = timerSeconds == null ? newVal : Math.max(0, Math.floor(timerSeconds))
    if (timerSeconds == null || newVal <= now) timerSeconds = newVal
    timerBombMode = bombActive
    el.innerText = formatTime(timerSeconds)
    el.classList.toggle("topbar__timer--bomb", !!bombActive)
    if (!timerTick) {
      timerTick = setInterval(() => {
        if (timerSeconds == null) return
        timerSeconds -= 1
        const t = document.getElementById("round_timer")
        if (t) t.innerText = formatTime(timerSeconds)
        if (timerSeconds <= 0) timerSeconds = 0
      }, 1000)
    }
  } else {
    timerSeconds = null
    el.classList.remove("topbar__timer--bomb")
    el.innerText = "0:00"
  }
}

let bombTick = null
let bombSeconds = null
let defuseSeconds = null
let defuseTick = null
function updateBomb(data) {
  const bomb = data.bomb
  const bombEl = document.getElementById("bomb_timer")
  const defuseEl = document.getElementById("defuse_timer")
  const defuseWrap = document.getElementById("defuse_timer_wrap")
  if (!bomb) {
    if (bombEl) bombEl.innerText = ""
    bombSeconds = null
    defuseSeconds = null
    if (defuseWrap) defuseWrap.classList.remove("visible")
    return
  }
  const c = bomb.countdown ?? bomb.Countdown
  const defusing = bomb.state === "defusing" || bomb.State === "defusing"
  const defuseCountdown = bomb.defuse_countdown ?? bomb.defuseCountdown ?? bomb.defuse_countdown
  if (c != null) {
    const newBomb = Math.floor(Number(c))
    if (bombSeconds == null || newBomb <= bombSeconds) bombSeconds = newBomb
    if (bombEl) bombEl.innerText = bombSeconds
    if (!bombTick) {
      bombTick = setInterval(() => {
        if (bombSeconds != null) bombSeconds = Math.max(0, bombSeconds - 1)
        if (bombEl && bombSeconds != null) bombEl.innerText = bombSeconds
      }, 1000)
    }
  }
  if (defuseWrap) {
    if (defusing && defuseCountdown != null) {
      const newDefuse = Math.floor(Number(defuseCountdown))
      if (defuseSeconds == null || newDefuse <= defuseSeconds) defuseSeconds = newDefuse
      defuseWrap.classList.add("visible")
      if (defuseEl) defuseEl.textContent = formatTime(defuseSeconds)
      if (!defuseTick) {
        defuseTick = setInterval(() => {
          if (defuseSeconds != null) defuseSeconds = Math.max(0, defuseSeconds - 1)
          if (defuseEl && defuseSeconds != null) defuseEl.textContent = formatTime(defuseSeconds)
          if (defuseSeconds <= 0 && defuseTick) { clearInterval(defuseTick); defuseTick = null }
        }, 1000)
      }
    } else {
      defuseWrap.classList.remove("visible")
      defuseSeconds = null
      if (defuseTick) { clearInterval(defuseTick); defuseTick = null }
    }
  }
}

function updateObservedPlayer(data) {
  const player = data.player || data.Player
  const all = data.allplayers || {}
  let p = null
  if (player) {
    const steamid = player.steamid || player.SteamId
    const slot = player.observer_slot
    if (steamid && all[steamid]) p = all[steamid]
    else if (slot != null && all[slot]) p = all[slot]
    else if (Object.keys(all).length > 0 && (player.name || player.Name)) {
      const name = (player.name || player.Name || "").trim()
      for (const id in all) { if ((all[id].name || "").trim() === name) { p = all[id]; break } }
    }
    if (!p && (player.name || player.Name)) p = { name: player.name || player.Name, match_stats: player.match_stats || player.Match_stats || {}, steamid: player.steamid || player.SteamId }
  }
  const nameEl = document.getElementById("observed_name")
  const kdaEl = document.getElementById("observed_kda")
  if (!nameEl && !kdaEl) return
  if (!p) {
    if (nameEl) nameEl.textContent = "—"
    if (kdaEl) kdaEl.textContent = "0 | 0 | 0"
    return
  }
  const stats = p.match_stats || p.Match_stats || {}
  const k = stats.kills ?? stats.Kills ?? 0
  const d = stats.deaths ?? stats.Deaths ?? 0
  const a = stats.assists ?? stats.Assists ?? 0
  if (nameEl) nameEl.textContent = p.name || "?"
  if (kdaEl) kdaEl.textContent = k + " | " + d + " | " + a
  const obsAvatar = document.getElementById("observed_avatar")
  if (obsAvatar) obsAvatar.src = p.steamid ? (window.location.origin || "http://localhost:3000") + "/avatar/" + encodeURIComponent(p.steamid) : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'/%3E"
}

function resolveName(allplayers, steamid, fallbackName) {
  if (!allplayers) return fallbackName || "?"
  if (steamid && allplayers[steamid] && allplayers[steamid].name) return allplayers[steamid].name
  return fallbackName || "?"
}

function updateKillfeed(data) {
  const recent = data.recent_kills || data.kill_feed
  const all = data.allplayers || {}
  if (Array.isArray(recent)) {
    for (let i = lastRecentKillsLength; i < recent.length; i++) {
      const k = recent[i]
      const weapon = String(k.weapon || "unknown").replace(/^weapon_/i, "")
      const killerName = resolveName(all, k.killer_steamid, k.killer_name)
      const victimName = resolveName(all, k.victim_steamid, k.victim_name)
      let assist = null
      if (k.assister_steamid || k.assister_name || k.assist_type) {
        const assistName = resolveName(all, k.assister_steamid, k.assister_name)
        const type = (k.assist_type || "").toLowerCase()
        assist = { name: assistName, type: type === "flash" ? "flash" : "damage" }
      }
      addKill(killerName, victimName, weapon, assist)
    }
    lastRecentKillsLength = recent.length
    return
  }
  lastRecentKillsLength = 0
  const round = data.round
  if (!all || !round) return
  let totalKills = 0
  for (const id in all) totalKills += (all[id].state && all[id].state.round_kills) || 0
  if (totalKills > lastProcessedKillCount) {
    let killerName = "?"
    for (const id in all) {
      const rk = (all[id].state && all[id].state.round_kills) || 0
      if (rk > 0) killerName = all[id].name || killerName
    }
    lastProcessedKillCount = totalKills
    addKill(killerName, "?", "unknown", null)
  }
  if (round && (round.phase === "over" || round.phase === "freezetime")) {
    lastProcessedKillCount = 0
    lastRecentKillsLength = 0
  }
}

const teamLogoMap = {}
const EMPTY_IMG = "assets/logos/logo.svg"
function updateTeamLogos(data) {
  if (!data.map) return
  const ct = data.map.team_ct
  const t = data.map.team_t
  const ctLogo = document.getElementById("ct_logo")
  const tLogo = document.getElementById("t_logo")
  if (ctLogo) {
    ctLogo.onerror = () => { ctLogo.src = EMPTY_IMG }
    ctLogo.src = (ct && teamLogoMap[ct.name]) ? teamLogoMap[ct.name] : (ct && ct.name) ? "assets/teams/" + String(ct.name).replace(/\s+/g, "_") + ".png" : EMPTY_IMG
  }
  if (tLogo) {
    tLogo.onerror = () => { tLogo.src = EMPTY_IMG }
    tLogo.src = (t && teamLogoMap[t.name]) ? teamLogoMap[t.name] : (t && t.name) ? "assets/teams/" + String(t.name).replace(/\s+/g, "_") + ".png" : EMPTY_IMG
  }
}
