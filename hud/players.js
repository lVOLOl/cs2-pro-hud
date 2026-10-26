const PRIMARY_WEAPON_TYPES = new Set(["Rifle", "Submachine Gun", "Shotgun", "Sniper Rifle", "Machine Gun"])
const GRENADE_ORDER = ["hegrenade", "flashbang", "smokegrenade", "molotov", "incgrenade", "decoy"]

// Fallback: если GSI не прислал поле type (случается при подборе/получении оружия),
// определяем категорию по имени оружия.
const WEAPON_TYPE_BY_NAME = {
  // Rifles
  ak47: "Rifle", m4a1: "Rifle", m4a1_silencer: "Rifle", m4a1_silencer_off: "Rifle",
  famas: "Rifle", galilar: "Rifle", aug: "Rifle", sg556: "Rifle",
  // Sniper
  awp: "Sniper Rifle", ssg08: "Sniper Rifle", g3sg1: "Sniper Rifle", scar20: "Sniper Rifle",
  // SMG
  mac10: "Submachine Gun", mp9: "Submachine Gun", mp5sd: "Submachine Gun",
  mp7: "Submachine Gun", ump45: "Submachine Gun", p90: "Submachine Gun", bizon: "Submachine Gun",
  // Shotgun
  nova: "Shotgun", xm1014: "Shotgun", sawedoff: "Shotgun", mag7: "Shotgun",
  // MG
  m249: "Machine Gun", negev: "Machine Gun",
  // Pistols
  glock: "Pistol", usp_silencer: "Pistol", usp_silencer_off: "Pistol",
  p2000: "Pistol", hkp2000: "Pistol", p250: "Pistol", fiveseven: "Pistol",
  cz75a: "Pistol", tec9: "Pistol", deagle: "Pistol", revolver: "Pistol", elite: "Pistol",
  // Grenades (включая CS2-варианты имён)
  hegrenade: "Grenade", flashbang: "Grenade", smokegrenade: "Grenade",
  molotov: "Grenade", incgrenade: "Grenade", firebomb: "Grenade", decoy: "Grenade",
  // Special
  c4: "C4", planted_c4: "C4", defuser: "Equipment", taser: "Equipment",
  // Knives — все варианты
  knife: "Knife", knife_t: "Knife", bayonet: "Knife", melee: "Knife",
  knife_bowie: "Knife", knife_butterfly: "Knife", knife_canis: "Knife",
  knife_cord: "Knife", knife_css: "Knife", knife_falchion: "Knife",
  knife_flip: "Knife", knife_gut: "Knife", knife_gypsy_jackknife: "Knife",
  knife_karambit: "Knife", knife_kukri: "Knife", knife_m9_bayonet: "Knife",
  knife_outdoor: "Knife", knife_push: "Knife", knife_skeleton: "Knife",
  knife_stiletto: "Knife", knife_survival_bowie: "Knife", knife_tactical: "Knife",
  knife_twinblade: "Knife", knife_ursus: "Knife", knife_widowmaker: "Knife",
  knifegg: "Knife",
}

function truncateName(name, max = 12) {
  if (!name) return "?"
  return name.length > max ? name.slice(0, max) + "…" : name
}

function getSteamAvatar(steamid) {
  if (!steamid) return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'/%3E"
  return (window.location.origin || "http://localhost:3000") + "/avatar/" + encodeURIComponent(steamid)
}

function classifyWeapons(player) {
  const weapons = player.weapons || {}
  let primary = null
  let pistol = null
  const grenadesMap = {}
  let hasBomb = false
  let hasDefuser = !!(player.state?.defusekit)
  let activeName = null

  for (const slot in weapons) {
    const w = weapons[slot]
    if (!w || typeof w !== "object") continue
    // Нормализуем имя: убираем префикс weapon_, приводим к нижнему регистру
    const name = String(w.name || "").replace(/^weapon_/i, "").toLowerCase().replace(/[^a-z0-9_]/g, "")
    if (!name) continue
    // type: сначала берём из GSI, если пустой или неизвестный — ищем по имени
    const rawType = String(w.type || "").trim().replace("SniperRifle", "Sniper Rifle").replace("SubmachineGun", "Submachine Gun").replace("MachineGun", "Machine Gun")
    const knownTypes = new Set(["Rifle", "Submachine Gun", "Shotgun", "Sniper Rifle", "Machine Gun", "Pistol", "Grenade", "C4", "Equipment", "Knife"])
    const type = (rawType && knownTypes.has(rawType)) ? rawType : (WEAPON_TYPE_BY_NAME[name] || "")
    const state = (w.state || "").toLowerCase()
    const isActive = state === "active"
    if (isActive) activeName = name

    if (name === "c4" || type === "C4") { hasBomb = true; continue }
    if (name === "defuser" || (type === "Equipment" && name !== "taser")) { hasDefuser = true; continue }
    if (type === "Knife") continue

    if (PRIMARY_WEAPON_TYPES.has(type)) {
      primary = { name, isActive }
    } else if (type === "Pistol") {
      pistol = { name, isActive }
    } else if (type === "Grenade") {
      if (!grenadesMap[name]) grenadesMap[name] = { count: 0, isActive: false }
      grenadesMap[name].count++
      if (isActive) grenadesMap[name].isActive = true
    }
  }

  const grenades = []
  for (const g of GRENADE_ORDER) {
    if (grenadesMap[g]) grenades.push({ name: g, ...grenadesMap[g] })
  }
  for (const name in grenadesMap) {
    if (!GRENADE_ORDER.includes(name)) grenades.push({ name, ...grenadesMap[name] })
  }

  return { primary, pistol, grenades, hasBomb, hasDefuser, activeName }
}

const _deadPlayers = new Set()

// ── Card style: "classic" | "blast" (переключается в админке → settings.card_style) ──
let _cardStyle = "classic"

function setCardStyle(style) {
  const next = style === "blast" ? "blast" : "classic"
  document.body.classList.toggle("cards--blast", next === "blast")
  if (next === _cardStyle) return
  _cardStyle = next
  _deadPlayers.clear()
  if (typeof lastState !== "undefined" && lastState) updatePlayers(lastState)
}

const BCARD_ICONS = {
  heart: `<svg viewBox="0 0 24 24" class="bcard__ico"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`,
  kills: `<svg viewBox="0 0 24 24" class="bcard__ico"><g fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="7.5"/><path d="M12 1.5v6M12 16.5v6M1.5 12h6M16.5 12h6"/></g><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>`,
  deaths: `<svg viewBox="0 0 24 24" class="bcard__ico"><path fill="currentColor" d="M12 2C6.9 2 3 5.7 3 10.4c0 2.8 1.4 5.2 3.6 6.7V20c0 1.1.9 2 2 2h6.8c1.1 0 2-.9 2-2v-2.9c2.2-1.5 3.6-3.9 3.6-6.7C21 5.7 17.1 2 12 2zm-3.6 12.2a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4zm7.2 0a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4zM10 18.5h1.2V21H10zm2.8 0H14V21h-1.2z"/></svg>`,
}

function _weaponImg(name, cls) {
  return `<img class="${cls}" src="assets/weapons/${name}.svg" alt="" onerror="this.style.display='none'">`
}

function buildBlastCard(id, p, team, observedSid) {
  const state = p.state || {}
  const health = state.health ?? 0
  const armor = state.armor ?? 0
  const helmet = state.helmet ?? false
  const ms = p.match_stats || {}
  const money = (state.money ?? state.Money) ?? 0
  const roundKills = state.round_kills ?? 0
  const roundDmg = state.round_totaldmg ?? 0
  const isDead = health <= 0
  const sideCls = team === "CT" ? "bcard--ct" : "bcard--t"

  const { primary, pistol, grenades, hasBomb, hasDefuser, activeName } = classifyWeapons(p)
  const main = primary || pistol

  const weaponHTML = main
    ? `<div class="bcard__weapon${main.isActive ? " active" : ""}">${_weaponImg(main.name, "bcard__weapon-img")}</div>`
    : `<div class="bcard__weapon"></div>`

  const grenHTML = grenades.map(g => {
    let out = ""
    for (let i = 0; i < g.count; i++) {
      out += `<div class="bcard__gren${g.isActive ? " active" : ""}">${_weaponImg(g.name, "")}</div>`
    }
    return out
  }).join("")

  const armorHTML = armor > 0
    ? _weaponImg(helmet ? "armor_helmet" : "kevlar", "bcard__armor")
    : ""

  let badgeHTML = ""
  if (hasBomb) badgeHTML += `<div class="bcard__badge bcard__badge--bomb${activeName === "c4" ? " active" : ""}"><span class="bcard__badge-ico"></span></div>`
  if (team === "CT" && hasDefuser) badgeHTML += `<div class="bcard__badge bcard__badge--kit"><span class="bcard__badge-ico"></span></div>`

  const slot = p.observer_slot ?? ""
  const slotLabel = slot === "" ? "" : String((Number(slot) + 1) % 10)   // клавиша, которой выбирают игрока
  const name = truncateName(p.name || "?", 14).replace(/</g, "&lt;")
  const observedCls = observedSid && String(p.steamid) === String(observedSid) ? " bcard--observed" : ""
  const deadCls = (isDead && _deadPlayers.has(id)) ? " bcard--dead" : ""

  const hpBlock = isDead
    ? `<div class="bcard__hp bcard__hp--dir"><span class="bcard__dir-val">${roundDmg}</span><span class="bcard__dir-lbl">DiR</span></div>`
    : `<div class="bcard__hp">${armorHTML}<span>${health}</span></div>`

  return `<div class="bcard ${sideCls}${deadCls}${observedCls}" data-pid="${id}">
    <div class="bcard__photo">
      <img class="bcard__avatar" src="${getSteamAvatar(p.steamid)}" alt="">
      <div class="bcard__badges">${badgeHTML}</div>
      ${roundKills > 0 ? `<div class="bcard__rk">${roundKills}</div>` : ""}
    </div>
    <div class="bcard__head">
      <div class="bcard__hpfill" style="width:${Math.max(0, Math.min(100, health))}%"></div>
      <div class="bcard__head-right">
        ${hpBlock}
        <div class="bcard__name">${name}</div>
      </div>
    </div>
    <div class="bcard__stats">
      <span class="bcard__stat bcard__stat--k">${BCARD_ICONS.kills}${ms.kills ?? 0}</span>
      <span class="bcard__stat bcard__stat--d">${BCARD_ICONS.deaths}${ms.deaths ?? 0}</span>
      <span class="bcard__money">$${money}</span>
    </div>
    <div class="bcard__loadout">
      ${weaponHTML}
      <div class="bcard__grens">${grenHTML}</div>
    </div>
  </div>`
}

// observer_slot в GSI с нуля: слот 0 = клавиша 1 (первый), слот 9 = клавиша 0 (последний)
function _slotOrder(p) {
  const s = Number(p.observer_slot)
  return Number.isFinite(s) ? s : 99
}

function updatePlayers(data) {
  if (!data.allplayers) return

  let ctHTML = ""
  let tHTML = ""
  const nowDead = new Set()
  const newlyDied = []
  const isBlast = _cardStyle === "blast"
  const observedSid = data.player?.steamid || data.player?.SteamId || null
  let ids = Object.keys(data.allplayers)
  if (isBlast) ids.sort((a, b) => _slotOrder(data.allplayers[a]) - _slotOrder(data.allplayers[b]))

  for (const id of ids) {
    const p = data.allplayers[id]
    const state = p.state || {}
    const health = state.health ?? 0
    const armor = state.armor ?? 0
    const helmet = state.helmet ?? false
    const matchStats = p.match_stats || {}
    const kills = matchStats.kills ?? 0
    const deaths = matchStats.deaths ?? 0
    const money = (state.money ?? state.Money) ?? 0
    const roundKills = state.round_kills ?? 0
    const roundDmg = state.round_totaldmg ?? 0

    let team = String(p.team || "").toUpperCase()
    if (team === "COUNTER-TERRORIST" || team === "0") team = "CT"
    else if (team === "TERRORIST" || team === "1") team = "T"
    const teamClass = team === "CT" ? "player--ct" : "player--t"

    const { primary, pistol, grenades, hasBomb, hasDefuser, activeName } = classifyWeapons(p)

    // Основной слот: показываем primary, или pistol если нет primary
    const effectivePrimary = primary || (pistol && !primary ? pistol : null)
    const showPistolSeparate = primary && pistol

    let primaryHTML = ""
    if (effectivePrimary) {
      primaryHTML = `<div class="player__wslot player__wslot--primary${effectivePrimary.isActive ? " active" : ""}">
        <img src="assets/weapons/${effectivePrimary.name}.svg" alt="" onerror="this.style.display='none'">
      </div>`
    }

    let pistolHTML = ""
    if (showPistolSeparate) {
      pistolHTML = `<div class="player__wslot player__wslot--pistol${pistol.isActive ? " active" : ""}">
        <img src="assets/weapons/${pistol.name}.svg" alt="" onerror="this.style.display='none'">
      </div>`
    }

    const grenadesHTML = grenades.map(g =>
      `<div class="player__gren${g.isActive ? " active" : ""}">
        <img src="assets/weapons/${g.name}.svg" alt="" onerror="this.style.display='none'">
        ${g.count > 1 ? `<span class="player__gren-count">${g.count}</span>` : ""}
      </div>`
    ).join("")

    const armorHTML = armor > 0
      ? `<img class="player__armor" src="assets/weapons/${helmet ? "armor_helmet" : "kevlar"}.svg" alt="">`
      : `<img class="player__armor player__armor--none" src="assets/weapons/kevlar.svg" alt="">`

    let specialHTML = ""
    if (hasBomb) {
      const isBombActive = activeName === "c4"
      specialHTML = `<div class="player__special${isBombActive ? " active" : ""}">
        <img src="assets/weapons/c4.svg" alt="bomb" onerror="this.style.display='none'">
      </div>`
    }
    if (team === "CT" && hasDefuser) {
      specialHTML += `<div class="player__special active">
        <img src="assets/weapons/defuser.svg" alt="kit" onerror="this.style.display='none'">
      </div>`
    }

    const isDead = health <= 0
    if (isDead) {
      nowDead.add(id)
      if (!_deadPlayers.has(id)) newlyDied.push(id)
    }
    const deadClass = (isDead && _deadPlayers.has(id)) ? " player--dead" : ""

    if (isBlast) {
      const bhtml = buildBlastCard(id, p, team, observedSid)
      if (team === "CT") ctHTML += bhtml
      else tHTML += bhtml
      continue
    }

    const html = `<div class="player ${teamClass}${deadClass}" data-pid="${id}">
      <div class="player__accent"></div>
      <div class="player__avatar_money-wrap">
        <div class="player__avatar-wrap">
          <img class="player__avatar" src="${getSteamAvatar(p.steamid)}" alt="">
        </div>
        <div class="player__money">$${money}</div>
      </div>
      <div class="player__body">
        <div class="player__top">
          <span class="player__name">${truncateName(p.name || "?").replace(/</g, "&lt;")}</span>
          <div class="player__kd">
            <div class="player__kd__KAD">
              <span class="player__kd-k">${kills}</span><span class="player__kd-sep">/</span><span class="player__kd-d">${deaths}</span>
            </div>
            <div class="player__kd__HP">
              ${health <= 0
                ? `<span class="player__HP player__HP--dir"><span class="player__dir-val">${roundDmg}</span><span class="player__dir-lbl">DiR</span></span>`
                : `<span class="player__HP"><img src="assets/weapons/hp.svg" alt="" srcset="">${health}</span>`
              }
            </div>
          </div>
        </div>
        <div class="player__loadout">
          ${primaryHTML}
          ${pistolHTML}
          <div class="player__grenades">${grenadesHTML}</div>
          <div class="player__equip">
            ${armorHTML}
            ${specialHTML}
          </div>
        </div>
      </div>
      <div class="player__hpbar" style="width:${health}%"></div>
      ${roundKills > 0 ? `<div class="player__round-kills"><span class="player__rk-badge">${roundKills}</span></div>` : ""}
    </div>`

    if (team === "CT") ctHTML += html
    else tHTML += html
  }

  document.getElementById("players_ct").innerHTML = ctHTML
  document.getElementById("players_t").innerHTML = tHTML

  // Trigger death transition for players who just died this tick
  for (const pid of newlyDied) {
    const el = document.querySelector(`.players [data-pid="${pid}"]`)
    if (el) {
      void el.offsetWidth
      el.classList.add(isBlast ? "bcard--dead" : "player--dead")
    }
  }

  _deadPlayers.clear()
  for (const pid of nowDead) _deadPlayers.add(pid)
}
