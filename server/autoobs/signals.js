// ── Сигналы по разнице соседних снимков GSI ─────────────────────────────────
//   стреляет      — ammo_clip активного оружия уменьшился (не во время перезарядки)
//   получил урон  — health уменьшилась
//   сделал килл   — round_kills вырос
//   умер          — health стала 0
//   кто кого убил — у кого в том же снимке (± kill_attrib_ms) вырос round_kills,
//                   при нескольких — ближайший к жертве; при сомнении — killfeed HUD
//   движение      — по изменению position (скорость, сглаженная)

const SNIPERS = new Set(["awp"])
const SNIPERS_SSG = new Set(["awp", "ssg08"])

function parseVec(v) {
  if (!v) return null
  if (typeof v === "object") return [Number(v.x) || 0, Number(v.y) || 0, Number(v.z) || 0]
  const p = String(v).split(",").map(Number)
  return p.length >= 3 && p.every(n => !isNaN(n)) ? p : null
}

function normTeam(t) {
  const s = String(t || "").toUpperCase()
  if (s === "CT" || s === "COUNTER-TERRORIST") return "CT"
  if (s === "T" || s === "TERRORIST") return "T"
  return ""
}

function weaponName(w) {
  return String(w?.name || "").replace(/^weapon_/i, "").toLowerCase()
}

function activeWeapon(weapons) {
  for (const w of Object.values(weapons || {})) {
    const s = String(w?.state || "").toLowerCase()
    if (s === "active" || s === "reloading") return w
  }
  return null
}

const hdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

function createSignals() {
  const mem = {}          // sid → память игрока
  const deaths = []       // [{ victim, at, pos, team }] — ждут сопоставления с убийцей
  const killsAt = []      // [{ killer, at, pos, team }]
  let lastMap = ""

  function reset() {
    for (const k of Object.keys(mem)) delete mem[k]
    deaths.length = 0
    killsAt.length = 0
  }

  // Сопоставление «кто кого убил» в окне kill_attrib_ms
  function attribute(now, cfg, killfeed) {
    const win = cfg.timing.kill_attrib_ms
    const open = deaths.filter(d => d.killer === undefined)
    // Все возможные пары «жертва — килл» в окне; сначала подтверждённые killfeed,
    // затем по возрастанию дистанции — так одна жертва не «забирает» чужого убийцу
    const pairs = []
    for (const d of open) {
      const fromFeed = (killfeed || []).find(k => String(k.victim_steamid) === d.victim)
      for (const k of killsAt) {
        if (k.used || k.team === d.team || Math.abs(k.at - d.at) > win) continue
        const feed = !!fromFeed && String(fromFeed.killer_steamid) === k.killer
        pairs.push({ d, k, feed, dist: k.pos && d.pos ? hdist(k.pos, d.pos) : 1e9 })
      }
    }
    pairs.sort((a, b) => (b.feed - a.feed) || (a.dist - b.dist))
    for (const { d, k } of pairs) {
      if (d.killer !== undefined || k.used) continue
      k.used = true
      d.killer = k.killer
    }
    for (const d of open) {
      if (d.killer === undefined && now - d.at > win) d.killer = null   // убийцу не нашли (бомба, падение, тимкилл)
      if (d.killer && mem[d.victim]) mem[d.victim].killedBy = d.killer
    }
    // чистим старое
    while (deaths.length && now - deaths[0].at > 10000) deaths.shift()
    while (killsAt.length && now - killsAt[0].at > 10000) killsAt.shift()
  }

  /**
   * @returns массив игроков с сигналами:
   *  { sid, name, team, slot, hp, alive, pos, fwd, vel, speed, weapon, sniper,
   *    lastShotAt, lastDamageAt, lastKillAt, deathAt, killedBy, shots:[ms], hits:[ms] }
   */
  function update(state, now, cfg) {
    const map = String(state.map?.name || "")
    if (map !== lastMap) { lastMap = map; reset() }
    const snipers = cfg.sniper.include_ssg ? SNIPERS_SSG : SNIPERS
    const out = []

    for (const [id, p] of Object.entries(state.allplayers || {})) {
      const team = normTeam(p.team)
      if (!team) continue
      const sid = String(p.steamid || id)
      const hp = Number(p.state?.health) || 0
      const roundKills = Number(p.state?.round_kills) || 0
      const pos = parseVec(p.position)
      const fwd = parseVec(p.forward)
      const aw = activeWeapon(p.weapons)
      const wname = weaponName(aw)
      const wstate = String(aw?.state || "").toLowerCase()
      const clip = aw && aw.ammo_clip != null ? Number(aw.ammo_clip) : null

      let m = mem[sid]
      if (!m) m = mem[sid] = { hp, roundKills, pos, posAt: now, vel: [0, 0], weapon: wname, clip, shots: [], hits: [],
                               lastShotAt: 0, lastDamageAt: 0, lastKillAt: 0, deathAt: 0, killedBy: null }

      // урон / смерть / воскрешение (новый раунд)
      if (hp < m.hp) { m.lastDamageAt = now; m.hits.push(now) }
      if (hp <= 0 && m.hp > 0) {
        m.deathAt = now
        m.killedBy = null
        deaths.push({ victim: sid, at: now, pos: m.pos || pos, team })
      }
      if (hp > 0 && m.hp <= 0) { m.deathAt = 0; m.killedBy = null }

      // килл (round_kills сбрасывается в новом раунде — это не килл)
      if (roundKills > m.roundKills) {
        m.lastKillAt = now
        for (let i = 0; i < roundKills - m.roundKills; i++) killsAt.push({ killer: sid, at: now, pos, team })
      }

      // выстрел: то же оружие, патронов в магазине стало меньше, не перезарядка
      if (clip != null && m.clip != null && wname && wname === m.weapon && clip < m.clip && wstate !== "reloading") {
        m.lastShotAt = now
        m.shots.push(now)
      }

      // скорость по позициям
      if (pos && m.pos && hp > 0) {
        const dt = (now - m.posAt) / 1000
        if (dt >= 0.04 && dt < 1) {
          const v = [(pos[0] - m.pos[0]) / dt, (pos[1] - m.pos[1]) / dt]
          if (Math.hypot(v[0], v[1]) < 1000) m.vel = [m.vel[0] * 0.5 + v[0] * 0.5, m.vel[1] * 0.5 + v[1] * 0.5]
        } else if (dt >= 1) m.vel = [0, 0]
      }
      if (pos && (now - m.posAt >= 40 || !m.pos)) { m.pos = pos; m.posAt = now }

      m.hp = hp
      m.roundKills = roundKills
      m.weapon = wname
      m.clip = clip

      const keep = now - Math.max(cfg.contact.active_window_ms, 3000)
      while (m.shots.length && m.shots[0] < keep) m.shots.shift()
      while (m.hits.length && m.hits[0] < keep) m.hits.shift()

      out.push({
        sid, name: p.name || sid, team, slot: p.observer_slot, hp, alive: hp > 0,
        pos, fwd, vel: m.vel, speed: Math.hypot(m.vel[0], m.vel[1]),
        weapon: wname, sniper: snipers.has(wname),
        hasBomb: Object.values(p.weapons || {}).some(w => weaponName(w) === "c4"),
        lastShotAt: m.lastShotAt, lastDamageAt: m.lastDamageAt, lastKillAt: m.lastKillAt,
        deathAt: m.deathAt, killedBy: m.killedBy,
        shots: m.shots, hits: m.hits,
      })
    }

    attribute(now, cfg, state.recent_kills)
    for (const p of out) p.killedBy = mem[p.sid]?.killedBy || null
    return out
  }

  return { update, reset }
}

module.exports = { createSignals, parseVec, normTeam, hdist }
