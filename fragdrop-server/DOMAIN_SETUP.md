# Инструкция: Домен + HTTPS для FragDrop

## Шаг 1 — Купить домен

Рекомендуемые регистраторы:
- **nic.ru** — российский, поддержка .ru/.com
- **reg.ru** — популярный, есть .ru/.com/.gg
- **namecheap.com** — дешевле, .com от $9/год

Выбери любое имя, например `fragdrop.ru` или `fragdrop.gg`

---

## Шаг 2 — Направить домен на сервер

В личном кабинете регистратора найди **DNS-записи** и добавь:

| Тип | Имя | Значение          | TTL  |
|-----|-----|-------------------|------|
| A   | @   | 195.226.92.15     | 3600 |
| A   | www | 195.226.92.15     | 3600 |

Замени `195.226.92.15` на IP твоего сервера.

DNS распространяется до 24 часов, обычно 15-30 минут.

Проверить: `ping fragdrop.ru` — должен ответить твой IP.

---

## Шаг 3 — Установить nginx

```bash
sudo apt install nginx -y
sudo systemctl enable nginx
sudo systemctl start nginx
```

---

## Шаг 4 — Настроить nginx как прокси

```bash
sudo nano /etc/nginx/sites-available/fragdrop
```

Вставь:

```nginx
server {
    listen 80;
    server_name fragdrop.ru www.fragdrop.ru;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/fragdrop /etc/nginx/sites-enabled/
sudo nginx -t        # проверка конфига
sudo systemctl reload nginx
```

---

## Шаг 5 — Получить бесплатный SSL (HTTPS)

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d fragdrop.ru -d www.fragdrop.ru
```

Certbot спросит email и автоматически настроит HTTPS.
Сертификат обновляется автоматически каждые 90 дней.

---

## Шаг 6 — Обновить CONFIG в server.js

После получения домена и HTTPS обязательно обнови:

```js
const CONFIG = {
  STEAM_API_KEY: 'твой_ключ',
  SITE_URL: 'https://fragdrop.ru',   // ← теперь https + домен
  SESSION_SECRET: 'твоя_строка',
};
```

И обнови домен в настройках Steam API ключа:
- Зайди на https://steamcommunity.com/dev/apikey
- Измени домен на `fragdrop.ru`

---

## Шаг 7 — Открыть только 80/443 порт (закрыть 3000)

После настройки nginx сайт работает через порты 80/443,
порт 3000 можно закрыть от внешнего доступа:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 22/tcp   # SSH — не забудь!
sudo ufw deny 3000/tcp
sudo ufw enable
sudo ufw status
```

---

## Итог

После всех шагов сайт будет доступен по:
- `https://fragdrop.ru` — с зелёным замком
- Steam авторизация будет работать через домен

