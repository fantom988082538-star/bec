const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { readDB, writeDB } = require('../services/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Короткий читаемый реферальный код (6 символов, буквы+цифры)
function generateReferralCode() {
  return uuid().replace(/-/g, '').slice(0, 6).toUpperCase();
}

router.post('/register', async (req, res) => {
  const { name, phone, password, ref } = req.body;
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'Заполните имя, телефон и пароль' });
  }
  const db = await readDB();
  if (db.users.find(u => u.phone === phone)) {
    return res.status(409).json({ error: 'Пользователь с таким телефоном уже существует' });
  }
  const passwordHash = await bcrypt.hash(password, 10);

  let referredBy = null;
  if (ref) {
    const referrer = db.users.find(u => u.referralCode === String(ref).toUpperCase());
    if (referrer) referredBy = referrer.id;
  }

  let referralCode = generateReferralCode();
  while (db.users.find(u => u.referralCode === referralCode)) referralCode = generateReferralCode();

  const user = {
    id: uuid(), name, phone, passwordHash,
    role: 'user', balance: 0,
    referralCode, referredBy, referralBonusPaid: false, referralEarnings: 0,
    telegramChatId: null,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  await writeDB(db);

  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, role: user.role, balance: user.balance } });
});

router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  const db = await readDB();
  const user = db.users.find(u => u.phone === phone);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Неверный телефон или пароль' });
  }
  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, role: user.role, balance: user.balance } });
});

router.get('/me', requireAuth, async (req, res) => {
  const db = await readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  // На случай если пользователь зарегистрировался ДО появления реферальной системы
  if (!user.referralCode) {
    let code = generateReferralCode();
    while (db.users.find(u => u.referralCode === code)) code = generateReferralCode();
    user.referralCode = code;
    await writeDB(db);
  }

  res.json({
    id: user.id, name: user.name, phone: user.phone, role: user.role, balance: user.balance,
    referralCode: user.referralCode,
    telegramLinked: !!user.telegramChatId
  });
});

module.exports = router;
