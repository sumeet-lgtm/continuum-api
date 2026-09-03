import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireIpRateLimit } from '../../plugins/rateLimit.js';
import { prisma } from '../../lib/prisma.js';
import { verifyUnsubToken } from '../../lib/unsubscribe.js';

function htmlPage(email: string, lists: Array<{ id: string; name: string; description: string | null; subscribed: boolean }>, suppressed: boolean, apiKeyId: string, token: string): string {
  const now = new Date().toISOString();
  const listRows = lists.map(l => `
    <div class="list-row ${!l.subscribed ? 'unsubscribed' : ''}">
      <div class="list-info">
        <div class="list-name">${escHtml(l.name)}</div>
        ${l.description ? `<div class="list-desc">${escHtml(l.description)}</div>` : ''}
      </div>
      <label class="toggle">
        <input type="checkbox" name="keep_${escHtml(l.id)}" value="1" ${l.subscribed && !suppressed ? 'checked' : ''} ${suppressed ? 'disabled' : ''}>
        <span class="track"></span>
      </label>
    </div>`).join('');

  const statusBlock = suppressed
    ? `<div class="status suppressed">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
        This address is globally unsubscribed — no emails will be sent.
      </div>`
    : `<div class="status active">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        Currently receiving emails from <strong>${escHtml(email.split('@')[1] ?? 'this sender')}</strong>.
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Preferences</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #f4f4f5;
      color: #09090b;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
    }
    .card {
      background: #fff;
      border: 1px solid #e4e4e7;
      border-radius: 16px;
      padding: 40px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 1px 4px rgba(0,0,0,.04);
    }
    .wordmark {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: .04em;
      color: #09090b;
      margin-bottom: 32px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .wordmark svg { opacity: 0.7; }
    h1 { font-size: 22px; font-weight: 700; letter-spacing: -.02em; margin-bottom: 4px; }
    .email-chip {
      display: inline-block;
      font-size: 12px;
      font-family: ui-monospace, monospace;
      background: #f4f4f5;
      border: 1px solid #e4e4e7;
      border-radius: 6px;
      padding: 3px 8px;
      color: #52525b;
      margin-bottom: 20px;
    }
    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      padding: 10px 14px;
      border-radius: 8px;
      margin-bottom: 24px;
    }
    .status.active { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
    .status.suppressed { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    .status svg { flex-shrink: 0; }
    .section-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: #a1a1aa;
      margin-bottom: 12px;
    }
    .list-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 0;
      border-bottom: 1px solid #f4f4f5;
    }
    .list-row:last-child { border-bottom: none; }
    .list-row.unsubscribed .list-name { color: #a1a1aa; }
    .list-name { font-size: 14px; font-weight: 500; }
    .list-desc { font-size: 12px; color: #71717a; margin-top: 2px; }
    .toggle { position: relative; display: inline-flex; flex-shrink: 0; cursor: pointer; }
    .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
    .track {
      width: 36px; height: 20px; background: #e4e4e7; border-radius: 10px;
      transition: background .15s;
      display: block;
    }
    .track::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 16px; height: 16px; background: #fff; border-radius: 50%;
      transition: transform .15s;
      box-shadow: 0 1px 2px rgba(0,0,0,.15);
    }
    .toggle input:checked + .track { background: #09090b; }
    .toggle input:checked + .track::after { transform: translateX(16px); }
    .toggle input:disabled + .track { opacity: 0.4; cursor: not-allowed; }
    .no-lists {
      font-size: 13px;
      color: #71717a;
      padding: 16px 0;
      border-top: 1px solid #f4f4f5;
      border-bottom: 1px solid #f4f4f5;
      margin-bottom: 24px;
    }
    .actions {
      margin-top: 28px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 11px 16px;
      font-size: 14px;
      font-weight: 500;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background .15s, border-color .15s;
      text-align: center;
    }
    .btn-primary {
      background: #09090b;
      color: #fff;
    }
    .btn-primary:hover { background: #27272a; }
    .btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-danger {
      background: #fff;
      color: #b91c1c;
      border-color: #fecaca;
    }
    .btn-danger:hover { background: #fef2f2; }
    .btn-danger:disabled { opacity: 0.45; cursor: not-allowed; }
    .divider {
      height: 1px; background: #f4f4f5; margin: 8px 0;
    }
    .note {
      font-size: 11px;
      color: #a1a1aa;
      text-align: center;
      margin-top: 20px;
      line-height: 1.6;
    }
    .success-msg { display: none; }
    .success-msg.show {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      background: #f0fdf4;
      color: #15803d;
      border: 1px solid #bbf7d0;
      padding: 12px 14px;
      border-radius: 8px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
<div class="card">
  <div class="wordmark">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
    Continuum
  </div>

  <h1>Email Preferences</h1>
  <div class="email-chip">${escHtml(email)}</div>
  ${statusBlock}

  ${lists.length > 0 ? `
  <div class="section-label">Mailing lists</div>
  <div id="listRows">${listRows}</div>
  <div class="actions">
    <button class="btn btn-primary" id="saveBtn" onclick="savePrefs()" ${suppressed ? 'disabled' : ''}>Save preferences</button>
    <div class="divider"></div>
    <button class="btn btn-danger" id="unsubAllBtn" onclick="unsubAll()" ${suppressed ? 'disabled' : ''}>
      Unsubscribe from all emails
    </button>
  </div>
  ` : `
  <div class="no-lists">You are not subscribed to any specific mailing lists.</div>
  <div class="actions">
    <button class="btn btn-danger" id="unsubAllBtn" onclick="unsubAll()" ${suppressed ? 'disabled' : ''}>
      ${suppressed ? 'Already unsubscribed' : 'Unsubscribe from all emails'}
    </button>
  </div>
  `}

  <div class="success-msg" id="successMsg">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
    <span id="successText">Preferences saved.</span>
  </div>
  <div class="success-msg" id="errorMsg" style="background:#fef2f2;color:#b91c1c;border-color:#fecaca;">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
    <span id="errorText">Something went wrong. Please try again.</span>
  </div>

  <p class="note">
    Transactional emails (account, security, billing) cannot be unsubscribed.<br>
    To request data deletion, contact the sender.
  </p>
</div>

<script>
const TOKEN = '${escHtml(token)}';

async function post(action, keepListIds) {
  const body = { token: TOKEN, action };
  if (keepListIds) body.keepListIds = keepListIds;
  const res = await fetch('/v1/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

function showSuccess(msg) {
  document.getElementById('errorMsg').classList.remove('show');
  document.getElementById('successText').textContent = msg;
  document.getElementById('successMsg').classList.add('show');
}
function showError(msg) {
  document.getElementById('successMsg').classList.remove('show');
  document.getElementById('errorText').textContent = msg;
  document.getElementById('errorMsg').classList.add('show');
}

async function savePrefs() {
  const btn = document.getElementById('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const checked = [...document.querySelectorAll('#listRows input[type=checkbox]:checked')].map(el => el.name.replace('keep_', ''));
  try {
    const res = await post('update', checked);
    if (res.ok) showSuccess('Preferences saved.');
    else showError('Failed to save. Please try again.');
  } catch { showError('Network error. Please try again.'); }
  btn.disabled = false; btn.textContent = 'Save preferences';
}

async function unsubAll() {
  if (!confirm('Unsubscribe from all marketing emails from this sender?')) return;
  const btn = document.getElementById('unsubAllBtn');
  btn.disabled = true; btn.textContent = 'Processing…';
  try {
    const res = await post('unsubscribe_all');
    if (res.ok) {
      showSuccess('You have been unsubscribed from all emails.');
      document.querySelectorAll('#listRows input[type=checkbox]').forEach(el => { el.checked = false; el.disabled = true; });
      if (document.getElementById('saveBtn')) document.getElementById('saveBtn').disabled = true;
      btn.disabled = true; btn.textContent = 'Unsubscribed';
    } else {
      showError('Failed to unsubscribe. Please try again.');
      btn.disabled = false; btn.textContent = 'Unsubscribe from all emails';
    }
  } catch {
    showError('Network error. Please try again.');
    btn.disabled = false; btn.textContent = 'Unsubscribe from all emails';
  }
}
</script>
</body>
</html>`;
}

function successPage(email: string, action: string): string {
  const isAll = action === 'unsubscribe_all';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isAll ? 'Unsubscribed' : 'Preferences saved'}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #f4f4f5; color: #09090b; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
    .card { background: #fff; border: 1px solid #e4e4e7; border-radius: 16px; padding: 40px; max-width: 480px; width: 100%; text-align: center; }
    .icon { width: 48px; height: 48px; background: #f0fdf4; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: #15803d; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    p { font-size: 14px; color: #71717a; line-height: 1.6; }
    .chip { display: inline-block; font-size: 12px; font-family: ui-monospace, monospace; background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 6px; padding: 3px 8px; color: #52525b; margin: 4px 0 16px; }
  </style>
</head>
<body>
<div class="card">
  <div class="icon">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
  </div>
  <h1>${isAll ? 'Unsubscribed' : 'Preferences saved'}</h1>
  <div class="chip">${escHtml(email)}</div>
  <p>${isAll
    ? 'You have been removed from all mailing lists. You will no longer receive marketing or newsletter emails from this sender.'
    : 'Your email preferences have been updated.'
  }</p>
</div>
</body>
</html>`;
}

function errorPage(msg: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Invalid link</title>
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}body{font-family:sans-serif;background:#f4f4f5;color:#09090b;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;}.card{background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:40px;max-width:480px;width:100%;text-align:center;}.icon{width:48px;height:48px;background:#fef2f2;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;color:#b91c1c;}h1{font-size:20px;font-weight:700;margin-bottom:8px;}p{font-size:14px;color:#71717a;}</style>
</head><body><div class="card"><div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg></div><h1>Invalid link</h1><p>${escHtml(msg)}</p></div></body></html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

export async function preferencesRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /v1/preferences?token= — render HTML preference center
  fastify.get(
    '/preferences',
    { preHandler: [requireIpRateLimit('preferences', 30)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { token } = request.query as { token?: string };
      if (!token) {
        return reply.status(400).header('Content-Type', 'text/html').send(errorPage('This link is missing a required token.'));
      }

      const payload = verifyUnsubToken(token);
      if (!payload) {
        return reply.status(400).header('Content-Type', 'text/html').send(errorPage('This preferences link is invalid or has expired. Please request a new link from the email sender.'));
      }

      const { email, apiKeyId } = payload;

      const [contact, suppression] = await Promise.all([
        prisma.contact.findUnique({
          where: { apiKeyId_email: { apiKeyId, email } },
          include: {
            memberships: {
              include: { list: { select: { id: true, name: true, description: true } } },
            },
          },
        }),
        prisma.suppression.findUnique({ where: { email } }),
      ]);

      const lists = (contact?.memberships ?? []).map(m => ({
        id: m.list.id,
        name: m.list.name,
        description: m.list.description,
        subscribed: m.status === 'subscribed',
      }));

      return reply
        .status(200)
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('X-Frame-Options', 'DENY')
        .send(htmlPage(email, lists, !!suppression, apiKeyId, token));
    },
  );

  // POST /v1/preferences — JSON body from preference center JS fetch()
  fastify.post(
    '/preferences',
    { preHandler: [requireIpRateLimit('preferences', 20)] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as { token?: string; action?: string; keepListIds?: string[] };
      const { token, action = 'update', keepListIds = [] } = body ?? {};

      if (!token) {
        return reply.status(400).send({ error: 'Missing token' });
      }

      const payload = verifyUnsubToken(token);
      if (!payload) {
        return reply.status(400).send({ error: 'Invalid or expired preferences link' });
      }

      const { email, apiKeyId } = payload;

      if (action === 'unsubscribe_all') {
        await prisma.suppression.upsert({
          where: { email },
          create: { email, reason: 'unsubscribed', apiKeyId },
          update: {},
        });
        await prisma.contactListMembership.updateMany({
          where: { contact: { email, apiKeyId }, status: 'subscribed' },
          data: { status: 'unsubscribed', unsubscribedAt: new Date() },
        });
        return reply.status(200).send({ ok: true, action: 'unsubscribe_all' });
      }

      // action === 'update' — save per-list preferences from keepListIds array
      const keepSet = new Set(keepListIds);

      const contact = await prisma.contact.findUnique({
        where: { apiKeyId_email: { apiKeyId, email } },
        include: { memberships: { select: { id: true, listId: true, status: true } } },
      });

      if (contact) {
        for (const m of contact.memberships) {
          const shouldKeep = keepSet.has(m.listId);
          if (shouldKeep && m.status !== 'subscribed') {
            await prisma.contactListMembership.update({
              where: { id: m.id },
              data: { status: 'subscribed', unsubscribedAt: null },
            });
          } else if (!shouldKeep && m.status === 'subscribed') {
            await prisma.contactListMembership.update({
              where: { id: m.id },
              data: { status: 'unsubscribed', unsubscribedAt: new Date() },
            });
          }
        }
      }

      // If all lists unchecked → global suppression
      if (keepSet.size === 0) {
        await prisma.suppression.upsert({
          where: { email },
          create: { email, reason: 'unsubscribed', apiKeyId },
          update: {},
        });
      }

      return reply.status(200).send({ ok: true, action: 'update' });
    },
  );
}
