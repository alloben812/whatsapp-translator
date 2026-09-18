import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ServiceError, type Message, type MessageStatus } from './domain.js';

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
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
        contact_id TEXT NOT NULL,
        original_text TEXT NOT NULL,
        translated_text TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'translating', 'sending', 'sent', 'received', 'failed', 'unknown'
        )),
        remote_id TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        error_code TEXT
      );
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

  list(): Message[] {
    const rows = this.database.prepare('SELECT * FROM messages ORDER BY rowid').all() as unknown as MessageRow[];
    return rows.map(fromRow);
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
