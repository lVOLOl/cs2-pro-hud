# ts-listener

Два бота TeamSpeak 3 для голоса команд в cs2-pro-hud. Запускается сервером худа
(`server/ts-audio.js`) из `ts/ts-listener.exe`, руками запускать не нужно.

Бот 1 сидит в канале команды 1, бот 2 — в канале команды 2. Каждые 20 мс в stdout
идёт микс голосов канала: `'P'`, номер команды (0/1), 960 сэмплов i16 LE, моно, 48 кГц.
Статус — строками JSON в stderr. Ключи ботов хранятся в `ts/ts-identities.txt`.

Сборка под Windows: `cargo build --release` (на Windows) или кросс-компиляция
`--target x86_64-pc-windows-gnu`. Основано на https://github.com/ReSpeak/tsclientlib
