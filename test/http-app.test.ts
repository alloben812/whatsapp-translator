import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { createApplication, type ConnectionState } from '../src/http-app.js';
import { Store } from '../src/store.js';
import { TranslationService } from '../src/service.js';

test('owner authentication, origin, CSRF, deterministic contact and idempotent send work together', async t => {
  const web = mkdtempSync(join(tmpdir(), 'wa-http-test-'));
  for (const file of ['index.html', 'app.js', 'styles.css']) writeFileSync(join(web, file), file);
  const store = new Store(':memory:');
  let sends = 0; let ready = true;
  let phase: ConnectionState['phase'] = 'disconnected';
  const connection = {
    state: () => ({ phase, qr: null, account: null, errorCode: null }),
    async connect() { phase = 'connected'; },
    async resolveContact(phone: string) { return { id: `${phone}@s.whatsapp.net` }; },
  };
  const service = new TranslationService(store, { async translate() { return 'Zdravo!'; } }, {
    async send(_contact, _text, messageId) { sends++; return { messageId: messageId! }; },
  }, []);
  const app = createApplication({ store, service, connection, webDirectory: web, origin: 'http://127.0.0.1:8787',
    password: 'private-owner-password', translatorStatus: () => ({ ready, label: 'Test fixture', reason: ready ? null : 'unavailable' }) });
  await new Promise<void>(accept => app.listen(0, '127.0.0.1', accept));
  t.after(async () => { app.closeAllConnections(); await new Promise<void>(accept => app.close(() => accept())); store.close(); rmSync(web, { recursive: true, force: true }); });
  const address = app.address(); assert.ok(address && typeof address === 'object');
  let session = ''; let csrf = '';
  const call = (path: string, data?: unknown, extras: Record<string, string> = {}) => new Promise<Response>((accept, reject) => {
    const req = httpRequest(`http://127.0.0.1:${address.port}${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Host: '127.0.0.1:8787', Cookie: session, ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }), ...extras },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        accept(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers }));
      });
    });
    req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  assert.equal((await call('/api/state')).status, 401);
  assert.equal((await call('/api/login', { password: 'wrong' })).status, 401);
  const login = await call('/api/login', { password: 'private-owner-password' });
  assert.equal(login.status, 200);
  session = login.headers.get('set-cookie')!.split(';')[0]!;
  assert.ok(login.headers.get('set-cookie')!.includes('HttpOnly'));
  const state = await (await call('/api/state')).json(); csrf = state.csrfToken;
  assert.equal((await call('/api/state', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/state', undefined, { Host: 'evil.example' })).status, 403);
  assert.equal((await call('/api/connect', {}, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await call('/api/connect', {})).status, 202);
  assert.equal((await call('/api/contacts', { name: 'Марко', phone: '381600000001', extra: 'no' })).status, 400);
  const contactResponse = await call('/api/contacts', { name: 'Марко', phone: '+381600000001' });
  assert.equal(contactResponse.status, 201);
  const contact = await contactResponse.json();
  const saveContact = store.saveContact.bind(store);
  store.saveContact = () => { throw new Error('Simulated disk failure'); };
  assert.equal((await call('/api/contacts', { name: 'Ана', phone: '+381600000002' })).status, 500);
  store.saveContact = saveContact;
  await assert.rejects(service.send({ contactId: '381600000002@s.whatsapp.net', text: 'Привет', idempotencyKey: 'unsaved' }), { code: 'unknown_contact' });
  const outgoing = { contactId: contact.id, text: 'Привет', idempotencyKey: 'stable-key' };
  const first = await (await call('/api/send', outgoing)).json();
  assert.equal(first.status, 'sent');
  assert.equal(first.translatedText, 'Zdravo!');
  phase = 'disconnected'; ready = false;
  const repeat = await (await call('/api/send', outgoing)).json();
  assert.equal(first.id, repeat.id);
  assert.equal(sends, 1);
  assert.equal((await call('/api/send', { ...outgoing, text: 'Другой текст' })).status, 400);
  assert.equal((await call('/api/send', { ...outgoing, idempotencyKey: 'new-key' })).status, 400);
  assert.equal(store.list().length, 1);
  assert.equal((await call('/api/state')).headers.get('cache-control'), 'no-store');
});
