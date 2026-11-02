'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const CATEGORIES = [
  'سباكة',
  'كهرباء',
  'تكييف وتبريد',
  'نجارة',
  'دهانات وتشطيبات',
  'تنظيف منزلي'
];

function getDbPath() {
  const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, 'harborcare.db');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function initDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_hash TEXT UNIQUE NOT NULL,
      admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS contact_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  return db;
}

function seedIfNeeded(db, demoPasswordEnv) {
  const seeded = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('seeded');
  if (seeded) return;

  const demoPassword = demoPasswordEnv || 'demo1234';
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(demoPassword, salt, 64);
  const passwordHash = salt.toString('base64') + ':' + hash.toString('base64');

  const insertAdmin = db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)');
  insertAdmin.run('demo', passwordHash);

  const services = [
    ['تركيب وإصلاح الأدوات الصحية', 'سباكة', 'خدمات سباكة شاملة للمنازل والمطابخ والحمامات.', 1],
    ['صيانة أعطال الكهرباء', 'كهرباء', 'إصلاح القواطع والإنارة والأعطال الكهربائية المنزلية.', 1],
    ['تنظيف منازل', 'تنظيف منزلي', 'تنظيف شامل للغرف والمطابخ والحمامات بعناية.', 1],
    ['دهانات داخلية', 'دهانات وتشطيبات', 'طلاء الجدران والأسقف بألوان عصرية ومتينة.', 0]
  ];

  const insertService = db.prepare('INSERT INTO services (name, category, description, active) VALUES (?, ?, ?, ?)');
  for (const s of services) insertService.run(...s);

  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('seeded', '1');
}

module.exports = {
  CATEGORIES,
  getDbPath,
  hashSessionToken,
  initDb,
  seedIfNeeded
};
