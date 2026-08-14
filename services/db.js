// Хранилище на MongoDB. Вся база хранится как ОДИН документ
// (users, orders, topups, reviews, games) — так проще всего, и весь остальной
// код (routes/*) как обращался к readDB()/writeDB(), так и продолжает,
// просто теперь их нужно ждать через await (они асинхронные).

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'manushop';
const DOC_ID = 'main';

let clientPromise = null;

function getClient() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI не задан в .env / переменных окружения на хостинге');
  }
  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI);
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function readDB() {
  const client = await getClient();
  const col = client.db(DB_NAME).collection('appstate');
  let doc = await col.findOne({ _id: DOC_ID });

  if (!doc) {
    const initial = {
      _id: DOC_ID,
      users: [],
      orders: [],
      topups: [],
      reviews: [],
      withdrawals: [],
      promocodes: [],
      telegramLinkCodes: [],
      settings: {
        referralBonusAmount: 10,
        topupBonusTiers: [
          { minAmount: 50, bonus: 5 },
          { minAmount: 200, bonus: 10 },
          { minAmount: 500, bonus: 30 }
        ],
        vipTiers: [
          { minSpent: 500, discountPercent: 5, label: 'Постоянный клиент' },
          { minSpent: 1500, discountPercent: 10, label: 'VIP' }
        ],
        firstOrderDiscountEnabled: true,
        firstOrderDiscountPercent: 5
      },
      games: require('../data/games.json')
    };
    await col.insertOne(initial);
    doc = initial;
  }
  if (!doc.topups) doc.topups = []; // на случай старой базы без этого поля
  if (!doc.reviews) doc.reviews = [];
  if (!doc.withdrawals) doc.withdrawals = [];
  if (!doc.promocodes) doc.promocodes = [];
  if (!doc.telegramLinkCodes) doc.telegramLinkCodes = [];
  if (!doc.settings) doc.settings = { referralBonusAmount: 10 };
  if (!doc.settings.topupBonusTiers) doc.settings.topupBonusTiers = [
    { minAmount: 50, bonus: 5 },
    { minAmount: 200, bonus: 10 },
    { minAmount: 500, bonus: 30 }
  ];
  if (!doc.settings.vipTiers) doc.settings.vipTiers = [
    { minSpent: 500, discountPercent: 5, label: 'Постоянный клиент' },
    { minSpent: 1500, discountPercent: 10, label: 'VIP' }
  ];
  if (doc.settings.firstOrderDiscountEnabled === undefined) doc.settings.firstOrderDiscountEnabled = true;
  if (doc.settings.firstOrderDiscountPercent === undefined) doc.settings.firstOrderDiscountPercent = 5;
  return doc;
}

async function writeDB(data) {
  const client = await getClient();
  const col = client.db(DB_NAME).collection('appstate');
  const { _id, ...rest } = data;
  await col.updateOne({ _id: DOC_ID }, { $set: rest }, { upsert: true });
}

module.exports = { readDB, writeDB };
