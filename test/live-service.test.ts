import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { TranslationService } from '../src/service.js';
import { ServiceError } from '../src/domain.js';

const contact = { id: '381600000001@s.whatsapp.net', name: 'Марко' };
const request = { contactId: contact.id, text: 'Завтра в 15:00?', idempotencyKey: 'owner-request' };

test('known disconnect before transport dispatch is recorded as not sent', async () => {
  const store = new Store(':memory:');
  try {
    const service = new TranslationService(store, { async translate() { return 'Sutra?'; } }, {
      async send() { throw new ServiceError('WHATSAPP_NOT_CONNECTED', 'Connect first'); },
    }, [contact]);
    const result = await service.send(request);
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'whatsapp_disconnected');
    assert.equal(result.translatedText, 'Sutra?');
    assert.deepEqual(await service.send(request), result);
  } finally { store.close(); }
});

test('outgoing identity is durable before send and early receipts are not downgraded by send completion/error', async () => {
  for (const throws of [false, true]) {
    const store = new Store(':memory:');
    try {
      const service = new TranslationService(store, { async translate() { return 'Sutra u 15:00?'; } }, {
        async send(contactId, _text, remoteId) {
          assert.ok(remoteId);
          assert.equal(store.byRequestKey(request.idempotencyKey)?.remoteId, remoteId);
          assert.equal(store.byRequestKey(request.idempotencyKey)?.status, 'sending');
          assert.equal(store.receipt(contactId, remoteId, 'delivered')?.status, 'delivered');
          assert.equal(store.receipt(contactId, remoteId, 'read')?.status, 'read');
          assert.equal(store.receipt(contactId, remoteId, 'sent')?.status, 'read');
          if (throws) throw new Error('Late transport failure');
          return { messageId: remoteId };
        },
      }, [contact]);
      const result = await service.send(request);
      assert.equal(result.status, 'read');
      assert.equal(result.errorCode, null);
      assert.equal(store.receipt('381600000002@s.whatsapp.net', result.remoteId!, 'read'), null);
      assert.equal(store.receipt(contact.id, 'not-our-message', 'read'), null);
    } finally { store.close(); }
  }
});

test('late receipt reconciles unknown delivery without repeating translation or send', async () => {
  const store = new Store(':memory:');
  try {
    let attempts = 0;
    const service = new TranslationService(store, { async translate() { return 'Sutra?'; } }, {
      async send() { attempts++; throw new Error('Disconnected after acceptance'); },
    }, [contact]);
    const unknown = await service.send(request);
    assert.equal(unknown.status, 'unknown');
    store.receipt(contact.id, unknown.remoteId!, 'delivered');
    const repeated = await service.send(request);
    assert.equal(repeated.status, 'delivered');
    assert.equal(repeated.errorCode, null);
    assert.equal(attempts, 1);
  } finally { store.close(); }
});

test('only failed incoming translations can be retried, concurrently at most once, with no sends', async () => {
  const store = new Store(':memory:');
  try {
    let calls = 0; let finish!: (text: string) => void; let sends = 0;
    const service = new TranslationService(store, { async translate() {
      if (++calls === 1) throw new Error('Quota');
      return new Promise<string>(accept => { finish = accept; });
    } }, { async send() { sends++; return { messageId: 'never' }; } }, [contact]);
    const failed = await service.receive({ id: 'reply-1', contactId: contact.id, text: 'Može.' });
    assert.equal(failed?.status, 'failed');
    const retry = service.retryIncoming(failed!.id);
    await assert.rejects(service.retryIncoming(failed!.id), { code: 'retry_not_allowed' });
    finish('Можно.');
    assert.equal((await retry).status, 'received');
    const outgoing = store.insertOutgoing(contact.id, 'Привет', 'failed-outgoing').message;
    store.setState(outgoing.id, 'failed');
    await assert.rejects(service.retryIncoming(outgoing.id), { code: 'retry_not_allowed' });
    assert.equal(calls, 2); assert.equal(sends, 0);
  } finally { store.close(); }
});

test('legacy database migration preserves messages and idempotency, adds persistent contacts and receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-migration-'));
  const path = join(directory, 'messages.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,direction TEXT NOT NULL,contact_id TEXT NOT NULL,
      original_text TEXT NOT NULL,translated_text TEXT,status TEXT CHECK(status IN ('translating','sending','sent','received','failed','unknown')),
      remote_id TEXT,idempotency_key TEXT UNIQUE,created_at TEXT NOT NULL,error_code TEXT);
      CREATE UNIQUE INDEX incoming_identity ON messages(contact_id,remote_id) WHERE direction='incoming';`);
    old.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)').run('legacy','outgoing',contact.id,'Привет','Zdravo','sent','wa-old','key-old','2026-09-18',null);
    old.close();
    const migrated = new Store(path);
    migrated.saveContact(contact);
    assert.equal(migrated.byRequestKey('key-old')?.originalText, 'Привет');
    assert.equal(migrated.receipt(contact.id, 'wa-old', 'delivered')?.status, 'delivered');
    assert.equal(migrated.insertOutgoing(contact.id, 'Привет', 'key-old').inserted, false);
    migrated.close();
    const reopened = new Store(path);
    assert.deepEqual(reopened.contacts(), [{ ...contact, language: 'sr-Latn' }]);
    assert.equal(reopened.get('legacy')?.status, 'delivered');
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
