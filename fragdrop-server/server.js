'use strict';

const express    = require('express');
const cookieParser = require('cookie-parser');
const rateLimit  = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');

const { SKINS, CASES, SKIN_MAP, CASE_MAP } = require('./game/data');
const { weightedRoll, resolveUpgrade, resolveContract, randWear, uid, upgradeChance } = require('./game/logic');
const DB = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов' }
});

const spinLimiter = rateLimit({
  windowMs: 10 * 1000, // 10 секунд
  max: 15,  // не более 15 спинов за 10 сек
  message: { error: 'Слишком быстро' }
});

app.use('/api', apiLimiter);
app.use('/api/spin', spinLimiter);

// ── Session middleware ────────────────────────────────
function getSession(req, res) {
  let sid = req.cookies['fd_sid'];
  if (!sid || !/^[0-9a-f-]{36}$/.test(sid)) {
    sid = uuidv4();
    res.cookie('fd_sid', sid, {
      httpOnly: true,     // JS не может читать
      sameSite: 'strict',
      maxAge: 365 * 24 * 60 * 60 * 1000  // 1 год
    });
  }
  return sid;
}

// Helper — обогащаем инвентарь данными скина
function enrichInventory(rows) {
  return rows.map(row => {
    const skin = SKIN_MAP.get(row.skin_id);
    if (!skin) return null;
    return { uid: row.uid, skinId: row.skin_id, wear: row.wear, showcased: row.showcased,
             name: skin.name, weapon: skin.weapon, rarity: skin.rarity,
             price: skin.price, img: skin.img };
  }).filter(Boolean);
}

function enrichHistory(rows) {
  return rows.map(row => {
    const skin = SKIN_MAP.get(row.skin_id);
    if (!skin) return null;
    return { type: row.type, skin: { ...skin }, wear: row.wear,
             price: skin.price, source: row.source, ts: row.ts * 1000 };
  }).filter(Boolean);
}

// ── API Routes ────────────────────────────────────────

// GET /api/state — полное состояние игрока
app.get('/api/state', (req, res) => {
  const sid = getSession(req, res);
  const player  = DB.getOrCreate(sid);
  const invRows = DB.getInventory(sid);
  const histRows = DB.getHistory(sid);

  res.json({
    balance:   player.balance,
    nick:      player.nick,
    freeDone:  player.free_done === 1,
    stats: {
      casesOpened: player.cases_opened,
      upgradeWin:  player.upgrade_win,
      upgradeLoss: player.upgrade_loss,
      contracts:   player.contracts,
      spent:       player.spent,
      earned:      player.earned,
    },
    inventory: enrichInventory(invRows),
    history:   enrichHistory(histRows),
    cases:     CASES,
    skins:     SKINS,
  });
});

// POST /api/deposit
app.post('/api/deposit', (req, res) => {
  const sid = getSession(req, res);
  const { amount } = req.body;
  if (!amount || typeof amount !== 'number' || amount <= 0 || amount > 1_000_000) {
    return res.status(400).json({ error: 'Недопустимая сумма' });
  }
  try {
    const newBal = DB.deposit(sid, amount);
    res.json({ balance: newBal });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/spin — открыть кейс
app.post('/api/spin', (req, res) => {
  const sid = getSession(req, res);
  const { caseId } = req.body;

  const caseData = CASE_MAP.get(caseId);
  if (!caseData) return res.status(400).json({ error: 'Кейс не найден' });

  const player = DB.getOrCreate(sid);

  // Проверка: бесплатный кейс — раз в сессию
  if (caseData.price === 0 && player.free_done === 1) {
    return res.status(400).json({ error: 'Бесплатный кейс уже получен' });
  }

  // Проверка баланса
  if (caseData.price > 0 && player.balance < caseData.price) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }

  // Крутим на сервере
  const invRows = DB.getInventory(sid);
  const invValue = enrichInventory(invRows).reduce((s, i) => s + i.price, 0);
  const result = weightedRoll(caseData.items, caseData.price, player.balance, invValue);
  const item = { uid: uid(), skinId: result.id, wear: randWear() };

  // Транзакция: списать баланс, добавить предмет, обновить стату
  DB.db.transaction(() => {
    const newBal = caseData.price > 0
      ? player.balance - caseData.price
      : player.balance;
    DB.stmts.updateBalance.run(newBal, sid);
    DB.addItem(sid, item);
    DB.addHistory(sid, {
      type: 'drop', skinId: result.id, wear: item.wear,
      price: result.price, source: caseData.name
    });
    DB.stmts.updateStats.run({
      co: 1, uw: 0, ul: 0, ct: 0,
      sp: caseData.price, ea: result.price,
      td: 0, fd: caseData.price === 0 ? 1 : 0,
      sid
    });
  })();

  const updPlayer = DB.stmts.getPlayer.get(sid);
  res.json({
    item: { ...item, name: result.name, weapon: result.weapon,
            rarity: result.rarity, price: result.price, img: result.img },
    balance: updPlayer.balance
  });
});

// POST /api/spin/multi — открыть N кейсов
app.post('/api/spin/multi', (req, res) => {
  const sid = getSession(req, res);
  const { caseId, count } = req.body;

  if (![3, 5, 10].includes(count)) return res.status(400).json({ error: 'count должен быть 3, 5 или 10' });

  const caseData = CASE_MAP.get(caseId);
  if (!caseData) return res.status(400).json({ error: 'Кейс не найден' });
  if (caseData.price === 0) return res.status(400).json({ error: 'Мульти-открытие недоступно для бесплатного кейса' });

  const player = DB.getOrCreate(sid);
  const totalCost = caseData.price * count;
  if (player.balance < totalCost) {
    return res.status(400).json({ error: `Недостаточно средств. Нужно ${totalCost}₽` });
  }

  const invRows = DB.getInventory(sid);
  const invValue = enrichInventory(invRows).reduce((s, i) => s + i.price, 0);

  const items = [];
  let totalEarned = 0;

  DB.db.transaction(() => {
    DB.stmts.updateBalance.run(player.balance - totalCost, sid);
    for (let i = 0; i < count; i++) {
      const result = weightedRoll(caseData.items, caseData.price, player.balance - totalCost, invValue);
      const item = { uid: uid(), skinId: result.id, wear: randWear() };
      DB.addItem(sid, item);
      DB.addHistory(sid, {
        type: 'drop', skinId: result.id, wear: item.wear,
        price: result.price, source: caseData.name
      });
      items.push({ ...item, name: result.name, weapon: result.weapon,
                   rarity: result.rarity, price: result.price, img: result.img });
      totalEarned += result.price;
    }
    DB.stmts.updateStats.run({
      co: count, uw: 0, ul: 0, ct: 0,
      sp: totalCost, ea: totalEarned,
      td: 0, fd: 0, sid
    });
  })();

  const updPlayer = DB.stmts.getPlayer.get(sid);
  res.json({ items, balance: updPlayer.balance, totalCost });
});

// POST /api/sell — продать предмет из инвентаря
app.post('/api/sell', (req, res) => {
  const sid = getSession(req, res);
  const { itemUid } = req.body;

  const row = DB.getItem(sid, itemUid);
  if (!row) return res.status(400).json({ error: 'Предмет не найден' });

  const skin = SKIN_MAP.get(row.skin_id);
  if (!skin) return res.status(400).json({ error: 'Данные скина не найдены' });

  const player = DB.stmts.getPlayer.get(sid);

  DB.db.transaction(() => {
    DB.removeItem(sid, itemUid);
    DB.stmts.updateBalance.run(player.balance + skin.price, sid);
    DB.addHistory(sid, {
      type: 'sell', skinId: skin.id, wear: row.wear,
      price: skin.price, source: 'Продажа'
    });
    DB.stmts.updateStats.run({ co:0,uw:0,ul:0,ct:0,sp:0,ea:skin.price,td:0,fd:0,sid });
  })();

  const updPlayer = DB.stmts.getPlayer.get(sid);
  res.json({ balance: updPlayer.balance, sold: skin.price });
});

// POST /api/upgrade
app.post('/api/upgrade', (req, res) => {
  const sid = getSession(req, res);
  const { srcUid, srcSkinId, dstSkinId } = req.body;

  if (!srcUid || !srcSkinId || !dstSkinId) {
    return res.status(400).json({ error: 'Неверные параметры' });
  }

  const invRows = DB.getInventory(sid);
  const inventory = invRows.map(r => ({ uid: r.uid, skinId: r.skin_id }));

  const result = resolveUpgrade(srcSkinId, srcUid, dstSkinId, inventory);
  if (result.error) return res.status(400).json({ error: result.error });

  const player = DB.stmts.getPlayer.get(sid);
  const srcSkin = SKIN_MAP.get(srcSkinId);
  const dstSkin = SKIN_MAP.get(dstSkinId);

  DB.db.transaction(() => {
    DB.removeItem(sid, result.removedUid);

    if (result.won) {
      DB.addItem(sid, result.item);
      DB.addHistory(sid, {
        type: 'upgrade', skinId: dstSkin.id, wear: result.item.wear,
        price: dstSkin.price, source: 'Апгрейд'
      });
      DB.stmts.updateStats.run({ co:0,uw:1,ul:0,ct:0,sp:srcSkin.price,ea:dstSkin.price,td:0,fd:0,sid });
    } else {
      DB.addHistory(sid, {
        type: 'upgrade_loss', skinId: srcSkin.id, wear: 'N/A',
        price: 0, source: 'Апгрейд'
      });
      DB.stmts.updateStats.run({ co:0,uw:0,ul:1,ct:0,sp:srcSkin.price,ea:0,td:0,fd:0,sid });
    }
  })();

  const updPlayer = DB.stmts.getPlayer.get(sid);
  const resp = {
    won: result.won,
    chance: result.chance,
    balance: updPlayer.balance
  };

  if (result.won) {
    resp.item = {
      ...result.item,
      name: dstSkin.name, weapon: dstSkin.weapon,
      rarity: dstSkin.rarity, price: dstSkin.price, img: dstSkin.img
    };
  }

  res.json(resp);
});

// POST /api/contract
app.post('/api/contract', (req, res) => {
  const sid = getSession(req, res);
  const { itemUids } = req.body;

  if (!Array.isArray(itemUids) || itemUids.length < 2 || itemUids.length > 10) {
    return res.status(400).json({ error: 'Нужно от 2 до 10 предметов' });
  }

  // Проверяем что все предметы есть в инвентаре
  const rows = itemUids.map(u => DB.getItem(sid, u)).filter(Boolean);
  if (rows.length !== itemUids.length) {
    return res.status(400).json({ error: 'Не все предметы найдены в инвентаре' });
  }

  const skinIds = rows.map(r => r.skin_id);
  const result = resolveContract(skinIds, SKINS);
  if (result.error) return res.status(400).json({ error: result.error });

  const resultSkin = result.resultSkin;

  DB.db.transaction(() => {
    for (const u of itemUids) DB.removeItem(sid, u);
    DB.addItem(sid, result.item);
    DB.addHistory(sid, {
      type: 'contract', skinId: resultSkin.id, wear: result.item.wear,
      price: resultSkin.price, source: 'Контракт'
    });
    DB.stmts.updateStats.run({
      co:0,uw:0,ul:0,ct:1,
      sp: result.totalIn, ea: resultSkin.price,
      td:0,fd:0,sid
    });
  })();

  const updPlayer = DB.stmts.getPlayer.get(sid);
  res.json({
    item: { ...result.item, name: resultSkin.name, weapon: resultSkin.weapon,
            rarity: resultSkin.rarity, price: resultSkin.price, img: resultSkin.img },
    balance: updPlayer.balance,
    mult: result.mult,
    totalIn: result.totalIn
  });
});

// POST /api/showcase — добавить/убрать из витрины
app.post('/api/showcase', (req, res) => {
  const sid = getSession(req, res);
  const { itemUid, on } = req.body;
  const row = DB.getItem(sid, itemUid);
  if (!row) return res.status(400).json({ error: 'Предмет не найден' });
  DB.stmts.setShowcase.run(on ? 1 : 0, itemUid, sid);
  res.json({ ok: true });
});

// POST /api/nick — сменить ник
app.post('/api/nick', (req, res) => {
  const sid = getSession(req, res);
  const { nick } = req.body;
  if (!nick || typeof nick !== 'string') return res.status(400).json({ error: 'Неверный ник' });
  const clean = nick.trim().slice(0, 32);
  DB.db.prepare('UPDATE players SET nick = ? WHERE session_id = ?').run(clean, sid);
  res.json({ nick: clean });
});

// ── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FragDrop server running on http://localhost:${PORT}`);
});
