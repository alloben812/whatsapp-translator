import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Translator, Transport } from './domain.js';
import { TranslationService } from './service.js';
import { Store } from './store.js';

const russian = 'Спроси, могу ли я приехать завтра в три.';
const serbian = 'Zdravo, Marko! Da li mogu da dođem sutra u 15 časova?';
const reply = 'Može, vidimo se sutra.';

const translator: Translator = {
  async translate(text, direction) {
    if (direction === 'ru-sr' && text === russian) return serbian;
    if (direction === 'sr-ru' && text === reply) return 'Да, увидимся завтра.';
    throw new Error('DEMO supports only its two fixed example translations.');
  },
};

const transport: Transport = {
  async send() {
    return { messageId: 'DEMO-outgoing-1' };
  },
};

const directory = mkdtempSync(join(tmpdir(), 'whatsapp-translator-demo-'));
let store: Store | undefined;
try {
  console.log('DEMO: fixed translations, simulated WhatsApp, no network or credentials.');
  store = new Store(join(directory, 'demo.sqlite'));
  const contact = { id: '381600000000@s.whatsapp.net', name: 'Марко (DEMO)' };
  const service = new TranslationService(store, translator, transport, [contact]);
  await service.send({ contactId: contact.id, text: russian, idempotencyKey: 'demo-request-1' });
  await service.receive({ id: 'DEMO-incoming-1', contactId: contact.id, text: reply });
  for (const message of service.list()) {
    console.log(JSON.stringify({
      mode: 'DEMO',
      direction: message.direction,
      contact: contact.name,
      original: message.originalText,
      translation: message.translatedText,
      status: message.status,
    }, null, 2));
  }
  console.log('DEMO complete. No messages were sent. The temporary database is removed.');
} finally {
  store?.close();
  rmSync(directory, { recursive: true, force: true });
}
