import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
