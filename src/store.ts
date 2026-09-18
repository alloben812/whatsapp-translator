import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ServiceError, type Contact, type Message, type MessageStatus } from './domain.js';

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
      CREATE UNIQUE INDEX IF NOT EXISTS incoming_identity
        ON messages (contact_id, remote_id) WHERE direction = 'incoming';
      UPDATE messages SET status = 'failed', error_code = 'interrupted_translation'
        WHERE status = 'translating';
      UPDATE messages SET status = 'unknown', error_code = 'uncertain_delivery'
        WHERE status = 'sending';
    `);
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
    return this.database.prepare('SELECT id, name FROM contacts ORDER BY name, id').all()
      .map(row => ({ id: String(row.id), name: String(row.name) }));
  }

  saveContact(contact: Contact): Contact {
    this.database.prepare('INSERT INTO contacts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(contact.id, contact.name);
    return contact;
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

  insertOutgoing(contactId: string, text: string, idempotencyKey: string): InsertResult {
    const result = this.database.prepare(`
      INSERT INTO messages (
        id, direction, contact_id, original_text, status, idempotency_key, created_at
      ) VALUES (?, 'outgoing', ?, ?, 'translating', ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(randomUUID(), contactId, text, idempotencyKey, new Date().toISOString());
    const row = this.database.prepare('SELECT * FROM messages WHERE idempotency_key = ?')
      .get(idempotencyKey) as unknown as MessageRow;
    const message = fromRow(row);
    if (message.contactId !== contactId || message.originalText !== text) {
      throw new ServiceError('idempotency_conflict', 'This request key belongs to different message content or contact.');
    }
    return { message, inserted: Number(result.changes) === 1 };
  }

  insertIncoming(contactId: string, text: string, remoteId: string): InsertResult {
    const result = this.database.prepare(`
      INSERT INTO messages (
        id, direction, contact_id, original_text, status, remote_id, created_at
      ) VALUES (?, 'incoming', ?, ?, 'translating', ?, ?)
      ON CONFLICT(contact_id, remote_id) WHERE direction = 'incoming' DO NOTHING
    `).run(randomUUID(), contactId, text, remoteId, new Date().toISOString());
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
