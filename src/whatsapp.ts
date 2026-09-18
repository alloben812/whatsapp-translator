import { chmod, lstat, mkdir } from 'node:fs/promises';
import type { BaileysEventMap, WAMessageKey, WAMessage } from '@whiskeysockets/baileys';
import { isIndividualContactId, ServiceError, type IncomingMessage, type Transport } from './domain.js';

export type WhatsAppState = {
  phase: 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out' | 'error';
  qr: string | null;
  account: string | null;
  errorCode: string | null;
};

type Receipt = { contactId: string; messageId: string; status: 'sent' | 'delivered' | 'read' };
type EventName = 'connection.update' | 'creds.update' | 'messages.upsert' | 'messages.update';

/** Small injectable boundary; tests never load Baileys or open a connection. */
export interface WhatsAppSession {
  on<K extends EventName>(event: K, listener: (value: BaileysEventMap[K]) => void): () => void;
  account(): string | null;
  phoneForLid(lid: string): Promise<string | null>;
  lookup(phone: string): Promise<{ jid: string; exists: boolean }[] | undefined>;
  sendText(contactId: string, text: string, messageId?: string): Promise<string | null>;
  saveCredentials(): Promise<void>;
  stop(): Promise<void>;
}

interface ConnectionOptions {
  authDirectory: string;
  onIncoming: (event: IncomingMessage) => Promise<unknown>;
  onReceipt: (event: Receipt) => void;
  onState?: () => void;
}

export interface WhatsAppDependencies {
  createSession?: (authDirectory: string) => Promise<WhatsAppSession>;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

const MAX_RECONNECTS = 5;
const silentLogger = {
  level: 'silent',
  child: (_bindings: Record<string, unknown>) => silentLogger,
  trace: (_data: unknown, _message?: string) => {},
  debug: (_data: unknown, _message?: string) => {},
  info: (_data: unknown, _message?: string) => {},
  warn: (_data: unknown, _message?: string) => {},
  error: (_data: unknown, _message?: string) => {},
};

async function createBaileysSession(authDirectory: string): Promise<WhatsAppSession> {
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(authDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('INVALID_AUTH_DIRECTORY');
  await chmod(authDirectory, 0o700);
  const { default: makeWASocket, useMultiFileAuthState } = await import('@whiskeysockets/baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authDirectory);
  const socket = makeWASocket({
    auth: state,
    logger: silentLogger,
    browser: ['WhatsApp Translator', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    shouldIgnoreJid: jid => !/^(?:\d+(?::\d+)?@(?:s\.whatsapp\.net|lid))$/.test(jid),
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    enableRecentMessageCache: false,
    enableAutoSessionRecreation: false,
    maxMsgRetryCount: 0,
    getMessage: async () => undefined,
    connectTimeoutMs: 30_000,
    defaultQueryTimeoutMs: 30_000,
  });
  return {
    on(event, listener) {
      socket.ev.on(event, listener);
      return () => { socket.ev.off(event, listener); };
    },
    account: () => canonicalPhoneJid(socket.user?.id) ?? null,
    phoneForLid: lid => socket.signalRepository.lidMapping.getPNForLID(lid),
    lookup: phone => socket.onWhatsApp(phone),
    async sendText(contactId, text, messageId) {
      const result = await socket.sendMessage(contactId, { text, linkPreview: null }, messageId ? { messageId } : {});
      return result?.key.id ?? null;
    },
    saveCredentials: saveCreds,
    stop: () => socket.end(undefined),
  };
}

function canonicalPhoneJid(jid: unknown): string | null {
  if (typeof jid !== 'string') return null;
  const match = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  return match ? `${match[1]}@s.whatsapp.net` : null;
}

/** Only protocol-provided phone numbers or the library's persisted LID map count. */
export async function resolveMessageContact(
  key: WAMessageKey,
  phoneForLid: (lid: string) => Promise<string | null>,
): Promise<string | null> {
  const phone = canonicalPhoneJid(key.remoteJid);
  if (phone) return phone;
  if (!key.remoteJid || !/^\d+(?::\d+)?@lid$/.test(key.remoteJid)) return null;
  const lid = key.remoteJid.replace(/:\d+@/, '@');
  const mapped = canonicalPhoneJid(await phoneForLid(lid));
  const alternate = canonicalPhoneJid(key.remoteJidAlt);
  if (mapped && alternate && mapped !== alternate) return null;
  return mapped ?? alternate;
}

/** Wrappers, media captions, edits, reactions and protocol messages are excluded. */
export function incomingPlainText(message: WAMessage): string | null {
  if (message.key.fromMe || !message.key.id || !message.message || message.messageStubType != null) return null;
  const content = message.message;
  const keys = Object.keys(content).filter(key => content[key as keyof typeof content] != null);
  if (keys.some(key => !['conversation', 'extendedTextMessage', 'messageContextInfo'].includes(key))) return null;
  if (content.conversation != null && content.extendedTextMessage != null) return null;
  const text = content.conversation ?? content.extendedTextMessage?.text;
  return typeof text === 'string' && text.trim().length > 0 ? text : null;
}

function disconnectCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('output' in error)) return null;
  const output = error.output;
  if (typeof output !== 'object' || output === null || !('statusCode' in output)) return null;
  return typeof output.statusCode === 'number' ? output.statusCode : null;
}

export class WhatsAppConnection implements Transport {
  private current: WhatsAppState = { phase: 'disconnected', qr: null, account: null, errorCode: null };
  private session: WhatsAppSession | null = null;
  private listeners: (() => void)[] = [];
  private cancelReconnect: (() => void) | null = null;
  private generation = 0;
  private reconnects = 0;
  private enabled = false;
  private opening: Promise<void> | null = null;
  private credentialsWork: Promise<void> = Promise.resolve();
  private incomingWork: Promise<void> = Promise.resolve();
  private receiptsWork: Promise<void> = Promise.resolve();
  private readonly createSession: (authDirectory: string) => Promise<WhatsAppSession>;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;

  constructor(private readonly options: ConnectionOptions, dependencies: WhatsAppDependencies = {}) {
    this.createSession = dependencies.createSession ?? createBaileysSession;
    this.schedule = dependencies.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
  }

  state(): WhatsAppState { return { ...this.current }; }

  async connect(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.enabled && (this.session || this.cancelReconnect)) return;
    this.enabled = true;
    this.reconnects = 0;
    this.generation += 1;
    await this.openSession(this.generation);
  }

  async close(): Promise<void> {
    this.enabled = false;
    this.generation += 1;
    this.cancelReconnect?.();
    this.cancelReconnect = null;
    const session = this.detachSession();
    this.update({ phase: 'disconnected', qr: null, account: null, errorCode: null });
    await Promise.all([session?.stop().catch(() => {}), this.opening]);
    await Promise.all([this.credentialsWork, this.incomingWork, this.receiptsWork]);
  }

  async resolveContact(phone: string): Promise<{ id: string; name?: string } | null> {
    if (typeof phone !== 'string') throw new ServiceError('INVALID_PHONE', 'Use an international phone number.');
    const normalized = phone.replace(/[\s()-]/g, '');
    if (!/^\+?[1-9]\d{6,14}$/.test(normalized)) throw new ServiceError('INVALID_PHONE', 'Use an international phone number.');
    const session = this.connectedSession();
    try {
      const results = await session.lookup(normalized);
      if (this.session !== session || this.current.phase !== 'connected') throw new Error('DISCONNECTED');
      const found = results?.filter(item => item.exists && canonicalPhoneJid(item.jid));
      if (!found?.length) return null;
      if (found.length !== 1) throw new Error('AMBIGUOUS_CONTACT');
      return { id: canonicalPhoneJid(found[0]!.jid)! };
    } catch {
      throw new ServiceError('WHATSAPP_CONTACT_LOOKUP_FAILED', 'Could not verify this WhatsApp contact.');
    }
  }

  async send(contactId: string, text: string, messageId?: string): Promise<{ messageId: string }> {
    if (!isIndividualContactId(contactId) || typeof text !== 'string' || !text.trim()) {
      throw new ServiceError('INVALID_WHATSAPP_MESSAGE', 'A selected individual contact and text are required.');
    }
    if (messageId !== undefined && !/^[A-Za-z0-9_-]{10,128}$/.test(messageId)) {
      throw new ServiceError('INVALID_WHATSAPP_MESSAGE_ID', 'Invalid persisted message identity.');
    }
    const session = this.connectedSession();
    try {
      const returnedId = await session.sendText(contactId, text, messageId);
      if (!returnedId || (messageId !== undefined && returnedId !== messageId)) throw new Error('MESSAGE_ID_MISMATCH');
      return { messageId: returnedId };
    } catch {
      // The application preserves its identity and marks delivery unknown; never retry here.
      throw new ServiceError('WHATSAPP_SEND_UNCERTAIN', 'The result of this send is uncertain.');
    }
  }

  private connectedSession(): WhatsAppSession {
    if (!this.session || this.current.phase !== 'connected') throw new ServiceError('WHATSAPP_NOT_CONNECTED', 'Connect WhatsApp first.');
    return this.session;
  }

  private update(patch: Partial<WhatsAppState>): void {
    this.current = { ...this.current, ...patch };
    try { this.options.onState?.(); } catch { /* UI notification must not break the connection. */ }
  }

  private detachSession(): WhatsAppSession | null {
    for (const unsubscribe of this.listeners) unsubscribe();
    this.listeners = [];
    const session = this.session;
    this.session = null;
    return session;
  }

  private async openSession(generation: number): Promise<void> {
    if (!this.enabled || generation !== this.generation) return;
    this.update({ phase: 'connecting', qr: null, errorCode: null });
    const opening = (async () => {
      try {
        await this.credentialsWork;
        if (!this.enabled || generation !== this.generation) return;
        const session = await this.createSession(this.options.authDirectory);
        if (!this.enabled || generation !== this.generation) { await session.stop(); return; }
        this.session = session;
        const active = () => this.enabled && this.session === session && generation === this.generation;
        this.listeners = [
          session.on('connection.update', value => {
            if (!active()) return;
            if (value.qr) this.update({ phase: 'qr', qr: value.qr, errorCode: null });
            if (value.connection === 'open') this.update({ phase: 'connected', qr: null, account: session.account(), errorCode: null });
            if (value.connection === 'close') this.disconnected(disconnectCode(value.lastDisconnect?.error), generation);
          }),
          session.on('creds.update', () => {
            if (!active()) return;
            this.credentialsWork = this.credentialsWork.then(() => session.saveCredentials()).catch(() => {
              // A pairing restart can close the socket while this write is still
              // pending. Failure must cancel that reconnect as well.
              if (!this.enabled || generation !== this.generation) return;
              this.enabled = false;
              this.cancelReconnect?.();
              this.cancelReconnect = null;
              const activeSession = this.detachSession();
              this.update({ phase: 'error', qr: null, errorCode: 'WHATSAPP_AUTH_SAVE_FAILED' });
              void (activeSession ?? session).stop().catch(() => {});
            });
          }),
          session.on('messages.upsert', event => {
            if (!active() || event.type !== 'notify' || event.requestId) return;
            for (const message of event.messages) {
              const text = incomingPlainText(message);
              if (text === null) continue;
              this.incomingWork = this.incomingWork.then(async () => {
                if (!active()) return;
                const contactId = await resolveMessageContact(message.key, lid => session.phoneForLid(lid));
                if (contactId && active()) await this.options.onIncoming({ id: message.key.id!, contactId, text, fromMe: false, isHistory: false });
              }).catch(() => {
                if (active()) this.update({ errorCode: 'WHATSAPP_INCOMING_PROCESSING_FAILED' });
              });
            }
          }),
          session.on('messages.update', events => {
            if (!active()) return;
            for (const event of events) {
              const status = event.update.status;
              if (!event.key.fromMe || !event.key.id || ![2, 3, 4, 5].includes(status ?? -1)) continue;
              this.receiptsWork = this.receiptsWork.then(async () => {
                if (!active()) return;
                const contactId = await resolveMessageContact(event.key, lid => session.phoneForLid(lid));
                if (contactId && active()) this.options.onReceipt({ contactId, messageId: event.key.id!, status: status! >= 4 ? 'read' : status === 3 ? 'delivered' : 'sent' });
              }).catch(() => {
                if (active()) this.update({ errorCode: 'WHATSAPP_RECEIPT_PROCESSING_FAILED' });
              });
            }
          }),
        ];
      } catch {
        if (this.enabled && generation === this.generation) {
          this.enabled = false;
          this.update({ phase: 'error', qr: null, errorCode: 'WHATSAPP_CONNECT_FAILED' });
        }
      }
    })();
    this.opening = opening;
    try { await opening; } finally { if (this.opening === opening) this.opening = null; }
  }

  private disconnected(code: number | null, generation: number): void {
    const session = this.detachSession();
    void session?.stop().catch(() => {});
    if (code === 401) {
      this.enabled = false;
      this.update({ phase: 'logged_out', qr: null, account: null, errorCode: 'WHATSAPP_LOGGED_OUT' });
      return;
    }
    if ([403, 411, 440, 500].includes(code ?? -1)) {
      this.enabled = false;
      this.update({ phase: 'error', qr: null, errorCode: code === 440 ? 'WHATSAPP_CONNECTION_REPLACED' : 'WHATSAPP_SESSION_REJECTED' });
      return;
    }
    if (this.reconnects >= MAX_RECONNECTS) {
      this.enabled = false;
      this.update({ phase: 'error', qr: null, errorCode: 'WHATSAPP_RECONNECT_LIMIT' });
      return;
    }
    const delayMs = code === 515 ? 0 : Math.min(30_000, 1_000 * 2 ** this.reconnects);
    this.reconnects += 1;
    this.update({ phase: 'connecting', qr: null, errorCode: 'WHATSAPP_RECONNECTING' });
    this.cancelReconnect = this.schedule(() => {
      this.cancelReconnect = null;
      void this.openSession(generation);
    }, delayMs);
  }
}
