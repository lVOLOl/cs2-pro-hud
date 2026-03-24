/**
 * Добавляет запись в киллфид.
 * @param {string} attacker - имя убийцы
 * @param {string} victim - имя жертвы
 * @param {string} weapon - имя оружия (без weapon_), для иконки assets/weapons/{weapon}.svg
 * @param {{ name: string, type: 'flash'|'damage' }|null} assist - ассист (флеш или урон)
 */
function addKill(attacker, victim, weapon, assist) {
  const div = document.createElement("div")
  div.className = "kill"
  const weaponName = (weapon || "unknown").replace(/^weapon_/i, "")
  const row = document.createElement("div")
  row.className = "kill__row"
  const killerSpan = document.createElement("span")
  killerSpan.className = "kill__killer"
  killerSpan.textContent = attacker || "?"
  const weaponWrap = document.createElement("span")
  weaponWrap.className = "kill__weapon-wrap"
  const img = document.createElement("img")
  img.className = "kill__weapon"
  img.src = "assets/weapons/" + weaponName + ".svg"
  img.alt = ""
  img.onerror = function () { this.style.display = "none" }
  weaponWrap.appendChild(img)
  const victimSpan = document.createElement("span")
  victimSpan.className = "kill__victim"
  victimSpan.textContent = victim || "?"
  row.appendChild(killerSpan)
  row.appendChild(weaponWrap)
  row.appendChild(victimSpan)
  div.appendChild(row)
  if (assist && assist.name) {
    const assistSpan = document.createElement("span")
    assistSpan.className = "kill__assist kill__assist--" + (assist.type === "flash" ? "flash" : "damage")
    assistSpan.textContent = assist.type === "flash" ? "Flash: " + assist.name : "Assist: " + assist.name
    div.appendChild(assistSpan)
  }
  document.getElementById("killfeed").appendChild(div)
  setTimeout(() => div.remove(), 6000)
}