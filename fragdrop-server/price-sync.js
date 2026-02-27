'use strict';
/**
 * FragDrop — синхронизация цен с market.csgo.com
 *
 * Запуск вручную:   node price-sync.js
 * Запуск из сервера через /api/admin/sync-prices
 *
 * Алгоритм:
 *  1. Скачиваем https://market.csgo.com/api/v2/prices/RUB.json
 *  2. Строим карту market_hash_name → цена (avg_price, рубли)
 *  3. Для каждого скина в SKINS ищем совпадение по market_hash_name
 *  4. Если нашли — обновляем price прямо в data.js через перезапись файла
 *  5. Выводим отчёт: найдено/не найдено/изменено
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const DATA_FILE = path.join(__dirname, 'game', 'data.js');

// market.csgo.com отдаёт цены в копейках (1 RUB = 100 единиц)
// → делим на 100 чтобы получить рубли
const PRICE_API = 'https://market.csgo.com/api/v2/prices/RUB.json';

// Нужно ли добавлять ★ для ножей
function hashName(skin) {
  return skin.rarity === 'knife' ? '★ ' + skin.name : skin.name;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'FragDrop/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function syncPrices() {
  console.log('[price-sync] Загружаем прайс-лист с market.csgo.com...');

  let priceData;
  try {
    priceData = await fetchJSON(PRICE_API);
  } catch(e) {
    throw new Error('Не удалось получить прайс-лист: ' + e.message);
  }

  if (!priceData.success || !priceData.items) {
    throw new Error('Некорректный ответ API: ' + JSON.stringify(priceData).slice(0, 200));
  }

  // Строим карту: market_hash_name → avg_price в рублях
  const priceMap = new Map();
  for (const item of Object.values(priceData.items)) {
    if (item.market_hash_name && item.price) {
      // price в API — рубли с копейками (строка "123.45")
      const rub = Math.round(parseFloat(item.price));
      if (rub > 0) priceMap.set(item.market_hash_name, rub);
    }
  }
  console.log(`[price-sync] Загружено ${priceMap.size} предметов из API`);

  // Загружаем текущие скины
  // Делаем это через eval-обход (data.js — не чистый JSON)
  const { SKINS } = require('./game/data');

  const results = { updated: [], notFound: [], unchanged: [] };

  // Читаем data.js как текст для замены цен
  let dataSource = fs.readFileSync(DATA_FILE, 'utf8');

  for (const skin of SKINS) {
    const hash = hashName(skin);
    const newPrice = priceMap.get(hash);

    if (!newPrice) {
      results.notFound.push({ id: skin.id, name: skin.name, hash });
      continue;
    }

    if (newPrice === skin.price) {
      results.unchanged.push(skin.name);
      continue;
    }

    // Заменяем строку цены в data.js
    // Паттерн: ищем строку с этим id и заменяем price:ЧИСЛО
    const idPart = skin.id < 10 ? `{id:${skin.id}, ` : `{id:${skin.id},`;
    // Ищем по id строки — заменяем первое совпадение price:OLDPRICE на price:NEWPRICE
    // Используем более точный regex чтобы не задеть другие поля
    const lineRegex = new RegExp(
      `({id:${skin.id}[,\\s][^}]+price:)${skin.price}(,)`,
      'g'
    );

    const newSource = dataSource.replace(lineRegex, `$1${newPrice}$2`);
    if (newSource !== dataSource) {
      dataSource = newSource;
      results.updated.push({ id: skin.id, name: skin.name, old: skin.price, new: newPrice });
    } else {
      // Fallback: попробуем другой паттерн (пробелы вокруг)
      const fallbackRegex = new RegExp(
        `(id:${skin.id}\\b[^}]*?price:)${skin.price}(,)`,
        's'
      );
      const fb = dataSource.replace(fallbackRegex, `$1${newPrice}$2`);
      if (fb !== dataSource) {
        dataSource = fb;
        results.updated.push({ id: skin.id, name: skin.name, old: skin.price, new: newPrice });
      } else {
        results.notFound.push({ id: skin.id, name: `[price replace failed] ${skin.name}`, hash });
      }
    }
  }

  // Записываем обновлённый data.js
  if (results.updated.length > 0) {
    fs.writeFileSync(DATA_FILE, dataSource, 'utf8');
    console.log(`[price-sync] Записан обновлённый data.js`);
  }

  // Инвалидируем кэш модуля Node.js
  try {
    delete require.cache[require.resolve('./game/data')];
  } catch(e) {}

  return {
    total: SKINS.length,
    updated: results.updated.length,
    unchanged: results.unchanged.length,
    notFound: results.notFound.length,
    updatedItems: results.updated,
    notFoundItems: results.notFound.map(x => x.name),
  };
}

// При запуске напрямую (node price-sync.js)
if (require.main === module) {
  syncPrices()
    .then(r => {
      console.log('\n=== Результат синхронизации ===');
      console.log(`Всего скинов: ${r.total}`);
      console.log(`Обновлено:    ${r.updated}`);
      console.log(`Без изменений:${r.unchanged}`);
      console.log(`Не найдено:   ${r.notFound}`);
      if (r.updatedItems.length) {
        console.log('\nОбновлённые цены:');
        r.updatedItems.forEach(x => console.log(`  [${x.id}] ${x.name}: ${x.old} → ${x.new} ₽`));
      }
      if (r.notFoundItems.length) {
        console.log('\nНе найдены на маркете:');
        r.notFoundItems.forEach(n => console.log('  - ' + n));
      }
    })
    .catch(e => {
      console.error('[price-sync] ОШИБКА:', e.message);
      process.exit(1);
    });
}

module.exports = { syncPrices };
