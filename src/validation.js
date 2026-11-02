'use strict';

const { CATEGORIES } = require('./db');

const ARABIC_INDIC = /[٠١٢٣٤٥٦٧٨٩]/g;
const INDIC_TO_WESTERN = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };

function normalizeDigits(input) {
  return String(input ?? '').replace(ARABIC_INDIC, c => INDIC_TO_WESTERN[c] || c);
}

function normalizePhone(input) {
  let s = normalizeDigits(input);
  s = s.replace(/[\s\-]/g, '');
  if (s.startsWith('0020')) s = s.slice(4);
  if (s.startsWith('+20')) s = s.slice(3);
  if (s.startsWith('0') && s.length === 11) s = s.slice(1);
  // After stripping prefixes, local 10-digit form expected; re-add leading zero for canonical 11-digit form
  if (s.length === 10 && /^1[0125][0-9]{8}$/.test(s)) s = '0' + s;
  return s;
}

function validateEgyptianMobile(raw) {
  const normalized = normalizePhone(raw);
  if (!/^01[0125][0-9]{8}$/.test(normalized)) {
    return { ok: false, error: 'أدخل رقم موبايل مصري صحيح (مثل 010XXXXXXXX).', value: normalized };
  }
  return { ok: true, value: normalized };
}

function validateContact({ name, phone, service_id, message }, db) {
  const errors = {};
  const values = {};

  const n = String(name ?? '').trim();
  if (!n || n.length < 2 || n.length > 100) errors.name = 'الاسم مطلوب بين حرفين و١٠٠ حرف.';
  values.name = n;

  const phoneCheck = validateEgyptianMobile(phone);
  if (!phoneCheck.ok) errors.phone = phoneCheck.error;
  values.phone = phoneCheck.value;
  values.phoneRaw = String(phone ?? '');

  const sid = String(service_id ?? '').trim();
  values.service_id = sid;
  if (sid) {
    const row = db.prepare('SELECT id FROM services WHERE id = ? AND active = 1').get(Number(sid));
    if (!row) errors.service_id = 'الخدمة المختارة غير متاحة.';
  }

  const m = String(message ?? '').trim();
  if (!m || m.length < 10 || m.length > 1000) errors.message = 'الرسالة مطلوبة بين ١٠ و١٠٠٠ حرف.';
  values.message = m;

  return { ok: Object.keys(errors).length === 0, errors, values };
}

function validateService({ name, category, description, active }) {
  const errors = {};
  const values = {};

  const n = String(name ?? '').trim();
  if (!n || n.length < 2 || n.length > 120) errors.name = 'اسم الخدمة مطلوب بين حرفين و١٢٠ حرف.';
  values.name = n;

  const c = String(category ?? '').trim();
  if (!CATEGORIES.includes(c)) errors.category = 'التصنيف المختار غير صالح.';
  values.category = c;

  const d = String(description ?? '').trim();
  if (!d || d.length < 10 || d.length > 500) errors.description = 'الوصف مطلوب بين ١٠ و٥٠٠ حرف.';
  values.description = d;

  const a = String(active ?? '');
  if (a !== '1' && a !== '0') errors.active = 'حالة الخدمة يجب أن تكون نشطة أو غير نشطة.';
  values.active = a;

  return { ok: Object.keys(errors).length === 0, errors, values };
}

module.exports = {
  normalizeDigits,
  normalizePhone,
  validateEgyptianMobile,
  validateContact,
  validateService,
  CATEGORIES
};
