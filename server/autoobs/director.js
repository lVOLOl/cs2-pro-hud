// ── Режиссёр автообсерва: кого показывать ───────────────────────────────────
// Сначала определяем самый высокий уровень, который есть прямо сейчас,
// затем внутри уровня выбираем игрока по очкам.
//
//   P0 КЛАТЧ        1 против 2+ → одиночка до конца раунда; 1 на 1 — кто ближе к действию
//   P1 КРУПНЫЙ      кластер контакта от big_cluster игроков, или снайперская дуэль
//   P2 КОНТАКТ      кластер меньше big_cluster
//   P3 БОМБА        закладка / дефьюз при отсутствии контактов
//   P4 ТИШИНА       ближе всех к контакту (дистанция до врага и сближение)
//
// Правила удержания — см. decide().

const { hdist } = require("./signals.js")

const LEVEL_NAMES = ["P0 CLUTCH", "P1 CONTACT", "P2 CONTACT", "P3 BOMB", "P4 QUIET"]
const NO_LEVEL = 5

const clamp01 = x => Math.max(0, Math.min(1, x))

function angleDeg(p, q) {
  if (!p.fwd || !p.pos || !q.pos) return 180
  const dx = q.pos[0] - p.pos[0], dy = q.pos[1] - p.pos[1]
  const l = Math.hypot(dx, dy), lf = Math.hypot(p.fwd[0], p.fwd[1])
  if (!l || !lf) return 180
  const c = Math.max(-1, Math.min(1, (dx * p.fwd[0] + dy * p.fwd[1]) / (l * lf)))
  return Math.acos(c) * 180 / Math.PI
}

function approach(p, q) {           // ед/с, с которой p движется к q
  if (!p.vel || !p.pos || !q.pos) return 0
  const dx = q.pos[0] - p.pos[0], dy = q.pos[1] - p.pos[1]
  const l = Math.hypot(dx, dy)
  return l ? (p.vel[0] * dx + p.vel[1] * dy) / l : 0
}

function createDirector() {
  const st = {
    observedSid: null,
    holdSince: 0,          // с какого момента камера на текущем игроке
    command: { sid: null, at: 0 },
    freezeDone: false,
    lastRoundPhase: "",
    links: new Map(),      // "sidA|sidB" → когда связь была в последний раз
    curMemory: null,       // { sid, level, value, at } — уровень текущего игрока (против мигания)
  }

  // ── Анализ ситуации ───────────────────────────────────────────────────────
  function analyze(players, state, now, cfg) {
    const C = cfg.contact
    const alive = players.filter(p => p.alive && p.pos)
    const looks = (p, q) => angleDeg(p, q) < (p.sniper ? C.look_deg_sniper : C.look_deg)
    const sameFloor = (p, q) => Math.abs(p.pos[2] - q.pos[2]) <= C.floor_dz
    const fighting = (p, ms) => now - Math.max(p.lastShotAt || 0, p.lastDamageAt || 0) < ms
    const recent = (arr, ms) => (arr || []).filter(t => now - t < ms).length
    const enemiesOf = p => alive.filter(e => e.team !== p.team)

    // Рёбра контакта между врагами. Связь «помнится» link_memory_ms: GSI приходит ~4 раза
    // в секунду, и без памяти кластер мигает (есть / нет), а камера скачет между уровнями.
    const linkKey = (a, b) => a.sid < b.sid ? a.sid + "|" + b.sid : b.sid + "|" + a.sid
    const edges = []
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j]
        if (a.team === b.team || !sameFloor(a, b)) continue
        const d = hdist(a.pos, b.pos)
        const key = linkKey(a, b)
        const fresh = d < C.r_contact &&
          (looks(a, b) || looks(b, a) || fighting(a, C.active_window_ms) || fighting(b, C.active_window_ms))
        if (fresh) st.links.set(key, now)
        const remembered = !fresh && now - (st.links.get(key) || 0) < C.link_memory_ms && d < C.r_contact * 1.2
        if (fresh || remembered) edges.push({ a, b, d })
      }
    }
    for (const [k, t] of st.links) if (now - t > C.link_memory_ms * 2) st.links.delete(k)

    // Кластеры: сначала ближайшие пары; группы не сливаются, если размах станет больше max_span —
    // иначе цепочки «враг—враг—враг» склеивают полкарты в один «контакт 5v5»
    edges.sort((x, y) => x.d - y.d)
    const groupOf = new Map()       // sid → массив-группа
    const span = (g, extra) => {
      let m = 0
      const all = extra ? g.concat(extra) : g
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) m = Math.max(m, hdist(all[i].pos, all[j].pos))
      return m
    }
    for (const { a, b } of edges) {
      const ga = groupOf.get(a.sid), gb = groupOf.get(b.sid)
      if (ga && ga === gb) continue
      const merged = (ga || [a]).concat(gb || [b])
      if (span(merged) > C.max_span) continue
      for (const p of merged) groupOf.set(p.sid, merged)
    }
    const linked = new Set(groupOf.keys())
    const groupsArr = [...new Set(groupOf.values())]
    const groups = new Map(groupsArr.map((g, i) => [i, g]))
    // Поддержка: союзники рядом с участником контакта (если не раздувают размах)
    for (const p of alive) {
      if (linked.has(p.sid)) continue
      for (const g of groups.values()) {
        if (g.some(m => m.team === p.team && sameFloor(m, p) && hdist(m.pos, p.pos) < C.r_support) && span(g, [p]) <= C.max_span) { g.push(p); break }
      }
    }

    const entities = []
    for (const members of groups.values()) {
      const nT = members.filter(m => m.team === "T").length, nCT = members.length - nT
      const activity = members.length +
        members.reduce((s, m) => s + recent(m.shots, C.active_window_ms) + recent(m.hits, C.active_window_ms), 0)
      entities.push({
        kind: "contact", level: members.length >= C.big_cluster ? 1 : 2,
        label: `${nT}T v ${nCT}CT`, members, activity,
      })
    }

    // Снайперские дуэли
    if (cfg.sniper.enabled) {
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const a = alive[i], b = alive[j]
          if (a.team === b.team || !a.sniper || !b.sniper) continue
          if (hdist(a.pos, b.pos) > cfg.sniper.max_dist) continue
          if (!(looks(a, b) && looks(b, a))) continue
          const activity = 2 + recent(a.shots, C.active_window_ms) + recent(b.shots, C.active_window_ms) +
                           recent(a.hits, C.active_window_ms) + recent(b.hits, C.active_window_ms)
          entities.push({ kind: "duel", level: 1, label: `AWP DUEL ${a.name} / ${b.name}`, members: [a, b], activity })
        }
      }
    }

    // Очки игрока внутри контакта
    function contactScore(p, ent) {
      if (ent.kind === "duel") {
        const sp = cfg.sniper.prefer === "holder" ? Math.max(0, 300 - p.speed) : p.speed
        return sp / 10 + (fighting(p, C.active_window_ms) ? 30 : 0)
      }
      const foes = ent.members.filter(m => m.team !== p.team)
      let minD = Infinity, lookAt = false, appr = 0
      for (const e of foes) {
        const d = hdist(p.pos, e.pos)
        if (d < minD) { minD = d; appr = approach(p, e) }
        if (looks(p, e)) lookAt = true
      }
      return (now - (p.lastShotAt || 0) < C.active_window_ms ? 50 : 0) +
             (now - (p.lastDamageAt || 0) < C.active_window_ms ? 40 : 0) +
             (lookAt ? 20 : 0) +
             15 * clamp01(1 - (isFinite(minD) ? minD : C.r_contact) / C.r_contact) +
             10 * clamp01(appr / 250)
    }
    for (const ent of entities) {
      ent.ranked = ent.members.map(p => ({ p, score: contactScore(p, ent) })).sort((a, b) => b.score - a.score)
    }

    // P0 клатч
    const aliveCT = alive.filter(p => p.team === "CT"), aliveT = alive.filter(p => p.team === "T")
    const bombState = String(state.bomb?.state || "").toLowerCase()
    const bombPlayer = state.bomb?.player ? String(state.bomb.player) : null
    function actionScore(p) {            // для 1 на 1: кто ближе к действию
      let s = 0
      if ((bombState === "planting" || bombState === "defusing") && bombPlayer === p.sid) s += 100
      if (fighting(p, C.active_window_ms)) s += 50
      for (const e of enemiesOf(p)) {
        if (looks(p, e)) s += 20
        s += 10 * clamp01(approach(p, e) / 250)
      }
      return s
    }
    let clutch = null
    if (aliveCT.length && aliveT.length) {
      if (aliveCT.length === 1 && aliveT.length >= 2) clutch = { lone: aliveCT[0], vs: aliveT.length }
      else if (aliveT.length === 1 && aliveCT.length >= 2) clutch = { lone: aliveT[0], vs: aliveCT.length }
      else if (aliveT.length === 1 && aliveCT.length === 1) {
        const a = aliveCT[0], b = aliveT[0]
        clutch = { duo: [a, b], scores: { [a.sid]: actionScore(a), [b.sid]: actionScore(b) } }
      }
    }

    // P3 бомба
    const bombActor = (bombState === "planting" || bombState === "defusing") && bombPlayer
      ? alive.find(p => p.sid === bombPlayer) || null : null

    // P4 тишина: ближе всех к контакту
    const Q = cfg.quiet
    const quiet = []
    for (const p of alive) {
      let best = Infinity, appr = 0
      for (const e of enemiesOf(p)) {
        const d = hdist(p.pos, e.pos) + (sameFloor(p, e) ? 0 : 500)
        if (d < best) { best = d; appr = approach(p, e) }
      }
      if (!isFinite(best)) continue
      const eff = best - Q.approach_weight * Math.max(0, appr) - (p.team === "T" && p.hasBomb ? Q.bomb_carrier_bonus : 0)
      quiet.push({ p, dist: best, eff, score: Math.max(0, Q.max_enemy_dist - eff), inRange: best <= Q.max_enemy_dist })
    }
    quiet.sort((a, b) => a.eff - b.eff)

    return { alive, entities, clutch, bombActor, bombState, quiet, fighting, looks }
  }

  // Самый высокий уровень и его лучший игрок
  function topTarget(sit) {
    if (sit.clutch?.lone) return { level: 0, p: sit.clutch.lone, value: 1000, label: `1v${sit.clutch.vs}` }
    if (sit.clutch?.duo) {
      const [a, b] = sit.clutch.duo
      const pa = sit.clutch.scores[a.sid], pb = sit.clutch.scores[b.sid]
      const p = pa >= pb ? a : b
      return { level: 0, p, value: Math.max(pa, pb), label: "1v1" }
    }
    for (const lvl of [1, 2]) {
      const ents = sit.entities.filter(e => e.level === lvl).sort((a, b) => b.activity - a.activity || b.members.length - a.members.length)
      if (ents.length) return { level: lvl, p: ents[0].ranked[0].p, value: ents[0].activity, entity: ents[0], label: ents[0].label }
    }
    if (sit.bombActor) return { level: 3, p: sit.bombActor, value: 100, label: sit.bombState }
    const q = sit.quiet.find(x => x.inRange)
    if (q) return { level: 4, p: q.p, value: q.score, label: `до врага ${Math.round(q.dist)}` }
    return null
  }

  // Уровень и «ценность» текущего игрока в этой же системе координат
  function levelOf(sid, sit) {
    if (sit.clutch?.lone?.sid === sid) return { level: 0, value: 1000 }
    if (sit.clutch?.duo?.some(p => p.sid === sid)) return { level: 0, value: sit.clutch.scores[sid] }
    let best = null
    for (const e of sit.entities) {
      const r = e.ranked.find(x => x.p.sid === sid)
      if (r && (!best || e.level < best.level || (e.level === best.level && e.activity > best.value))) {
        best = { level: e.level, value: e.activity, entity: e, playerScore: r.score }
      }
    }
    if (best) return best
    if (sit.bombActor?.sid === sid) return { level: 3, value: 100 }
    const q = sit.quiet.find(x => x.p.sid === sid && x.inRange)
    if (q) return { level: 4, value: q.score }
    return { level: NO_LEVEL, value: 0 }
  }

  // ── Решение ───────────────────────────────────────────────────────────────
  // dry = true — только анализ для отладки (автомат выключен / на паузе): ничего не запоминаем
  function decide(players, state, now, cfg, observedSid, dry = false) {
    const T = cfg.timing
    if (observedSid !== st.observedSid) { st.observedSid = observedSid; st.holdSince = now }

    const sit = analyze(players, state, now, cfg)
    const top = topTarget(sit)
    const cur = players.find(p => p.sid === observedSid) || null
    let curLv = cur && cur.alive ? levelOf(cur.sid, sit) : { level: NO_LEVEL, value: 0 }
    // Память уровня текущего игрока: если он на пару тиков «выпал» из контакта,
    // не считаем, что у остальных теперь более высокий приоритет
    if (cur && cur.alive) {
      const m = st.curMemory
      const keep = m && m.sid === cur.sid && curLv.level > m.lv.level && now - m.at < T.level_memory_ms
      if (keep) curLv = m.lv
      else st.curMemory = { sid: cur.sid, lv: curLv, at: now }
    }
    const held = now - st.holdSince

    const holds = {
      min_hold_left: Math.max(0, T.min_hold_ms - held),
      fight_left: cur ? Math.max(0, T.fight_hold_ms - (now - Math.max(cur.lastShotAt || 0, cur.lastDamageAt || 0))) : 0,
      kill_left: cur ? Math.max(0, T.kill_hold_ms - (now - (cur.lastKillAt || 0))) : 0,
    }
    const result = {
      level: top ? top.level : null,
      level_name: top ? LEVEL_NAMES[top.level] : "—",
      label: top?.label || "",
      current_level: curLv.level < NO_LEVEL ? LEVEL_NAMES[curLv.level] : "—",
      holds,
      entities: sit.entities.map(e => ({ kind: e.kind, level: e.level, label: e.label, activity: e.activity,
        players: e.ranked.map(r => ({ name: r.p.name, slot: r.p.slot, team: r.p.team, score: Math.round(r.score) })) })),
      quiet: sit.quiet.slice(0, 5).map(q => ({ name: q.p.name, slot: q.p.slot, team: q.p.team, dist: Math.round(q.dist), score: Math.round(q.score), in_range: q.inRange })),
      action: null,
      why: "",
    }
    const go = (p, reason) => {
      if (!p || p.sid === observedSid) { result.why = "уже на камере"; return result }
      if (st.command.sid === p.sid && now - st.command.at < T.command_grace_ms) { result.why = "ждём выполнения команды"; return result }
      // минимум удержания считаем с нашей команды, а не с момента, когда игра её выполнит:
      // иначе пока камера ещё не сменилась, режиссёр успевает отдать вторую команду
      if (!dry) { st.command = { sid: p.sid, at: now }; st.holdSince = now }
      result.action = { sid: p.sid, slot: p.slot, name: p.name, reason }
      return result
    }
    const hold = why => { result.why = why; return result }

    // Фазы без переключений
    const roundPhase = String(state.round?.phase || "")
    const mapPhase = String(state.map?.phase || "")
    const cdPhase = String(state.phase_countdowns?.phase || "")
    if (roundPhase !== st.lastRoundPhase) { st.lastRoundPhase = roundPhase; if (roundPhase !== "freezetime") st.freezeDone = false }
    if (["warmup", "intermission", "gameover"].includes(mapPhase)) return hold("фаза карты: " + mapPhase)
    if (["timeout_ct", "timeout_t", "paused"].includes(cdPhase)) return hold("тайм-аут")
    if (roundPhase === "over") return hold("конец раунда")
    if (roundPhase === "freezetime") {
      // Без пролёток: к старту раунда камера уже на игроке (P4, без ограничения дистанции)
      const left = Number(state.phase_countdowns?.phase_ends_in) * 1000
      if (!st.freezeDone && isFinite(left) && left <= T.pre_round_switch_ms) {
        if (!dry) st.freezeDone = true
        const q = sit.quiet[0]
        if (q) return go(q.p, `PRE-ROUND → ${q.p.name}`)
      }
      return hold("фризтайм")
    }
    // Команда отдана, но игра её ещё не выполнила — ждём, а не отдаём новую каждый тик
    if (st.command.sid && st.command.sid !== observedSid && now - st.command.at < T.command_grace_ms) {
      return hold("ждём выполнения команды")
    }

    // Текущего убили / нет на камере — раньше проверки «нет кандидатов»: с трупа уходим всегда
    if (!cur || !cur.alive) {
      if (cur && cur.deathAt && now - cur.deathAt < T.death_switch_ms) return hold("ждём после смерти")
      if (top && top.level === 0) return go(top.p, `${LEVEL_NAMES[0]} ${top.label} → ${top.p.name}`)
      const killer = cur?.killedBy ? players.find(p => p.sid === cur.killedBy && p.alive) : null
      if (killer && (sit.fighting(killer, cfg.contact.active_window_ms) || sit.entities.some(e => e.members.includes(killer)))) {
        return go(killer, `DEATH → убийца ${killer.name}`)
      }
      if (top) return go(top.p, `DEATH → ${LEVEL_NAMES[top.level]} ${top.label} → ${top.p.name}`)
      const near = sit.quiet[0]   // никого рядом с врагами — хотя бы ближайший к ним
      if (near) return go(near.p, `DEATH → ближайший к врагу ${near.p.name}`)
      return hold("нет живых кандидатов")
    }
    if (!top) return hold("нет кандидатов")

    // P0: клатч начался — сразу на одиночку и до конца раунда
    if (top.level === 0 && sit.clutch.lone) {
      if (cur.sid === sit.clutch.lone.sid) return hold("клатч — держим до конца раунда")
      return go(top.p, `${LEVEL_NAMES[0]} ${top.label} → ${top.p.name}`)
    }
    if (top.level === 0 && sit.clutch.duo) {
      const onDuo = sit.clutch.duo.some(p => p.sid === cur.sid)
      if (!onDuo) return go(top.p, `${LEVEL_NAMES[0]} 1v1 → ${top.p.name}`)
      if (top.p.sid === cur.sid) return hold("1v1 — показываем ближе к действию")
      const other = sit.clutch.scores[top.p.sid], mine = sit.clutch.scores[cur.sid]
      if (holds.fight_left > 0) return hold("1v1 — текущий в перестрелке")
      if (other >= mine + 40) return go(top.p, `${LEVEL_NAMES[0]} 1v1 → ${top.p.name} (явная причина)`)
      return hold("1v1 — без явной причины не переключаем")
    }

    // Не уводим с перестрелки и после килла
    if (holds.fight_left > 0) return hold("текущий в перестрелке")
    if (holds.kill_left > 0) return hold("текущий сделал килл")
    if (top.p.sid === cur.sid) return hold("лучший — текущий")

    // Более высокий приоритет — переключаемся без ожидания
    const curLevel = curLv.level === NO_LEVEL ? 4.5 : curLv.level
    if (top.level < curLevel && !(curLv.level === NO_LEVEL && top.level === 4)) {
      return go(top.p, `${LEVEL_NAMES[top.level]} ${top.label} → ${top.p.name}`)
    }
    if (holds.min_hold_left > 0) return hold("минимум на игроке")

    // Тот же уровень: только если заметно лучше
    let better
    if (curLv.entity && top.entity && curLv.entity === top.entity) {
      const mine = curLv.playerScore || 0
      const theirs = top.entity.ranked[0].score
      better = theirs >= Math.max(1, mine) * T.better_ratio
    } else {
      better = top.value >= Math.max(0.01, curLv.value) * T.better_ratio
    }
    if (better || curLv.level === NO_LEVEL) return go(top.p, `${LEVEL_NAMES[top.level]} ${top.label} → ${top.p.name}`)
    return hold("кандидат не лучше на " + Math.round((T.better_ratio - 1) * 100) + "%")
  }

  // Наш собственный выбор (при включении / возврате из паузы) — не считать перехватом
  function markOwn(sid, now) { st.command = { sid, at: now } }
  function lastCommand() { return st.command }

  // После пролётки: игрок по правилу P4 (без ограничения дистанции — во фризтайм все далеко).
  // Отмечаем фризтайм обработанным, чтобы обычное PRE-ROUND не нажало второй раз.
  function preRoundTarget(players, state, now, cfg) {
    const sit = analyze(players, state, now, cfg)
    st.freezeDone = true
    return sit.quiet[0]?.p || sit.alive[0] || null
  }

  return { decide, markOwn, lastCommand, analyze, preRoundTarget }
}

module.exports = { createDirector, LEVEL_NAMES }
