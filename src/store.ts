import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isIndividualContactId, ServiceError, type Contact, type Message, type MessageStatus, type DiscoveredChat, type ChatListEntry } from './domain.js';
import {
  DEFAULT_CONTACT_LANGUAGE, isContactLanguage, isTranslationLanguages, translationLanguages,
  type ContactLanguageCode, type LanguageCode, type TranslationLanguages,
} from './languages.js';

interface MessageRow {
  id: string;
  direction: Message['direction'];
  contact_id: string;
  original_text: string;
  translated_text: string | null;
  status: MessageStatus;
  remote_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  error_code: string | null;
  source_language: LanguageCode;
  target_language: LanguageCode;
}

interface InsertResult {
  message: Message;
  inserted: boolean;
}

type StatePatch = Partial<Pick<Message, 'translatedText' | 'remoteId' | 'errorCode'>>;

function fromRow(row: MessageRow): Message {
  return {
    id: row.id,
    direction: row.direction,
    contactId: row.contact_id,
    originalText: row.original_text,
    translatedText: row.translated_text,
    status: row.status,
    remoteId: row.remote_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    errorCode: row.error_code,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
  };
}

/** One open Store / TranslationService per database; startup recovery assumes this. */
export class Store {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    const schema = `
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
        contact_id TEXT NOT NULL,
        original_text TEXT NOT NULL,
        translated_text TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'translating', 'sending', 'sent', 'delivered', 'read', 'received', 'failed', 'unknown'
        )),
        remote_id TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        error_code TEXT
      );`;
    const existing = this.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get();
    if (existing && !String(existing.sql).includes("'delivered'")) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.exec('ALTER TABLE messages RENAME TO messages_legacy');
        this.database.exec(schema);
        this.database.exec('INSERT INTO messages SELECT * FROM messages_legacy; DROP TABLE messages_legacy; COMMIT;');
      } catch (error) { this.database.exec('ROLLBACK'); this.database.close(); throw error; }
    } else this.database.exec(schema);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discovered_chats (
        id TEXT PRIMARY KEY, name TEXT, last_message_at TEXT, preview TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS incoming_identity
        ON messages (contact_id, remote_id) WHERE direction = 'incoming';
      UPDATE messages SET status = 'failed', error_code = 'interrupted_translation'
        WHERE status = 'translating';
      UPDATE messages SET status = 'unknown', error_code = 'uncertain_delivery'
        WHERE status = 'sending';
    `);
    this.migrateLanguages();
  }

  private migrateLanguages(): void {
    // Assign original Serbian defaults only to rows that predate this feature.
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const contactColumns = this.database.prepare('PRAGMA table_info(contacts)').all().map(row => row.name);
      if (!contactColumns.includes('language')) {
        this.database.exec("ALTER TABLE contacts ADD COLUMN language TEXT NOT NULL DEFAULT 'sr-Latn'");
      }
      const messageColumns = this.database.prepare('PRAGMA table_info(messages)').all().map(row => row.name);
      if (!messageColumns.includes('source_language')) {
        this.database.exec("ALTER TABLE messages ADD COLUMN source_language TEXT NOT NULL DEFAULT 'ru'");
        this.database.exec("UPDATE messages SET source_language='sr-Latn' WHERE direction='incoming'");
      }
      if (!messageColumns.includes('target_language')) {
        this.database.exec("ALTER TABLE messages ADD COLUMN target_language TEXT NOT NULL DEFAULT 'sr-Latn'");
        this.database.exec("UPDATE messages SET target_language='ru' WHERE direction='incoming'");
      }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); this.database.close(); throw error; }
  }

  close(): void {
    this.database.close();
  }

  list(limit = 500): Message[] {
    const rows = this.database.prepare('SELECT * FROM (SELECT rowid AS sequence, * FROM messages ORDER BY rowid DESC LIMIT ?) ORDER BY sequence')
      .all(limit) as unknown as MessageRow[];
    return rows.map(fromRow);
  }

  contacts(): Contact[] {
    return this.database.prepare('SELECT id, name, language FROM contacts ORDER BY name, id').all()
      .map(row => ({ id: String(row.id), name: String(row.name), language: String(row.language) as ContactLanguageCode }));
  }

  saveDiscoveredChats(chats: DiscoveredChat[]): void {
    const save = this.database.prepare(`INSERT INTO discovered_chats(id,name,last_message_at,preview) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=COALESCE(excluded.name,discovered_chats.name),
        preview=CASE WHEN excluded.last_message_at IS NOT NULL AND
          (discovered_chats.last_message_at IS NULL OR excluded.last_message_at>=discovered_chats.last_message_at)
          THEN excluded.preview ELSE discovered_chats.preview END,
        last_message_at=CASE WHEN excluded.last_message_at IS NOT NULL AND
          (discovered_chats.last_message_at IS NULL OR excluded.last_message_at>=discovered_chats.last_message_at)
          THEN excluded.last_message_at ELSE discovered_chats.last_message_at END`);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const chat of chats.slice(0, 10000)) {
        if (!isIndividualContactId(chat.id)) continue;
        const name = typeof chat.name === 'string' && chat.name.trim() ? chat.name.trim().slice(0, 120) : null;
        const timestamp = chat.lastMessageAt && Number.isFinite(Date.parse(chat.lastMessageAt))
          ? new Date(chat.lastMessageAt).toISOString() : null;
        const preview = timestamp && typeof chat.preview === 'string' ? chat.preview.slice(0, 240) : null;
        save.run(chat.id, name, timestamp, preview);
      }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  chats(): ChatListEntry[] {
    const rows = this.database.prepare(`
      SELECT all_ids.id, COALESCE(c.name,d.name) AS name, COALESCE(c.language,'sr-Latn') AS language,
        c.id IS NOT NULL AS enabled, d.last_message_at, d.preview
      FROM (SELECT id FROM contacts UNION SELECT id FROM discovered_chats) all_ids
      LEFT JOIN contacts c ON c.id=all_ids.id LEFT JOIN discovered_chats d ON d.id=all_ids.id
      ORDER BY d.last_message_at DESC, name COLLATE NOCASE, all_ids.id LIMIT 10000
    `).all();
    return rows.map(row => ({
      id: String(row.id), name: row.name === null ? '+' + String(row.id).split('@')[0] : String(row.name),
      language: String(row.language) as ContactLanguageCode, translationEnabled: Boolean(row.enabled),
      lastMessageAt: row.last_message_at === null ? null : String(row.last_message_at),
      preview: row.preview === null ? null : String(row.preview),
    }));
  }

  openDiscoveredChat(contactId: string): Contact {
    const existing = this.contacts().find(contact => contact.id === contactId);
    if (existing) return existing;
    const chat = this.database.prepare('SELECT name FROM discovered_chats WHERE id=?').get(contactId);
    if (!chat || !isIndividualContactId(contactId)) throw new ServiceError('unknown_contact', 'Unknown WhatsApp chat.');
    return this.saveContact({ id: contactId, name: chat.name ? String(chat.name) : '+' + contactId.split('@')[0] });
  }

  saveContact(contact: Contact): Contact {
    const existing = this.database.prepare('SELECT language FROM contacts WHERE id=?').get(contact.id);
    const language = contact.language ?? existing?.language ?? DEFAULT_CONTACT_LANGUAGE;
    if (!isContactLanguage(language)) throw new ServiceError('invalid_language', 'Unsupported contact language.');
    this.database.prepare('INSERT INTO contacts(id,name,language) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, language=excluded.language')
      .run(contact.id, contact.name, language);
    return { ...contact, language };
  }

  setContactLanguage(contactId: string, language: ContactLanguageCode): Contact {
    if (!isContactLanguage(language)) throw new ServiceError('invalid_language', 'Unsupported contact language.');
    const result = this.database.prepare('UPDATE contacts SET language=? WHERE id=?').run(language, contactId);
    if (!result.changes) throw new ServiceError('unknown_contact', 'The selected contact is not allowed.');
    const row = this.database.prepare('SELECT id, name FROM contacts WHERE id=?').get(contactId)!;
    return { id: String(row.id), name: String(row.name), language };
  }

  byRequestKey(key: string): Message | undefined {
    const row = this.database.prepare('SELECT * FROM messages WHERE idempotency_key=?').get(key) as unknown as MessageRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  receipt(contactId: string, remoteId: string, status: 'sent' | 'delivered' | 'read'): Message | null {
    const row = this.database.prepare("SELECT * FROM messages WHERE direction='outgoing' AND contact_id=? AND remote_id=?")
      .get(contactId, remoteId) as unknown as MessageRow | undefined;
    if (!row || !['sending', 'unknown', 'sent', 'delivered', 'read'].includes(row.status)) return null;
    const rank = { sending: 0, unknown: 0, sent: 1, delivered: 2, read: 3 };
    if (rank[status] <= rank[row.status as keyof typeof rank]) return fromRow(row);
    return this.setState(row.id, status, { errorCode: null });
  }

  get(id: string): Message | undefined {
    const row = this.database.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  insertOutgoing(
    contactId: string, text: string, idempotencyKey: string,
    languages: TranslationLanguages = translationLanguages('outgoing'),
  ): InsertResult {
    if (!isTranslationLanguages(languages) || languages.sourceLanguage !== 'ru') {
      throw new ServiceError('invalid_language', 'Invalid outgoing translation languages.');
    }
    const result = this.database.prepare(`
      INSERT INTO messages (
        id, direction, contact_id, original_text, status, idempotency_key, created_at, source_language, target_language
      ) VALUES (?, 'outgoing', ?, ?, 'translating', ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(randomUUID(), contactId, text, idempotencyKey, new Date().toISOString(), languages.sourceLanguage, languages.targetLanguage);
    const row = this.database.prepare('SELECT * FROM messages WHERE idempotency_key = ?')
      .get(idempotencyKey) as unknown as MessageRow;
    const message = fromRow(row);
    if (message.contactId !== contactId || message.originalText !== text) {
      throw new ServiceError('idempotency_conflict', 'This request key belongs to different message content or contact.');
    }
    return { message, inserted: Number(result.changes) === 1 };
  }

  insertIncoming(
    contactId: string, text: string, remoteId: string,
    languages: TranslationLanguages = translationLanguages('incoming'),
  ): InsertResult {
    if (!isTranslationLanguages(languages) || languages.targetLanguage !== 'ru') {
      throw new ServiceError('invalid_language', 'Invalid incoming translation languages.');
    }
    const result = this.database.prepare(`
      INSERT INTO messages (
        id, direction, contact_id, original_text, status, remote_id, created_at, source_language, target_language
      ) VALUES (?, 'incoming', ?, ?, 'translating', ?, ?, ?, ?)
      ON CONFLICT(contact_id, remote_id) WHERE direction = 'incoming' DO NOTHING
    `).run(randomUUID(), contactId, text, remoteId, new Date().toISOString(), languages.sourceLanguage, languages.targetLanguage);
    const row = this.database.prepare(`
      SELECT * FROM messages WHERE direction = 'incoming' AND contact_id = ? AND remote_id = ?
    `).get(contactId, remoteId) as unknown as MessageRow;
    return { message: fromRow(row), inserted: Number(result.changes) === 1 };
  }

  setState(id: string, status: MessageStatus, patch: StatePatch = {}): Message {
    const current = this.get(id);
    if (!current) throw new Error('Message does not exist.');
    const next: Message = { ...current, ...patch, status };
    this.database.prepare(`
      UPDATE messages SET status = ?, translated_text = ?, remote_id = ?, error_code = ?
      WHERE id = ?
    `).run(next.status, next.translatedText, next.remoteId, next.errorCode, id);
    return next;
  }
}
