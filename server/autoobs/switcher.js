// ── Способ переключения камеры (заменяемый модуль) ──────────────────────────
// "keys"    — агент на ПК с CS2 жмёт цифру 1–0 по observer_slot скан-кодом
//             (команды идут по Socket.IO в пространство имён /agent).
// "console" — заготовка под будущее: если организаторы разрешат -tools,
//             spec_player_by_accountid пойдёт прямо в консоль.
//
// Протокол агента (Socket.IO, пространство имён /agent):
//   агент → сервер: agent:hello {host, version}, agent:hotkey {action:"on"|"off"},
//                   agent:manual {reason}, agent:focus {cs2}, agent:pressed {seq, key, skipped?}
//   сервер → агент: agent:press {seq, key, ttl_ms}, agent:release_all {}, agent:state {enabled, paused}

const AGENT_NS = "/agent"   // отдельное пространство имён: агент не получает пакеты HUD

// GSI отдаёт observer_slot с нуля (0…9), клавиши зрителя — 1…9, 0:
// слот 0 → «1», слот 8 → «9», слот 9 → «0». Проверено по записи матча
// (нажатие K выбирало игрока со слотом K−1). Так же считает миникарта HUD.
function slotKey(slot) {
  if (slot == null || slot === "") return null      // Number(null) = 0 — нажали бы «1»
  const n = Number(slot)
  if (!Number.isInteger(n) || n < 0 || n > 9) return null
  return String((n + 1) % 10)
}

function createKeysSwitcher(io, getCfg) {
  let seq = 0
  return {
    name: "keys",
    switchTo(target) {
      const key = slotKey(target.slot)
      if (key == null) return { ok: false, error: "нет observer_slot" }
      seq++
      io.of(AGENT_NS).emit("agent:press", { seq, key, ttl_ms: getCfg().timing.command_ttl_ms })
      return { ok: true, seq, key }
    },
    releaseAll() { io.of(AGENT_NS).emit("agent:release_all", {}) },
  }
}

function createConsoleSwitcher() {
  return {
    name: "console",
    switchTo() { return { ok: false, error: "консольный способ ещё не реализован (нужен -tools)" } },
    releaseAll() {},
  }
}

function createSwitcher(io, getCfg) {
  const keys = createKeysSwitcher(io, getCfg)
  const consoleSw = createConsoleSwitcher()
  return () => (getCfg().switch.method === "console" ? consoleSw : keys)
}

module.exports = { createSwitcher, AGENT_NS, slotKey }
