# FragDrop — Инструкция по установке на Ubuntu/Debian

## 1. Установка Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # должно быть v20.x.x
```

## 2. Создание пользователя и папки

```bash
sudo useradd -m -s /bin/bash fragdrop
sudo su - fragdrop
mkdir -p ~/app && cd ~/app
```

## 3. Загрузка файлов

Скопируй на сервер папку `fragdrop-server` любым способом:
```bash
# Вариант через scp с локальной машины:
scp -r fragdrop-server/ user@YOUR_IP:~/app/

# Или создай файлы вручную через nano/vim
```

## 4. Установка зависимостей

```bash
cd ~/app/fragdrop-server
npm install
```

## 5. Тест запуска

```bash
node server.js
# → FragDrop server running on http://localhost:3000
```

Открой в браузере: `http://YOUR_SERVER_IP:3000`

## 6. Автозапуск через systemd (постоянная работа)

```bash
sudo nano /etc/systemd/system/fragdrop.service
```

Вставь содержимое:
```ini
[Unit]
Description=FragDrop Server
After=network.target

[Service]
Type=simple
User=fragdrop
WorkingDirectory=/home/fragdrop/app/fragdrop-server
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=fragdrop
Environment=NODE_ENV=production PORT=3000

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable fragdrop
sudo systemctl start fragdrop
sudo systemctl status fragdrop   # должно быть active (running)
```

## 7. Открыть порт в файрволе

```bash
sudo ufw allow 3000/tcp
sudo ufw status
```

Сайт доступен по адресу: `http://YOUR_SERVER_IP:3000`

## 8. Полезные команды

```bash
# Логи в реальном времени
sudo journalctl -u fragdrop -f

# Перезапустить после изменений
sudo systemctl restart fragdrop

# База данных
ls ~/app/fragdrop-server/data/fragdrop.db
# Просмотр через sqlite3:
sqlite3 ~/app/fragdrop-server/data/fragdrop.db
> SELECT session_id, nick, balance FROM players;
> .quit
```

## Структура проекта

```
fragdrop-server/
├── server.js          ← Express сервер, все API роуты
├── db.js              ← SQLite слой (better-sqlite3)
├── package.json
├── game/
│   ├── data.js        ← SKINS[], CASES[]
│   └── logic.js       ← weightedRoll, upgrade, contract
├── public/
│   └── index.html     ← Фронтенд (твой fragdrop.html)
└── data/
    └── fragdrop.db    ← База данных (создаётся автоматически)
```

## API endpoints

| Метод | URL              | Описание                        |
|-------|------------------|---------------------------------|
| GET   | /api/state       | Получить всё состояние игрока   |
| POST  | /api/deposit     | { amount }                      |
| POST  | /api/spin        | { caseId }                      |
| POST  | /api/spin/multi  | { caseId, count }               |
| POST  | /api/sell        | { itemUid }                     |
| POST  | /api/upgrade     | { srcUid, srcSkinId, dstSkinId }|
| POST  | /api/contract    | { itemUids: [] }                |
| POST  | /api/showcase    | { itemUid, on: bool }           |
| POST  | /api/nick        | { nick }                        |

## Безопасность

- Баланс и инвентарь хранятся только в SQLite на сервере
- Клиент не может изменить баланс напрямую — только через API
- Сессия в httpOnly cookie — JavaScript не может её прочитать
- Rate limiting: 120 запросов/мин на API, 15 спинов/10сек
- Вся игровая логика (roll, шансы) выполняется на сервере
