'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { URL } = require('node:url');

const { initDb, seedIfNeeded } = require('./db');
const {
  verifyPassword, DUMMY_PASSWORD_HASH, setSessionCookie, clearSessionCookie,
  getSession, createSession, deleteSession, securityHeaders, formatRetryAfter
} = require('./security');
const { validateContact, validateService } = require('./validation');
const {
  homePage, servicesPage, contactPage, loginPage, adminPage,
  serviceFormPage, deleteConfirmPage, errorPage
} = require('./views');
const { RateLimiter } = require('./ratelimit');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234';

fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = path.join(DATA_DIR, 'harborcare.db');
const db = initDb(dbPath);
seedIfNeeded(db, DEMO_PASSWORD);

const contactLimiter = new RateLimiter({
  max: parseInt(process.env.CONTACT_RATE_MAX || '5', 10),
  windowMs: parseInt(process.env.CONTACT_RATE_WINDOW_MS || '600000', 10),
  clock: process.env.CONTACT_RATE_CLOCK_MS ? () => parseInt(process.env.CONTACT_RATE_CLOCK_MS, 10) : Date.now
});

const loginLimiter = new RateLimiter({
  max: parseInt(process.env.LOGIN_RATE_MAX || '10', 10),
  windowMs: parseInt(process.env.LOGIN_RATE_WINDOW_MS || '900000', 10),
  clock: process.env.LOGIN_RATE_CLOCK_MS ? () => parseInt(process.env.LOGIN_RATE_CLOCK_MS, 10) : Date.now
});

const sessionClock = process.env.SESSION_CLOCK_MS ? () => parseInt(process.env.SESSION_CLOCK_MS, 10) : Date.now;

const cssPath = path.resolve(__dirname, 'styles.css');
const css = fs.readFileSync(cssPath, 'utf8');

function getClientIp(req) {
  // Do not trust X-Forwarded-For. Use direct socket address.
  return req.socket.remoteAddress || 'unknown';
}

function loginRateKey(req, username) {
  return `${getClientIp(req)}:${String(username ?? '').trim().toLowerCase()}`;
}

function readBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let oversized = false;
    const chunks = [];
    req.on('data', chunk => {
      if (oversized) return;
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        reject(Object.assign(new Error('Request entity too large'), { code: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!oversized) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  if ([...params.keys()].length > 32) {
    throw Object.assign(new Error('Too many parameters'), { code: 400 });
  }
  const out = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

function redirect(res, location, status = 303) {
  res.writeHead(status, { Location: location });
  res.end();
}

function render(res, status, html, isAdminOrPost = false) {
  securityHeaders(res, isAdminOrPost);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function originCheck(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host || `${HOST}:${PORT}`;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost === host;
}

function isCrossSite(req) {
  const site = req.headers['sec-fetch-site'];
  return site === 'cross-site';
}

function requireFormContentType(req, res) {
  const ct = req.headers['content-type'] || '';
  const mediaType = ct.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') {
    render(res, 415, errorPage(415, 'نوع المحتوى غير مدعوم. يرجى إرسال النموذج بالتنسيق المدعوم.'), true);
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  const session = getSession(db, req, sessionClock);
  if (!session) {
    redirect(res, '/admin/login');
    return null;
  }
  return session;
}

function csrfOk(session, body, req) {
  if (!session) return false;
  const token = String(body.csrf_token || '');
  if (!token || token !== session.csrf_token) return false;
  return originCheck(req) && !isCrossSite(req);
}

function allServices() {
  return db.prepare('SELECT * FROM services ORDER BY created_at DESC, id DESC').all();
}

function activeServices() {
  return db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY created_at DESC, id DESC').all();
}

function getService(id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id);
}

async function handlePublic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/styles.css') {
    securityHeaders(res, false);
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(css);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    render(res, 200, homePage(activeServices()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/services') {
    render(res, 200, servicesPage(activeServices()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/contact') {
    const submitted = url.searchParams.get('submitted') === '1';
    render(res, 200, contactPage({
      submitted,
      errors: {},
      values: { service_id: url.searchParams.get('service') || '' },
      services: activeServices()
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/contact') {
    if (!originCheck(req) || isCrossSite(req)) {
      render(res, 403, errorPage(403, 'تم رفض الطلب. يرجى إرسال النموذج من نفس الموقع.'), true);
      return;
    }
    if (!requireFormContentType(req, res)) return;

    const limit = contactLimiter.check(getClientIp(req));
    if (!limit.allowed) {
      securityHeaders(res, true);
      res.writeHead(429, {
        'Content-Type': 'text/html; charset=utf-8',
        'Retry-After': formatRetryAfter(limit.resetIn / 1000)
      });
      res.end(errorPage(429, 'لقد تجاوزت عدد المحاولات المسموح. يرجى الانتظار والمحاولة لاحقاً.'));
      return;
    }

    let text;
    try {
      text = await readBody(req);
    } catch (err) {
      if (err.code === 413) {
        render(res, 413, errorPage(413, 'حجم الطلب كبير جداً.'), true);
        return;
      }
      throw err;
    }

    let data;
    try {
      data = parseForm(text);
    } catch (err) {
      render(res, 400, errorPage(400, 'بيانات النموذج غير صالحة.'), true);
      return;
    }

    const result = validateContact(data, db);
    if (!result.ok) {
      render(res, 400, contactPage({
        submitted: false,
        errors: result.errors,
        values: result.values,
        services: activeServices()
      }), true);
      return;
    }

    db.prepare('INSERT INTO contact_requests (name, phone, service_id, message) VALUES (?, ?, ?, ?)').run(
      result.values.name,
      result.values.phone,
      result.values.service_id ? Number(result.values.service_id) : null,
      result.values.message
    );
    redirect(res, '/contact?submitted=1');
    return;
  }

  render(res, 404, errorPage(404, 'الصفحة المطلوبة غير موجودة.'));
}

async function handleAdmin(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/admin/login') {
    render(res, 200, loginPage({ error: null }), false);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/login') {
    if (!requireFormContentType(req, res)) return;
    let text;
    try {
      text = await readBody(req);
    } catch (err) {
      if (err.code === 413) {
        render(res, 413, loginPage({ error: 'حجم الطلب كبير جداً.' }), true);
        return;
      }
      throw err;
    }
    const data = parseForm(text);
    const username = String(data.username || '').trim();
    const password = String(data.password || '');

    const limit = loginLimiter.check(loginRateKey(req, username));
    if (!limit.allowed) {
      securityHeaders(res, true);
      res.writeHead(429, {
        'Content-Type': 'text/html; charset=utf-8',
        'Retry-After': formatRetryAfter(limit.resetIn / 1000)
      });
      res.end(errorPage(429, 'لقد تجاوزت عدد محاولات تسجيل الدخول المسموح. يرجى الانتظار والمحاولة لاحقاً.'));
      return;
    }

    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    const passwordHash = admin ? admin.password_hash : DUMMY_PASSWORD_HASH;
    if (admin && verifyPassword(password, passwordHash)) {
      loginLimiter.reset(loginRateKey(req, username));
      const sess = createSession(db, admin.id);
      setSessionCookie(res, sess.token);
      redirect(res, '/admin');
      return;
    }
    // Consume similar time for missing usernames to avoid timing side-channels.
    if (!admin) verifyPassword(password, passwordHash);
    render(res, 400, loginPage({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' }), true);
    return;
  }

  const session = requireAdmin(req, res);
  if (!session) return;

  if (req.method === 'GET' && url.pathname === '/admin') {
    render(res, 200, adminPage(allServices(), session.csrf_token), true);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/logout') {
    if (!requireFormContentType(req, res)) return;
    const data = parseForm(await readBody(req));
    if (!csrfOk(session, data, req)) {
      render(res, 403, errorPage(403, 'الطلب غير مصرح به.'), true);
      return;
    }
    deleteSession(db, req);
    clearSessionCookie(res);
    redirect(res, '/admin/login');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/services/new') {
    render(res, 200, serviceFormPage({ service: null, csrf: session.csrf_token, errors: {}, values: {} }), true);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/services/new') {
    if (!requireFormContentType(req, res)) return;
    const data = parseForm(await readBody(req));
    if (!csrfOk(session, data, req)) {
      render(res, 403, errorPage(403, 'الطلب غير مصرح به.'), true);
      return;
    }
    const result = validateService(data);
    if (!result.ok) {
      render(res, 400, serviceFormPage({ service: null, csrf: session.csrf_token, errors: result.errors, values: result.values }), true);
      return;
    }
    db.prepare('INSERT INTO services (name, category, description, active) VALUES (?, ?, ?, ?)').run(
      result.values.name,
      result.values.category,
      result.values.description,
      Number(result.values.active)
    );
    redirect(res, '/admin');
    return;
  }

  const editMatch = url.pathname.match(/^\/admin\/services\/([0-9]+)\/edit$/);
  if (editMatch) {
    const id = Number(editMatch[1]);
    const service = getService(id);
    if (!service) {
      render(res, 404, errorPage(404, 'الخدمة غير موجودة.'));
      return;
    }
    if (req.method === 'GET') {
      render(res, 200, serviceFormPage({ service, csrf: session.csrf_token, errors: {}, values: {} }), true);
      return;
    }
    if (req.method === 'POST') {
      if (!requireFormContentType(req, res)) return;
      const data = parseForm(await readBody(req));
      if (!csrfOk(session, data, req)) {
        render(res, 403, errorPage(403, 'الطلب غير مصرح به.'), true);
        return;
      }
      const result = validateService(data);
      if (!result.ok) {
        render(res, 400, serviceFormPage({ service, csrf: session.csrf_token, errors: result.errors, values: result.values }), true);
        return;
      }
      db.prepare('UPDATE services SET name = ?, category = ?, description = ?, active = ?, updated_at = unixepoch() WHERE id = ?').run(
        result.values.name,
        result.values.category,
        result.values.description,
        Number(result.values.active),
        id
      );
      redirect(res, '/admin');
      return;
    }
  }

  const deleteMatch = url.pathname.match(/^\/admin\/services\/([0-9]+)\/delete$/);
  if (deleteMatch) {
    const id = Number(deleteMatch[1]);
    const service = getService(id);
    if (!service) {
      render(res, 404, errorPage(404, 'الخدمة غير موجودة.'));
      return;
    }
    if (req.method === 'GET') {
      render(res, 200, deleteConfirmPage(service, session.csrf_token), true);
      return;
    }
    if (req.method === 'POST') {
      if (!requireFormContentType(req, res)) return;
      const data = parseForm(await readBody(req));
      if (!csrfOk(session, data, req)) {
        render(res, 403, errorPage(403, 'الطلب غير مصرح به.'), true);
        return;
      }
      db.prepare('DELETE FROM services WHERE id = ?').run(id);
      redirect(res, '/admin');
      return;
    }
  }

  render(res, 404, errorPage(404, 'الصفحة المطلوبة غير موجودة.'));
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.length > 2048) {
    securityHeaders(res, true);
    res.writeHead(414, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(errorPage(414, 'عنوان URL طويل جداً.'));
    return;
  }

  // Unsupported methods on known public routes
  const knownRoutes = ['/', '/services', '/contact', '/styles.css', '/admin', '/admin/login'];
  const urlPath = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  if (req.method && !['GET', 'POST', 'HEAD'].includes(req.method)) {
    if (knownRoutes.includes(urlPath) || urlPath.startsWith('/admin/')) {
      securityHeaders(res, true);
      res.writeHead(405, { 'Content-Type': 'text/html; charset=utf-8', Allow: 'GET, POST, HEAD' });
      res.end(errorPage(405, 'الطريقة غير مسموح بها.'));
      return;
    }
  }

  (async () => {
    try {
      if (urlPath.startsWith('/admin')) {
        await handleAdmin(req, res);
      } else {
        await handlePublic(req, res);
      }
    } catch (err) {
      console.error(err);
      try {
        render(res, 500, errorPage(500, 'حدث خطأ غير متوقع. يرجى المحاولة لاحقاً.'), true);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Internal Server Error');
        }
      }
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`HarborCare listening on http://${HOST}:${server.address().port}`);
});
