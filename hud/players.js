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

function updatePlayers(data) {
  if (!data.allplayers) return

  let ctHTML = ""
  let tHTML = ""

  for (const id in data.allplayers) {
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

    const deadClass = health <= 0 ? " player--dead" : ""

    const html = `<div class="player ${teamClass}${deadClass}">
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
      ${roundKills > 0 ? `<div class="player__round-kills">${"<img src='assets/weapons/kill-star.png' class='player__kill-star' alt=''>".repeat(roundKills)}</div>` : ""}
    </div>`

    if (team === "CT") ctHTML += html
    else tHTML += html
  }

  document.getElementById("players_ct").innerHTML = ctHTML
  document.getElementById("players_t").innerHTML = tHTML
}
