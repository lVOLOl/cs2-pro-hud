// ── Конфиг автообсерва ───────────────────────────────────────────────────────
// Все пороги и времена — в autoobs.json рядом с settings.json.
// В файле указывается только то, что меняешь, — остальное берётся отсюда
// (поэтому новые значения по умолчанию из обновлений не перекрываются старой копией).
// Правки подхватываются без перезапуска сервера (проверка раз в 2 с).

const fs = require("fs")
const path = require("path")

// Файл, который создаётся при первом запуске
const STARTER = {
  disabled: false,
  _doc: "Здесь только то, что меняешь. Все ключи и значения по умолчанию — server/autoobs/config.js и docs/autoobs.md",
}

const DEFAULTS = {
  disabled: false,          // true — автообсерв и пролётки отключены целиком (код остаётся; запись GSI работает)
  contact: {
    r_contact: 1200,        // враги ближе — возможный контакт (2D, юниты)
    r_support: 600,         // союзники ближе к участнику контакта — тоже в кластере
    big_cluster: 4,         // от стольких игроков контакт «крупный» (P1)
    look_deg: 30,           // «смотрит на врага»: угол между взглядом и направлением на врага
    look_deg_sniper: 15,    // то же для снайперской винтовки в руках
    floor_dz: 200,          // |Δz| больше — другой этаж, не контакт
    active_window_ms: 2000, // окно для «активности» контакта (выстрелы/урон)
    link_memory_ms: 1500,   // связь двух врагов держится столько после пропадания (против мигания)
    max_span: 1600,         // кластер не шире этого — не склеиваем полкарты в один контакт
  },
  sniper: {
    enabled: true,
    include_ssg: false,     // считать SSG 08 снайперской
    max_dist: 4000,
    prefer: "peeker",       // "peeker" — того, кто выглядывает (движется); "holder" — того, кто держит угол
  },
  quiet: {
    max_enemy_dist: 3500,   // дальше от ближайшего врага — в тишине не показываем
    approach_weight: 1.5,   // сколько юнитов «дистанции» даёт 1 ед/с сближения
    bomb_carrier_bonus: 400 // носитель бомбы за T считается ближе на столько юнитов
  },
  timing: {
    min_hold_ms: 3000,          // минимум на одном игроке
    fight_hold_ms: 1500,        // стрелял / получал урон за это время — не уводим
    kill_hold_ms: 1500,         // сделал килл — держим минимум столько
    death_switch_ms: 700,       // текущего убили — переключаемся через столько
    better_ratio: 1.25,         // внутри уровня — только если новый лучше на 25%
    manual_pause_ms: 5000,      // ручное переключение / мышь — пауза автомата
    pre_round_switch_ms: 1500,  // за столько до конца фризтайма — камера на игрока (P4)
    kill_attrib_ms: 700,        // окно сопоставления убийцы и жертвы (GSI ~4 пакета в секунду)
    level_memory_ms: 2000,      // текущий игрок «помнит» свой уровень столько (против мигания)
    command_grace_ms: 1800,     // столько ждём, что игра выполнит нашу команду
    command_ttl_ms: 1500,       // старше — агент команду не нажимает
  },
  switch: {
    method: "keys",             // "keys" — агент жмёт цифры; позже "console"
  },
  flyover: {
    enabled: true,
    start_delay_ms: 500,        // старт через столько после начала фризтайма
    end_before_ms: 1800,        // закончить за столько до конца фризтайма (> pre_round_switch_ms)
    min_freeze_ms: 6000,        // до конца фризтайма меньше — не запускать
    in_timeouts: false,         // пролётки в тайм-аутах
    hz: 60,                     // кадров spec_goto в секунду
    height: 450,                // высота камеры над спавном (выше крыш)
    speed: 150,                 // ед/с
    max_turn_dps: 18,           // поворот не быстрее, °/с
    min_ms: 8000,               // длительность пролётки
    max_ms: 15000,
    enter_cmd: "",              // команда перед первым кадром, например "spec_mode 4" — проверить в CS2
    exit_cmd: "",               // команда после пролётки (до нажатия цифры игрока)
  },
  log: {
    file: "autoobs.log",        // пусто — не писать в файл
  },
}

function deepMerge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return base
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object"
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

function createConfig(baseDir) {
  const file = path.join(baseDir, "autoobs.json")
  let current = DEFAULTS
  let mtime = 0
  let error = ""

  function load() {
    try {
      if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(STARTER, null, 2))
      const st = fs.statSync(file)
      if (st.mtimeMs === mtime) return
      mtime = st.mtimeMs
      current = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(file, "utf8")))
      error = ""
    } catch (e) {
      error = "autoobs.json: " + e.message   // при ошибке остаётся прошлый рабочий конфиг
    }
  }
  load()
  setInterval(load, 2000).unref()

  return {
    get: () => current,
    file,
    error: () => error,
    raw: () => { try { return fs.readFileSync(file, "utf8") } catch { return JSON.stringify(DEFAULTS, null, 2) } },
    save(text) {
      const parsed = JSON.parse(text)          // бросит ошибку, если JSON битый
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2))
      mtime = 0
      load()
    },
  }
}

module.exports = { createConfig, DEFAULTS, deepMerge }
