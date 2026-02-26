'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'fragdrop.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Шаг 1: создаём таблицы БЕЗ Steam-колонок (IF NOT EXISTS — не трогает старую БД)
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    session_id      TEXT PRIMARY KEY,
    nick            TEXT NOT NULL DEFAULT 'Игрок',
    balance         REAL NOT NULL DEFAULT 0,
    total_deposited REAL NOT NULL DEFAULT 0,
    cases_opened    INTEGER NOT NULL DEFAULT 0,
    upgrade_win     INTEGER NOT NULL DEFAULT 0,
    upgrade_loss    INTEGER NOT NULL DEFAULT 0,
    contracts       INTEGER NOT NULL DEFAULT 0,
    spent           REAL NOT NULL DEFAULT 0,
    earned          REAL NOT NULL DEFAULT 0,
    free_done       INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS inventory (
    uid         TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    skin_id     INTEGER NOT NULL,
    wear        TEXT NOT NULL,
    showcased   INTEGER NOT NULL DEFAULT 0,
    acquired_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (session_id) REFERENCES players(session_id)
  );
  CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    type        TEXT NOT NULL,
    skin_id     INTEGER NOT NULL,
    wear        TEXT NOT NULL,
    price       REAL NOT NULL,
    source      TEXT,
    ts          INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (session_id) REFERENCES players(session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_inv_session  ON inventory(session_id);
  CREATE INDEX IF NOT EXISTS idx_hist_session ON history(session_id, ts DESC);
`);

// Шаг 2: миграция — добавляем Steam-колонки если их нет в старой БД
const cols = db.prepare("PRAGMA table_info(players)").all().map(c => c.name);
if (!cols.includes('steam_id'))     db.exec("ALTER TABLE players ADD COLUMN steam_id TEXT");
if (!cols.includes('steam_avatar')) db.exec("ALTER TABLE players ADD COLUMN steam_avatar TEXT");

// Шаг 3: индекс по steam_id — только после того как колонка точно есть
// WHERE steam_id IS NOT NULL — частичный индекс, не конфликтует с NULL у не-Steam игроков
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_steam ON players(steam_id) WHERE steam_id IS NOT NULL;`);

const stmts = {
  getPlayer:        db.prepare('SELECT * FROM players WHERE session_id = ?'),
  getPlayerBySteam: db.prepare('SELECT * FROM players WHERE steam_id = ?'),
  createPlayer:     db.prepare('INSERT OR IGNORE INTO players (session_id, balance) VALUES (?, 1000)'),
  updateBalance:    db.prepare('UPDATE players SET balance = ? WHERE session_id = ?'),
  updateSteam:      db.prepare('UPDATE players SET steam_id = ?, nick = ?, steam_avatar = ? WHERE session_id = ?'),
  updateStats:      db.prepare(`UPDATE players SET
    cases_opened = cases_opened + @co,
    upgrade_win  = upgrade_win  + @uw,
    upgrade_loss = upgrade_loss + @ul,
    contracts    = contracts    + @ct,
    spent        = spent        + @sp,
    earned       = earned       + @ea,
    total_deposited = total_deposited + @td,
    free_done    = CASE WHEN @fd = 1 THEN 1 ELSE free_done END
    WHERE session_id = @sid`),
  addItem:      db.prepare('INSERT INTO inventory (uid, session_id, skin_id, wear) VALUES (@uid, @sid, @skinId, @wear)'),
  removeItem:   db.prepare('DELETE FROM inventory WHERE uid = ? AND session_id = ?'),
  getInventory: db.prepare('SELECT * FROM inventory WHERE session_id = ? ORDER BY acquired_at DESC'),
  getItem:      db.prepare('SELECT * FROM inventory WHERE uid = ? AND session_id = ?'),
  setShowcase:  db.prepare('UPDATE inventory SET showcased = ? WHERE uid = ? AND session_id = ?'),
  addHistory:   db.prepare('INSERT INTO history (session_id, type, skin_id, wear, price, source) VALUES (@sid, @type, @skinId, @wear, @price, @source)'),
  getHistory:   db.prepare('SELECT * FROM history WHERE session_id = ? ORDER BY ts DESC LIMIT 100'),
};

function getOrCreate(sid) { stmts.createPlayer.run(sid); return stmts.getPlayer.get(sid); }
function deposit(sid, amount) {
  if (amount <= 0 || amount > 1_000_000) throw new Error('Недопустимая сумма');
  const p = stmts.getPlayer.get(sid);
  if (!p) throw new Error('Игрок не найден');
  const newBal = p.balance + amount;
  db.transaction(() => {
    stmts.updateBalance.run(newBal, sid);
    stmts.updateStats.run({ co:0,uw:0,ul:0,ct:0,sp:0,ea:0,td:amount,fd:0,sid });
  })();
  return newBal;
}
function addItem(sid, { uid, skinId, wear })   { stmts.addItem.run({ uid, sid, skinId, wear }); }
function removeItem(sid, uid)                  { return stmts.removeItem.run(uid, sid).changes > 0; }
function getInventory(sid)                     { return stmts.getInventory.all(sid); }
function getItem(sid, uid)                     { return stmts.getItem.get(uid, sid); }
function addHistory(sid, { type, skinId, wear, price, source }) {
  stmts.addHistory.run({ sid, type, skinId, wear, price, source });
}
function getHistory(sid) { return stmts.getHistory.all(sid); }

module.exports = { db, stmts, getOrCreate, deposit, addItem, removeItem, getInventory, getItem, addHistory, getHistory };
