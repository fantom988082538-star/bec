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
      settings: { referralBonusAmount: 10 },
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
  return doc;
}

async function writeDB(data) {
  const client = await getClient();
  const col = client.db(DB_NAME).collection('appstate');
  const { _id, ...rest } = data;
  await col.updateOne({ _id: DOC_ID }, { $set: rest }, { upsert: true });
}

module.exports = { readDB, writeDB };
