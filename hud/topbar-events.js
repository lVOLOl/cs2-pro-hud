// ── Крылья компактного табло (только BLAST-вариант, body.cards--blast) ───────
// Справа (сторона T): закладка бомбы → бомба стоит.
// Слева (сторона CT): дефьюз.
// У победителя раунда: ROUND WIN.
// Время раунда в центре во время бомбы заменяется прочерком,
// после дефьюза / взрыва — иконкой исхода.

const TBW_PLANT_TIME = 3.2
const TBW_BOMB_TIME  = 40
const TBW_HOLD_MS    = 1500   // сколько держим «дефьюз завершён» перед ROUND WIN
const TBW_STALL_MS   = 5000   // нет обновлений дольше — замираем (демо на паузе)

const _tbw = {
  plant:  null,   // { value, at, total }
  bomb:   null,   // { value, at }
  defuse: null,   // { value, at, total }
  bombPlayer: null,
  prevBombState: null,
  resolvedAt: 0,  // когда бомбу разминировали
  raf: null,
  last: null,     // последний data
}

function _tbwEls(side) {
  const root = document.getElementById(side === "CT" ? "tbw_ct" : "tbw_t")
  if (!root) return null
  return {
    root,
    fill: root.querySelector(".tbw__fill"),
    l1:   root.querySelector(".tbw__l1"),
    l2:   root.querySelector(".tbw__l2"),
  }
}

function _tbwSet(side, mode, l1 = "", l2 = "") {
  const e = _tbwEls(side)
  if (!e) return
  const cls = "tbw tbw--" + side.toLowerCase() + (mode ? " tbw--open tbw--" + mode : "")
  if (e.root.className !== cls) e.root.className = cls
  if (e.l1.textContent !== l1) e.l1.textContent = l1
  if (e.l2.textContent !== l2) e.l2.textContent = l2
}

function _tbwFill(side, frac) {
  const e = _tbwEls(side)
  if (e) e.fill.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(2) + "%"
}

function _tbwRemain(sync) {
  if (!sync) return 0
  const elapsed = Math.min(Date.now() - sync.at, TBW_STALL_MS) / 1000
  return Math.max(0, sync.value - elapsed)
}

function _tbwFmtDefuse(sec) {
  const s  = Math.floor(sec)
  const ms = Math.floor((sec - s) * 1000)
  return s + ":" + String(ms).padStart(3, "0")
}

function _tbwName(data, steamid) {
  if (!steamid || !data.allplayers) return ""
  let p = data.allplayers[steamid]
  if (!p) p = Object.values(data.allplayers).find(x => String(x.steamid) === String(steamid))
  return p && p.name ? String(p.name).toUpperCase() : ""
}

// content: null — обычный таймер; строка/HTML — вместо таймера
function _tbwCenter(content) {
  const alt  = document.getElementById("round_timer_alt")
  const wrap = document.getElementById("round_timer_wrap")
  if (!alt || !wrap) return
  const on = content !== null
  wrap.classList.toggle("topbar__timer--alt", on)
  const html = on ? content : ""
  if (alt.dataset.html !== html) { alt.dataset.html = html; alt.innerHTML = html }
}

function _tbwReset() {
  _tbw.plant = _tbw.bomb = _tbw.defuse = null
  _tbwSet("CT", null)
  _tbwSet("T", null)
  _tbwCenter(null)
}

function updateTopbarEvents(data) {
  _tbw.last = data
  if (!document.body.classList.contains("cards--blast")) { _tbwReset(); return }

  const bomb  = data.bomb || {}
  const state = String(bomb.state || "").toLowerCase()
  const cd    = Number(bomb.countdown)
  const now   = Date.now()
  if (bomb.player) _tbw.bombPlayer = bomb.player

  // Закладка: countdown = сколько осталось до установки
  if (state === "planting" && !isNaN(cd)) {
    if (!_tbw.plant) _tbw.plant = { value: cd, at: now, total: Math.max(cd, TBW_PLANT_TIME) }
    else { _tbw.plant.value = cd; _tbw.plant.at = now }
  } else if (state !== "planting") _tbw.plant = null

  // Бомба: во время дефьюза GSI отдаёт в countdown время дефьюза,
  // поэтому таймер бомбы продолжаем от последнего значения в "planted"
  if (state === "planted" && !isNaN(cd)) _tbw.bomb = { value: cd, at: now }
  else if (state !== "planted" && state !== "defusing") _tbw.bomb = null

  if (state === "defusing") {
    const v = Number(bomb.defuse_countdown ?? bomb.countdown)
    if (!isNaN(v)) {
      if (!_tbw.defuse) _tbw.defuse = { value: v, at: now, total: v <= 5.5 ? 5 : 10 }
      else { _tbw.defuse.value = v; _tbw.defuse.at = now }
    }
  } else if (state !== "defused") _tbw.defuse = null

  if (state === "defused" && _tbw.prevBombState !== "defused") {
    _tbw.resolvedAt = now
    if (_tbw.defuse) { _tbw.defuse.value = 0; _tbw.defuse.at = now }
  }
  _tbw.prevBombState = state

  _tbwRender()
  if (!_tbw.raf && (_tbw.plant || _tbw.bomb || _tbw.defuse || _tbw.resolvedAt)) _tbwLoop()
}

function _tbwHolding() {
  return !!_tbw.resolvedAt && (Date.now() - _tbw.resolvedAt < TBW_HOLD_MS)
}

function _tbwRender() {
  const data = _tbw.last
  if (!data || !document.body.classList.contains("cards--blast")) return
  const state      = String(data.bomb?.state || "").toLowerCase()
  const roundPhase = data.round?.phase || ""
  const winTeam    = String(data.round?.win_team || "").toUpperCase()
  const roundBomb  = String(data.round?.bomb || "").toLowerCase()
  const name       = _tbwName(data, _tbw.bombPlayer)
  const holding    = _tbwHolding()

  // Центр табло
  if (roundPhase === "over" && (roundBomb === "defused" || state === "defused"))
    _tbwCenter(`<span class="topbar__outcome topbar__outcome--defused"></span>`)
  else if (roundPhase === "over" && (roundBomb === "exploded" || state === "exploded"))
    _tbwCenter(`<span class="topbar__outcome topbar__outcome--exploded"></span>`)
  else if (state === "planted" || state === "defusing") _tbwCenter("–")
  else if (roundPhase === "over") _tbwCenter("")
  else _tbwCenter(null)

  // Победа в раунде (после короткой паузы на «дефьюз завершён»)
  if (roundPhase === "over" && (winTeam === "CT" || winTeam === "T") && !holding) {
    const lose = winTeam === "CT" ? "T" : "CT"
    _tbwSet(winTeam, "win")
    _tbwFill(winTeam, 1)
    _tbwSet(lose, null)
    return
  }

  // Сторона T: закладка / бомба
  if (state === "planting" && _tbw.plant) {
    _tbwSet("T", "plant", name, "PLANTING")
    _tbwFill("T", 1 - _tbwRemain(_tbw.plant) / _tbw.plant.total)
  } else if ((state === "planted" || state === "defusing") && _tbw.bomb) {
    _tbwSet("T", "bomb", "", "PLANTED")
    _tbwFill("T", _tbwRemain(_tbw.bomb) / TBW_BOMB_TIME)
  } else {
    _tbwSet("T", null)
  }

  // Сторона CT: дефьюз
  if (state === "defusing" && _tbw.defuse) {
    const left = _tbwRemain(_tbw.defuse)
    _tbwSet("CT", "defuse", name, _tbwFmtDefuse(left))
    _tbwFill("CT", left / _tbw.defuse.total)
  } else if (holding && _tbw.defuse) {
    _tbwSet("CT", "defused", name, "DEFUSED")
    _tbwFill("CT", 0)
  } else {
    _tbwSet("CT", null)
  }
}

function _tbwLoop() {
  const tick = () => {
    _tbwRender()
    const holding = _tbwHolding()
    if (!holding) _tbw.resolvedAt = 0
    if (_tbw.plant || _tbw.bomb || (_tbw.defuse && _tbwIsDefusing()) || holding) {
      _tbw.raf = requestAnimationFrame(tick)
    } else {
      _tbw.raf = null
      _tbwRender()
    }
  }
  _tbw.raf = requestAnimationFrame(tick)
}

function _tbwIsDefusing() {
  return String(_tbw.last?.bomb?.state || "").toLowerCase() === "defusing"
}
