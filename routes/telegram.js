const express = require('express');
const { v4: uuid } = require('uuid');
const { readDB, writeDB } = require('../services/db');
const { requireAuth } = require('../middleware/auth');
const { sendToChat } = require('../services/telegram');

const router = express.Router();

// Покупатель нажимает "Подключить Telegram" — получает одноразовый код,
// открывает бота по ссылке t.me/<бот>?start=<код>, бот присылает этот код
// нам в вебхук, мы находим по коду пользователя и запоминаем его chat_id.

router.post('/link-code', requireAuth, async (req, res) => {
  const db = await readDB();
  // подчищаем старые коды (старше 15 минут) — чтобы не копились
  const now = Date.now();
  db.telegramLinkCodes = db.telegramLinkCodes.filter(c => now - new Date(c.createdAt).getTime() < 15 * 60 * 1000);

  const code = uuid().replace(/-/g, '').slice(0, 8);
  db.telegramLinkCodes.push({ code, userId: req.user.id, createdAt: new Date().toISOString() });
  await writeDB(db);
  res.json({ code });
});

router.get('/status', requireAuth, async (req, res) => {
  const db = await readDB();
  const user = db.users.find(u => u.id === req.user.id);
  res.json({ linked: !!user?.telegramChatId });
});

router.post('/unlink', requireAuth, async (req, res) => {
  const db = await readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (user) user.telegramChatId = null;
  await writeDB(db);
  res.json({ ok: true });
});

// Вебхук от Telegram — сюда бот присылает все входящие сообщения.
// Настраивается ОДИН РАЗ вручную (см. инструкцию), дальше работает сам.
router.post('/webhook', async (req, res) => {
  try {
    const message = req.body?.message;
    if (message && typeof message.text === 'string') {
      const chatId = message.chat.id;
      const text = message.text.trim();

      if (text.startsWith('/start')) {
        const parts = text.split(' ');
        const code = parts[1];

        if (!code) {
          await sendToChat(chatId, 'Привет! Это бот уведомлений ManuShop 👋\nЧтобы подключить уведомления, нажмите «Подключить Telegram» в личном кабинете на сайте.');
        } else {
          const db = await readDB();
          const entry = db.telegramLinkCodes.find(c => c.code === code);
          if (!entry) {
            await sendToChat(chatId, '⚠️ Код недействителен или устарел. Сгенерируйте новый в личном кабинете на сайте.');
          } else {
            const user = db.users.find(u => u.id === entry.userId);
            if (user) {
              user.telegramChatId = chatId;
              db.telegramLinkCodes = db.telegramLinkCodes.filter(c => c.code !== code);
              await writeDB(db);
              await sendToChat(chatId, `✅ Готово! Telegram привязан к аккаунту <b>${user.name}</b>.\nТеперь вы будете получать уведомления о заказах и пополнениях прямо сюда.`);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[telegram webhook]', e.message);
  }
  res.sendStatus(200); // Telegram ждёт быстрый 200 ответ, иначе будет повторять запрос
});

module.exports = router;
