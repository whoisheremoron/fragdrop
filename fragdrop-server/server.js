'use strict';

const express       = require('express');
const cookieParser  = require('cookie-parser');
const session       = require('express-session');
const SqliteStore   = require('better-sqlite3-session-store')(session);
const passport      = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const rateLimit     = require('express-rate-limit');
const path          = require('path');

const { SKINS, CASES, SKIN_MAP, CASE_MAP } = require('./game/data');
const { weightedRoll, resolveUpgrade, resolveContract, randWear, uid } = require('./game/logic');
const DB = require('./db');
const { syncPrices } = require('./price-sync');

const app  = express();
const PORT = process.env.PORT || 3000;

// ════════════════════════════════════════════════════════
//  КОНФИГ — МЕНЯЙ ЗДЕСЬ
// ════════════════════════════════════════════════════════
const CONFIG = {
  // 1. Получи ключ на https://steamcommunity.com/dev/apikey
  STEAM_API_KEY: 'ВСТАВЬ_STEAM_API_KEY_СЮДА',

  // 2. Полный URL сайта без слеша: 'http://1.2.3.4:3000' или 'https://fragdrop.ru'
  SITE_URL: 'http://ВСТАВЬ_IP_ИЛИ_ДОМЕН:3000',

  // 3. Любая длинная случайная строка
  SESSION_SECRET: 'замени-на-случайную-строку-минимум-32-символа',
};
// ════════════════════════════════════════════════════════

// ── Middleware ────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: CONFIG.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new SqliteStore({ client: DB.db }),
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 * 1000 },
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ─────────────────────────────────────────
app.use('/api', rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false, message: { error: 'Слишком много запросов' } }));
app.use('/api/spin', rateLimit({ windowMs: 5_000, max: 10, message: { error: 'Слишком быстро' } }));

// ── Passport Steam ────────────────────────────────────────
passport.use(new SteamStrategy(
  { returnURL: `${CONFIG.SITE_URL}/auth/steam/return`, realm: `${CONFIG.SITE_URL}/`, apiKey: CONFIG.STEAM_API_KEY },
  (identifier, profile, done) => done(null, {
    steamId: profile.id,
    nick:    profile.displayName,
    avatar:  profile.photos?.[0]?.value || null,
  })
));
passport.serializeUser((user, done)   => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Auth routes ───────────────────────────────────────────
app.get('/auth/steam', passport.authenticate('steam', { failureRedirect: '/' }));

app.get('/auth/steam/return', (req, res, next) => {
  passport.authenticate('steam', { failureRedirect: '/?auth=fail' }, (err, user) => {
    if (err || !user) {
      console.error('[STEAM AUTH ERROR]', err);
      return res.redirect('/?auth=fail');
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) { console.error('[STEAM LOGIN ERROR]', loginErr); return res.redirect('/?auth=fail'); }
      try {
        // Создаём/обновляем игрока — данные хранятся по steam_id
        DB.upsertPlayer(user.steamId, user.nick, user.avatar);
        req.session.steamId = user.steamId;
        console.log('[STEAM AUTH OK]', user.steamId, user.nick);
        res.redirect('/');
      } catch(e) {
        console.error('[STEAM DB ERROR]', e);
        res.redirect('/?auth=fail');
      }
    });
  })(req, res, next);
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ── Auth guard — все API требуют Steam логин ──────────────
function requireAuth(req, res, next) {
  const steamId = req.session?.steamId;
  if (!steamId) return res.status(401).json({ error: 'Необходима авторизация через Steam', needLogin: true });
  req.steamId = steamId;
  next();
}

// ── Helpers ───────────────────────────────────────────────
function enrichInventory(rows) {
  return rows.map(row => {
    const skin = SKIN_MAP.get(row.skin_id);
    if (!skin) return null;
    return { uid: row.uid, skinId: row.skin_id, wear: row.wear, showcased: row.showcased,
             name: skin.name, weapon: skin.weapon, rarity: skin.rarity, price: skin.price, img: skin.img };
  }).filter(Boolean);
}

function enrichHistory(rows) {
  return rows.map(row => {
    const skin = SKIN_MAP.get(row.skin_id);
    if (!skin) return null;
    return { type: row.type, skin: { ...skin }, wear: row.wear, price: skin.price, source: row.source, ts: row.ts * 1000 };
  }).filter(Boolean);
}

// ── API: публичное состояние (не требует логина) ───────────
// Возвращает cases/skins + статус авторизации
app.get('/api/state', (req, res) => {
  const steamId = req.session?.steamId;

  if (!steamId) {
    // Не залогинен — отдаём только список кейсов и флаг
    return res.json({ loggedIn: false, cases: CASES, skins: SKINS });
  }

  const player   = DB.getPlayer(steamId);
  if (!player) {
    // Сессия протухла — сбрасываем
    req.session.destroy();
    return res.json({ loggedIn: false, cases: CASES, skins: SKINS });
  }

  res.json({
    loggedIn:  true,
    balance:   player.balance,
    nick:      player.nick,
    steamId:   player.steam_id,
    avatar:    player.steam_avatar || null,
    freeDone:  player.free_last_ts > 0 && (Math.floor(Date.now()/1000) - player.free_last_ts) < 6*3600,
    freeNextTs: player.free_last_ts > 0 ? (player.free_last_ts + 6*3600) * 1000 : 0,
    stats: {
      casesOpened: player.cases_opened,
      upgradeWin:  player.upgrade_win,
      upgradeLoss: player.upgrade_loss,
      contracts:   player.contracts,
      spent:       player.spent,
      earned:      player.earned,
    },
    inventory: enrichInventory(DB.getInventory(steamId)),
    history:   enrichHistory(DB.getHistory(steamId)),
    cases:     CASES,
    skins:     SKINS,
  });
});

// ── Все остальные API — только для залогиненных ────────────

app.post('/api/deposit', requireAuth, (req, res) => {
  const { amount } = req.body;
  if (!amount || typeof amount !== 'number' || amount <= 0 || amount > 1_000_000)
    return res.status(400).json({ error: 'Недопустимая сумма' });
  try { res.json({ balance: DB.deposit(req.steamId, amount) }); }
  catch(e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/spin', requireAuth, (req, res) => {
  const sid      = req.steamId;
  const caseData = CASE_MAP.get(req.body.caseId);
  if (!caseData) return res.status(400).json({ error: 'Кейс не найден' });

  const player = DB.getPlayer(sid);
  if (caseData.price === 0) {
    const now = Math.floor(Date.now()/1000);
    const cooldown = 6 * 3600;
    if (player.free_last_ts > 0 && (now - player.free_last_ts) < cooldown) {
      const secsLeft = cooldown - (now - player.free_last_ts);
      const h = Math.floor(secsLeft/3600), m = Math.floor((secsLeft%3600)/60);
      return res.status(400).json({ error: `Следующий бесплатный кейс через ${h}ч ${m}м` });
    }
  }
  if (caseData.price > 0 && player.balance < caseData.price)
    return res.status(400).json({ error: 'Недостаточно средств' });

  const invValue = enrichInventory(DB.getInventory(sid)).reduce((s, i) => s + i.price, 0);
  const result   = weightedRoll(caseData.items, caseData.price, player.balance, invValue);
  const item     = { uid: uid(), skinId: result.id, wear: randWear() };

  DB.db.transaction(() => {
    DB.stmts.updateBalance.run(caseData.price > 0 ? player.balance - caseData.price : player.balance, sid);
    DB.addItem(sid, item);
    DB.addHistory(sid, { type: 'drop', skinId: result.id, wear: item.wear, price: result.price, source: caseData.name });
    DB.stmts.updateStats.run({ co:1,uw:0,ul:0,ct:0,sp:caseData.price,ea:result.price,td:0,fd:caseData.price===0?1:0,sid });
  })();

  res.json({
    item: { ...item, name: result.name, weapon: result.weapon, rarity: result.rarity, price: result.price, img: result.img },
    balance: DB.getPlayer(sid).balance,
  });
});

app.post('/api/spin/multi', requireAuth, (req, res) => {
  const sid      = req.steamId;
  const { caseId, count } = req.body;
  if (![3, 5, 10].includes(count)) return res.status(400).json({ error: 'count: 3, 5 или 10' });
  const caseData = CASE_MAP.get(caseId);
  if (!caseData || caseData.price === 0) return res.status(400).json({ error: 'Недоступно' });

  const player    = DB.getPlayer(sid);
  const totalCost = caseData.price * count;
  if (player.balance < totalCost) return res.status(400).json({ error: `Нужно ${totalCost}₽` });

  const invValue  = enrichInventory(DB.getInventory(sid)).reduce((s, i) => s + i.price, 0);
  const items     = [];
  let totalEarned = 0;

  DB.db.transaction(() => {
    DB.stmts.updateBalance.run(player.balance - totalCost, sid);
    for (let i = 0; i < count; i++) {
      const result = weightedRoll(caseData.items, caseData.price, player.balance - totalCost, invValue);
      const item   = { uid: uid(), skinId: result.id, wear: randWear() };
      DB.addItem(sid, item);
      DB.addHistory(sid, { type: 'drop', skinId: result.id, wear: item.wear, price: result.price, source: caseData.name });
      items.push({ ...item, name: result.name, weapon: result.weapon, rarity: result.rarity, price: result.price, img: result.img });
      totalEarned += result.price;
    }
    DB.stmts.updateStats.run({ co:count,uw:0,ul:0,ct:0,sp:totalCost,ea:totalEarned,td:0,fd:0,sid });
  })();

  res.json({ items, balance: DB.getPlayer(sid).balance, totalCost });
});

app.post('/api/sell', requireAuth, (req, res) => {
  const sid  = req.steamId;
  const row  = DB.getItem(sid, req.body.itemUid);
  if (!row) return res.status(400).json({ error: 'Предмет не найден' });
  const skin = SKIN_MAP.get(row.skin_id);
  if (!skin) return res.status(400).json({ error: 'Скин не найден' });

  const player = DB.getPlayer(sid);
  DB.db.transaction(() => {
    DB.removeItem(sid, req.body.itemUid);
    DB.stmts.updateBalance.run(player.balance + skin.price, sid);
    DB.addHistory(sid, { type: 'sell', skinId: skin.id, wear: row.wear, price: skin.price, source: 'Продажа' });
    DB.stmts.updateStats.run({ co:0,uw:0,ul:0,ct:0,sp:0,ea:skin.price,td:0,fd:0,sid });
  })();

  res.json({ balance: DB.getPlayer(sid).balance, sold: skin.price });
});

app.post('/api/upgrade', requireAuth, (req, res) => {
  const sid = req.steamId;
  const { srcUid, srcSkinId, dstSkinId, extraBet = 0 } = req.body;
  if (!srcUid || !srcSkinId || !dstSkinId) return res.status(400).json({ error: 'Неверные параметры' });

  const srcSkinIdNum = Number(srcSkinId);
  const dstSkinIdNum = Number(dstSkinId);
  const betAmount    = Math.max(0, Number(extraBet) || 0);

  const player = DB.getPlayer(sid);
  if (betAmount > 0 && player.balance < betAmount)
    return res.status(400).json({ error: 'Недостаточно средств для доплаты' });

  const inventory = DB.getInventory(sid).map(r => ({ uid: r.uid, skinId: Number(r.skin_id) }));
  const result    = resolveUpgrade(srcSkinIdNum, srcUid, dstSkinIdNum, inventory, betAmount);
  if (result.error) return res.status(400).json({ error: result.error });

  const srcSkin = SKIN_MAP.get(srcSkinIdNum);
  const dstSkin = SKIN_MAP.get(dstSkinIdNum);

  DB.db.transaction(() => {
    // Списываем доплату если была
    if (betAmount > 0) {
      const p = DB.getPlayer(sid);
      DB.stmts.updateBalance.run(p.balance - betAmount, sid);
      DB.stmts.updateStats.run({ co:0,uw:0,ul:0,ct:0,sp:betAmount,ea:0,td:0,fd:0,sid });
    }
    DB.removeItem(sid, result.removedUid);
    if (result.won) {
      DB.addItem(sid, result.item);
      DB.addHistory(sid, { type: 'upgrade', skinId: dstSkin.id, wear: result.item.wear, price: dstSkin.price, source: 'Апгрейд' });
      DB.stmts.updateStats.run({ co:0,uw:1,ul:0,ct:0,sp:srcSkin.price,ea:dstSkin.price,td:0,fd:0,sid });
    } else {
      DB.addHistory(sid, { type: 'upgrade_loss', skinId: srcSkin.id, wear: 'N/A', price: 0, source: 'Апгрейд' });
      DB.stmts.updateStats.run({ co:0,uw:0,ul:1,ct:0,sp:srcSkin.price,ea:0,td:0,fd:0,sid });
    }
  })();

  const resp = { won: result.won, chance: result.chance, balance: DB.getPlayer(sid).balance };
  if (result.won) resp.item = { ...result.item, name: dstSkin.name, weapon: dstSkin.weapon, rarity: dstSkin.rarity, price: dstSkin.price, img: dstSkin.img };
  res.json(resp);
});

app.post('/api/contract', requireAuth, (req, res) => {
  const sid = req.steamId;
  const { itemUids } = req.body;
  if (!Array.isArray(itemUids) || itemUids.length < 2 || itemUids.length > 10)
    return res.status(400).json({ error: 'Нужно от 2 до 10 предметов' });

  const rows = itemUids.map(u => DB.getItem(sid, u)).filter(Boolean);
  if (rows.length !== itemUids.length) return res.status(400).json({ error: 'Не все предметы найдены' });

  const result     = resolveContract(rows.map(r => r.skin_id), SKINS);
  if (result.error) return res.status(400).json({ error: result.error });
  const resultSkin = result.resultSkin;

  DB.db.transaction(() => {
    for (const u of itemUids) DB.removeItem(sid, u);
    DB.addItem(sid, result.item);
    DB.addHistory(sid, { type: 'contract', skinId: resultSkin.id, wear: result.item.wear, price: resultSkin.price, source: 'Контракт' });
    DB.stmts.updateStats.run({ co:0,uw:0,ul:0,ct:1,sp:result.totalIn,ea:resultSkin.price,td:0,fd:0,sid });
  })();

  res.json({ item: { ...result.item, name: resultSkin.name, weapon: resultSkin.weapon, rarity: resultSkin.rarity, price: resultSkin.price, img: resultSkin.img }, balance: DB.getPlayer(sid).balance, mult: result.mult, totalIn: result.totalIn });
});

app.post('/api/showcase', requireAuth, (req, res) => {
  const sid = req.steamId;
  const { itemUid, on } = req.body;
  if (!DB.getItem(sid, itemUid)) return res.status(400).json({ error: 'Предмет не найден' });
  DB.stmts.setShowcase.run(on ? 1 : 0, itemUid, sid);
  res.json({ ok: true });
});

app.post('/api/nick', requireAuth, (req, res) => {
  const { nick } = req.body;
  if (!nick || typeof nick !== 'string') return res.status(400).json({ error: 'Неверный ник' });
  const clean = nick.trim().slice(0, 32);
  DB.db.prepare('UPDATE players SET nick = ? WHERE steam_id = ?').run(clean, req.steamId);
  res.json({ nick: clean });
});


// ── Автосинхронизация цен каждые 6 часов ────────────────
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
function autoSync() {
  syncPrices()
    .then(r => console.log(`[auto-sync] Обновлено ${r.updated}/${r.total} цен`))
    .catch(e => console.error('[auto-sync] Ошибка:', e.message));
}
setTimeout(() => { autoSync(); setInterval(autoSync, SYNC_INTERVAL_MS); }, 30000);

// ── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FragDrop server running on http://localhost:${PORT}`);
  if (CONFIG.STEAM_API_KEY === 'ВСТАВЬ_STEAM_API_KEY_СЮДА')
    console.warn('⚠️  Steam API key не настроен!');
});

app.use((err, req, res, next) => {
  console.error('[EXPRESS ERROR]', err.stack || err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});
process.on('unhandledRejection', (r) => console.error('[UNHANDLED REJECTION]', r));
process.on('uncaughtException',  (e) => console.error('[UNCAUGHT EXCEPTION]',  e.stack || e));
