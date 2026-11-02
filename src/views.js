'use strict';

const { escapeHtml } = require('./security');
const { CATEGORIES } = require('./db');

function layout(title, body, { adminUser } = {}) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — هاربوركير</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <a href="#main" class="skip">تخطي إلى المحتوى الرئيسي</a>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/">هاربوركير</a>
      <nav aria-label="الملاحة الرئيسية">
        <a href="/">الرئيسية</a>
        <a href="/services">الخدمات</a>
        <a href="/contact">تواصل معنا</a>
        ${adminUser ? `<a href="/admin">لوحة التحكم</a>` : ''}
      </nav>
    </div>
  </header>
  <main id="main" class="container">
    ${body}
  </main>
  <footer class="site-footer">
    <div class="container">
      <p>موقع تجريبي محلي للتقييم فقط — لا يستخدم بيانات حقيقية.</p>
    </div>
  </footer>
</body>
</html>`;
}

function fieldError(errors, field) {
  if (!errors || !errors[field]) return '';
  return `<p class="field-error" id="error-${field}">${escapeHtml(errors[field])}</p>`;
}

function errorSummary(errors) {
  if (!errors || Object.keys(errors).length === 0) return '';
  const items = Object.entries(errors).map(([field, msg]) =>
    `<li><a href="#${field}">${escapeHtml(msg)}</a></li>`
  ).join('');
  return `<div class="error-summary" role="alert" aria-live="polite" tabindex="-1" id="error-summary">
    <strong>يرجى تصحيح الأخطاء التالية:</strong>
    <ul>${items}</ul>
  </div>`;
}

function heroIllustration() {
  return `<svg class="hero-illustration" role="img" aria-labelledby="hero-title" viewBox="0 0 360 240" xmlns="http://www.w3.org/2000/svg">
    <title id="hero-title">منزل مع أدوات صيانة وقطرات مياه</title>
    <rect class="illustration-bg" x="8" y="8" width="344" height="224" rx="28" aria-hidden="true"/>
    <g aria-hidden="true">
      <path class="illustration-house" d="M80 185 L80 120 L125 82 L170 120 L170 185 Z"/>
      <path class="illustration-roof" d="M68 123 L125 76 L182 123 Z"/>
      <rect class="illustration-roof" x="119" y="148" width="24" height="37" rx="3"/>
      <rect class="illustration-water" x="135" y="123" width="20" height="20" rx="2"/>
      <rect class="illustration-surface" x="144" y="123" width="2" height="20"/>
      <rect class="illustration-surface" x="135" y="132" width="20" height="2"/>
    </g>
    <path class="illustration-water" d="M235 105 C235 105 215 130 215 145 C215 159 225 169 235 169 C245 169 255 159 255 145 C255 130 235 105 235 105 Z" aria-hidden="true"/>
    <g aria-hidden="true">
      <rect class="illustration-tool" x="255" y="115" width="14" height="72" rx="3"/>
      <rect class="illustration-accent" x="251" y="175" width="22" height="16" rx="3"/>
    </g>
    <circle class="illustration-accent" cx="60" cy="200" r="8" aria-hidden="true"/>
    <circle class="illustration-accent" cx="300" cy="60" r="6" aria-hidden="true"/>
    <circle class="illustration-accent" cx="310" cy="190" r="5" aria-hidden="true"/>
  </svg>`;
}

function homePage(services) {
  const activeServices = services.filter(s => s.active);
  const featured = activeServices.slice(0, 3);
  const cards = featured.length
    ? featured.map(s => serviceCard(s)).join('')
    : '';

  const steps = [
    ['اختر الخدمة', 'استعرض الخدمات المتاحة واختر ما يناسب منزلك.'],
    ['راسلنا', 'املأ نموذج التواصل ببياناتك وموعدك المفضل.'],
    ['نتواصل معك', 'فريقنا يتابع طلبك ويؤكد التفاصيل.']
  ];

  return layout('الرئيسية', `
    <section class="hero">
      <div class="hero-content">
        <h1>خدمات منزلية موثوقة</h1>
        <p class="lead">حلول عملية للصيانة والتنظيف في منزلك.</p>
        <a class="btn btn-primary" href="/services">استعرض خدماتنا</a>
      </div>
      <div class="hero-media">
        ${heroIllustration()}
      </div>
    </section>
    ${cards ? `<section class="section-stack"><h2 class="page-title">خدمات مميزة</h2><div class="card-grid">${cards}</div></section>` : ''}
    <section class="section-stack">
      <h2 class="page-title">كيف نعمل</h2>
      <div class="card-grid">
        ${steps.map(([t, d]) => `<article class="service-card"><h3>${escapeHtml(t)}</h3><p>${escapeHtml(d)}</p></article>`).join('')}
      </div>
    </section>
  `);
}

function servicesPage(services) {
  const activeServices = services.filter(s => s.active);
  const list = activeServices.length
    ? `<div class="card-grid">${activeServices.map(s => serviceCard(s)).join('')}</div>`
    : `<div class="empty-state"><p>لا توجد خدمات متاحة حالياً. يرجى العودة لاحقاً.</p></div>`;

  return layout('الخدمات', `
    <h1 class="page-title">خدماتنا</h1>
    <p class="lead">اختر من الخدمات المنزلية المتاحة.</p>
    ${list}
  `);
}

function serviceCard(s) {
  return `<article class="service-card">
    <span class="category">${escapeHtml(s.category)}</span>
    <h3>${escapeHtml(s.name)}</h3>
    <p>${escapeHtml(s.description)}</p>
    <a class="btn btn-secondary btn-margin-top" href="/contact?service=${s.id}">اطلب الخدمة</a>
  </article>`;
}

function contactPage({ submitted, errors, values, services }) {
  const success = submitted
    ? `<div class="success-banner" role="status" aria-live="polite" tabindex="-1" id="success-banner"><strong>تم استلام طلبك.</strong> شكراً لتواصلك معنا.</div>`
    : '';

  const serviceOptions = services.map(s =>
    `<option value="${s.id}"${String(values.service_id || '') === String(s.id) ? ' selected' : ''}>${escapeHtml(s.name)}</option>`
  ).join('');

  const summary = errorSummary(errors);

  return layout('تواصل معنا', `
    <h1 class="page-title">تواصل معنا</h1>
    <p class="lead">أرسل لنا طلبك وسنحتفظ بالتفاصيل المقدمة.</p>
    ${success}
    ${summary}
    <form method="post" action="/contact" novalidate>
      <div class="form-group">
        <label for="name">الاسم الكامل</label>
        <input id="name" name="name" type="text" value="${escapeHtml(values.name || '')}" aria-describedby="error-name" aria-invalid="${errors.name ? 'true' : 'false'}">
        ${fieldError(errors, 'name')}
      </div>
      <div class="form-group">
        <label for="phone">رقم الموبايل</label>
        <input id="phone" name="phone" type="tel" value="${escapeHtml(values.phoneRaw || values.phone || '')}" aria-describedby="error-phone" aria-invalid="${errors.phone ? 'true' : 'false'}">
        ${fieldError(errors, 'phone')}
      </div>
      <div class="form-group">
        <label for="service_id">الخدمة (اختياري)</label>
        <select id="service_id" name="service_id" aria-describedby="error-service_id" aria-invalid="${errors.service_id ? 'true' : 'false'}">
          <option value="">— اختر خدمة —</option>
          ${serviceOptions}
        </select>
        ${fieldError(errors, 'service_id')}
      </div>
      <div class="form-group">
        <label for="message">الرسالة</label>
        <textarea id="message" name="message" aria-describedby="error-message" aria-invalid="${errors.message ? 'true' : 'false'}">${escapeHtml(values.message || '')}</textarea>
        ${fieldError(errors, 'message')}
      </div>
      <button class="btn btn-primary" type="submit">إرسال الطلب</button>
    </form>
  `);
}

function loginPage({ error }) {
  const banner = error
    ? `<div class="error-summary" role="alert" aria-live="polite">${escapeHtml(error)}</div>`
    : '';

  return layout('تسجيل الدخول', `
    <div class="login-box">
      <h1 class="page-title">تسجيل الدخول</h1>
      <p class="lead">لوحة التحكم التجريبية للمسؤول.</p>
      ${banner}
      <form method="post" action="/admin/login" novalidate>
        <div class="form-group">
          <label for="username">اسم المستخدم</label>
          <input id="username" name="username" type="text" autocomplete="username">
        </div>
        <div class="form-group">
          <label for="password">كلمة المرور</label>
          <input id="password" name="password" type="password" autocomplete="current-password">
        </div>
        <button class="btn btn-primary" type="submit">دخول</button>
      </form>
    </div>
  `, { adminUser: false });
}

function adminPage(services, csrf) {
  const rows = services.map(s => `
    <tr>
      <td data-label="الاسم">${escapeHtml(s.name)}</td>
      <td data-label="التصنيف">${escapeHtml(s.category)}</td>
      <td data-label="الحالة">${s.active ? '<span class="status-active">نشطة</span>' : '<span class="status-inactive">غير نشطة</span>'}</td>
      <td data-label="إجراءات" class="actions">
        <a class="btn btn-secondary" href="/admin/services/${s.id}/edit">تعديل</a>
        <a class="btn btn-danger" href="/admin/services/${s.id}/delete">حذف</a>
      </td>
    </tr>
  `).join('');

  const table = services.length
    ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>الاسم</th><th>التصنيف</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="empty-state"><p>لا توجد خدمات. أضف خدمة جديدة.</p></div>`;

  return layout('لوحة التحكم', `
    <h1 class="page-title">لوحة التحكم</h1>
    <div class="admin-header">
      <p class="lead">إدارة الخدمات</p>
      <div class="actions">
        <a class="btn btn-primary" href="/admin/services/new">خدمة جديدة</a>
        <form method="post" action="/admin/logout" class="inline-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="btn btn-secondary" type="submit">خروج</button></form>
      </div>
    </div>
    ${table}
  `, { adminUser: true });
}

function serviceFormPage({ service, csrf, errors, values }) {
  const isEdit = !!service;
  const v = { ...service, ...values };
  const title = isEdit ? 'تعديل خدمة' : 'خدمة جديدة';
  const action = isEdit ? `/admin/services/${service.id}/edit` : '/admin/services/new';

  const categoryOptions = CATEGORIES.map(c =>
    `<option value="${escapeHtml(c)}"${v.category === c ? ' selected' : ''}>${escapeHtml(c)}</option>`
  ).join('');

  let activeValue;
  if (isEdit) {
    activeValue = String(service.active);
  } else if (values.active !== undefined) {
    activeValue = String(values.active);
  } else {
    activeValue = '1';
  }

  return layout(title, `
    <h1 class="page-title">${title}</h1>
    ${errorSummary(errors)}
    <form method="post" action="${action}" novalidate>
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
      <div class="form-group">
        <label for="name">اسم الخدمة</label>
        <input id="name" name="name" type="text" value="${escapeHtml(v.name || '')}" aria-describedby="error-name" aria-invalid="${errors.name ? 'true' : 'false'}">
        ${fieldError(errors, 'name')}
      </div>
      <div class="form-group">
        <label for="category">التصنيف</label>
        <select id="category" name="category" aria-describedby="error-category" aria-invalid="${errors.category ? 'true' : 'false'}">
          <option value="">— اختر تصنيف —</option>
          ${categoryOptions}
        </select>
        ${fieldError(errors, 'category')}
      </div>
      <div class="form-group">
        <label for="description">الوصف</label>
        <textarea id="description" name="description" aria-describedby="error-description" aria-invalid="${errors.description ? 'true' : 'false'}">${escapeHtml(v.description || '')}</textarea>
        ${fieldError(errors, 'description')}
      </div>
      <fieldset class="form-group">
        <legend>حالة الخدمة</legend>
        <label class="radio-label">
          <input type="radio" name="active" value="1"${activeValue === '1' ? ' checked' : ''}> نشطة
        </label>
        <label class="radio-label radio-label-inline">
          <input type="radio" name="active" value="0"${activeValue === '0' ? ' checked' : ''}> غير نشطة
        </label>
        ${fieldError(errors, 'active')}
      </fieldset>
      <div class="actions">
        <button class="btn btn-primary" type="submit">حفظ</button>
        <a class="btn btn-secondary" href="/admin">إلغاء</a>
      </div>
    </form>
  `, { adminUser: true });
}

function deleteConfirmPage(service, csrf) {
  return layout('تأكيد الحذف', `
    <h1 class="page-title">تأكيد حذف الخدمة</h1>
    <p>هل أنت متأكد من حذف <strong>${escapeHtml(service.name)}</strong>؟</p>
    <form method="post" action="/admin/services/${service.id}/delete" novalidate>
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
      <div class="actions">
        <button class="btn btn-danger" type="submit">نعم، احذف</button>
        <a class="btn btn-secondary" href="/admin">إلغاء</a>
      </div>
    </form>
  `, { adminUser: true });
}

function errorPage(status, message) {
  const title = status === 404 ? 'الصفحة غير موجودة' : 'خطأ في الخادم';
  return layout(title, `
    <h1 class="page-title">${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <a class="btn btn-primary" href="/">العودة للرئيسية</a>
  `);
}

module.exports = {
  layout,
  homePage,
  servicesPage,
  contactPage,
  loginPage,
  adminPage,
  serviceFormPage,
  deleteConfirmPage,
  errorPage,
  errorSummary,
  fieldError
};
