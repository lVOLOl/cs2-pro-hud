const socket = io({ transports: ["websocket", "polling"] })

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
  updateMinimap(lastState)
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

function updateRound(data) {
  const el = document.getElementById("round_timer")
  const wrap = document.getElementById("round_timer_wrap")
  if (!el) return
  const bomb = data.bomb
  const bombLive = !!(bomb && (bomb.state === "planted" || bomb.state === "defusing"))
  const phase = data.phase_countdowns
  let countdown = null
  if (bombLive && bomb.countdown != null) countdown = Number(bomb.countdown)
  else if (phase && phase.phase_ends_in != null) countdown = Number(phase.phase_ends_in)

  if (countdown != null && !isNaN(countdown)) {
    timerSyncValue = countdown
    timerSyncAt = Date.now()
    if (wrap) wrap.classList.toggle("topbar__timer--bomb", bombLive)
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
    if (wrap) wrap.classList.remove("topbar__timer--bomb")
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
    return
  }

  if (nameEl) nameEl.textContent = p.name || "?"
  if (avatarEl) {
    avatarEl.src = p.steamid
      ? (window.location.origin || "http://localhost:3000") + "/avatar/" + encodeURIComponent(p.steamid)
      : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56'/%3E"
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
