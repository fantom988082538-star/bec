const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { readDB, writeDB } = require('../services/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyAdmin, sendToChat } = require('../services/telegram');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'receipts');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Разрешены только изображения (jpg, png, webp)'), ok);
  }
});

router.post('/', requireAuth, upload.single('receipt'), async (req, res) => {
  const { amount } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Прикрепите скриншот или фото чека' });
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) return res.status(400).json({ error: 'Укажите сумму пополнения' });

  const checksum = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const db = await readDB();
  const duplicate = db.topups.find(t => t.checksum === checksum);
  if (duplicate) {
    return res.status(409).json({ error: 'Этот чек уже был использован ранее' });
  }

  const ext = req.file.mimetype === 'image/png' ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
  const filename = `${uuid()}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);

  const topup = {
    id: uuid(),
    userId: req.user.id,
    amount: amountNum,
    receiptFile: filename,
    checksum,
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    rejectReason: null,
    createdAt: new Date().toISOString()
  };
  db.topups.push(topup);
  await writeDB(db);

  const user = db.users.find(u => u.id === req.user.id);
  notifyAdmin(
    `💰 <b>Новая заявка на пополнение</b>\n` +
    `Пользователь: ${user?.name || '—'} (${user?.phone || '—'})\n` +
    `Сумма: <b>${amountNum} сомони</b>\n` +
    `Проверь в админ-панели: вкладка «Пополнения»`
  );

  res.json({ ...topup, receiptFile: undefined, checksum: undefined });
});

router.get('/', requireAuth, async (req, res) => {
  const db = await readDB();
  const mine = db.topups
    .filter(t => t.userId === req.user.id)
    .reverse()
    .map(({ checksum, receiptFile, ...safe }) => safe);
  res.json(mine);
});

router.get('/admin/list', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const db = await readDB();
  const status = req.query.status || 'pending';
  const list = db.topups
    .filter(t => status === 'all' || t.status === status)
    .reverse()
    .map(t => {
      const user = db.users.find(u => u.id === t.userId);
      return { ...t, checksum: undefined, userName: user?.name, userPhone: user?.phone };
    });
  res.json(list);
});

router.get('/admin/:id/receipt', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const db = await readDB();
  const topup = db.topups.find(t => t.id === req.params.id);
  if (!topup) return res.status(404).json({ error: 'Заявка не найдена' });
  res.sendFile(path.join(UPLOAD_DIR, topup.receiptFile));
});

router.post('/admin/:id/approve', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const db = await readDB();
  const topup = db.topups.find(t => t.id === req.params.id);
  if (!topup) return res.status(404).json({ error: 'Заявка не найдена' });
  if (topup.status !== 'pending') return res.status(409).json({ error: 'Заявка уже обработана' });

  const user = db.users.find(u => u.id === topup.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  user.balance = (user.balance || 0) + topup.amount;
  topup.status = 'approved';
  topup.reviewedBy = req.user.id;
  topup.reviewedAt = new Date().toISOString();

  // Бонус за сумму пополнения — берём самый крупный подходящий порог (не складываем все)
  const tiers = (db.settings?.topupBonusTiers || []).slice().sort((a, b) => b.minAmount - a.minAmount);
  const matchedTier = tiers.find(t => topup.amount >= t.minAmount);
  let amountBonus = 0;
  if (matchedTier) {
    amountBonus = matchedTier.bonus;
    user.balance += amountBonus;
    topup.bonusApplied = amountBonus;
  }

  // Реферальный бонус — платим тому, кто пригласил, при ПЕРВОМ одобренном пополнении приглашённого
  // (защита от накрутки: просто регистрация ничего не даёт, только реальная активность)
  if (user.referredBy && !user.referralBonusPaid) {
    const referrer = db.users.find(u => u.id === user.referredBy);
    const bonus = db.settings?.referralBonusAmount ?? 0;
    if (referrer && bonus > 0) {
      referrer.balance = (referrer.balance || 0) + bonus;
      referrer.referralEarnings = (referrer.referralEarnings || 0) + bonus;
      user.referralBonusPaid = true;
      if (referrer.telegramChatId) {
        sendToChat(referrer.telegramChatId, `🎉 Ваш друг <b>${user.name}</b> совершил первое пополнение — вам начислен бонус <b>${bonus} сомони</b>!`);
      }
    }
  }

  await writeDB(db);

  // Если у человека были заказы, "зависшие" на оплате из-за нехватки денег —
  // теперь, когда баланс пополнился, автоматически оплачиваем их (от старых к новым),
  // чтобы не оставалось непонятных "висящих" заказов ни у него, ни в админке.
  const pendingOrders = db.orders
    .filter(o => o.userId === user.id && o.status === 'awaiting_payment')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const paidOrderIds = [];
  for (const order of pendingOrders) {
    if (user.balance >= order.price) {
      user.balance -= order.price;
      order.status = 'checking';
      paidOrderIds.push(order.id);
    }
  }
  if (paidOrderIds.length > 0) {
    await writeDB(db);
    notifyAdmin(
      `🎮 <b>Заказ оплачен после пополнения баланса</b>\n` +
      `Пользователь: ${user.name}\n` +
      `Заказы: ${paidOrderIds.join(', ')}\n` +
      `Проверь в админ-панели: вкладка «Заказы»`
    );
  }

  if (user.telegramChatId) {
    const bonusLine = amountBonus > 0 ? `\n🎁 Бонус за сумму пополнения: +${amountBonus} сомони!` : '';
    const paidLine = paidOrderIds.length > 0 ? `\n✅ Заказ${paidOrderIds.length>1?'ы':''} оплачен${paidOrderIds.length>1?'ы':''} автоматически и передан${paidOrderIds.length>1?'ы':''} на выполнение!` : '';
    sendToChat(user.telegramChatId, `✅ Баланс пополнен на <b>${topup.amount} сомони</b>.${bonusLine}${paidLine}\nТекущий баланс: ${user.balance} сомони.`);
  }
  res.json({ ok: true, newBalance: user.balance, bonusApplied: amountBonus, paidOrders: paidOrderIds.length });
});

router.post('/admin/:id/reject', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const { reason } = req.body;
  const db = await readDB();
  const topup = db.topups.find(t => t.id === req.params.id);
  if (!topup) return res.status(404).json({ error: 'Заявка не найдена' });
  if (topup.status !== 'pending') return res.status(409).json({ error: 'Заявка уже обработана' });

  topup.status = 'rejected';
  topup.reviewedBy = req.user.id;
  topup.reviewedAt = new Date().toISOString();
  topup.rejectReason = reason || null;
  await writeDB(db);
  const user = db.users.find(u => u.id === topup.userId);
  if (user?.telegramChatId) {
    sendToChat(user.telegramChatId, `❌ Заявка на пополнение (${topup.amount} сомони) отклонена.${reason ? '\nПричина: ' + reason : ''}`);
  }
  res.json({ ok: true });
});

module.exports = router;
