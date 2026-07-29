# CS2 Pro HUD

Broadcast-оверлей для CS2 в стиле профессиональных трансляций. Работает через CS2 Game State Integration (GSI) — официальный API, никаких читов и инъекций.

---

## Возможности

### Топбар
- Счёт CT / T с логотипами команд
- Таймер раунда с тремя режимами:
  - Стандартный обратный отсчёт
  - Красный + иконка C4 + пульсирующая анимация — бомба заложена
  - Зелёный + иконка дефьюзера — идёт разминирование
- SVG-кольцо прогресса вокруг таймера (60 fps, requestAnimationFrame)
- Счётчик живых игроков `X vs X` под таймером
- **Fire streak** — если команда берёт 5 раундов подряд, её панель загорается с оранжевым пульсирующим свечением; стрик сбрасывается при проигрыше раунда и корректно переносится через смену сторон на перерыве

### Карточки игроков (боковые панели)
- 5 игроков CT слева, 5 T справа
- Аватарки из Steam API
- HP-бар, броня (кевлар / шлем + кевлар), деньги, observer-слот
- Оружие + пистолет + гранаты в инвентаре с SVG-иконками
- Звёзды убийств в раунде
- **DiR** (Damage in Round) — когда игрок мёртв, вместо HP показывается урон нанесённый им за раунд
- Плавная анимация смерти: карточка сужается и тускнеет

### Карточка наблюдаемого игрока

Два режима, переключаются в панели администратора:

**Detail** (стандартный):
- Аватарка или живая вебка слева
- Имя, команда, HP
- Активное оружие + боезапас (анимация убывания патронов)
- Броня с иконкой, иконка дефьюзер-кита для CT
- Гранаты в инвентаре, звёзды убийств, K / A / D за матч

**Broadcast** (для трансляций):
- Вебка / аватарка заполняет весь блок
- Иконки гранат в левом нижнем углу, боезапас в правом
- Внизу: плашка с именем игрока и числом HP
- HP-бар в цвет команды (CT = синий, T = жёлтый) с красным «отколом» при получении урона

### Гранаты команды
- Панель всегда видна: CT слева, T справа
- Количество HE / Flash / Smoke / Molotov у живых игроков каждой команды
- Иконки с 0 затемняются

### Статистика раунда (Round Stats)
- Появляется в freezetime, исчезает за 3 секунды до старта раунда
- Плавный fade-in / fade-out
- K / A / D, K/D для каждого игрока обеих команд
- **ADR** (Average Damage per Round) — накапливается локально из `round_totaldmg` на протяжении всего матча
- Сортировка: убийства → K/D → ADR

### Миникарта
- Все соревновательные карты: Dust2, Mirage, Inferno, Overpass, Vertigo, Ancient, Anubis, Nuke
- de_nuke: два этажа (верхний / нижний) автоматически по Z-координате
- Плавное движение точек (lerp 60 fps), стрелка направления взгляда
- Номера observer-слотов (1–0) внутри точек
- Бомбоносец подсвечивается красным пульсирующим кольцом
- Маркер C4 (пульсирует когда заложена)
- Крестики смерти в цвете команды, сбрасываются при новом раунде
- **Гранаты на миникарте** (требует CSSharp-плагин):
  - Smoke — расширяющийся серый круг (реальный радиус 144 units, анимация 3.5 с)
  - Molotov / Inferno — пульсирующий оранжевый круг (150 units)
  - HE — жёлтая вспышка (80 units)
  - Flashbang — белая вспышка (60 units)
  - Каждый тип — своя иконка + полупрозрачный круг поражения

### Оверлеи
- **TACTICAL PAUSE** — всплывает при тайм-ауте, показывает команду CT/T
- **DEFUSING** — зелёный таймер разминирования с точностью до сотых, бейдж KIT при наличии кита; кольцо прогресса корректно анимируется как для 10 с (без кита), так и для 5 с (с китом) — от 100% до 0% за точное время дефьюза
- **Kill Feed** — лента убийств: оружие, хедшот, слепое убийство, сквозь дым, через стену, ноускоп, ассист (флеш / урон)

### Webcam
- Привязка SteamID64 → URL (VDO.ninja или любой iframe-совместимый источник)
- Все iframe'ы предзагружены в фоне — переключение мгновенное
- В режиме Broadcast вебка занимает весь блок наблюдаемого игрока

### Player Card (индивидуальная карточка игрока)

Отдельная страница-оверлей для каждого игрока. Открывается как отдельный Browser Source в OBS для стримерских раскладок.

**URL:** `http://localhost:3000/player/1` … `http://localhost:3000/player/10`

Каждый URL привязан к конкретному наблюдательному слоту (1–10). Номер слота берётся из пути URL, выполняется поиск SteamID в `player-cards.json → slots`, и карточка автоматически показывает данные нужного игрока.

**Что отображается:**
- Анимированный фон (плавающие орбы, частицы, световые засветки на Canvas)
- Турнирная информация (две строки — название + стадия)
- Счёт CT : T + таймер раунда (с режимами: заморозка, бомба заложена, разминирование) + название карты
- Вебкам (iframe) или аватарка Steam — автоматически по тому, есть ли привязка в `webcams.json`
- Имя игрока + K / A / D за матч
- Иконка уровня Faceit (level_1 … level_10) + ELO
- Иконка роли игрока (carry, sniper, entry, anchor, rifler, support) + название роли

**Настройка данных** через `/api/player-cards` (POST) или файл `player-cards.json`:

```json
{
  "tournament": ["НАЗВАНИЕ ТУРНИРА", "Стадия"],
  "slots": { "1": "76561198...", "2": "76561199..." },
  "players": {
    "76561198...": { "elo": 3055, "role": "CARRY" }
  }
}
```

**Необходимые ассеты** (положить в `hud/assets/faceit/`):
- `level_1.png` … `level_10.png` — иконки уровней Faceit
- `carry.svg`, `sniper.svg`, `entry.svg`, `anchor.svg`, `rifler.svg`, `support.svg` — иконки ролей

Все данные обновляются в реальном времени через Socket.IO (`state`, `player-cards`, `webcams`, `veto`).

### Map Veto Bar
- Стрип над миникартой
- BO1 / BO3 / BO5, статус карты (предстоящая / активная / сыграна), счёт по картам
- Прокрутка при большом числе карт

### Страница администратора
`http://localhost:3000/admin`

- **Webcam Bindings** — привязка SteamID64 → URL вебки, автоматически подтягивает игроков из текущей игры (обновляется каждые 3 с)
- **Map Veto** — редактор вето, публикуется мгновенно через Socket.IO
- **Display Modes** — Detail / Broadcast; переключатель гранат на миникарте
- **Steam API** — поле для ввода ключа прямо в интерфейсе (сохраняется в `.env`, без перезапуска сервера)
- **Team Logos** — загрузка PNG/SVG логотипов и назначение конкретного файла для стороны CT и T через dropdown; сохраняется в `player-cards.json`, HUD обновляется мгновенно без перезагрузки

> Все изменения в admin-панели применяются во всех открытых Browser Source мгновенно через Socket.IO — без перезагрузки страниц.

---

## Установка и запуск

**Требования:** Node.js 18+

```bash
npm install
npm start
```

Сервер запустится на `http://localhost:3000`.

### Сборка .exe (без Node.js на целевой машине)

```bash
npm install -g pkg
pkg server/server.js --targets node18-win-x64 --out-path dist/
```

Рядом с `server.exe` должна находиться папка `hud/` со всеми ассетами.

---

## Настройка

### 1. Steam API Key (аватарки)

Получить ключ на [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey).

**Вариант A** — через панель администратора (рекомендуется):
Открыть `http://localhost:3000/admin`, секция **Steam API**, вставить ключ и нажать «Сохранить».

**Вариант B** — через файл `.env` в корне проекта:
```env
STEAM_API_KEY=ВАШ_32_СИМВОЛЬНЫЙ_КЛЮЧ
```

Без ключа HUD работает полностью — аватарки просто не загружаются.

### 2. Game State Integration

Скопировать `cfg/gamestate_integration_prohud.vdf` в:

```
C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\
```

Перезапустить CS2 (или сменить карту).

### 3. OBS Browser Source

| Параметр | Значение |
|---|---|
| URL | `http://localhost:3000` |
| Ширина | 1920 |
| Высота | 1080 |
| Пользовательский CSS | `body { background: transparent !important; }` |

Административная панель открывается в обычном браузере: `http://localhost:3000/admin`

### 4. Логотипы команд

**Вариант A — через панель администратора (рекомендуется):**

1. Открыть `http://localhost:3000/admin`, секция **Team Logos**
2. Загрузить PNG/SVG через кнопку загрузки
3. Выбрать нужный файл в dropdown для CT-стороны и T-стороны
4. Нажать «Сохранить» — HUD обновится мгновенно

Этот способ работает всегда, независимо от того, настроены ли названия команд в CS2.

**Вариант B — по имени команды (автоматически):**

Положить PNG-файлы в `hud/assets/teams/`. Имя файла = название команды из CS2 с заменой пробелов на `_`:

```
hud/assets/teams/Natus_Vincere.png
hud/assets/teams/Team_Spirit.png
```

HUD найдёт лого автоматически, если CS2 отдаёт название команды в GSI.

---

## CSSharp плагин (гранаты на миникарте)

CS2 GSI не отдаёт данные о брошенных гранатах в обычном матче. Плагин для CounterStrikeSharp хукает игровые события и шлёт координаты на HUD-сервер.

### Что делает

При взрыве каждой гранаты отправляет `POST http://localhost:3000/grenade` с телом `{id, type, x, y, z}`:

| Тип | Значение `type` | TTL |
|---|---|---|
| Smoke | `smoke` | 20 с |
| Molotov / Incgrenade | `inferno` | 10 с |
| HE | `frag` | 3 с |
| Flashbang | `flashbang` | 2 с |

### Компиляция

```bash
cd csharp
dotnet build -c Release
```

### Установка

Скопировать `csharp/bin/Release/net8.0/GrenadeTracker.dll` на CS2-сервер:

```
game/csgo/addons/counterstrikesharp/plugins/GrenadeTracker/GrenadeTracker.dll
```

Перезапустить сервер или выполнить `css_plugins_load GrenadeTracker`.

После установки включить гранаты в админ-панели: **Display Modes → Гранаты на карте → Вкл**.

---

## Структура проекта

```
cs2-pro-hud/
├── server/
│   └── server.js          # Express + Socket.IO, GSI, Kill Detection, Fire Streak, все REST API
├── hud/
│   ├── index.html         # Основной оверлей (DOM)
│   ├── admin.html         # Панель администратора
│   ├── player-card.html   # Индивидуальная карточка игрока (/player/1–10)
│   ├── main.js            # Топбар, таймер, fire streak, наблюдаемый игрок, round stats
│   ├── players.js         # Боковые карточки игроков, классификация оружий
│   ├── minimap.js         # Миникарта (Canvas, RAF, lerp, многоэтажность, гранаты)
│   ├── killfeed.js        # Лента убийств
│   ├── style.css          # Все стили (~1400 строк)
│   └── assets/
│       ├── weapons/       # SVG-иконки оружий + kill/modifier PNG
│       ├── overviews/
│       │   ├── radar/     # PNG-радары карт + .txt файлы калибровки
│       │   └── map_logo/  # Превью карт для veto bar
│       ├── logos/         # Fallback логотип команды
│       ├── teams/         # Логотипы команд (добавить вручную)
│       └── faceit/        # level_1–10.png + иконки ролей .svg
├── steam/
│   └── steam.js           # Steam Web API (аватарки)
├── csharp/
│   ├── GrenadeTracker.cs  # CounterStrikeSharp плагин для гранат
│   └── GrenadeTracker.csproj
├── cfg/
│   └── gamestate_integration_prohud.vdf   # Конфиг GSI для CS2
├── .env                   # STEAM_API_KEY (не коммитится)
├── settings.json          # obs_mode, show_grenades (создаётся автоматически)
├── player-cards.json      # Данные карточек: tournament, slots, players (ELO, role)
├── veto.json              # Данные veto (создаётся автоматически)
├── webcams.json           # SteamID64 → URL (создаётся автоматически)
└── package.json
```

---

## Архитектура

```
CS2 → POST / (0.1 с) → server.js
  normalizeGSI()              нормализация полей
  trackGrenadeThrows()        трекинг бросков гранат по тикам
  detectKills()               сравнение HP / kills между тиками
  fire streak logic           отслеживание серии побед по стороне (CT/T)
  io.emit("state", gameState) → OBS Browser Source

CSSharp Plugin → POST /grenade → activeGrenades{} → io.emit("grenades")
setInterval 500ms → удаление устаревших гранат → io.emit("grenades")

Admin Browser → POST /api/settings|veto|webcams
  → запись файла → io.emit() → мгновенное обновление в OBS
```

---

## API

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/` | GSI endpoint — данные от CS2 |
| `GET` | `/api/state` | Текущий gameState как JSON (для отладки) |
| `GET` | `/admin` | Страница администратора |
| `GET` | `/api/players` | Игроки из текущей игры |
| `GET/POST` | `/api/webcams` | Привязки SteamID64 → URL |
| `GET/POST` | `/api/veto` | Данные veto |
| `GET/POST` | `/api/settings` | Настройки HUD |
| `GET/POST` | `/api/steam-key` | Чтение / обновление Steam API Key |
| `POST` | `/api/streak` | Ручная установка стрика `{ side, streak }` |
| `GET` | `/api/mapinfo/:map` | Калибровка миникарты (pos_x, pos_y, scale) |
| `GET` | `/avatar/:steamid` | 302-редирект на аватарку Steam |
| `GET` | `/radar/:map` | PNG-радар карты |
| `POST` | `/grenade` | CSSharp: координаты взрыва гранаты |
| `POST` | `/kill` | CSSharp: обогащённые данные убийства (wallbang, noscope и т.д.) |
| `GET` | `/player/:slot` | Индивидуальная карточка игрока (slot = 1–10) |
| `GET` | `/api/logos` | Список загруженных файлов логотипов из `hud/assets/teams/` |
| `POST` | `/api/logo` | Загрузка нового логотипа (multipart/form-data, поле `logo`) |
| `GET/POST` | `/api/player-cards` | Данные карточек игроков; POST принимает `{ team_logos: { ct, t } }` для назначения логотипов |

Socket.IO события от сервера: `state`, `grenades`, `settings`, `veto`, `logos-updated`, `player-cards`.

---

## Поддерживаемые карты

| Карта | Этажей |
|---|---|
| de_dust2 | 1 |
| de_mirage | 1 |
| de_inferno | 1 |
| de_overpass | 1 |
| de_vertigo | 1 |
| de_ancient | 1 |
| de_anubis | 1 |
| de_nuke | 2 (верхний / нижний по Z) |
| de_cache | 1 |
