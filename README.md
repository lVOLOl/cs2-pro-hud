# CS2 Pro HUD

Кастомный HUD для трансляций турниров по Counter-Strike 2. Получает данные из игры через Game State Integration (GSI) и отображает счёт, таймер раунда, игроков, киллфид (кто кого убил, оружие, ассисты флешем/уроном).

## Запуск

1. Установить зависимости: `npm install`
2. Запустить сервер: `node server/server.js`
3. Открыть в браузере: http://localhost:3000
4. В OBS добавить источник «Браузер» с URL http://localhost:3000 (фон прозрачный).

## Подключение CS2 (Game State Integration)

Чтобы игра отправляла состояние на HUD:

1. Найти папку конфигов CS2:
   - **Windows:** `Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\`
   - Для CS2 путь может быть: `...\Counter-Strike 2\game\csgo\cfg\`
2. Скопировать файл `cfg/gamestate_integration_prohud.vdf` в эту папку.
3. В файле при необходимости изменить URL: заменить `http://localhost:3000/` на адрес твоего сервера (для трансляции с одной машины оставь localhost).
4. Перезапустить CS2 или сменить карту.

Игра будет отправлять POST-запросы с JSON-состоянием на указанный URL. Сервер раздаёт это состояние всем открытым клиентам по WebSocket (Socket.IO).

## Ассеты

Положи в папку `hud/assets/`:

- **bomb.png** — иконка бомбы.
- **weapons/** — иконки оружий (имя файла = имя оружия без префикса `weapon_`), например: `ak47.png`, `awp.png`, `knife.png`, `deagle.png`.
- **teams/** — логотипы команд (имя файла = название команды с подчёркиваниями вместо пробелов), например: `Team_Vitality.png`, `Natus_Vincere.png`. Если файла нет, можно задать маппинг в коде (`teamLogoMap` в main.js).

## Переменные окружения

- **STEAM_API_KEY** — ключ Steam Web API для загрузки аватарок игроков. Без ключа используется встроенный (лимиты могут быть жёстче). Получить ключ: https://steamcommunity.com/dev/apikey

## Структура проекта

- **server/server.js** — Express + Socket.IO, приём GSI POST, раздача state клиентам, роут `/avatar/:steamid` для аватарок.
- **hud/** — статика HUD: index.html, style.css, main.js (счёт, таймер, бомба, киллфид, логотипы, игроки).
- **hud/players.js** — список игроков CT/T, аватар, хп, оружие, деньги.
- **hud/killfeed.js** — отображение убийств (кто кого, оружие, ассист флешем/уроном).
- **steam/steam.js** — getAvatar(steamid) через Steam Web API.
- **cfg/gamestate_integration_prohud.vdf** — конфиг GSI для CS2.

## Киллфид

Формат данных: в state должен быть массив **`recent_kills`** (или **`kill_feed`**). Каждый элемент:

| Поле | Описание |
|------|----------|
| `killer_steamid` / `killer_name` | Убийца (имя подставится из `allplayers`, если передан steamid) |
| `victim_steamid` / `victim_name` | Жертва |
| `weapon` | Оружие (например `weapon_ak47` или `ak47`) — для иконки `assets/weapons/{weapon}.svg` |
| `assister_steamid` / `assister_name` | Ассистент (опционально) |
| `assist_type` | `"flash"` (флеш-ассист) или `"damage"` (ассист уроном) |

Пример: `{ "killer_steamid": "...", "victim_steamid": "...", "weapon": "ak47", "assister_steamid": "...", "assist_type": "flash" }`.

В интерфейсе: строка «Killer [иконка оружия] Victim», ниже — «Flash: Имя» (жёлтым) или «Assist: Имя» (серым).

Если `recent_kills` нет, по `allplayers[].state.round_kills` показывается только факт убийства (кто убил, без жертвы и оружия). Сброс при фазе freezetime/over.
