'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'fragdrop.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Схема ──────────────────────────────────────────────────────────────────
// Основной ключ игрока — steam_id (не session_id)
// session_id используется только как временный указатель на steam_id
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    steam_id        TEXT PRIMARY KEY,
    nick            TEXT NOT NULL DEFAULT 'Игрок',
    steam_avatar    TEXT,
    balance         REAL    NOT NULL DEFAULT 0,
    total_deposited REAL    NOT NULL DEFAULT 0,
    cases_opened    INTEGER NOT NULL DEFAULT 0,
    upgrade_win     INTEGER NOT NULL DEFAULT 0,
    upgrade_loss    INTEGER NOT NULL DEFAULT 0,
    contracts       INTEGER NOT NULL DEFAULT 0,
    spent           REAL    NOT NULL DEFAULT 0,
    earned          REAL    NOT NULL DEFAULT 0,
    free_done       INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS inventory (
    uid         TEXT    PRIMARY KEY,
    steam_id    TEXT    NOT NULL,
    skin_id     INTEGER NOT NULL,
    wear        TEXT    NOT NULL,
    showcased   INTEGER NOT NULL DEFAULT 0,
    acquired_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (steam_id) REFERENCES players(steam_id)
  );

  CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    steam_id    TEXT    NOT NULL,
    type        TEXT    NOT NULL,
    skin_id     INTEGER NOT NULL,
    wear        TEXT    NOT NULL,
    price       REAL    NOT NULL,
    source      TEXT,
    ts          INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (steam_id) REFERENCES players(steam_id)
  );

  CREATE INDEX IF NOT EXISTS idx_inv_steam  ON inventory(steam_id);
  CREATE INDEX IF NOT EXISTS idx_hist_steam ON history(steam_id, ts DESC);
`);

// ── Prepared statements ────────────────────────────────────────────────────
const stmts = {
  getPlayer:     db.prepare('SELECT * FROM players WHERE steam_id = ?'),
  upsertPlayer:  db.prepare(`
    INSERT INTO players (steam_id, nick, steam_avatar)
    VALUES (?, ?, ?)
    ON CONFLICT(steam_id) DO UPDATE SET
      nick         = excluded.nick,
      steam_avatar = excluded.steam_avatar
  `),
  updateBalance: db.prepare('UPDATE players SET balance = ? WHERE steam_id = ?'),
  updateStats:   db.prepare(`
    UPDATE players SET
      cases_opened    = cases_opened    + @co,
      upgrade_win     = upgrade_win     + @uw,
      upgrade_loss    = upgrade_loss    + @ul,
      contracts       = contracts       + @ct,
      spent           = spent           + @sp,
      earned          = earned          + @ea,
      total_deposited = total_deposited + @td,
      free_done       = CASE WHEN @fd = 1 THEN 1 ELSE free_done END
    WHERE steam_id = @sid
  `),

  // Inventory
  addItem:      db.prepare('INSERT INTO inventory (uid, steam_id, skin_id, wear) VALUES (@uid, @sid, @skinId, @wear)'),
  removeItem:   db.prepare('DELETE FROM inventory WHERE uid = ? AND steam_id = ?'),
  getInventory: db.prepare('SELECT * FROM inventory WHERE steam_id = ? ORDER BY acquired_at DESC'),
  getItem:      db.prepare('SELECT * FROM inventory WHERE uid = ? AND steam_id = ?'),
  setShowcase:  db.prepare('UPDATE inventory SET showcased = ? WHERE uid = ? AND steam_id = ?'),

  // History
  addHistory:   db.prepare('INSERT INTO history (steam_id, type, skin_id, wear, price, source) VALUES (@sid, @type, @skinId, @wear, @price, @source)'),
  getHistory:   db.prepare('SELECT * FROM history WHERE steam_id = ? ORDER BY ts DESC LIMIT 100'),
};

// Создать/обновить игрока при логине через Steam
function upsertPlayer(steamId, nick, avatar) {
  stmts.upsertPlayer.run(steamId, nick, avatar || null);
  // Стартовый баланс 1000 только при первом создании
  const p = stmts.getPlayer.get(steamId);
  if (p.balance === 0 && p.cases_opened === 0) {
    stmts.updateBalance.run(1000, steamId);
  }
  return stmts.getPlayer.get(steamId);
}

function getPlayer(steamId)  { return stmts.getPlayer.get(steamId); }

function deposit(steamId, amount) {
  if (amount <= 0 || amount > 1_000_000) throw new Error('Недопустимая сумма');
  const p = stmts.getPlayer.get(steamId);
  if (!p) throw new Error('Игрок не найден');
  const newBal = p.balance + amount;
  db.transaction(() => {
    stmts.updateBalance.run(newBal, steamId);
    stmts.updateStats.run({ co:0,uw:0,ul:0,ct:0,sp:0,ea:0,td:amount,fd:0,sid:steamId });
  })();
  return newBal;
}

function addItem(steamId, { uid, skinId, wear }) {
  stmts.addItem.run({ uid, sid: steamId, skinId, wear });
}
function removeItem(steamId, uid)  { return stmts.removeItem.run(uid, steamId).changes > 0; }
function getInventory(steamId)     { return stmts.getInventory.all(steamId); }
function getItem(steamId, uid)     { return stmts.getItem.get(uid, steamId); }
function addHistory(steamId, { type, skinId, wear, price, source }) {
  stmts.addHistory.run({ sid: steamId, type, skinId, wear, price, source });
}
function getHistory(steamId) { return stmts.getHistory.all(steamId); }

module.exports = {
  db, stmts,
  upsertPlayer, getPlayer, deposit,
  addItem, removeItem, getInventory, getItem, addHistory, getHistory,
};
