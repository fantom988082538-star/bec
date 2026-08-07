// Отправка уведомлений администраторам в Telegram через бота.
// Токен бота и chat_id берутся из .env — если они не заданы,
// уведомления просто тихо пропускаются (сайт продолжает работать как обычно).
//
// Можно указать НЕСКОЛЬКО получателей — впиши их id через запятую:
// TELEGRAM_ADMIN_CHAT_ID=111111111,222222222,333333333

const axios = require('axios');

async function notifyAdmin(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const raw = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !raw) return;

  const chatIds = raw.split(',').map(id => id.trim()).filter(Boolean);

  await Promise.all(chatIds.map(async (chatId) => {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.error(`[telegram] Не удалось отправить уведомление ${chatId}:`, e.response?.data || e.message);
    }
  }));
}

// Отправить сообщение конкретному человеку по его chat_id
// (используется для уведомлений покупателям — статус заказа, пополнения и т.д.)
async function sendToChat(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    });
  } catch (e) {
    console.error(`[telegram] Не удалось отправить сообщение ${chatId}:`, e.response?.data || e.message);
  }
}

module.exports = { notifyAdmin, sendToChat };
