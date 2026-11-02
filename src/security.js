'use strict';

const crypto = require('node:crypto');
const { hashSessionToken } = require('./db');

const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

// Dummy hash used to consume similar time when verifying a missing username.
const DUMMY_PASSWORD_HASH = (() => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync('dummy', salt, 64);
  return salt.toString('base64') + ':' + hash.toString('base64');
})();

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = crypto.scryptSync(password, salt, 64);
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('base64') + ':' + hash.toString('base64');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function setSessionCookie(res, token) {
  const expires = new Date(Date.now() + SESSION_DURATION_MS);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Expires=${expires.toUTCString()}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function parseCookies(header) {
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(rest.join('=') || '');
    } catch {
      // Malformed percent-encoding: treat cookie value as absent/invalid.
      out[name] = '';
    }
  }
  return out;
}

function getSession(db, req, clock = Date.now) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session;
  if (!token) return null;
  const hash = hashSessionToken(token);
  const now = Math.floor(clock() / 1000);
  const row = db.prepare('SELECT s.id, s.admin_id, s.csrf_token, s.expires_at, a.username FROM sessions s JOIN admins a ON s.admin_id = a.id WHERE s.session_hash = ? AND s.expires_at > ?').get(hash, now);
  return row || null;
}

function createSession(db, adminId) {
  const token = randomToken(32);
  const csrf = randomToken(32);
  const hash = hashSessionToken(token);
  const expiresAt = Math.floor((Date.now() + SESSION_DURATION_MS) / 1000);
  db.prepare('INSERT INTO sessions (session_hash, admin_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(hash, adminId, csrf, expiresAt);
  return { token, csrf };
}

function deleteSession(db, req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session;
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE session_hash = ?').run(hashSessionToken(token));
}

function securityHeaders(res, isAdminOrPost = false) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (isAdminOrPost) {
    res.setHeader('Cache-Control', 'no-store');
  }
}

function formatRetryAfter(seconds) {
  return String(Math.max(1, Math.ceil(seconds)));
}

module.exports = {
  escapeHtml,
  verifyPassword,
  hashPassword,
  DUMMY_PASSWORD_HASH,
  randomToken,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  getSession,
  createSession,
  deleteSession,
  securityHeaders,
  formatRetryAfter,
  SESSION_DURATION_MS
};
