const KILLFEED_MAX = 6

/**
 * @param {string} attacker
 * @param {string} victim
 * @param {string} weapon
 * @param {{ name: string, steamid?: string, team?: string, type: 'flash'|'damage' }|null} assist
 * @param {{ headshot?: boolean, blind?: boolean, noscope?: boolean, wallbang?: boolean, through_smoke?: boolean, killerTeam?: string, victimTeam?: string }} flags
 */
function addKill(attacker, victim, weapon, assist, flags) {
  const feed = document.getElementById("killfeed")
  if (!feed) return

  while (feed.children.length >= KILLFEED_MAX) {
    feed.removeChild(feed.firstChild)
  }

  const weaponName     = (weapon || "unknown").replace(/^weapon_/i, "")
  const isHeadshot     = flags?.headshot      === true
  const isBlind        = flags?.blind         === true
  const isNoscope      = flags?.noscope       === true
  const isWallbang     = flags?.wallbang      === true
  const isThroughSmoke = flags?.through_smoke === true
  const killerTeam     = (flags?.killerTeam   || "").toUpperCase()
  const victimTeam     = (flags?.victimTeam   || "").toUpperCase()

  const div = document.createElement("div")
  div.className = "kill"

  const row = document.createElement("div")
  row.className = "kill__row"

  // ── Убийца ──
  const killerSpan = document.createElement("span")
  killerSpan.className = "kill__killer"
  if (killerTeam === "CT") killerSpan.classList.add("kill__name--ct")
  else if (killerTeam === "T") killerSpan.classList.add("kill__name--t")
  killerSpan.textContent = truncateName(attacker || "?")
  row.appendChild(killerSpan)

  // ── Ассист (инлайн, рядом с убийцей) ──
  if (assist && assist.name) {
    const plus = document.createElement("span")
    plus.className = "kill__plus"
    plus.textContent = "+"
    row.appendChild(plus)

    const assistSpan = document.createElement("span")
    assistSpan.className = "kill__assister"
    const assistTeam = (assist.team || "").toUpperCase()
    if (assistTeam === "CT") assistSpan.classList.add("kill__name--ct")
    else if (assistTeam === "T") assistSpan.classList.add("kill__name--t")

    if (assist.type === "flash") {
      const fi = document.createElement("img")
      fi.className = "kill__assist-icon"
      fi.src = "assets/weapons/flashbang_assist.svg"
      fi.alt = ""
      fi.onerror = function () { this.style.display = "none" }
      assistSpan.appendChild(fi)
    }

    assistSpan.appendChild(document.createTextNode(truncateName(assist.name)))
    row.appendChild(assistSpan)
  }

  // ── Пре-модификаторы (до оружия): blind, smoke, wallbang, noscope ──
  if (isBlind) {
    const mi = document.createElement("img")
    mi.className = "kill__mod"
    mi.src = "assets/weapons/Blind_kill.png"
    mi.alt = "Blind"
    mi.onerror = function () { this.style.display = "none" }
    row.appendChild(mi)
  }
  if (isThroughSmoke) {
    const mi = document.createElement("img")
    mi.className = "kill__mod"
    mi.src = "assets/weapons/Smoke_kill.png"
    mi.alt = "Smoke"
    mi.onerror = function () { this.style.display = "none" }
    row.appendChild(mi)
  }
  if (isWallbang) {
    const mi = document.createElement("img")
    mi.className = "kill__mod"
    mi.src = "assets/weapons/Csgo_icon-penetrate.png"
    mi.alt = "WB"
    mi.onerror = function () { this.style.display = "none" }
    row.appendChild(mi)
  }
  if (isNoscope) {
    const mi = document.createElement("img")
    mi.className = "kill__mod"
    mi.src = "assets/weapons/Noscope_kill.png"
    mi.alt = "NSP"
    mi.onerror = function () { this.style.display = "none" }
    row.appendChild(mi)
  }

  // ── Оружие ──
  const weaponImg = document.createElement("img")
  weaponImg.className = "kill__weapon"
  weaponImg.src = "assets/weapons/" + weaponName + ".svg"
  weaponImg.alt = ""
  weaponImg.onerror = function () { this.style.display = "none" }
  row.appendChild(weaponImg)

  // ── Пост-модификатор: headshot (после оружия) ──
  if (isHeadshot) {
    const hsImg = document.createElement("img")
    hsImg.className = "kill__hs"
    hsImg.src = "assets/weapons/headshot_kill.png"
    hsImg.alt = "HS"
    hsImg.onerror = function () { this.style.display = "none" }
    row.appendChild(hsImg)
  }

  // ── Жертва ──
  const victimSpan = document.createElement("span")
  victimSpan.className = "kill__victim"
  if (victimTeam === "CT") victimSpan.classList.add("kill__name--ct-dim")
  else if (victimTeam === "T") victimSpan.classList.add("kill__name--t-dim")
  victimSpan.textContent = truncateName(victim || "?")
  row.appendChild(victimSpan)

  div.appendChild(row)

  feed.appendChild(div)
  setTimeout(() => div.remove(), 7000)
}
