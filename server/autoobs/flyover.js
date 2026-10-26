// ── Пролётки над спавном в фризтайм ─────────────────────────────────────────
// Пути:
//   • сгенерированные по спавнам (spawns.js): «дуга» перед игроками, «проход» вдоль
//     строя, «кран» — подъём с наклоном вниз. Камера стоит перед игроками
//     (в сторону, куда они смотрят — там открытое пространство), на высоте над ними;
//   • записанные вручную — flyovers.json в формате ТЗ:
//     { "de_dust2": { "T": [ { "id": "t1", "keyframes": [ { "pos":[x,y,z], "ang":[pitch,yaw], "t":0 }, ... ] } ], "CT": [...] } }
//     Записанные для карты/стороны заменяют сгенерированные.
// Воспроизведение: сервер считает кадры (spec_goto x y z pitch yaw) с частотой hz,
// агент проигрывает их через exec-трюк (bind <клавиша> "exec autoobs_frame").

const fs = require("fs")
const path = require("path")

const DEG = 180 / Math.PI
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const lerp = (a, b, t) => a + (b - a) * t

// ── Геометрия ────────────────────────────────────────────────────────────────
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t
  return p1.map((_, i) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t +
    (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3))
}

// Плотная выборка Catmull-Rom по ключевым точкам (концы продублированы)
function denseSpline(pts, perSeg = 40) {
  if (pts.length === 1) return [pts[0]]
  const ext = [pts[0], ...pts, pts[pts.length - 1]]
  const out = []
  for (let i = 1; i < ext.length - 2; i++) {
    for (let k = 0; k < perSeg; k++) out.push(catmull(ext[i - 1], ext[i], ext[i + 1], ext[i + 2], k / perSeg))
  }
  out.push(pts[pts.length - 1])
  return out
}

function cumLength(pts) {
  const c = [0]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    c.push(c[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0)))
  }
  return c
}

function atLength(pts, cum, s) {
  const total = cum[cum.length - 1]
  if (total <= 0) return pts[0]
  s = clamp(s, 0, total)
  let lo = 0, hi = cum.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m }
  const seg = cum[hi] - cum[lo] || 1
  const t = (s - cum[lo]) / seg
  return pts[lo].map((v, i) => lerp(v, pts[hi][i], t))
}

function lookAngles(pos, target) {
  const dx = target[0] - pos[0], dy = target[1] - pos[1], dz = target[2] - pos[2]
  const yaw = Math.atan2(dy, dx) * DEG
  const pitch = -Math.atan2(dz, Math.hypot(dx, dy)) * DEG      // Source: положительный pitch — вниз
  return [pitch, yaw]
}

// Развернуть yaw без скачков через ±180
function unwrap(list) {
  const out = [list[0]]
  for (let i = 1; i < list.length; i++) {
    let d = list[i] - list[i - 1]
    while (d > 180) d -= 360
    while (d < -180) d += 360
    out.push(out[i - 1] + d)
  }
  return out
}

// ── Профиль скорости: трапеция с плавным разгоном/торможением ──────────────
// Возвращает долю пройденного пути u(t) ∈ [0, uEnd]; при обрезке (tEnd < dur)
// торможение заканчивается ровно в tEnd, скорость в конце — 0.
function makeProfile(dur, ramp, tEnd) {
  ramp = Math.min(ramp, dur / 2)
  const vmax = 1 / (dur - ramp)                       // площадь трапеции = 1
  // сглаженная рампа (smoothstep по скорости): s(t) = ∫ v
  const rampDist = (t, r) => vmax * (t * t * t / (r * r) - t * t * t * t / (2 * r * r * r))   // ∫ vmax*(3x²-2x³), x=t/r
  const full = t => {
    if (t <= 0) return 0
    if (t < ramp) return rampDist(t, ramp)
    if (t <= dur - ramp) return rampDist(ramp, ramp) + vmax * (t - ramp)
    if (t < dur) return 1 - rampDist(dur - t, ramp)
    return 1
  }
  if (tEnd >= dur) return { u: full, end: dur }
  // обрезка: едем как обычно до tStop, затем тормозим за ramp2 до нуля
  const ramp2 = Math.min(ramp, tEnd / 2)
  const tStop = tEnd - ramp2
  const base = full(tStop)
  const vAt = t => t < ramp ? vmax * (3 * (t / ramp) ** 2 - 2 * (t / ramp) ** 3) : vmax
  const v0 = vAt(tStop)
  return {
    end: tEnd,
    u: t => {
      if (t <= tStop) return full(t)
      const x = clamp((t - tStop) / ramp2, 0, 1)
      // скорость v0*(1 - smoothstep(x)) → путь v0*ramp2*(x - x³ + x⁴/2)
      return base + v0 * ramp2 * (x - x * x * x + x * x * x * x / 2)
    },
  }
}

// ── Генерация путей по спавну ────────────────────────────────────────────────
function spawnFrame(spawn, enemy) {
  const pts = spawn.points
  const c = [0, 1, 2].map(i => pts.reduce((s, p) => s + p[i], 0) / pts.length)
  const zs = pts.map(p => p[2]).sort((a, b) => a - b)
  c[2] = zs[Math.floor(zs.length / 2)]
  // «вперёд» — к спавну врага, иначе куда смотрят игроки, иначе +X
  let f = null
  if (enemy?.points?.length) {
    const e = [0, 1].map(i => enemy.points.reduce((s, p) => s + p[i], 0) / enemy.points.length)
    const l = Math.hypot(e[0] - c[0], e[1] - c[1])
    if (l > 1) f = [(e[0] - c[0]) / l, (e[1] - c[1]) / l]
  }
  if (!f && spawn.forward) { const l = Math.hypot(...spawn.forward); if (l > 0.1) f = [spawn.forward[0] / l, spawn.forward[1] / l] }
  if (!f) f = [1, 0]
  const lat = [-f[1], f[0]]
  let dMin = 0, dMax = 0, lMin = 0, lMax = 0
  for (const p of pts) {
    const d = (p[0] - c[0]) * f[0] + (p[1] - c[1]) * f[1]
    const l = (p[0] - c[0]) * lat[0] + (p[1] - c[1]) * lat[1]
    dMin = Math.min(dMin, d); dMax = Math.max(dMax, d); lMin = Math.min(lMin, l); lMax = Math.max(lMax, l)
  }
  return { c, f, lat, depth: dMax - dMin, width: lMax - lMin, front: dMax }
}

const at = (fr, fwd, side, up) => [fr.c[0] + fr.f[0] * fwd + fr.lat[0] * side, fr.c[1] + fr.f[1] * fwd + fr.lat[1] * side, fr.c[2] + up]

function generatePaths(spawn, enemy, opt) {
  const fr = spawnFrame(spawn, enemy)
  const H = opt.height
  const look = [fr.c[0], fr.c[1], fr.c[2] + 40]
  const R = Math.max(520, fr.width / 2 + 420, fr.front + 380)
  const halfW = Math.max(250, fr.width / 2 + 200)
  const D = Math.max(380, fr.front + 320)

  // 1. Дуга перед игроками: −55° … +55° вокруг центра спавна
  const orbit = []
  for (let i = 0; i <= 6; i++) {
    const a = (-55 + i * (110 / 6)) / DEG
    orbit.push({ pos: at(fr, R * Math.cos(a), R * Math.sin(a), H), look })
  }
  // 2. Проход вдоль строя перед игроками, взгляд скользит следом
  const dolly = []
  for (let i = 0; i <= 4; i++) {
    const s = -halfW + i * (2 * halfW / 4)
    dolly.push({ pos: at(fr, D, s, H * 0.8), look: at(fr, 0, s * 0.55, 40) })
  }
  // 3. Кран: издалека и пониже — ближе и выше, наклон вниз растёт
  const crane = []
  for (let i = 0; i <= 4; i++) {
    const t = i / 4
    crane.push({ pos: at(fr, lerp(D + 520, D * 0.55, t), lerp(-halfW * 0.35, halfW * 0.2, t), lerp(H * 0.55, H * 1.45, t)), look })
  }
  return [
    { id: "orbit", generated: true, keyframes: orbit },
    { id: "dolly", generated: true, keyframes: dolly },
    { id: "crane", generated: true, keyframes: crane },
  ]
}

// ── Кадры для агента ────────────────────────────────────────────────────────
// path.keyframes: [{pos, look}] (сгенерированные) или [{pos, ang, t}] (записанные)
function buildFrames(pth, opt, tAvailMs) {
  const kf = pth.keyframes
  if (!kf || kf.length < 2) return null
  const posDense = denseSpline(kf.map(k => k.pos))
  const cum = cumLength(posDense)
  const L = cum[cum.length - 1]
  const hasLook = kf.every(k => k.look)
  const lookDense = hasLook ? denseSpline(kf.map(k => k.look)) : null
  const lookCum = hasLook ? cumLength(lookDense) : null
  // записанные углы: разворачиваем yaw и интерполируем тем же сплайном
  let angDense = null
  if (!hasLook) {
    const yaws = unwrap(kf.map(k => (k.ang || [0, 0])[1]))
    angDense = denseSpline(kf.map((k, i) => [(k.ang || [0, 0])[0], yaws[i], 0]))
  }
  const sample = u => {
    const pos = atLength(posDense, cum, u * L)
    let ang
    if (hasLook) ang = lookAngles(pos, atLength(lookDense, lookCum, u * lookCum[lookCum.length - 1]))
    else {
      const idx = clamp(Math.round(u * (angDense.length - 1)), 0, angDense.length - 1)
      ang = [angDense[idx][0], angDense[idx][1]]
    }
    return { pos, ang }
  }

  // поворот по пути — чтобы не превысить max_turn_dps
  let turn = 0, prev = null
  for (let i = 0; i <= 100; i++) {
    const a = sample(i / 100).ang
    if (prev) {
      let dy = a[1] - prev[1]; while (dy > 180) dy -= 360; while (dy < -180) dy += 360
      turn += Math.abs(dy) + Math.abs(a[0] - prev[0])
    }
    prev = a
  }
  const recordedDur = !hasLook && kf[kf.length - 1].t ? kf[kf.length - 1].t * 1000 : 0
  let dur = recordedDur || Math.max(L / opt.speed * 1000, turn / opt.max_turn_dps * 1000)
  dur = clamp(dur, opt.min_ms, opt.max_ms)
  const ramp = Math.min(2000, dur / 4)
  const prof = makeProfile(dur / 1000, ramp / 1000, (tAvailMs ?? dur) / 1000)
  const n = Math.max(2, Math.round(prof.end * opt.hz))

  const frames = []
  let yawPrev = null
  let maxSpeed = 0, maxTurn = 0, lastPos = null, lastAng = null
  for (let i = 0; i <= n; i++) {
    const t = i / opt.hz
    const { pos, ang } = sample(prof.u(Math.min(t, prof.end)))
    let yaw = ang[1]
    if (yawPrev != null) { while (yaw - yawPrev > 180) yaw -= 360; while (yaw - yawPrev < -180) yaw += 360 }
    yawPrev = yaw
    const yawOut = ((yaw + 540) % 360) - 180
    if (lastPos) {
      maxSpeed = Math.max(maxSpeed, Math.hypot(pos[0] - lastPos[0], pos[1] - lastPos[1], pos[2] - lastPos[2]) * opt.hz)
      maxTurn = Math.max(maxTurn, (Math.abs(yaw - lastAng[1]) + Math.abs(ang[0] - lastAng[0])) * opt.hz)
    }
    lastPos = pos; lastAng = [ang[0], yaw]
    frames.push(`spec_goto ${pos[0].toFixed(1)} ${pos[1].toFixed(1)} ${pos[2].toFixed(1)} ${ang[0].toFixed(2)} ${yawOut.toFixed(2)}`)
  }
  return { frames, hz: opt.hz, dur_ms: Math.round(prof.end * 1000), full_ms: Math.round(dur), length: Math.round(L),
           max_speed: Math.round(maxSpeed), max_turn_dps: Math.round(maxTurn), truncated: prof.end * 1000 < dur - 1 }
}

// ── Планировщик ─────────────────────────────────────────────────────────────
// onEnd(flyover, reason) — вызывается после любой остановки: index.js возвращает камеру на игрока
function createFlyover({ baseDir, spawns, io, log, getCfg, agentNs, onEnd }) {
  const FILE = path.join(baseDir, "flyovers.json")
  let recorded = {}, recMtime = 0
  const loadRecorded = () => {
    try {
      const m = fs.statSync(FILE).mtimeMs
      if (m !== recMtime) { recMtime = m; recorded = JSON.parse(fs.readFileSync(FILE, "utf8")) || {} }
    } catch { recorded = recMtime ? recorded : {} }
  }

  const st = {
    active: null,          // { seq, map, side, id, startedAt, dur_ms, reason }
    seq: 0,
    freezeKey: "", freezeStartAt: 0, tried: false,
    winner: null,          // { side, sids:Set } — победитель прошлого раунда
    lastVariant: {},       // "map:side" → id
    lastEnd: null,         // { at, reason }
  }

  function pathsFor(map, side) {
    loadRecorded()
    const rec = recorded?.[map]?.[side]
    if (Array.isArray(rec) && rec.length) return rec.filter(p => p.keyframes?.length >= 2)
    const sp = spawns.get(map, side)
    if (!sp || !sp.points?.length) return []
    return generatePaths(sp, spawns.get(map, side === "T" ? "CT" : "T"), getCfg().flyover)
  }

  function pickSide(state) {
    if (!st.winner) return Math.random() < 0.5 ? "T" : "CT"
    // где сейчас играет победившая команда (по составу — переживает смену сторон)
    let t = 0, ct = 0
    for (const [id, p] of Object.entries(state.allplayers || {})) {
      const sid = String(p.steamid || id)
      if (!st.winner.sids.has(sid)) continue
      const team = String(p.team || "").toUpperCase()
      if (team === "T" || team === "TERRORIST") t++
      else if (team === "CT") ct++
    }
    if (t || ct) return t > ct ? "T" : "CT"
    return st.winner.side
  }

  function play(map, side, id, tAvailMs, reason, preview = false) {
    const cfg = getCfg().flyover
    const all = pathsFor(map, side)
    if (!all.length) return { ok: false, error: `нет пролёток и спавнов для ${map} ${side}` }
    let pth = id ? all.find(p => p.id === id) : null
    if (!pth) {
      const key = map + ":" + side
      const pool = all.length > 1 ? all.filter(p => p.id !== st.lastVariant[key]) : all
      pth = pool[Math.floor(Math.random() * pool.length)]
      st.lastVariant[key] = pth.id
    }
    const built = buildFrames(pth, cfg, tAvailMs)
    if (!built) return { ok: false, error: "пустой путь" }
    if (cfg.enter_cmd) built.frames[0] = cfg.enter_cmd + "; " + built.frames[0]
    const seq = ++st.seq
    if (st.active) stop("запущена другая пролётка")
    st.active = { seq, map, side, id: pth.id, startedAt: Date.now(), dur_ms: built.dur_ms, reason, info: built, preview }
    io.of(agentNs).emit("agent:fly", { seq, hz: built.hz, frames: built.frames, exit: cfg.exit_cmd || "" })
    io.emit("flyover:start", { map, side, id: pth.id, dur_ms: built.dur_ms })
    log(`FLYOVER ${map} ${side} ${pth.id}${pth.generated ? " (по спавнам)" : ""} · ${(built.dur_ms / 1000).toFixed(1)} с` +
        `${built.truncated ? " (обрезана)" : ""} · до ${built.max_speed} ед/с, ${built.max_turn_dps}°/с · ${reason}`)
    return { ok: true, seq, id: pth.id, ...built, frames: undefined }
  }

  function stop(reason) {
    if (!st.active) return
    io.of(agentNs).emit("agent:fly_stop", { seq: st.active.seq, reason })
    end(st.active.seq, reason)
  }

  function end(seq, reason) {
    if (!st.active || st.active.seq !== seq) return
    const a = st.active
    st.active = null
    st.lastEnd = { at: Date.now(), reason }
    io.emit("flyover:end", { map: a.map, side: a.side, id: a.id, reason })
    log(`FLYOVER END ${a.id}: ${reason}`)
    if (onEnd) { try { onEnd(a, reason) } catch (e) { log("FLYOVER onEnd: " + e.message) } }
  }

  // Каждый пакет GSI. active — автообсерв включён и не на паузе.
  function onState(state, now, active) {
    const cfg = getCfg()
    const F = cfg.flyover
    const map = String(state.map?.name || "")
    const mapPhase = String(state.map?.phase || "")
    const roundPhase = String(state.round?.phase || "")
    const cd = String(state.phase_countdowns?.phase || "")
    const left = Number(state.phase_countdowns?.phase_ends_in) * 1000

    // Победитель раунда (фаза "over"), запасной источник — map.round_wins
    if (roundPhase === "over") {
      let side = String(state.round?.win_team || "").toUpperCase()
      if (!side) {
        const wins = state.map?.round_wins || {}
        const last = wins[Object.keys(wins).map(Number).sort((a, b) => b - a)[0]]
        if (last) side = String(last).startsWith("ct") ? "CT" : "T"
      }
      if (side === "CT" || side === "T") {
        const sids = new Set()
        for (const [id, p] of Object.entries(state.allplayers || {})) {
          const team = String(p.team || "").toUpperCase()
          if ((side === "CT" && team === "CT") || (side === "T" && (team === "T" || team === "TERRORIST"))) sids.add(String(p.steamid || id))
        }
        st.winner = { side, sids }
      }
    }
    if (mapPhase === "warmup" || mapPhase === "gameover") st.winner = null

    const inFreeze = roundPhase === "freezetime"
    const inTimeout = ["timeout_ct", "timeout_t", "paused"].includes(cd)
    // Прерывание
    if (st.active) {
      // предпросмотр из админки живёт сам по себе — останавливают только время и оператор
      if (st.active.preview) {
        if (now - st.active.startedAt > st.active.dur_ms + 1500) end(st.active.seq, "предпросмотр закончен")
        return
      }
      if (!active) return stop("автообсерв выключен / пауза")
      if (!inFreeze) return stop("фризтайм закончился")
      if (inTimeout && !F.in_timeouts) return stop("тайм-аут")
      if (isFinite(left) && left <= F.end_before_ms) return stop("конец фризтайма")
      if (now - st.active.startedAt > st.active.dur_ms + 1500) end(st.active.seq, "время вышло (агент не ответил)")
      return
    }
    if (!inFreeze) { st.freezeKey = ""; return }

    const fkey = map + ":" + (state.map?.round ?? "")
    if (fkey !== st.freezeKey) { st.freezeKey = fkey; st.freezeStartAt = now; st.tried = false }
    if (!active || !F.enabled || st.tried) return
    if (mapPhase === "warmup" || mapPhase === "intermission") return
    if (inTimeout && !F.in_timeouts) return
    if (now - st.freezeStartAt < F.start_delay_ms) return
    if (!isFinite(left)) return
    st.tried = true
    if (left < F.min_freeze_ms) { log(`FLYOVER пропуск: до конца фризтайма ${(left / 1000).toFixed(1)} с`); return }
    const side = pickSide(state)
    const r = play(map, side, null, left - F.end_before_ms, st.winner ? `победитель прошлого раунда (${side})` : "первый раунд — случайный спавн")
    if (!r.ok) log("FLYOVER пропуск: " + r.error)
  }

  return {
    onState, play, stop, end,
    active: () => st.active,
    recentlyActive: ms => !!st.active || (st.lastEnd && Date.now() - st.lastEnd.at < ms),
    pathsFor,
    status() {
      const a = st.active
      return {
        active: a ? { map: a.map, side: a.side, id: a.id, elapsed_ms: Date.now() - a.startedAt, dur_ms: a.dur_ms, reason: a.reason,
                      max_speed: a.info.max_speed, max_turn_dps: a.info.max_turn_dps, truncated: a.info.truncated } : null,
        last_end: st.lastEnd ? { reason: st.lastEnd.reason, ago_ms: Date.now() - st.lastEnd.at } : null,
        winner: st.winner ? st.winner.side : null,
        recorded_file: path.relative(baseDir, FILE),
      }
    },
    recordedFile: FILE,
  }
}

module.exports = { createFlyover, generatePaths, buildFrames, makeProfile, spawnFrame }
