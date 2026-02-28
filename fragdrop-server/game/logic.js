'use strict';
const { SKIN_MAP, CASE_MAP } = require('./data');

const WEAR_NAMES = ['Factory New','Minimal Wear','Field-Tested','Well-Worn','Battle-Scarred'];
const UPGRADE_GUARANTEED_LOSS_THRESHOLD = 1500;

function randWear() {
  return WEAR_NAMES[Math.floor(Math.random() * WEAR_NAMES.length)];
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Adaptive drain — чем богаче игрок, тем хуже удача
function drainFactor(balance, inventoryValue) {
  const wealth = balance + inventoryValue;
  if (wealth < 2000)  return 1.00;
  if (wealth < 5000)  return 0.92;
  if (wealth < 15000) return 0.80;
  if (wealth < 50000) return 0.65;
  return 0.50;
}

// Weighted roll с price-based дропами как в CS2
function weightedRoll(skinIds, casePrice, balance, inventoryValue) {
  const rarityBase = {
    consumer: 3000, mil: 600, restricted: 120,
    classified: 24, covert: 5, contraband: 1, knife: 0.5
  };
  const df = drainFactor(balance, inventoryValue);

  let items = [];
  let totalW = 0;

  for (const id of skinIds) {
    const skin = SKIN_MAP.get(id);
    if (!skin) continue;

    const base = rarityBase[skin.rarity] || 10;
    const priceFactor = 1 / Math.pow(Math.max(skin.price, 1), 0.5);
    let drainMult = 1;
    if (skin.rarity === 'knife' || skin.rarity === 'contraband') drainMult = df * df;
    else if (skin.rarity === 'covert')      drainMult = df;
    else if (skin.rarity === 'classified')  drainMult = df * 0.7 + 0.3;

    const w = base * priceFactor * drainMult;
    items.push({ skin, weight: w });
    totalW += w;
  }

  if (items.length === 0) {
    const pool = skinIds.map(id => SKIN_MAP.get(id)).filter(Boolean);
    if (pool.length === 0) return [...SKIN_MAP.values()][0];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  let r = Math.random() * totalW;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it.skin;
  }
  return items[items.length - 1].skin;
}

// Шанс апгрейда — честный, без drain на отображение
function upgradeChance(srcPrice, dstPrice) {
  return Math.min(90, Math.max(1, Math.round((srcPrice / dstPrice) * 100)));
}

// Апгрейд — возвращает { won, item|null }
function resolveUpgrade(srcId, srcUid, dstId, inventory, extraBet = 0) {
  const src = SKIN_MAP.get(srcId);
  const dst = SKIN_MAP.get(dstId);
  if (!src || !dst) return { error: 'Предмет не найден' };
  if (dst.price <= src.price) return { error: 'Целевой предмет должен быть дороже' };

  // Проверяем что srcUid реально в инвентаре
  const invIdx = inventory.findIndex(i => i.uid === srcUid && i.skinId === srcId);
  if (invIdx === -1) return { error: 'Предмет не найден в инвентаре' };

  const boost = Math.max(0, Number(extraBet) || 0);
  const chance = upgradeChance(src.price + boost, dst.price);
  // Скрытый незаход для дорогих скинов
  const guaranteedLoss = dst.price > UPGRADE_GUARANTEED_LOSS_THRESHOLD;
  const won = guaranteedLoss ? false : (Math.random() * 100 < chance);

  if (won) {
    const item = { uid: uid(), skinId: dst.id, wear: randWear() };
    return { won: true, chance, item, removedUid: srcUid };
  }
  return { won: false, chance, item: null, removedUid: srcUid };
}

// Контракт — никогда не выдаёт предмет дороже 2000₽
function resolveContract(skinIds, allSkins) {
  const skins = skinIds.map(id => SKIN_MAP.get(id)).filter(Boolean);
  if (skins.length < 2) return { error: 'Минимум 2 предмета' };

  const total = skins.reduce((s, sk) => s + sk.price, 0);

  // Случайный множитель 0.15–1.95
  const mult = 0.15 + Math.random() * 1.8;
  const target = total * mult;

  // Только предметы до 2000₽
  const eligible = allSkins.filter(s => s.price <= 2000);
  const pool = eligible.length > 0 ? eligible : allSkins;
  const sorted = [...pool].sort((a, b) => Math.abs(a.price - target) - Math.abs(b.price - target));
  const result = sorted[0];

  return {
    item: { uid: uid(), skinId: result.id, wear: randWear() },
    totalIn: total,
    mult: parseFloat(mult.toFixed(2)),
    resultSkin: result
  };
}

module.exports = { weightedRoll, resolveUpgrade, resolveContract, randWear, uid, upgradeChance };
