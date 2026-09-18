import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../src/store.js';

test('discovered WhatsApp metadata persists separately from translation contacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-directory-'));
  const path = join(directory, 'messages.sqlite');
  let store = new Store(path);
  try {
    const id = '381600000001@s.whatsapp.net';
    store.saveDiscoveredChats([
      { id, name: 'Алекс', lastMessageAt: '2026-09-18T12:00:00Z', preview: 'Последний текст' },
      { id: '381600000002@s.whatsapp.net', name: 'Другой контакт', lastMessageAt: '2026-09-17T12:00:00Z' },
      { id: '12345@lid', name: 'Не номер телефона' },
      { id: '12345@g.us', name: 'Группа' },
    ]);
    assert.equal(store.chats().length, 2);
    assert.equal(store.chats()[0]?.id, id);
    assert.equal(store.contacts().length, 0);
    assert.equal(store.list().length, 0);
    store.saveDiscoveredChats([{ id, lastMessageAt: '2026-09-01T10:00:00Z', preview: 'Старая история' }]);
    store.saveDiscoveredChats([{ id, lastMessageAt: '2026-09-18T12:00:00Z' }]);
    store.saveDiscoveredChats([{ id }]);
    assert.equal(store.chats()[0]?.name, 'Алекс');
    assert.equal(store.chats()[0]?.preview, 'Последний текст');
    store.close(); store = new Store(path);
    assert.equal(store.chats()[0]?.translationEnabled, false);
    assert.equal(store.openDiscoveredChat(id).name, 'Алекс');
    store.setContactLanguage(id, 'en');
    store.saveContact({ id, name: 'Моё имя контакта' });
    store.saveDiscoveredChats([{ id, name: 'Имя из WhatsApp' }]);
    assert.equal(store.openDiscoveredChat(id).language, 'en');
    assert.equal(store.chats()[0]?.name, 'Моё имя контакта');
    assert.equal(store.chats()[0]?.translationEnabled, true);
    assert.equal(store.list().length, 0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('discovered chat directory caps new rows globally while updating existing rows', () => {
  const store = new Store(':memory:');
  try {
    const chats = Array.from({ length: 10000 }, (_, index) => {
      const phone = String(381600000000 + index);
      return {
        id: `${phone}@s.whatsapp.net`,
        name: `Контакт ${index}`,
        lastMessageAt: new Date(Date.UTC(2026, 8, 18, 12, 0, index % 60)).toISOString(),
        preview: `Сообщение ${index}`,
      };
    });
    store.saveDiscoveredChats(chats);
    assert.equal(store.chats().length, 10000);

    const existing = chats[1234]!.id;
    const extra = '381699999999@s.whatsapp.net';
    store.saveDiscoveredChats([
      { id: extra, name: 'Лишний чат', lastMessageAt: '2026-09-19T12:00:00Z', preview: 'Не должен сохраниться' },
      { id: existing, name: 'Обновлённый контакт', lastMessageAt: '2026-09-20T12:00:00Z', preview: 'Новое сообщение' },
    ]);

    assert.equal(store.chats().length, 10000);
    assert.throws(() => store.openDiscoveredChat(extra), /Unknown WhatsApp chat/);
    assert.equal(store.openDiscoveredChat(existing).name, 'Обновлённый контакт');
    assert.equal(store.contacts().some(contact => contact.id === existing), true);
  } finally { store.close(); }
});

test('discovered chat directory orders pinned chats before recent unpinned chats', () => {
  const store = new Store(':memory:');
  try {
    const pinned = '381600000101@s.whatsapp.net';
    const latest = '381600000102@s.whatsapp.net';
    const older = '381600000103@s.whatsapp.net';
    store.saveDiscoveredChats([
      {
        id: older,
        name: 'Старый обычный',
        lastMessageAt: '2026-09-16T12:00:00Z',
        preview: 'Старее',
        hasConversation: true,
      },
      {
        id: latest,
        name: 'Новый обычный',
        lastMessageAt: '2026-09-18T12:00:00Z',
        preview: 'Новее',
        hasConversation: true,
      },
      {
        id: pinned,
        name: 'Закреплённый',
        lastMessageAt: '2026-09-10T12:00:00Z',
        preview: 'Старый, но закреплённый',
        pinnedAt: '2026-09-11T09:00:00Z',
        hasConversation: true,
      },
    ]);

    const chats = store.chats();
    assert.equal(chats[0]?.id, pinned);
    assert.equal(chats[0]?.pinnedAt, '2026-09-11T09:00:00.000Z');
    assert.equal(chats[1]?.id, latest);
    assert.equal(chats[2]?.id, older);
  } finally { store.close(); }
});

test('discovered chat directory applies explicit unpin and archive clears without a new timestamp', () => {
  const store = new Store(':memory:');
  try {
    const id = '381600000104@s.whatsapp.net';
    store.saveDiscoveredChats([{
      id,
      name: 'Архив',
      lastMessageAt: '2026-09-18T12:00:00Z',
      preview: 'Предыдущее сообщение',
      pinnedAt: '2026-09-18T13:00:00Z',
      archived: true,
      hasConversation: true,
    }]);
    assert.equal(store.chats()[0]?.pinnedAt, '2026-09-18T13:00:00.000Z');
    assert.equal(store.chats()[0]?.archived, true);

    store.saveDiscoveredChats([{ id, pinnedAt: null, archived: false }]);

    const chat = store.chats().find(entry => entry.id === id);
    assert.equal(chat?.pinnedAt, null);
    assert.equal(chat?.archived, false);
    assert.equal(chat?.lastMessageAt, '2026-09-18T12:00:00.000Z');
    assert.equal(chat?.preview, 'Предыдущее сообщение');
    assert.equal(chat?.hasConversation, true);
  } finally { store.close(); }
});

test('contact-only discovery updates names without erasing conversation state or creating chats', () => {
  const store = new Store(':memory:');
  try {
    const conversation = '381600000105@s.whatsapp.net';
    const contactOnly = '381600000106@s.whatsapp.net';
    store.saveDiscoveredChats([{
      id: conversation,
      name: 'Исходное имя',
      lastMessageAt: '2026-09-18T12:00:00Z',
      preview: 'Живой чат',
      pinnedAt: '2026-09-18T13:00:00Z',
      archived: true,
      hasConversation: true,
    }]);

    store.saveDiscoveredChats([
      { id: conversation, name: 'Имя из адресной книги' },
      { id: contactOnly, name: 'Только контакт' },
    ]);

    const chats = store.chats();
    const updated = chats.find(entry => entry.id === conversation);
    const contact = chats.find(entry => entry.id === contactOnly);
    assert.equal(updated?.name, 'Имя из адресной книги');
    assert.equal(updated?.lastMessageAt, '2026-09-18T12:00:00.000Z');
    assert.equal(updated?.preview, 'Живой чат');
    assert.equal(updated?.pinnedAt, '2026-09-18T13:00:00.000Z');
    assert.equal(updated?.archived, true);
    assert.equal(updated?.hasConversation, true);
    assert.equal(contact?.name, 'Только контакт');
    assert.equal(contact?.lastMessageAt, null);
    assert.equal(contact?.preview, null);
    assert.equal(contact?.pinnedAt, null);
    assert.equal(contact?.archived, null);
    assert.equal(contact?.hasConversation, false);
    assert.ok(chats.findIndex(entry => entry.id === conversation) < chats.findIndex(entry => entry.id === contactOnly));
  } finally { store.close(); }
});

test('chat directory migration preserves old rows and marks only timestamped rows as conversations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-directory-migration-'));
  const path = join(directory, 'messages.sqlite');
  let store: Store | null = null;
  try {
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE discovered_chats (
        id TEXT PRIMARY KEY, name TEXT, last_message_at TEXT, preview TEXT
      );
      INSERT INTO discovered_chats(id,name,last_message_at,preview) VALUES
        ('381600000107@s.whatsapp.net','Исторический чат','2026-09-18T12:00:00.000Z','Старое сообщение'),
        ('381600000108@s.whatsapp.net','Старый контакт',NULL,NULL);
    `);
    database.close();

    store = new Store(path);
    const historical = store.chats().find(entry => entry.id === '381600000107@s.whatsapp.net');
    const contactOnly = store.chats().find(entry => entry.id === '381600000108@s.whatsapp.net');
    assert.equal(historical?.name, 'Исторический чат');
    assert.equal(historical?.lastMessageAt, '2026-09-18T12:00:00.000Z');
    assert.equal(historical?.preview, 'Старое сообщение');
    assert.equal(historical?.hasConversation, true);
    assert.equal(historical?.pinnedAt, null);
    assert.equal(historical?.archived, null);
    assert.equal(contactOnly?.name, 'Старый контакт');
    assert.equal(contactOnly?.lastMessageAt, null);
    assert.equal(contactOnly?.hasConversation, false);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
