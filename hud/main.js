const socket = io({ transports: ["websocket", "polling"] })

// ── Webcam pool — pre-load all iframes so switching is instant ────────────────
let _webcams = {}
let _webcamIframes = {}   // steamid → <iframe>
let _activeWebcamSid = null

function makeWebcamUrl(raw) {
  if (!raw) return ""
  return raw.includes("autoplay=") ? raw : raw + (raw.includes("?") ? "&" : "?") + "autoplay=1"
}

function syncWebcamPool() {
  const pool = document.getElementById("observed_webcam_pool")
  if (!pool) return

  // Create iframes for new entries
  for (const sid in _webcams) {
    const url = makeWebcamUrl(_webcams[sid])
    if (!url) continue
    if (!_webcamIframes[sid]) {
      const f = document.createElement("iframe")
      f.src = url
      f.allow = "autoplay; camera; microphone; fullscreen"
      f.allowFullscreen = true
      f.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:none;background:#000;visibility:hidden;pointer-events:none;"
      pool.appendChild(f)
      _webcamIframes[sid] = f
    }
  }

  // Remove iframes whose URLs were deleted
  for (const sid in _webcamIframes) {
    if (!_webcams[sid]) {
      _webcamIframes[sid].remove()
      delete _webcamIframes[sid]
    }
  }
}

function showWebcamFor(steamid) {
  const hasIframe = !!(steamid && _webcamIframes[steamid])
  for (const sid in _webcamIframes) {
    const active = sid === steamid && hasIframe
    _webcamIframes[sid].style.visibility = active ? "visible" : "hidden"
    _webcamIframes[sid].style.pointerEvents = active ? "auto" : "none"
  }
  return hasIframe
}

async function refreshWebcams() {
  try {
    const prev = JSON.stringify(_webcams)
    _webcams = await fetch("/api/webcams").then(r => r.json())
    if (JSON.stringify(_webcams) !== prev) syncWebcamPool()
  } catch {}
}
refreshWebcams()
setInterval(refreshWebcams, 3000)

let lastProcessedKillCount = 0
let lastRecentKillsLength = 0
let lastState = null

// Патроны: трекинг для анимации обратного отсчёта
let _obsWeaponName = null
let _obsDisplayedClip = null
let _obsClipAnimTimer = null

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
      position: pick(p, "position", "Position") || null,
      forward: pick(p, "forward", "Forward") || null,
      observer_slot: pick(p, "observer_slot") ?? null,
      state: {
        health: pick(state, "health", "Health"),
        money: pick(state, "money", "Money"),
        armor: pick(state, "armor", "Armor"),
        helmet: pick(state, "helmet", "Helmet"),
        defusekit: pick(state, "defusekit", "Defusekit"),
        flashing: pick(state, "flashing", "Flashing"),
        position: pick(state, "position", "Position"),
        round_kills: pick(state, "round_kills"),
        round_killhs: pick(state, "round_killhs"),
        round_totaldmg: pick(state, "round_totaldmg"),
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
    phase_countdowns: Object.keys(phase).length ? { phase: phase.phase ?? phase.Phase, phase_ends_in: phase.phase_ends_in ?? phase.Phase_ends_in } : null,
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

// ── Map veto ─────────────────────────────────────────────────────────────────
const MAP_SHORT = {
  de_dust2: "DUST2", de_mirage: "MIRAGE", de_inferno: "INFERNO",
  de_overpass: "OVERPASS", de_vertigo: "VERTIGO", de_ancient: "ANCIENT",
  de_anubis: "ANUBIS", de_nuke: "NUKE",
}

socket.on("veto", (data) => { renderVeto(data) })

function renderVeto(veto) {
  const bar    = document.getElementById("veto_bar")
  const boEl   = document.getElementById("veto_bo")
  const mapsEl = document.getElementById("veto_maps")
  const outer  = document.getElementById("veto_scroll_outer")
  const inner  = document.getElementById("veto_inner")
  if (!bar || !mapsEl) return

  const maps = veto.maps || []
  if (!maps.length) { bar.style.display = "none"; return }
  bar.style.display = "flex"
  if (boEl) boEl.textContent = veto.bo || "BO3"

  mapsEl.innerHTML = ""
  for (const m of maps) {
    const name = MAP_SHORT[m.name] || (m.name || "").replace("de_", "").toUpperCase()
    const logo = `assets/overviews/map_logo/${m.name}.png`
    const status = m.status || "upcoming"

    let scoreHtml = ""
    if (status === "played" && m.score && m.score.length >= 2) {
      scoreHtml = `<span class="veto-map__score">
        <span class="veto-map__score-ct">${m.score[0]}</span>
        <span class="veto-map__score-sep">:</span>
        <span class="veto-map__score-t">${m.score[1]}</span>
      </span>`
    }

    const div = document.createElement("div")
    div.className = `veto-map veto-map--${status}`
    div.innerHTML = `<img class="veto-map__logo" src="${logo}" alt="">
      <span class="veto-map__name">${name}</span>${scoreHtml}`
    mapsEl.appendChild(div)
  }

  // Apply scroll animation if content overflows
  inner.classList.remove("veto-bar__inner--scroll")
  inner.style.removeProperty("--veto-scroll-dist")
  requestAnimationFrame(() => {
    if (!outer || !inner) return
    const overflow = inner.scrollWidth - outer.clientWidth
    if (overflow > 4) {
      inner.style.setProperty("--veto-scroll-dist", `-${overflow}px`)
      inner.classList.add("veto-bar__inner--scroll")
    }
  })
}

socket.on("state", (data) => {
  const noDataEl = document.getElementById("no-data")
  if (noDataEl) noDataEl.classList.add("hidden")
  lastState = normalizeGameState(data)
  updateScore(lastState)
  updateRound(lastState)
  updateBomb(lastState)
  updateTimerRing(lastState)
  updatePlayers(lastState)
  updateObservedPlayer(lastState)
  updateKillfeed(lastState)
  updateTeamLogos(lastState)
  updateMinimap(lastState)
  updateTeamGrenades(lastState)
  updateRoundStats(lastState)
})

function updateScore(data) {
  if (!data.map) return
  const ct = data.map.team_ct
  const t = data.map.team_t
  const ctEl = document.getElementById("ct_score")
  const tEl = document.getElementById("t_score")
  if (ctEl && ct) ctEl.innerText = ct.score != null ? ct.score : 0
  if (tEl && t) tEl.innerText = t.score != null ? t.score : 0

  const all = data.allplayers || {}
  let ctAlive = 0, tAlive = 0
  for (const id in all) {
    const p = all[id]
    const team = (p.team || "").toUpperCase()
    const alive = (p.state?.health ?? 0) > 0
    if (team === "CT" && alive) ctAlive++
    else if (team === "T" && alive) tAlive++
  }
  const ctAliveEl = document.getElementById("ct_alive")
  const tAliveEl  = document.getElementById("t_alive")
  if (ctAliveEl) ctAliveEl.textContent = ctAlive
  if (tAliveEl)  tAliveEl.textContent  = tAlive
}

// Синхронизация таймера с игрой: храним последнее значение сервера и время его получения.
// Если обновления прекратились (демо на паузе) — дисплей замирает.
const TIMER_PAUSE_MS = 5000  // порог паузы в мс

let timerTick = null
let timerSyncValue = null
let timerSyncAt = null

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m + ":" + String(s).padStart(2, "0")
}

function updatePause(data) {
  const overlay = document.getElementById("pause_overlay")
  const badge   = document.getElementById("pause_team_badge")
  if (!overlay) return
  const ph = data.phase_countdowns?.phase || ""
  const isPause = ph === "timeout_ct" || ph === "timeout_t" || ph === "paused"
  overlay.style.display = isPause ? "flex" : "none"
  if (badge) {
    if (ph === "timeout_ct") { badge.textContent = "CT"; badge.className = "pause-overlay__badge pause-overlay__badge--ct" }
    else if (ph === "timeout_t") { badge.textContent = "T";  badge.className = "pause-overlay__badge pause-overlay__badge--t" }
    else { badge.textContent = "PAUSE"; badge.className = "pause-overlay__badge" }
  }
}

function updateRound(data) {
  updatePause(data)
  const el = document.getElementById("round_timer")
  const wrap = document.getElementById("round_timer_wrap")
  if (!el) return
  const bomb = data.bomb
  const isPlanted  = !!(bomb && bomb.state === "planted")
  const isDefusing = !!(bomb && bomb.state === "defusing")
  const bombLive   = isPlanted || isDefusing
  const phase = data.phase_countdowns
  let countdown = null
  if (bombLive && bomb.countdown != null) countdown = Number(bomb.countdown)
  else if (phase && phase.phase_ends_in != null) countdown = Number(phase.phase_ends_in)

  if (countdown != null && !isNaN(countdown)) {
    timerSyncValue = countdown
    timerSyncAt = Date.now()
    if (wrap) {
      wrap.classList.toggle("topbar__timer--bomb",    isPlanted)
      wrap.classList.toggle("topbar__timer--defuse",  isDefusing)
    }
    el.innerText = formatTime(countdown)
    if (!timerTick) {
      timerTick = setInterval(() => {
        const t = document.getElementById("round_timer")
        if (!t || timerSyncValue == null || timerSyncAt == null) return
        if (Date.now() - timerSyncAt > TIMER_PAUSE_MS) return
        const elapsed = (Date.now() - timerSyncAt) / 1000
        // Целочисленное вычитание: избегаем раннего декрементирования
        const serverSec = Math.floor(timerSyncValue)
        const elapsedSec = Math.floor(elapsed)
        t.innerText = formatTime(Math.max(0, serverSec - elapsedSec))
      }, 50)
    }
  } else {
    timerSyncValue = null
    timerSyncAt = null
    if (wrap) { wrap.classList.remove("topbar__timer--bomb"); wrap.classList.remove("topbar__timer--defuse") }
    el.innerText = "0:00"
  }
}

let defuseSyncValue = null
let defuseSyncAt = null
let defuseInitial = null
let defuseTick = null

function formatDefuseMs(sec) {
  sec = Math.max(0, sec)
  const s = Math.floor(sec)
  const cs = Math.floor((sec - s) * 100)
  return s + "." + String(cs).padStart(2, "0")
}

function updateBomb(data) {
  const bomb = data.bomb
  const defuseEl = document.getElementById("defuse_timer")
  const defuseWrap = document.getElementById("defuse_timer_wrap")
  const kitBadge = document.getElementById("defuse_kit_badge")
  if (!bomb) {
    defuseSyncValue = null
    defuseSyncAt = null
    defuseInitial = null
    if (defuseWrap) defuseWrap.classList.remove("visible")
    if (defuseTick) { clearInterval(defuseTick); defuseTick = null }
    return
  }
  const defusing = bomb.state === "defusing"
  const defuseCountdown = bomb.defuse_countdown ?? bomb.defuseCountdown
  if (defuseWrap) {
    if (defusing && defuseCountdown != null) {
      const val = Number(defuseCountdown)
      // Определяем наличие кита по начальному значению (≤5.5 = с китом)
      if (defuseInitial === null) {
        defuseInitial = val
        // Показываем badge KIT если время ≤ 5.5s
        if (kitBadge) kitBadge.style.display = val <= 5.5 ? "inline-block" : "none"
      }
      defuseSyncValue = val
      defuseSyncAt = Date.now()
      defuseWrap.classList.add("visible")
      if (defuseEl) defuseEl.textContent = formatDefuseMs(val)
      if (!defuseTick) {
        defuseTick = setInterval(() => {
          if (!defuseEl || defuseSyncValue == null || defuseSyncAt == null) return
          if (Date.now() - defuseSyncAt > TIMER_PAUSE_MS) return
          const elapsed = (Date.now() - defuseSyncAt) / 1000
          const cur = Math.max(0, defuseSyncValue - elapsed)
          defuseEl.textContent = formatDefuseMs(cur)
          if (cur <= 0 && defuseTick) { clearInterval(defuseTick); defuseTick = null }
        }, 16)
      }
    } else {
      defuseWrap.classList.remove("visible")
      defuseSyncValue = null
      defuseSyncAt = null
      defuseInitial = null
      if (defuseTick) { clearInterval(defuseTick); defuseTick = null }
    }
  }

  // Defuser icon in topbar timer
  const topDefuser = document.getElementById("topbar_defuser_icon")
  if (topDefuser) topDefuser.style.display = (bomb.state === "defusing") ? "block" : "none"
}

// ── Timer progress ring ───────────────────────────────────────────────────────
let _ringState     = null   // "bomb" | "defuse" | "pause"
let _ringInitial   = null
let _ringStartAt   = null   // Date.now() when ring state began (fallback timer)
let _prevBombState = null
let _prevIsPause   = false
let _ringRafId     = null
let _ringColor     = "#ef4444"
// Pause sync (interpolated like bomb/defuse)
let _pauseSyncValue = null
let _pauseSyncAt    = null

function buildRectPath(W, H, R) {
  const hw = W / 2
  return `M${hw},0 H${W-R} A${R},${R} 0 0 1 ${W},${R} V${H-R} A${R},${R} 0 0 1 ${W-R},${H} H${R} A${R},${R} 0 0 1 0,${H-R} V${R} A${R},${R} 0 0 1 ${R},0 H${hw}`
}

function rectPerimeter(W, H, R) {
  return 2 * (W - 2*R) + 2 * (H - 2*R) + 2 * Math.PI * R
}

let _ringGeom = null  // cached { W, H, R, perim, d }

function getRingGeom() {
  const wrap = document.getElementById("round_timer_wrap")
  const W = (wrap ? wrap.offsetWidth  : 220) + 10
  const H = (wrap ? wrap.offsetHeight : 72)  + 10
  if (_ringGeom && _ringGeom.W === W && _ringGeom.H === H) return _ringGeom
  const R = 13
  const perim = rectPerimeter(W, H, R)
  const d = buildRectPath(W, H, R)
  _ringGeom = { W, H, R, perim, d }
  return _ringGeom
}

function applyRing(progress, color) {
  const svg   = document.getElementById("timer_ring_svg")
  const track = document.getElementById("timer_ring_track")
  const bar   = document.getElementById("timer_ring_bar")
  if (!svg || !track || !bar) return

  if (progress <= 0) { svg.style.display = "none"; return }

  const { W, H, perim, d } = getRingGeom()
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`)
  track.setAttribute("d", d)
  bar.setAttribute("d", d)
  track.setAttribute("stroke-dasharray", `${perim} ${perim}`)
  track.setAttribute("stroke-dashoffset", "0")
  bar.setAttribute("stroke", color)
  bar.setAttribute("stroke-dasharray", `${perim} ${perim}`)
  bar.setAttribute("stroke-dashoffset", perim * (1 - Math.max(0, Math.min(1, progress))))
  svg.style.display = "block"
}

function ringProgress() {
  const now = Date.now()
  if (_ringState === "bomb") {
    const elapsed = timerSyncAt ? (now - timerSyncAt) / 1000 : 0
    return Math.max(0, (timerSyncValue ?? 0) - elapsed) / _ringInitial
  }
  if (_ringState === "defuse") {
    // If defuseSyncValue available (from GSI), interpolate from it
    if (defuseSyncValue != null && defuseSyncAt != null) {
      const elapsed = (now - defuseSyncAt) / 1000
      return Math.max(0, defuseSyncValue - elapsed) / _ringInitial
    }
    // Fallback: count elapsed time since defuse started
    const elapsed = _ringStartAt ? (now - _ringStartAt) / 1000 : 0
    return Math.max(0, 1 - elapsed / _ringInitial)
  }
  if (_ringState === "pause") {
    const elapsed = _pauseSyncAt ? (now - _pauseSyncAt) / 1000 : 0
    return Math.max(0, (_pauseSyncValue ?? _ringInitial) - elapsed) / _ringInitial
  }
  return 0
}

function startRingRaf() {
  if (_ringRafId) return
  function tick() {
    if (!_ringState) { _ringRafId = null; applyRing(0, "#fff"); return }
    applyRing(ringProgress(), _ringColor)
    _ringRafId = requestAnimationFrame(tick)
  }
  _ringRafId = requestAnimationFrame(tick)
}

function updateTimerRing(data) {
  const bomb      = data.bomb
  const bombState = bomb?.state
  const ph        = data.phase_countdowns?.phase || ""
  const isPause   = ph === "timeout_ct" || ph === "timeout_t" || ph === "paused"

  if (bombState === "planted" && _prevBombState !== "planted") {
    _ringState = "bomb"; _ringColor = "#ef4444"
    _ringInitial = timerSyncValue || Number(bomb.countdown) || 40
    _ringStartAt = Date.now()
  } else if (bombState === "defusing" && _prevBombState !== "defusing") {
    _ringState = "defuse"; _ringColor = "#22c55e"
    _ringInitial = defuseSyncValue || Number(bomb.defuse_countdown ?? bomb.defuseCountdown) || 10
    _ringStartAt = Date.now()
  } else if (isPause && !_prevIsPause) {
    _ringState = "pause"; _ringColor = "#94a3b8"
    _ringInitial = Number(data.phase_countdowns?.phase_ends_in) || 30
    _pauseSyncValue = _ringInitial; _pauseSyncAt = Date.now()
    _ringStartAt = Date.now()
  } else if (bombState !== "planted" && bombState !== "defusing" && !isPause) {
    _ringState = null; _ringInitial = null; _ringStartAt = null
    _pauseSyncValue = null; _pauseSyncAt = null
  }

  // Update pause sync on each GSI tick
  if (_ringState === "pause") {
    const raw = Number(data.phase_countdowns?.phase_ends_in)
    if (!isNaN(raw) && raw > 0) { _pauseSyncValue = raw; _pauseSyncAt = Date.now() }
  }

  _prevBombState = bombState
  _prevIsPause   = isPause

  if (_ringState) startRingRaf()
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
    if (!p && (player.name || player.Name)) {
      p = {
        name: player.name || player.Name,
        match_stats: player.match_stats || player.Match_stats || {},
        state: player.state || player.State || {},
        weapons: player.weapons || player.Weapons || {},
        steamid: player.steamid || player.SteamId,
      }
    }
  }

  const nameEl = document.getElementById("observed_name")
  const avatarEl = document.getElementById("observed_avatar")
  const hpEl = document.getElementById("observed_hp")
  const armorIconEl = document.getElementById("observed_armor_icon")
  const weaponAmmoEl = document.getElementById("observed_weapon_ammo")
  const grenadesEl = document.getElementById("observed_grenades")
  const obsKEl = document.getElementById("obs_k")
  const obsAEl = document.getElementById("obs_a")
  const obsDEl = document.getElementById("obs_d")

  if (!p) {
    if (nameEl) nameEl.textContent = "—"
    if (hpEl) hpEl.textContent = "—"
    showWebcamFor(null)
    document.getElementById("observed")?.classList.remove("has-webcam")
    _activeWebcamSid = null
    return
  }

  if (nameEl) nameEl.textContent = p.name || "?"

  // Avatar vs webcam pool
  const observedSteamid = p.steamid || (player && (player.steamid || player.SteamId)) || null
  if (avatarEl) {
    avatarEl.src = observedSteamid
      ? (window.location.origin || "http://localhost:3000") + "/avatar/" + encodeURIComponent(observedSteamid)
      : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'/%3E"
  }
  if (observedSteamid !== _activeWebcamSid) {
    _activeWebcamSid = observedSteamid
    const hasWebcam = showWebcamFor(observedSteamid)
    const observedEl = document.getElementById("observed")
    observedEl?.classList.toggle("has-webcam", hasWebcam)
    if (avatarEl) avatarEl.style.display = hasWebcam ? "none" : "block"
  }

  const state = p.state || {}
  const health = state.health ?? 0
  const armor = state.armor ?? 0
  const helmet = state.helmet ?? false
  if (hpEl) hpEl.textContent = health

  const observedEl = document.getElementById("observed")
  if (observedEl) {
    observedEl.classList.remove("observed--ct", "observed--t")
    const team = (p.team || "").toUpperCase()
    if (team === "CT") observedEl.classList.add("observed--ct")
    else if (team === "T") observedEl.classList.add("observed--t")
  }

  const hpBarEl = document.getElementById("observed_hpbar")
  if (hpBarEl) hpBarEl.style.width = Math.max(0, Math.min(100, health)) + "%"

  if (armorIconEl) {
    if (armor > 0) {
      armorIconEl.src = "assets/weapons/" + (helmet ? "armor_helmet" : "kevlar") + ".svg"
      armorIconEl.style.opacity = "1"
      armorIconEl.style.filter = ""
    } else {
      armorIconEl.src = "assets/weapons/kevlar.svg"
      armorIconEl.style.opacity = "0.2"
      armorIconEl.style.filter = "grayscale(1)"
    }
  }

  const stats = p.match_stats || {}
  if (obsKEl) obsKEl.textContent = stats.kills ?? 0
  if (obsAEl) obsAEl.textContent = stats.assists ?? 0
  if (obsDEl) obsDEl.textContent = stats.deaths ?? 0

  const obsDefuserEl = document.getElementById("observed_defuser")
  if (obsDefuserEl) {
    const team = (p.team || "").toUpperCase()
    const hasKit = team === "CT" && !!(p.state?.defusekit)
    obsDefuserEl.style.display = hasKit ? "block" : "none"
  }

  const obsRoundKillsEl = document.getElementById("observed_round_kills")
  if (obsRoundKillsEl) {
    const rk = state.round_kills ?? 0
    obsRoundKillsEl.innerHTML = rk > 0
      ? "<img src='assets/weapons/kill-star.png' class='player__kill-star' alt=''>".repeat(rk)
      : ""
  }

  // Используем data.player.weapons для ammo (в allplayers ammo_clip не передаётся)
  const rawWeapons = (data.player && data.player.weapons) || p.weapons || {}
  let activeWeapon = null
  for (const slot in rawWeapons) {
    const w = rawWeapons[slot]
    if (!w || typeof w !== "object") continue
    if ((w.state || "").toLowerCase() === "active") { activeWeapon = w; break }
  }

  updateObsAmmo(weaponAmmoEl, activeWeapon)

  if (grenadesEl) {
    // classifyWeapons определён в players.js (загружается после, но вызывается при событии)
    const { grenades } = classifyWeapons({ weapons: rawWeapons })
    grenadesEl.innerHTML = grenades.map(g =>
      `<div class="obs-grenade${g.isActive ? " active" : ""}">
        <img src="assets/weapons/${g.name}.svg" alt="${g.name}" onerror="this.style.display='none'">
        ${g.count > 1 ? `<span class="obs-grenade__count">${g.count}</span>` : ""}
      </div>`
    ).join("")
  }
}

function updateObsAmmo(weaponAmmoEl, activeWeapon) {
  if (!weaponAmmoEl) return
  if (!activeWeapon) {
    weaponAmmoEl.innerHTML = ""
    _obsWeaponName = null
    _obsDisplayedClip = null
    if (_obsClipAnimTimer) { clearInterval(_obsClipAnimTimer); _obsClipAnimTimer = null }
    return
  }

  const wName = String(activeWeapon.name || "").replace(/^weapon_/i, "")
  const targetClip = activeWeapon.ammo_clip ?? null
  const reserve = activeWeapon.ammo_reserve

  if (wName !== _obsWeaponName) {
    // Сменили оружие — пересоздаём DOM
    _obsWeaponName = wName
    _obsDisplayedClip = targetClip
    if (_obsClipAnimTimer) { clearInterval(_obsClipAnimTimer); _obsClipAnimTimer = null }
    weaponAmmoEl.innerHTML = ""
    const obsDiv = document.createElement("div")
    obsDiv.className = "obs-weapon"
    const img = document.createElement("img")
    img.className = "obs-weapon__icon"
    img.src = "assets/weapons/" + wName + ".svg"
    img.alt = wName
    img.onerror = function() { this.style.display = "none" }
    obsDiv.appendChild(img)
    if (targetClip != null) {
      const ammoDiv = document.createElement("div")
      ammoDiv.className = "obs-weapon__ammo"
      const clipSpan = document.createElement("span")
      clipSpan.className = "obs-weapon__clip"
      clipSpan.textContent = targetClip
      const sepSpan = document.createElement("span")
      sepSpan.className = "obs-weapon__sep"
      sepSpan.textContent = "/"
      const resSpan = document.createElement("span")
      resSpan.className = "obs-weapon__reserve"
      resSpan.textContent = reserve ?? ""
      ammoDiv.appendChild(clipSpan)
      ammoDiv.appendChild(sepSpan)
      ammoDiv.appendChild(resSpan)
      obsDiv.appendChild(ammoDiv)
    }
    weaponAmmoEl.appendChild(obsDiv)
    return
  }

  // То же оружие — обновляем только числа
  const reserveEl = weaponAmmoEl.querySelector(".obs-weapon__reserve")
  if (reserveEl && reserve != null) reserveEl.textContent = reserve

  const clipEl = weaponAmmoEl.querySelector(".obs-weapon__clip")
  if (!clipEl || targetClip == null) return

  if (_obsDisplayedClip === null || _obsDisplayedClip <= targetClip) {
    // Перезарядка или первый раз — мгновенно
    _obsDisplayedClip = targetClip
    clipEl.textContent = targetClip
    if (_obsClipAnimTimer) { clearInterval(_obsClipAnimTimer); _obsClipAnimTimer = null }
  } else if (_obsDisplayedClip > targetClip) {
    // Патроны убыли — анимируем обратный отсчёт
    if (_obsClipAnimTimer) { clearInterval(_obsClipAnimTimer); _obsClipAnimTimer = null }
    const steps = _obsDisplayedClip - targetClip
    const interval = Math.min(80, Math.floor(250 / steps))
    _obsClipAnimTimer = setInterval(() => {
      if (_obsDisplayedClip > targetClip) {
        _obsDisplayedClip--
        clipEl.textContent = _obsDisplayedClip
      } else {
        clearInterval(_obsClipAnimTimer)
        _obsClipAnimTimer = null
      }
    }, interval)
  }
}

function resolveName(allplayers, steamid, fallbackName) {
  if (!allplayers) return fallbackName || "?"
  if (steamid && allplayers[steamid] && allplayers[steamid].name) return allplayers[steamid].name
  return fallbackName || "?"
}

function updateKillfeed(data) {
  const recent = data.recent_kills || data.kill_feed
  const all = data.allplayers || {}
  const round = data.round

  if (Array.isArray(recent)) {
    // Если массив стал короче — начался новый раунд, сбрасываем счётчик
    if (recent.length < lastRecentKillsLength) {
      lastRecentKillsLength = 0
    }
    for (let i = lastRecentKillsLength; i < recent.length; i++) {
      const k = recent[i]
      const weapon = String(k.weapon || "unknown").replace(/^weapon_/i, "")
      const killerName = resolveName(all, k.killer_steamid, k.killer_name)
      const victimName = resolveName(all, k.victim_steamid, k.victim_name)
      // Команды: берём из данных убийства (сервер присылает), или фоллбэк через allplayers
      const killerTeam = k.killer_team || all[k.killer_steamid]?.team || ""
      const victimTeam = k.victim_team || all[k.victim_steamid]?.team || ""
      let assist = null
      if (k.assister_steamid || k.assister_name) {
        const assistName = resolveName(all, k.assister_steamid, k.assister_name)
        const type = (k.assist_type || "").toLowerCase()
        assist = { name: assistName, steamid: k.assister_steamid, team: k.assister_team || "", type: type === "flash" ? "flash" : "damage" }
      }
      addKill(killerName, victimName, weapon, assist, {
        headshot:      !!k.headshot,
        blind:         !!k.blind,
        noscope:       !!k.noscope,
        wallbang:      !!k.wallbang,
        through_smoke: !!k.through_smoke,
        killerTeam,
        victimTeam,
      })
    }
    lastRecentKillsLength = recent.length
    return
  }

  // Фолбэк: нет recent_kills — читаем round_kills из состояний игроков
  lastRecentKillsLength = 0
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
  if (round.phase === "over" || round.phase === "freezetime") {
    lastProcessedKillCount = 0
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

// ── Team grenades panel ───────────────────────────────────────────────────────

const TG_TYPES = [
  { key: "he",    names: ["hegrenade"],              icon: "hegrenade"    },
  { key: "flash", names: ["flashbang"],              icon: "flashbang"    },
  { key: "smoke", names: ["smokegrenade"],           icon: "smokegrenade" },
  { key: "molo",  names: ["molotov", "incgrenade"], icon: "molotov"      },
]

function updateTeamGrenades(data) {
  _renderTeamGrenades(data)
}

function _renderTeamGrenades(data) {
  const all    = data.allplayers || {}
  const counts = { CT: {}, T: {} }

  for (const id in all) {
    const p = all[id]
    if ((p.state?.health ?? 0) <= 0) continue
    const side = p.team === "CT" ? "CT" : "T"
    for (const slot in (p.weapons || {})) {
      const wname = String(p.weapons[slot]?.name || "").replace(/^weapon_/i, "").toLowerCase()
      for (const g of TG_TYPES) {
        if (g.names.includes(wname)) counts[side][g.key] = (counts[side][g.key] ?? 0) + 1
      }
    }
  }

  const ctEl = document.getElementById("tg_ct")
  const tEl  = document.getElementById("tg_t")
  if (ctEl) ctEl.innerHTML = _buildTgHtml(counts.CT)
  if (tEl)  tEl.innerHTML  = _buildTgHtml(counts.T)
}

function _buildTgHtml(counts) {
  return TG_TYPES.map(g => {
    const n = counts[g.key] ?? 0
    return `<div class="tg-item${n === 0 ? " tg-item--empty" : ""}">
  <img class="tg-icon" src="assets/weapons/${g.icon}.svg" alt="">
  <span class="tg-count">${n}</span>
</div>`
  }).join("")
}

// ── Round stats overlay ───────────────────────────────────────────────────────

const _adrTotalDmg    = {}   // steamid → суммарный урон за все раунды
const _adrRoundPeak   = {}   // steamid → максимальный round_totaldmg в текущем раунде
let _adrPrevScore     = -1   // предыдущий ctScore + tScore
let _adrRoundsCounted = 0    // сколько раундов мы зафиксировали

function updateAdrTracking(data) {
  const phase = data.phase_countdowns?.phase || data.round?.phase
  const score = (data.map?.team_ct?.score ?? 0) + (data.map?.team_t?.score ?? 0)
  const all   = data.allplayers || {}

  // Во время live накапливаем максимальный round_totaldmg — тот же источник что DiR
  if (phase === "live") {
    for (const id in all) {
      const sid = all[id].steamid || id
      const dmg = all[id].state?.round_totaldmg ?? 0
      if (dmg > (_adrRoundPeak[sid] ?? 0)) _adrRoundPeak[sid] = dmg
    }
  }

  // Счёт вырос → раунд завершился, фиксируем накопленный DiR каждого игрока
  if (_adrPrevScore >= 0 && score > _adrPrevScore) {
    _adrRoundsCounted++
    for (const id in all) {
      const sid = all[id].steamid || id
      _adrTotalDmg[sid] = (_adrTotalDmg[sid] ?? 0) + (_adrRoundPeak[sid] ?? 0)
    }
    for (const k in _adrRoundPeak) delete _adrRoundPeak[k]
  }

  _adrPrevScore = score
}

function getAdr(sid) {
  if (!_adrRoundsCounted) return null
  return Math.round((_adrTotalDmg[sid] ?? 0) / _adrRoundsCounted)
}

let _statsVisible      = false
let _statsHiding       = false
let _statsRendered     = false
let _statsHiddenFreeze = false  // true = already hidden this freeze period, don't re-show

function _showRoundStats(el) {
  el.style.display = "flex"
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-visible")))
}

function _hideRoundStats(el) {
  if (_statsHiding) return
  _statsHiding = true
  el.classList.remove("is-visible")
  setTimeout(() => {
    el.style.display = "none"
    _statsVisible  = false
    _statsHiding   = false
    _statsRendered = false
  }, 400)
}

function updateRoundStats(data) {
  updateAdrTracking(data)
  const phase       = data.phase_countdowns?.phase
  const phaseEndsIn = Number(data.phase_countdowns?.phase_ends_in ?? Infinity)
  const isFreeze    = phase === "freezetime"
  const el          = document.getElementById("round_stats")
  if (!el) return

  if (isFreeze) {
    if (!_statsVisible && !_statsHiding && !_statsHiddenFreeze) {
      _statsVisible = true
      _showRoundStats(el)
    }
    if (!_statsRendered && _statsVisible) {
      _renderRoundStats(data)
      _statsRendered = true
    }
    // Hide 3s before round starts — set flag so we don't re-show on next GSI tick
    if (phaseEndsIn <= 3 && !_statsHiding) {
      _statsHiddenFreeze = true
      _hideRoundStats(el)
    }
  } else {
    // Phase changed away from freezetime — reset flag for next round
    _statsHiddenFreeze = false
    if (_statsVisible && !_statsHiding) _hideRoundStats(el)
  }
}

function _renderRoundStats(data) {
  const all  = data.allplayers || {}
  const ctEl = document.getElementById("round_stats_ct")
  const tEl  = document.getElementById("round_stats_t")
  if (!ctEl || !tEl) return
  const ct = [], t = []
  for (const id in all) {
    const p = all[id]
    ;(p.team === "CT" ? ct : t).push({ ...p, _id: id })
  }
  function sortPlayers(arr) {
    arr.sort((a, b) => {
      const ka = a.match_stats?.kills ?? 0,  kb = b.match_stats?.kills ?? 0
      if (kb !== ka) return kb - ka
      const da = a.match_stats?.deaths ?? 0, db = b.match_stats?.deaths ?? 0
      const kda = da > 0 ? ka / da : ka,     kdb = db > 0 ? kb / db : kb
      if (Math.abs(kdb - kda) > 0.001) return kdb - kda
      return (getAdr(b.steamid || b._id) ?? 0) - (getAdr(a.steamid || a._id) ?? 0)
    })
  }
  sortPlayers(ct)
  sortPlayers(t)
  ctEl.innerHTML = _buildTeamHtml(ct, "CT")
  tEl.innerHTML  = _buildTeamHtml(t, "T")
}

function _buildTeamHtml(players, side) {
  const label  = side === "CT" ? "Counter-Terrorists" : "Terrorists"
  const origin = window.location.origin || "http://localhost:3000"
  const blank  = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'/%3E"
  const header = `<div class="round-stats__team-header">${label}</div>
<div class="round-stats__col-header">
  <span></span>
  <span class="round-stats__col-lbl">PLAYER</span>
  <span class="round-stats__col-lbl">K</span>
  <span class="round-stats__col-lbl">A</span>
  <span class="round-stats__col-lbl">D</span>
  <span class="round-stats__col-lbl">K/D</span>
</div>`
  const rows = players.map(p => {
    const sid  = p.steamid || p._id
    const s    = p.match_stats || {}
    const k    = s.kills   ?? 0
    const a    = s.assists ?? 0
    const d    = s.deaths  ?? 0
    const kd   = d > 0 ? (k / d).toFixed(2) : (k > 0 ? k + ".00" : "0.00")
    const adr  = getAdr(sid) ?? "-"
    const av   = sid ? `${origin}/avatar/${encodeURIComponent(sid)}` : blank
    const name = String(p.name || "?").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    return `<div class="round-stats__row">
  <img class="round-stats__avatar" src="${av}" onerror="this.src='${blank}'" alt="">
  <span class="round-stats__name">${name}</span>
  <span class="round-stats__stat round-stats__stat--k">${k}</span>
  <span class="round-stats__stat round-stats__stat--a">${a}</span>
  <span class="round-stats__stat round-stats__stat--d">${d}</span>
  <span class="round-stats__stat round-stats__stat--kd">${kd}</span>
</div>`
  }).join("")
  return header + rows
}
