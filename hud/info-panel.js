// ── Панель над миникартой: карты серии ⇄ название турнира ──────────────────
// В фризтайм и первые секунды раунда — карты серии (вето): название карты и логотип
//   • сыгранная — логотип победителя;
//   • текущая / предстоящая — логотип команды, которая выбрала карту (поле «Пик» в вето),
//     десайдер — надпись DECIDER; текущая подсвечена;
// дальше — название турнира и стадия матча (админка → «Название турнира», строки 1 и 2).
// Если чего-то из двух нет — показываем то, что есть.

const INFO_MAPS_AFTER_LIVE_MS = 6000   // сколько ещё держать карты после старта раунда

const _info = {
  veto: { bo: "", maps: [] },
  teams: [],            // [{ name, logo }] из settings.teams (блок «Команды»)
  tournament: ["", ""],
  phase: "",
  liveSince: 0,
  mode: null,
  state: null,
}

const _infoShort = { de_dust2: "DUST2", de_mirage: "MIRAGE", de_inferno: "INFERNO", de_overpass: "OVERPASS",
  de_vertigo: "VERTIGO", de_ancient: "ANCIENT", de_anubis: "ANUBIS", de_nuke: "NUKE", de_cache: "CACHE", de_train: "TRAIN" }

const _infoEsc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))

function _infoLogo(teamName) {
  if (!teamName) return null
  const key = String(teamName).trim().toLowerCase()
  const t = _info.teams.find(x => String(x?.name || "").trim().toLowerCase() === key)
  if (t && t.logo) return "assets/teams/" + encodeURIComponent(t.logo)
  if (typeof teamLogoMap !== "undefined" && teamLogoMap[teamName]) return teamLogoMap[teamName]
  return null
}

function _infoWinner(m) {
  if (!Array.isArray(m.score) || m.score.length < 2) return null
  const a = Number(m.score[0]) || 0, b = Number(m.score[1]) || 0
  if (a === b) return null
  return a > b ? (m.teams?.ct || null) : (m.teams?.t || null)
}

function _infoRenderMaps() {
  const el = document.getElementById("veto_maps")
  if (!el) return
  const live = _info.state?.map
  el.innerHTML = _info.veto.maps.map(m => {
    const status = m.status || "upcoming"
    const name = _infoShort[m.name] || String(m.name || "").replace(/^de_/, "").toUpperCase()
    const mapIcon = `<img class="info-map__logo info-map__logo--map" src="assets/overviews/map_logo/${_infoEsc(m.name)}.png" alt="" onerror="this.remove()">`
    const pickLogo = m.pick && m.pick !== "decider" ? _infoLogo(m.pick) : null
    let body = "", foot = ""
    if (status === "played") {
      // сыгранная: логотип победителя (нет победителя / логотипа — кто выбрал, иначе иконка карты) + итоговый счёт
      const logo = _infoLogo(_infoWinner(m)) || pickLogo
      body = logo ? `<img class="info-map__logo" src="${logo}" alt="">` : mapIcon
      if (Array.isArray(m.score)) foot = `${_infoEsc(m.score[0])}:${_infoEsc(m.score[1])}`
    } else {
      // текущая / предстоящая: кто выбрал карту (или десайдер); у текущей — живой счёт
      body = m.pick === "decider" ? `<span class="info-map__text info-map__text--decider">DECIDER</span>`
           : pickLogo ? `<img class="info-map__logo" src="${pickLogo}" alt="">` : mapIcon
      if (status === "active") foot = live ? `${live.team_ct?.score ?? 0}:${live.team_t?.score ?? 0}` : "LIVE"
    }
    return `<div class="info-map info-map--${status}"><span class="info-map__name">${_infoEsc(name)}</span>${body}` +
           `<span class="info-map__foot">${foot}</span></div>`
  }).join("")
}

function _infoRenderTitle() {
  const t1 = document.getElementById("veto_t1"), t2 = document.getElementById("veto_t2")
  if (t1) t1.textContent = _info.tournament[0] || ""
  if (t2) t2.textContent = _info.tournament[1] || ""
}

function _infoApply() {
  const bar = document.getElementById("veto_bar")
  if (!bar) return
  const hasMaps = _info.veto.maps.length > 0
  const hasTitle = !!(_info.tournament[0] || _info.tournament[1])
  if (!hasMaps && !hasTitle) { bar.style.display = "none"; _info.mode = null; return }
  bar.style.display = ""

  const now = Date.now()
  const ph = _info.phase
  const mapsTime = ph === "freezetime" || ph === "" || (ph === "live" && now - _info.liveSince < INFO_MAPS_AFTER_LIVE_MS)
  const mode = hasMaps && (mapsTime || !hasTitle) ? "maps" : "title"
  bar.classList.toggle("veto-bar--only", !(hasMaps && hasTitle))
  if (mode !== _info.mode) {
    _info.mode = mode
    bar.classList.toggle("veto-bar--title", mode === "title")
    bar.classList.toggle("veto-bar--maps", mode === "maps")
  }
}

// ── Вход данных ─────────────────────────────────────────────────────────────
function infoPanelSetVeto(veto) {
  _info.veto = { bo: veto?.bo || "", maps: Array.isArray(veto?.maps) ? veto.maps : [] }
  _infoRenderMaps()
  _infoApply()
}
function infoPanelSetTeams(teams) {
  _info.teams = Array.isArray(teams) ? teams : []
  _infoRenderMaps()
}
function infoPanelSetTournament(lines) {
  _info.tournament = Array.isArray(lines) ? [lines[0] || "", lines[1] || ""] : ["", ""]
  _infoRenderTitle()
  _infoApply()
}
function infoPanelUpdate(data) {
  _info.state = data
  const ph = String(data?.round?.phase || "")
  if (ph === "live" && _info.phase !== "live") _info.liveSince = Date.now()
  _info.phase = ph
  // живой счёт текущей карты — перерисовываем, только когда он изменился
  const scoreKey = `${data?.map?.team_ct?.score ?? ""}:${data?.map?.team_t?.score ?? ""}`
  if (scoreKey !== _info.scoreKey && _info.veto.maps.some(m => m.status === "active")) { _info.scoreKey = scoreKey; _infoRenderMaps() }
  _infoApply()
}

// GSI в тишине приходит редко — переключение по таймеру, а не только по пакетам
setInterval(_infoApply, 500)
