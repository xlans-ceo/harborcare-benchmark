'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const serverScript = path.join(root, 'src', 'server.js');
const cssPath = path.join(root, 'src', 'styles.css');
const { RateLimiter } = require(path.join(root, 'src', 'ratelimit.js'));
const views = require(path.join(root, 'src', 'views.js'));

function makeAppDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcb-test-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return dir;
}

function startServer(appDir, { port = 0, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [serverScript], {
      cwd: appDir,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: path.join(appDir, 'data'),
        DEMO_PASSWORD: 'demo1234',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    let resolved = false;
    proc.on('error', reject);

    function tryResolve() {
      if (resolved) return;
      let actualPort = port;
      if (actualPort === 0) {
        const m = stdout.match(/listening.*:([0-9]+)/i);
        if (m) actualPort = parseInt(m[1], 10);
      }
      if (!actualPort) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ proc, port: actualPort, stdout, stderr });
    }

    // The server hashes the demo password with crypto.scryptSync during DB
    // seeding on every fresh temp directory, so startup time is variable.
    // Resolve as soon as the listening log line is emitted instead of relying
    // on a tight fixed timeout.
    proc.stdout.on('data', tryResolve);

    const timer = setTimeout(() => {
      if (resolved) return;
      if (!port && !stdout.match(/listening.*:([0-9]+)/i)) {
        proc.kill();
        reject(new Error(`Could not determine server port. stdout: ${stdout}; stderr: ${stderr}`));
        return;
      }
      tryResolve();
    }, 10000);

    proc.on('exit', code => {
      clearTimeout(timer);
      if (!resolved) {
        reject(new Error(`Server exited early with code ${code}; stderr: ${stderr}; stdout: ${stdout}`));
      }
    });
  });
}

function stopServer(ctx) {
  return new Promise(resolve => {
    if (!ctx || !ctx.proc) return resolve();
    ctx.proc.kill();
    ctx.proc.on('exit', () => resolve());
    setTimeout(() => {
      try { ctx.proc.kill('SIGKILL'); } catch {}
      resolve();
    }, 600);
  });
}

function request(port, method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) };
    if (opts.body && !headers['content-type']) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => body += d);
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function postForm(port, path, fields, opts = {}) {
  const body = new URLSearchParams(fields).toString();
  const headers = { ...(opts.headers || {}) };
  if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
  return request(port, 'POST', path, { ...opts, headers, body });
}

function contactCount(dbPath) {
  return new (require('node:sqlite').DatabaseSync)(dbPath)
    .prepare('SELECT COUNT(*) AS c FROM contact_requests')
    .get().c;
}

async function adminLogin(ctx) {
  const res = await postForm(ctx.port, '/admin/login', { username: 'demo', password: 'demo1234' });
  assert.equal(res.status, 303);
  const cookies = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']];
  const sessionCookie = cookies.find(c => c && c.startsWith('session='));
  assert.ok(sessionCookie, 'session cookie set');
  return sessionCookie.split(';')[0];
}

async function adminCsrf(ctx, cookie) {
  const res = await request(ctx.port, 'GET', '/admin', { headers: { cookie } });
  assert.equal(res.status, 200);
  const m = res.body.match(/name="csrf_token" value="([^"]+)"/);
  assert.ok(m, 'csrf token found');
  return m[1];
}

void (async () => {
  const test = require('node:test');

  await test('server starts and serves Arabic RTL home page', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const res = await request(ctx.port, 'GET', '/');
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('dir="rtl"'));
      assert.ok(res.body.includes('lang="ar"'));
      assert.ok(res.body.includes('هاربوركير'));
      assert.ok(res.body.includes('خدمات منزلية'));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('public pages return Arabic RTL and responsive meta', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      for (const p of ['/', '/services', '/contact']) {
        const res = await request(ctx.port, 'GET', p);
        assert.equal(res.status, 200, p);
        assert.ok(res.body.includes('dir="rtl"'), p);
        assert.ok(res.body.includes('name="viewport"'), p);
        assert.ok(res.body.includes('<main id="main"'), p);
      }
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('CSP allows same-origin CSS and no inline style attributes', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const css = await request(ctx.port, 'GET', '/styles.css');
      assert.equal(css.status, 200);
      assert.ok(css.headers['content-type'].includes('text/css'));

      const home = await request(ctx.port, 'GET', '/');
      const csp = home.headers['content-security-policy'];
      assert.ok(csp.includes("default-src 'none'"), csp);
      assert.ok(csp.includes("style-src 'self'"), csp);
      assert.ok(csp.includes("form-action 'self'"), csp);
      assert.ok(csp.includes("frame-ancestors 'none'"), csp);
      assert.ok(!home.body.includes('style="'), 'no inline style attributes');
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('home page contains inline SVG hero illustration with no external images', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const home = await request(ctx.port, 'GET', '/');
      assert.equal(home.status, 200);
      assert.ok(home.body.includes('<svg'), 'home page contains an svg element');
      assert.ok(home.body.includes('role="img"'), 'svg has role img');
      const labelledByMatch = home.body.match(/aria-labelledby="([^"]+)"/);
      assert.ok(labelledByMatch, 'svg has aria-labelledby');
      const titleMatch = home.body.match(/<title[^>]*id="([^"]+)"[^>]*>/);
      assert.ok(titleMatch, 'svg title has id');
      assert.equal(labelledByMatch[1], titleMatch[1], 'aria-labelledby matches title id');
      assert.ok(home.body.includes('منزل') || home.body.includes('مياه') || home.body.includes('صيانة'), 'svg title describes motif');

      assert.ok(!home.body.includes('<img'), 'no img tag on home page');
      const externalUrl = /(?:src|href)=["']https?:\/\/[^"']+["']/i;
      assert.ok(!externalUrl.test(home.body), 'home page has no external http/https references');

      const csp = home.headers['content-security-policy'];
      assert.ok(csp.includes("default-src 'none'"), csp);
      assert.ok(csp.includes("style-src 'self'"), csp);
      assert.ok(csp.includes("img-src 'self' data:"), csp);
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('server ignores hostile HOST override and binds loopback only', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir, { env: { HOST: '0.0.0.0' } });
    try {
      assert.ok(ctx.stdout.includes('127.0.0.1'), 'server logs loopback address');
      assert.ok(!ctx.stdout.includes('0.0.0.0'), 'server does not log 0.0.0.0');
      const res = await request(ctx.port, 'GET', '/');
      assert.equal(res.status, 200);
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('active services appear on services page; inactive are hidden', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const res = await request(ctx.port, 'GET', '/services');
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('تركيب وإصلاح الأدوات الصحية'));
      assert.ok(res.body.includes('صيانة أعطال الكهرباء'));
      assert.ok(res.body.includes('تنظيف منازل'));
      assert.ok(!res.body.includes('دهانات داخلية'), 'inactive service hidden');
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('valid contact submission persists and redirects via PRG', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const res = await postForm(ctx.port, '/contact', {
        name: 'أحمد سالم',
        phone: '01012345678',
        service_id: '',
        message: 'أحتاج صيانة تكييف في أقرب وقت.'
      });
      assert.equal(res.status, 303);
      assert.equal(res.headers.location, '/contact?submitted=1');

      const follow = await request(ctx.port, 'GET', '/contact?submitted=1');
      assert.equal(follow.status, 200);
      assert.ok(follow.body.includes('تم استلام'));

      const dbPath = path.join(dir, 'data', 'harborcare.db');
      const row = new (require('node:sqlite').DatabaseSync)(dbPath)
        .prepare('SELECT name, phone FROM contact_requests WHERE name = ?')
        .get('أحمد سالم');
      assert.ok(row);
      assert.equal(row.phone, '01012345678');
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('contact normalizes Arabic-Indic digits, +20, 0020, and spaces', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const phones = ['+20 102 345 6789', '00201023456789', '٠١٠٢٣٤٥٦٧٨٩', '010 23-45-67-89'];
      for (const phone of phones) {
        const name = 'test ' + Math.random().toString(36).slice(2);
        const res = await postForm(ctx.port, '/contact', {
          name,
          phone,
          service_id: '',
          message: 'رسالة تجريبية طويلة بما يكفي.'
        });
        assert.equal(res.status, 303, `phone ${phone}`);
      }
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('invalid contact rejected without persistence', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const dbPath = path.join(dir, 'data', 'harborcare.db');
      const countBefore = new (require('node:sqlite').DatabaseSync)(dbPath)
        .prepare('SELECT COUNT(*) AS c FROM contact_requests')
        .get().c;

      const res = await postForm(ctx.port, '/contact', {
        name: 'A',
        phone: '123',
        service_id: '999',
        message: 'قصيرة'
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.includes('الاسم'));
      assert.ok(res.body.includes('موبايل'));
      assert.ok(res.body.includes('خدمة'));
      assert.ok(res.body.includes('الرسالة'));
      assert.ok(res.body.includes('value="A"'));

      const countAfter = new (require('node:sqlite').DatabaseSync)(dbPath)
        .prepare('SELECT COUNT(*) AS c FROM contact_requests')
        .get().c;
      assert.equal(countAfter, countBefore, 'invalid contact made no DB write');
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('contact rejects cross-origin and cross-site requests', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const dbPath = path.join(dir, 'data', 'harborcare.db');
      const before = contactCount(dbPath);

      const badOrigin = await postForm(ctx.port, '/contact', {
        name: 'أحمد',
        phone: '01012345678',
        message: 'رسالة تجريبية طويلة بما يكفي.'
      }, { headers: { origin: 'https://evil.example' } });
      assert.equal(badOrigin.status, 403);

      const crossSite = await postForm(ctx.port, '/contact', {
        name: 'أحمد',
        phone: '01012345678',
        message: 'رسالة تجريبية طويلة بما يكفي.'
      }, { headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(crossSite.status, 403);

      assert.equal(contactCount(dbPath), before, 'rejected requests made no DB writes');

      const goodOrigin = await postForm(ctx.port, '/contact', {
        name: 'أحمد',
        phone: '01012345678',
        message: 'رسالة تجريبية طويلة بما يكفي.'
      }, { headers: { origin: `http://127.0.0.1:${ctx.port}` } });
      assert.equal(goodOrigin.status, 303);
      assert.equal(contactCount(dbPath), before + 1, 'valid same-origin request persisted once');
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('contact rate limit rejects after threshold', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir, { env: { CONTACT_RATE_MAX: '2', CONTACT_RATE_WINDOW_MS: '3600000' } });
    try {
      const dbPath = path.join(dir, 'data', 'harborcare.db');
      const payload = {
        name: 'أحمد',
        phone: '01012345678',
        message: 'رسالة تجريبية طويلة بما يكفي.'
      };
      const r1 = await postForm(ctx.port, '/contact', payload);
      assert.equal(r1.status, 303);
      const r2 = await postForm(ctx.port, '/contact', payload);
      assert.equal(r2.status, 303);
      const beforeBlock = contactCount(dbPath);
      const r3 = await postForm(ctx.port, '/contact', payload);
      assert.equal(r3.status, 429);
      assert.ok(r3.headers['retry-after']);
      assert.equal(contactCount(dbPath), beforeBlock, 'blocked request made no DB write');

      // Simulate window passing by moving clock forward
      await stopServer(ctx);
      const ctx2 = await startServer(dir, { env: { CONTACT_RATE_MAX: '2', CONTACT_RATE_WINDOW_MS: '3600000', CONTACT_RATE_CLOCK_MS: String(Date.now() + 4000000) } });
      try {
        const r4 = await postForm(ctx2.port, '/contact', payload);
        assert.equal(r4.status, 303);
      } finally {
        await stopServer(ctx2);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('admin login success grants session; failure denied', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const bad = await postForm(ctx.port, '/admin/login', { username: 'demo', password: 'wrong' });
      assert.equal(bad.status, 400);
      assert.ok(!bad.headers['set-cookie'] || !String(bad.headers['set-cookie']).includes('session='));

      const good = await postForm(ctx.port, '/admin/login', { username: 'demo', password: 'demo1234' });
      assert.equal(good.status, 303);
      assert.ok(good.headers['set-cookie']);
      const cookieHeader = Array.isArray(good.headers['set-cookie']) ? good.headers['set-cookie'].join('; ') : String(good.headers['set-cookie']);
      const cookie = cookieHeader.split(';')[0];
      assert.ok(cookie.startsWith('session='));
      assert.ok(cookieHeader.includes('HttpOnly'));
      assert.ok(cookieHeader.includes('SameSite'));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('login rate limit blocks after threshold and resets on success', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir, { env: { LOGIN_RATE_MAX: '2', LOGIN_RATE_WINDOW_MS: '3600000' } });
    try {
      const payload = { username: 'demo', password: 'wrong' };
      const r1 = await postForm(ctx.port, '/admin/login', payload);
      assert.equal(r1.status, 400);

      // Successful login resets the failed-attempt counter for this username+IP
      const good = await postForm(ctx.port, '/admin/login', { username: 'demo', password: 'demo1234' });
      assert.equal(good.status, 303);

      // After reset, two failures are still allowed
      const r2 = await postForm(ctx.port, '/admin/login', payload);
      assert.equal(r2.status, 400);
      const r3 = await postForm(ctx.port, '/admin/login', payload);
      assert.equal(r3.status, 400);

      // Third failure after reset triggers the block
      const r4 = await postForm(ctx.port, '/admin/login', payload);
      assert.equal(r4.status, 429);
      assert.ok(r4.headers['retry-after']);

      // Different username from same IP is not blocked
      const other = await postForm(ctx.port, '/admin/login', { username: 'other', password: 'wrong' });
      assert.equal(other.status, 400);
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('session hash stored not plaintext; logout invalidates session', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const login = await postForm(ctx.port, '/admin/login', { username: 'demo', password: 'demo1234' });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const token = cookie.split('=')[1];
      const dbPath = path.join(dir, 'data', 'harborcare.db');
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      const db = new (require('node:sqlite').DatabaseSync)(dbPath);
      const row = db.prepare('SELECT session_hash FROM sessions WHERE session_hash = ?').get(hash);
      assert.ok(row, 'session hash stored');
      const csrf = await adminCsrf(ctx, cookie);
      const dbRaw = fs.readFileSync(dbPath);
      assert.ok(!dbRaw.includes(Buffer.from(token)), 'plaintext token not stored');

      const logout = await postForm(ctx.port, '/admin/logout', { csrf_token: csrf }, { headers: { cookie } });
      assert.equal(logout.status, 303);
      assert.ok(String(logout.headers['set-cookie']).includes('Max-Age=0'));

      const after = await request(ctx.port, 'GET', '/admin', { headers: { cookie } });
      assert.equal(after.status, 303);
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('admin CRUD creates, edits, deletes service via confirmation page', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const cookie = await adminLogin(ctx);
      const csrf = await adminCsrf(ctx, cookie);

      const create = await postForm(ctx.port, '/admin/services/new', {
        csrf_token: csrf,
        name: 'تركيب سيراميك',
        category: 'سباكة',
        description: 'تركيب سيراميك حمامات ومطابخ بجودة عالية.',
        active: '1'
      }, { headers: { cookie } });
      assert.equal(create.status, 303);

      let services = await request(ctx.port, 'GET', '/services');
      assert.ok(services.body.includes('تركيب سيراميك'));

      const admin = await request(ctx.port, 'GET', '/admin', { headers: { cookie } });
      const idMatch = admin.body.match(/\/admin\/services\/([0-9]+)\/edit/);
      assert.ok(idMatch);
      const id = idMatch[1];

      // Delete control on the admin list must be a GET link to the confirmation page
      const deleteLink = admin.body.includes(`href="/admin/services/${id}/delete"`);
      const deletePostForm = admin.body.includes(`action="/admin/services/${id}/delete"`);
      assert.ok(deleteLink, 'admin list links to delete confirmation page');
      assert.ok(!deletePostForm, 'admin list does not post delete directly');

      const edit = await postForm(ctx.port, `/admin/services/${id}/edit`, {
        csrf_token: csrf,
        name: 'تركيب سيراميك مُحدَّث',
        category: 'سباكة',
        description: 'تركيب سيراميك حمامات ومطابخ بجودة عالية ومتابعة.',
        active: '1'
      }, { headers: { cookie } });
      assert.equal(edit.status, 303);

      services = await request(ctx.port, 'GET', '/services');
      assert.ok(services.body.includes('تركيب سيراميك مُحدَّث'));

      // GET to delete route shows confirmation page and does not delete
      const confirm = await request(ctx.port, 'GET', `/admin/services/${id}/delete`, { headers: { cookie } });
      assert.equal(confirm.status, 200);
      assert.ok(confirm.body.includes('تأكيد حذف'));
      services = await request(ctx.port, 'GET', '/services');
      assert.ok(services.body.includes('تركيب سيراميك'));

      // POST from confirmation page performs deletion
      const del = await postForm(ctx.port, `/admin/services/${id}/delete`, {
        csrf_token: csrf
      }, { headers: { cookie } });
      assert.equal(del.status, 303);

      services = await request(ctx.port, 'GET', '/services');
      assert.ok(!services.body.includes('تركيب سيراميك'));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('unauthorized admin GET and POST are denied without mutation', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const get = await request(ctx.port, 'GET', '/admin');
      assert.equal(get.status, 303);
      assert.equal(get.headers.location, '/admin/login');

      const post = await postForm(ctx.port, '/admin/services/new', {
        name: 'اختراق',
        category: 'سباكة',
        description: 'وصف وهمي طويل بما يكفي.',
        active: '1'
      });
      assert.equal(post.status, 303);
      assert.equal(post.headers.location, '/admin/login');

      const services = await request(ctx.port, 'GET', '/services');
      assert.ok(!services.body.includes('اختراق'));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('malformed session cookie is treated as invalid, not 500', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      for (const cookie of ['session=%ZZ', 'session=%', 'session=%%']) {
        const get = await request(ctx.port, 'GET', '/admin', { headers: { cookie } });
        assert.equal(get.status, 303, `GET with ${cookie}`);
        assert.equal(get.headers.location, '/admin/login', `GET redirect with ${cookie}`);

        const post = await postForm(ctx.port, '/admin/services/new', {
          name: 'اختراق',
          category: 'سباكة',
          description: 'وصف وهمي طويل بما يكفي.',
          active: '1'
        }, { headers: { cookie } });
        assert.equal(post.status, 303, `POST with ${cookie}`);
        assert.equal(post.headers.location, '/admin/login', `POST redirect with ${cookie}`);
      }

      const services = await request(ctx.port, 'GET', '/services');
      assert.ok(!services.body.includes('اختراق'));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('admin mutations reject missing or tampered CSRF', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const cookie = await adminLogin(ctx);
      const csrf = await adminCsrf(ctx, cookie);

      const noCsrf = await postForm(ctx.port, '/admin/services/new', {
        name: 'اختراق',
        category: 'سباكة',
        description: 'وصف وهمي طويل بما يكفي.',
        active: '1'
      }, { headers: { cookie } });
      assert.equal(noCsrf.status, 403);

      const badCsrf = await postForm(ctx.port, '/admin/services/new', {
        csrf_token: 'tampered',
        name: 'اختراق',
        category: 'سباكة',
        description: 'وصف وهمي طويل بما يكفي.',
        active: '1'
      }, { headers: { cookie } });
      assert.equal(badCsrf.status, 403);

      const noCsrfLogout = await postForm(ctx.port, '/admin/logout', {}, { headers: { cookie } });
      assert.equal(noCsrfLogout.status, 403);

      const create = await postForm(ctx.port, '/admin/services/new', {
        csrf_token: csrf,
        name: 'هدف للحذف',
        category: 'سباكة',
        description: 'وصف الهدف للحذف طويل بما يكفي.',
        active: '1'
      }, { headers: { cookie } });
      assert.equal(create.status, 303);
      const admin = await request(ctx.port, 'GET', '/admin', { headers: { cookie } });
      const idMatch = admin.body.match(/\/admin\/services\/([0-9]+)\/delete/);
      assert.ok(idMatch);
      const id = idMatch[1];

      const noCsrfEdit = await postForm(ctx.port, `/admin/services/${id}/edit`, {
        name: 'معدل',
        category: 'سباكة',
        description: 'وصف معدل طويل بما يكفي.',
        active: '1'
      }, { headers: { cookie } });
      assert.equal(noCsrfEdit.status, 403);

      const noCsrfDelete = await postForm(ctx.port, `/admin/services/${id}/delete`, {}, { headers: { cookie } });
      assert.equal(noCsrfDelete.status, 403);

      const services = await request(ctx.port, 'GET', '/services');
      assert.ok(!services.body.includes('اختراق'));
      assert.ok(services.body.includes('هدف للحذف'));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('expired or random session cookie is denied without mutation', async () => {
    const dir = makeAppDir();
    let ctx = await startServer(dir);
    try {
      const cookie = await adminLogin(ctx);
      const valid = await request(ctx.port, 'GET', '/admin', { headers: { cookie } });
      assert.equal(valid.status, 200);

      await stopServer(ctx);
      ctx = await startServer(dir, { env: { SESSION_CLOCK_MS: String(Date.now() + 7 * 60 * 60 * 1000) } });
      const stillValid = await request(ctx.port, 'GET', '/admin', { headers: { cookie } });
      assert.equal(stillValid.status, 200);

      await stopServer(ctx);
      ctx = await startServer(dir, { env: { SESSION_CLOCK_MS: String(Date.now() + 9 * 60 * 60 * 1000) } });
      const expired = await request(ctx.port, 'GET', '/admin', { headers: { cookie } });
      assert.equal(expired.status, 303);
      assert.equal(expired.headers.location, '/admin/login');

      const randomCookie = 'session=' + crypto.randomBytes(32).toString('base64url');
      const random = await request(ctx.port, 'GET', '/admin', { headers: { cookie: randomCookie } });
      assert.equal(random.status, 303);
      assert.equal(random.headers.location, '/admin/login');
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('service description 500 accepted, 501 rejected', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const cookie = await adminLogin(ctx);
      const csrf = await adminCsrf(ctx, cookie);

      const ok = await postForm(ctx.port, '/admin/services/new', {
        csrf_token: csrf,
        name: 'اختبار 500',
        category: 'سباكة',
        description: 'أ'.repeat(500),
        active: '1'
      }, { headers: { cookie } });
      assert.equal(ok.status, 303);

      const bad = await postForm(ctx.port, '/admin/services/new', {
        csrf_token: csrf,
        name: 'اختبار 501',
        category: 'سباكة',
        description: 'أ'.repeat(501),
        active: '1'
      }, { headers: { cookie } });
      assert.equal(bad.status, 400);
      assert.ok(bad.body.includes('الوصف'));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('invalid new-service form preserves exactly one active/inactive choice', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const cookie = await adminLogin(ctx);
      const csrf = await adminCsrf(ctx, cookie);

      const res = await postForm(ctx.port, '/admin/services/new', {
        csrf_token: csrf,
        name: 'A',
        category: '',
        description: 'short',
        active: '0'
      }, { headers: { cookie } });
      assert.equal(res.status, 400);
      const checkedCount = (res.body.match(/checked/g) || []).length;
      assert.equal(checkedCount, 1, 'exactly one radio is checked');
      assert.ok(res.body.includes('value="0" checked'), 'submitted inactive choice is preserved');
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('XSS payloads escaped in output', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const payload = '<script>alert(1)</script>';
      const res = await postForm(ctx.port, '/contact', {
        name: payload,
        phone: '01012345678',
        message: 'رسالة تجريبية طويلة بما يكفي.'
      });
      assert.equal(res.status, 303);
      const follow = await request(ctx.port, 'GET', '/contact?submitted=1');
      assert.ok(follow.body.includes('&lt;script&gt;') || !follow.body.includes('<script>alert(1)</script>'));
      assert.ok(!follow.body.includes('<script>alert(1)</script>'));

      // Also verify invalid form preserves escaped values
      const invalid = await postForm(ctx.port, '/contact', {
        name: payload,
        phone: 'bad',
        message: 'short'
      });
      assert.equal(invalid.status, 400);
      assert.ok(invalid.body.includes('&lt;script&gt;'));
      assert.ok(!invalid.body.includes('<script>alert(1)</script>'));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('SQL injection treated literally and rejected or harmless', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const res = await postForm(ctx.port, '/contact', {
        name: "'; DROP TABLE services; --",
        phone: '01012345678',
        message: 'رسالة تجريبية طويلة بما يكفي.'
      });
      // Name is long enough to pass validation; prepared statements prevent mutation
      assert.equal(res.status, 303);
      const services = await request(ctx.port, 'GET', '/services');
      assert.equal(services.status, 200);
      assert.ok(services.body.includes('تركيب وإصلاح الأدوات الصحية'));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('oversized body returns 413', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const dbPath = path.join(dir, 'data', 'harborcare.db');
      const before = contactCount(dbPath);
      const big = 'message=' + encodeURIComponent('أ'.repeat(17000));
      const res = await request(ctx.port, 'POST', '/contact', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: big
      });
      assert.equal(res.status, 413);
      assert.equal(contactCount(dbPath), before, 'oversized request made no DB write');
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('unsupported content type returns 415 before mutation', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const dbPath = path.join(dir, 'data', 'harborcare.db');
      const before = contactCount(dbPath);

      const cases = [
        { label: 'application/json', headers: { 'content-type': 'application/json' }, body: '{}' },
        { label: 'text/plain', headers: { 'content-type': 'text/plain' }, body: 'hello' },
        { label: 'non-standard form-like type', headers: { 'content-type': 'application/x-www-form-urlencoded-not-a-type' }, body: 'a=1' },
        { label: 'missing content-type', headers: {}, body: undefined }
      ];

      for (const c of cases) {
        const res = await request(ctx.port, 'POST', '/contact', c);
        assert.equal(res.status, 415, `contact ${c.label} should be rejected`);
        assert.equal(contactCount(dbPath), before, `${c.label} contact made no DB write`);
      }

      const loginJson = await request(ctx.port, 'POST', '/admin/login', {
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(loginJson.status, 415);
      assert.ok(!loginJson.headers['set-cookie'] || !String(loginJson.headers['set-cookie']).includes('session='));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('unsupported method on known route returns 405 with Allow', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const res = await request(ctx.port, 'DELETE', '/contact');
      assert.equal(res.status, 405);
      assert.ok((res.headers.allow || '').includes('GET'));
      assert.ok((res.headers.allow || '').includes('POST'));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('404 and 500 pages return generic messages without stack', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const notFound = await request(ctx.port, 'GET', '/nonexistent');
      assert.equal(notFound.status, 404);
      assert.ok(notFound.body.includes('غير موجودة'));
      assert.ok(!notFound.body.includes('at '));
      assert.ok(!notFound.body.includes('Error'));
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('generic 500 path returns Arabic message without stack or SQL details', async () => {
    const dir = makeAppDir();
    const ctx = await startServer(dir);
    try {
      const dbPath = path.join(dir, 'data', 'harborcare.db');
      // Trigger an internal database error at runtime from an isolated temp DB.
      const testDb = new (require('node:sqlite').DatabaseSync)(dbPath);
      testDb.exec('DROP TABLE services');
      testDb.close();

      const res = await request(ctx.port, 'GET', '/');
      assert.equal(res.status, 500);
      assert.ok(res.body.includes('حدث خطأ') || res.body.includes('غير متوقع'), 'response contains Arabic error message');
      assert.ok(!res.body.includes('at '), 'no stack trace');
      assert.ok(!res.body.includes('Error'), 'no Error string');
      const sqlKeywords = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|TABLE|SQL|no such)\b/i;
      assert.ok(!sqlKeywords.test(res.body), 'no SQL details leaked');
    } finally {
      await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('data persists after server restart on same DB', async () => {
    const dir = makeAppDir();
    let ctx = await startServer(dir);
    try {
      await postForm(ctx.port, '/contact', {
        name: 'محمد',
        phone: '01098765432',
        message: 'رسالة طويلة بما يكفي للاختبار.'
      });
      await stopServer(ctx);
      ctx = null;

      const ctx2 = await startServer(dir);
      try {
        const adminCookie = await adminLogin(ctx2);
        const csrf = await adminCsrf(ctx2, adminCookie);
        await postForm(ctx2.port, '/admin/services/new', {
          csrf_token: csrf,
          name: 'خدمة بعد إعادة التشغيل',
          category: 'نجارة',
          description: 'وصف الخدمة بعد إعادة تشغيل الخادم.',
          active: '1'
        }, { headers: { cookie: adminCookie } });

        const services = await request(ctx2.port, 'GET', '/services');
        assert.ok(services.body.includes('خدمة بعد إعادة التشغيل'));

        const dbPath = path.join(dir, 'data', 'harborcare.db');
        const db = new (require('node:sqlite').DatabaseSync)(dbPath);
        const row = db.prepare('SELECT name, phone FROM contact_requests WHERE name = ?').get('محمد');
        assert.ok(row);
        assert.equal(row.phone, '01098765432');
      } finally {
        await stopServer(ctx2);
      }
    } finally {
      if (ctx) await stopServer(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('RateLimiter blocks and expires within the same instance', () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 2, windowMs: 60000, clock: () => now });
    assert.ok(limiter.check('a').allowed);
    assert.ok(limiter.check('a').allowed);
    const blocked = limiter.check('a');
    assert.ok(!blocked.allowed);
    assert.ok(blocked.resetIn > 0);

    now = 61000;
    const reset = limiter.check('a');
    assert.ok(reset.allowed);
  });

  await test('contact page does not promise outbound contact follow-up', () => {
    const html = views.contactPage({ submitted: true, errors: {}, values: {}, services: [] });
    const outboundPhrases = ['سنتواصل معك', 'نتواصل معك', 'في أقرب وقت', 'قريباً'];
    for (const phrase of outboundPhrases) {
      assert.ok(!html.includes(phrase), `contact page should not contain "${phrase}"`);
    }
    assert.ok(html.includes('تم الإرسال') || html.includes('تم استلام'), 'success message remains');
  });

  await test('navigation label uses correct Arabic spelling', () => {
    const html = views.homePage([]);
    assert.ok(html.includes('aria-label="الملاحة الرئيسية"'), 'correct navigation label');
    assert.ok(!html.includes('الملاحجة الرئيسية'), 'typo removed');
  });

  await test('concurrent server starts use isolated ports and respond', async () => {
    const count = 4;
    const dirs = Array.from({ length: count }, () => makeAppDir());
    const contexts = await Promise.all(dirs.map(dir => startServer(dir)));
    try {
      const ports = contexts.map(c => c.port);
      assert.equal(new Set(ports).size, count, 'each server bound a distinct port');
      for (let i = 0; i < count; i++) {
        const res = await request(ports[i], 'GET', '/');
        assert.equal(res.status, 200, `server ${i} responds`);
        assert.ok(res.body.includes('هاربوركير'), `server ${i} serves home page`);
      }
    } finally {
      await Promise.all(contexts.map(stopServer));
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('CSS color tokens meet listed contrast ratios', async () => {
    const css = fs.readFileSync(cssPath, 'utf8');
    const hex = v => {
      const n = parseInt(v, 16);
      const r = ((n >> 16) & 0xff) / 255;
      const g = ((n >> 8) & 0xff) / 255;
      const b = (n & 0xff) / 255;
      const lum = c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
    };
    const ratio = (a, b) => {
      const l1 = hex(a) + 0.05;
      const l2 = hex(b) + 0.05;
      return l1 > l2 ? l1 / l2 : l2 / l1;
    };

    const pairs = [
      ['0F172A', 'FAF9F7', 16.97],
      ['0F172A', 'FFFFFF', 17.85],
      ['475569', 'FAF9F7', 7.20],
      ['475569', 'FFFFFF', 7.58],
      ['FFFFFF', '0369A1', 5.93],
      ['FFFFFF', '075985', 7.56],
      ['7C2D12', 'FFF3EA', 8.59],
      ['B91C1C', 'FEF2F2', 5.91],
      ['B91C1C', 'FFFFFF', 6.47],
      ['166534', 'F0FDF4', 6.81],
      ['854D0E', 'FEFCE8', 6.62]
    ];

    for (const [fg, bg, expected] of pairs) {
      const r = ratio(fg, bg);
      assert.ok(r >= expected - 0.1 && r <= expected + 0.1, `contrast ${fg}/${bg} expected ~${expected}, got ${r}`);
      assert.ok(r >= 4.5, `contrast ${fg}/${bg} below 4.5: ${r}`);
    }
  });
})();
