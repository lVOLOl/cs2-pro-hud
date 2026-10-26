// ── Спавны карт: запоминаются сами по GSI ────────────────────────────────────
// Во фризтайм игроки заморожены на точках спавна, а GSI присылает позиции всех
// десяти игроков. Сервер запоминает их по карте и стороне в spawns.json —
// точнее любых координат из интернета и сам обновляется после патчей карт.
//
// spawns.json: { "de_dust2": { "T": { "points": [[x,y,z]...], "forward": [fx,fy] }, "CT": {...} } }

const fs = require("fs")
const path = require("path")
const { parseVec, normTeam } = require("./signals.js")

const MERGE_DIST = 40      // точки ближе — одна и та же точка спавна
const MAX_POINTS = 32

function createSpawns(baseDir) {
  const file = path.join(baseDir, "spawns.json")
  let data = {}
  try { data = JSON.parse(fs.readFileSync(file, "utf8")) || {} } catch { data = {} }
  let dirty = false
  let seenRoundKey = ""

  const save = () => {
    if (!dirty) return
    dirty = false
    try { fs.writeFileSync(file, JSON.stringify(data, null, 1)) } catch {}
  }
  setInterval(save, 5000).unref()

  // Вызывается на каждом пакете; учитывает только фризтайм
  function observe(state) {
    const map = String(state.map?.name || "")
    if (!map || String(state.round?.phase || "") !== "freezetime") return
    // один раз за фризтайм достаточно, но точки добавляются, пока игроки ещё «прилетают»
    const key = map + ":" + (state.map?.round ?? "")
    const fresh = key !== seenRoundKey
    seenRoundKey = key
    const m = data[map] || (data[map] = {})
    for (const p of Object.values(state.allplayers || {})) {
      const side = normTeam(p.team)
      const pos = parseVec(p.position)
      if (!side || !pos || !(Number(p.state?.health) > 0)) continue
      const s = m[side] || (m[side] = { points: [], forward: null, rounds: 0 })
      if (!s.points.some(q => Math.hypot(q[0] - pos[0], q[1] - pos[1]) < MERGE_DIST && Math.abs(q[2] - pos[2]) < 64)) {
        s.points.push(pos.map(v => Math.round(v)))
        if (s.points.length > MAX_POINTS) s.points.shift()
        dirty = true
      }
      const fwd = parseVec(p.forward)
      if (fwd && Math.hypot(fwd[0], fwd[1]) > 0.1) {
        const l = Math.hypot(fwd[0], fwd[1])
        const f = [fwd[0] / l, fwd[1] / l]
        s.forward = s.forward ? [s.forward[0] * 0.9 + f[0] * 0.1, s.forward[1] * 0.9 + f[1] * 0.1] : f
      }
    }
    if (fresh) for (const side of ["T", "CT"]) if (m[side]) { m[side].rounds = (m[side].rounds || 0) + 1; dirty = true }
  }

  return {
    observe,
    get: (map, side) => data[map]?.[side] || null,
    all: () => data,
    clear(map) { if (map) delete data[map]; else data = {}; dirty = true; save() },
    file,
  }
}

module.exports = { createSpawns }
