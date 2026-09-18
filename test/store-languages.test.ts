import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { CONTACT_LANGUAGES, type ContactLanguageCode } from '../src/languages.js';

const contact = { id: '381600000001@s.whatsapp.net', name: 'Марко' };

test('contact language validates the catalog and rename preserves the saved choice', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.saveContact(contact).language, 'sr-Latn');
    for (const language of CONTACT_LANGUAGES) {
      assert.equal(store.setContactLanguage(contact.id, language.code).language, language.code);
    }
    store.setContactLanguage(contact.id, 'sr-Cyrl');
    assert.deepEqual(store.saveContact({ ...contact, name: 'Милан' }), { ...contact, name: 'Милан', language: 'sr-Cyrl' });
    assert.throws(() => store.setContactLanguage(contact.id, 'ru' as ContactLanguageCode), { code: 'invalid_language' });
    assert.throws(() => store.saveContact({ ...contact, language: 'unknown' as ContactLanguageCode }), { code: 'invalid_language' });
    assert.throws(() => store.setContactLanguage('missing', 'en'), { code: 'unknown_contact' });
    assert.equal(store.contacts()[0]?.language, 'sr-Cyrl');
  } finally { store.close(); }
});

test('legacy migration backfills original language once and preserves snapshots through restart, retry and receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-languages-migration-'));
  const path = join(directory, 'messages.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,direction TEXT NOT NULL,contact_id TEXT NOT NULL,"
      + "original_text TEXT NOT NULL,translated_text TEXT,status TEXT CHECK(status IN ('translating','sending','sent','received','failed','unknown')),"
      + "remote_id TEXT,idempotency_key TEXT UNIQUE,created_at TEXT NOT NULL,error_code TEXT);"
      + "CREATE UNIQUE INDEX incoming_identity ON messages(contact_id,remote_id) WHERE direction='incoming';"
      + "CREATE TABLE contacts(id TEXT PRIMARY KEY,name TEXT NOT NULL);");
    old.prepare('INSERT INTO contacts VALUES(?,?)').run(contact.id, contact.name);
    const insert = old.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)');
    insert.run('outgoing-old', 'outgoing', contact.id, 'Привет', 'Zdravo', 'unknown', 'wa-old', 'old-request', '2026-09-18', null);
    insert.run('incoming-old', 'incoming', contact.id, 'Zdravo', null, 'failed', 'incoming-old', null, '2026-09-18', 'translation_failed');
    old.close();
    const migrated = new Store(path);
    assert.equal(migrated.contacts()[0]?.language, 'sr-Latn');
    assert.equal(migrated.get('outgoing-old')?.sourceLanguage, 'ru');
    assert.equal(migrated.get('outgoing-old')?.targetLanguage, 'sr-Latn');
    assert.equal(migrated.get('incoming-old')?.sourceLanguage, 'sr-Latn');
    assert.equal(migrated.get('incoming-old')?.targetLanguage, 'ru');
    migrated.setContactLanguage(contact.id, 'fr');
    const newMessage = migrated.insertOutgoing(contact.id, 'Новый текст', 'new-request',
      { sourceLanguage: 'ru', targetLanguage: 'fr' }).message;
    migrated.setState(newMessage.id, 'sent');
    migrated.close();
    const reopened = new Store(path);
    try {
      assert.equal(reopened.contacts()[0]?.language, 'fr');
      assert.equal(reopened.get(newMessage.id)?.targetLanguage, 'fr');
      const duplicate = reopened.insertOutgoing(contact.id, 'Привет', 'old-request',
        { sourceLanguage: 'ru', targetLanguage: 'fr' });
      assert.equal(duplicate.inserted, false);
      assert.equal(duplicate.message.targetLanguage, 'sr-Latn');
      assert.equal(reopened.receipt(contact.id, 'wa-old', 'delivered')?.targetLanguage, 'sr-Latn');
      assert.equal(reopened.get('incoming-old')?.sourceLanguage, 'sr-Latn');
      assert.equal(reopened.insertIncoming(contact.id, 'Zdravo', 'incoming-old',
        { sourceLanguage: 'fr', targetLanguage: 'ru' }).message.sourceLanguage, 'sr-Latn');
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
