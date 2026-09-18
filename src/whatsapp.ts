import { chmod, lstat, mkdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { BaileysEventMap, Chat, Contact as BaileysContact, WAMessageKey, WAMessage } from '@whiskeysockets/baileys';
import { isIndividualContactId, ServiceError, type DiscoveredChat, type IncomingMessage, type Transport } from './domain.js';

export type WhatsAppState = {
  phase: 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out' | 'error';
  qr: string | null;
  account: string | null;
  errorCode: string | null;
};

type Receipt = { contactId: string; messageId: string; status: 'sent' | 'delivered' | 'read' };
type SendTextResult = string | { messageId: string; timestamp?: unknown } | null;
type EventName =
  | 'connection.update'
  | 'creds.update'
  | 'messages.upsert'
  | 'messages.update'
  | 'messaging-history.set'
  | 'chats.upsert'
  | 'chats.update'
  | 'contacts.upsert'
  | 'contacts.update';

/** Small injectable boundary; tests never load Baileys or open a connection. */
export interface WhatsAppSession {
  on<K extends EventName>(event: K, listener: (value: BaileysEventMap[K]) => void): () => void;
  account(): string | null;
  phoneForLid(lid: string): Promise<string | null>;
  lookup(phone: string): Promise<{ jid: string; exists: boolean }[] | undefined>;
  sendText(contactId: string, text: string, messageId?: string): Promise<SendTextResult>;
  syncContacts?(): Promise<void>;
  saveCredentials(): Promise<void>;
  stop(): Promise<void>;
}

interface ConnectionOptions {
  authDirectory: string;
  onIncoming: (event: IncomingMessage) => Promise<unknown>;
  onReceipt: (event: Receipt) => void;
  onChats?: (chats: DiscoveredChat[]) => void;
  onState?: () => void;
}

export interface WhatsAppDependencies {
  createSession?: (authDirectory: string) => Promise<WhatsAppSession>;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

const MAX_RECONNECTS = 5;
const CONTACT_SYNC_TIMEOUT_MS = 35_000;
const APP_STATE_COLLECTIONS = ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'] as const;
const DIRECTORY_HISTORY_SYNC_TYPES = new Set([0, 3, 4]);
const SESSION_EVENT_NAMES: EventName[] = [
  'connection.update',
  'creds.update',
  'messages.upsert',
  'messages.update',
  'messaging-history.set',
  'chats.upsert',
  'chats.update',
  'contacts.upsert',
  'contacts.update',
];
const silentLogger = {
  level: 'silent',
  child: (_bindings: Record<string, unknown>) => silentLogger,
  trace: (_data: unknown, _message?: string) => {},
  debug: (_data: unknown, _message?: string) => {},
  info: (_data: unknown, _message?: string) => {},
  warn: (_data: unknown, _message?: string) => {},
  error: (_data: unknown, _message?: string) => {},
};

export function shouldSyncDirectoryHistoryMessage(message: { syncType?: number | null }): boolean {
  return typeof message.syncType === 'number' && DIRECTORY_HISTORY_SYNC_TYPES.has(message.syncType);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('WHATSAPP_CONTACT_SYNC_TIMEOUT')), timeoutMs);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function waitForAppStateKey(
  socket: {
    authState: { creds: { myAppStateKeyId?: string | null } };
    ev: {
      on(event: 'creds.update', listener: (value: { myAppStateKeyId?: string | null }) => void): void;
      off(event: 'creds.update', listener: (value: { myAppStateKeyId?: string | null }) => void): void;
    };
  },
  timeoutMs: number,
): Promise<void> {
  if (socket.authState.creds.myAppStateKeyId) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.ev.off('creds.update', onCredentials);
      reject(new Error('WHATSAPP_APP_STATE_KEY_UNAVAILABLE'));
    }, timeoutMs);
    timer.unref();
    const finish = () => {
      clearTimeout(timer);
      socket.ev.off('creds.update', onCredentials);
      resolve();
    };
    const onCredentials = (value: { myAppStateKeyId?: string | null }) => {
      if (value.myAppStateKeyId || socket.authState.creds.myAppStateKeyId) finish();
    };
    socket.ev.on('creds.update', onCredentials);
  });
}

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
    shouldSyncHistoryMessage: shouldSyncDirectoryHistoryMessage,
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
  const events = new EventEmitter();
  const pending = new Map<EventName, unknown[]>();
  const listenerCounts = new Map<EventName, number>();
  for (const eventName of SESSION_EVENT_NAMES) {
    socket.ev.on(eventName, value => {
      if ((listenerCounts.get(eventName) ?? 0) === 0) {
        const queue = pending.get(eventName) ?? [];
        queue.push(value);
        if (queue.length > 50) queue.shift();
        pending.set(eventName, queue);
      } else {
        events.emit(eventName, value);
      }
    });
  }
  return {
    on(event, listener) {
      const wrapped = listener as (value: unknown) => void;
      listenerCounts.set(event, (listenerCounts.get(event) ?? 0) + 1);
      events.on(event, wrapped);
      for (const value of pending.get(event) ?? []) wrapped(value);
      pending.delete(event);
      return () => {
        events.off(event, wrapped);
        listenerCounts.set(event, Math.max(0, (listenerCounts.get(event) ?? 1) - 1));
      };
    },
    account: () => canonicalPhoneJid(socket.user?.id) ?? null,
    phoneForLid: lid => socket.signalRepository.lidMapping.getPNForLID(lid),
    lookup: phone => socket.onWhatsApp(phone),
    async sendText(contactId, text, messageId) {
      const result = await socket.sendMessage(contactId, { text, linkPreview: null }, messageId ? { messageId } : {});
      return result?.key.id ? { messageId: result.key.id, timestamp: result.messageTimestamp } : null;
    },
    syncContacts: async () => {
      const startedAt = Date.now();
      await waitForAppStateKey(socket, CONTACT_SYNC_TIMEOUT_MS);
      const remainingMs = Math.max(1, CONTACT_SYNC_TIMEOUT_MS - (Date.now() - startedAt));
      await withTimeout(socket.resyncAppState(APP_STATE_COLLECTIONS, true), remainingMs);
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

function canonicalLidJid(jid: unknown): string | null {
  if (typeof jid !== 'string') return null;
  const match = /^(\d+)(?::\d+)?@lid$/.exec(jid);
  return match ? `${match[1]}@lid` : null;
}

async function phoneForDirectJid(
  jid: unknown,
  protocolPhone: unknown,
  phoneForLid: (lid: string) => Promise<string | null>,
): Promise<string | null> {
  const phone = canonicalPhoneJid(jid);
  if (phone) return phone;
  const lid = canonicalLidJid(jid);
  if (!lid) return jid == null ? canonicalPhoneJid(protocolPhone) : null;
  const mapped = canonicalPhoneJid(await phoneForLid(lid));
  const alternate = canonicalPhoneJid(protocolPhone);
  if (mapped && alternate && mapped !== alternate) return null;
  return mapped ?? alternate;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object' && value !== null && 'toNumber' in value && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    const converted = (value as { toNumber: () => unknown }).toNumber();
    return typeof converted === 'number' && Number.isFinite(converted) ? converted : null;
  }
  return null;
}

const MAX_DATE_MILLIS = 8_640_000_000_000_000;

function timestampMillis(value: unknown): number | null {
  const timestamp = numberValue(value);
  if (timestamp === null || timestamp <= 0) return null;
  const millis = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  return Number.isFinite(millis) && millis > 0 && millis <= MAX_DATE_MILLIS ? millis : null;
}

function isoTimestamp(value: unknown): string | undefined {
  const millis = timestampMillis(value);
  if (millis === null) return undefined;
  return new Date(millis).toISOString();
}

function directoryMessageContent(message: WAMessage): NonNullable<WAMessage['message']> | undefined {
  let content = message.message;
  for (let depth = 0; depth < 3 && content; depth += 1) {
    if (content.ephemeralMessage?.message) { content = content.ephemeralMessage.message; continue; }
    if (content.viewOnceMessage?.message) { content = content.viewOnceMessage.message; continue; }
    if (content.viewOnceMessageV2?.message) { content = content.viewOnceMessageV2.message; continue; }
    if (content.viewOnceMessageV2Extension?.message) { content = content.viewOnceMessageV2Extension.message; continue; }
    break;
  }
  return content ?? undefined;
}

function messagePreview(message: WAMessage): string | undefined {
  const content = directoryMessageContent(message);
  if (!content) return undefined;
  return nonEmptyString(content.conversation)
    ?? nonEmptyString(content.extendedTextMessage?.text)
    ?? nonEmptyString(content.imageMessage?.caption)
    ?? nonEmptyString(content.videoMessage?.caption)
    ?? nonEmptyString(content.documentMessage?.caption)
    ?? (content.audioMessage ? 'Голосовое сообщение' : undefined)
    ?? (content.imageMessage ? 'Фото' : undefined)
    ?? (content.videoMessage ? 'Видео' : undefined)
    ?? (content.stickerMessage ? 'Стикер' : undefined)
    ?? (content.documentMessage ? 'Документ' : undefined)
    ?? (content.contactMessage || content.contactsArrayMessage ? 'Контакт' : undefined)
    ?? (content.locationMessage || content.liveLocationMessage ? 'Локация' : undefined);
}

function discoveredChat(fields: {
  id: string;
  name?: string | undefined;
  lastMessageAt?: string | undefined;
  preview?: string | undefined;
  pinnedAt?: string | null | undefined;
  archived?: boolean | undefined;
  hasConversation?: boolean | undefined;
}): DiscoveredChat {
  const chat: DiscoveredChat = { id: fields.id };
  if (fields.name !== undefined) chat.name = fields.name;
  if (fields.lastMessageAt !== undefined) chat.lastMessageAt = fields.lastMessageAt;
  if (fields.preview !== undefined) chat.preview = fields.preview;
  if (fields.pinnedAt !== undefined) chat.pinnedAt = fields.pinnedAt;
  if (fields.archived !== undefined) chat.archived = fields.archived;
  if (fields.hasConversation !== undefined) chat.hasConversation = fields.hasConversation;
  return chat;
}

function isRealDirectoryMessage(message: WAMessage): boolean {
  if (!message.message || message.messageStubType != null) return false;
  const content = directoryMessageContent(message);
  if (!content) return false;
  if (content.protocolMessage || content.reactionMessage || content.pollUpdateMessage) return false;
  return messagePreview(message) !== undefined;
}

function newestRealMessage(messages: WAMessage[]): WAMessage | undefined {
  let selected: { message: WAMessage; timestamp: number } | undefined;
  for (const message of messages) {
    if (!isRealDirectoryMessage(message)) continue;
    const timestamp = timestampMillis(message.messageTimestamp);
    if (timestamp === null || timestamp <= 0) continue;
    if (!selected || timestamp > selected.timestamp) selected = { message, timestamp };
  }
  return selected?.message;
}

function nativeChatTimestamp(chat: Partial<Chat>, latestReal: WAMessage | undefined): string | undefined {
  const latestRealTimestamp = timestampMillis(latestReal?.messageTimestamp);
  const primary = [
    latestRealTimestamp,
    timestampMillis(chat.lastMsgTimestamp),
    timestampMillis(chat.conversationTimestamp),
  ].filter((value): value is number => value !== null && value > 0);
  const selected = primary.length ? Math.max(...primary) : timestampMillis(chat.lastMessageRecvTimestamp);
  return selected !== null && selected > 0 ? new Date(selected).toISOString() : undefined;
}

function pinnedTimestamp(chat: Partial<Chat>): string | null | undefined {
  if (!Object.hasOwn(chat, 'pinned') || chat.pinned === undefined) return undefined;
  const pinnedValue = numberValue(chat.pinned);
  if (chat.pinned === null || pinnedValue === 0) return null;
  return isoTimestamp(chat.pinned);
}

function archivedFlag(chat: Partial<Chat>): boolean | undefined {
  return typeof chat.archived === 'boolean' && Object.hasOwn(chat, 'archived') ? chat.archived : undefined;
}

function previewForTimestamp(message: WAMessage | undefined, lastMessageAt: string | undefined): string | undefined {
  if (!message || !lastMessageAt) return undefined;
  return isoTimestamp(message.messageTimestamp) === lastMessageAt ? messagePreview(message) : undefined;
}

async function discoveredFromContact(
  contact: Partial<BaileysContact>,
  phoneForLid: (lid: string) => Promise<string | null>,
): Promise<DiscoveredChat | null> {
  const id = await phoneForDirectJid(contact.id, contact.phoneNumber, phoneForLid);
  if (!id) return null;
  return discoveredChat({ id, name: nonEmptyString(contact.name) ?? nonEmptyString(contact.notify) ?? nonEmptyString(contact.verifiedName) });
}

async function discoveredFromChat(
  chat: Partial<Chat>,
  phoneForLid: (lid: string) => Promise<string | null>,
): Promise<DiscoveredChat | null> {
  const id = await phoneForDirectJid(chat.id, chat.pnJid, phoneForLid);
  if (!id) return null;
  const latest = newestRealMessage(chat.messages?.map(item => item.message).filter((item): item is WAMessage => !!item) ?? []);
  const lastMessageAt = nativeChatTimestamp(chat, latest);
  return discoveredChat({
    id,
    name: nonEmptyString(chat.name) ?? nonEmptyString(chat.displayName) ?? nonEmptyString(chat.username),
    lastMessageAt,
    preview: previewForTimestamp(latest, lastMessageAt),
    pinnedAt: pinnedTimestamp(chat),
    archived: archivedFlag(chat),
    hasConversation: latest ? true : undefined,
  });
}

async function discoveredFromMessage(message: WAMessage, phoneForLid: (lid: string) => Promise<string | null>): Promise<DiscoveredChat | null> {
  if (!isRealDirectoryMessage(message)) return null;
  const contactId = await resolveMessageContact(message.key, phoneForLid);
  if (!contactId) return null;
  return discoveredChat({
    id: contactId,
    name: message.key.fromMe ? undefined : nonEmptyString(message.pushName) ?? nonEmptyString(message.verifiedBizName),
    lastMessageAt: isoTimestamp(message.messageTimestamp),
    preview: messagePreview(message),
    hasConversation: true,
  });
}

function sentMessageMetadata(contactId: string, text: string, timestamp: unknown, now: () => Date = () => new Date()): DiscoveredChat {
  return discoveredChat({
    id: contactId,
    lastMessageAt: isoTimestamp(timestamp) ?? now().toISOString(),
    preview: text.length > 240 ? `${text.slice(0, 240)}…` : text,
    hasConversation: true,
  });
}

function parseSendTextResult(result: SendTextResult): { messageId: string; timestamp?: unknown } | null {
  if (typeof result === 'string') return result.trim() ? { messageId: result } : null;
  if (result && typeof result === 'object' && typeof result.messageId === 'string' && result.messageId.trim()) return result;
  return null;
}

function timestampMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mergeDiscoveredChats(chats: (DiscoveredChat | null)[]): DiscoveredChat[] {
  const merged = new Map<string, DiscoveredChat>();
  for (const chat of chats) {
    if (!chat) continue;
    const existing = merged.get(chat.id);
    const existingAt = timestampMs(existing?.lastMessageAt);
    const chatAt = timestampMs(chat.lastMessageAt);
    const next = discoveredChat({
      id: chat.id,
      name: chat.name ?? existing?.name,
      pinnedAt: chat.pinnedAt !== undefined ? chat.pinnedAt : existing?.pinnedAt,
      archived: chat.archived !== undefined ? chat.archived : existing?.archived,
      hasConversation: chat.hasConversation === true ? true : existing?.hasConversation,
    });
    if (chatAt !== null) {
      if (existingAt === null || chatAt > existingAt) {
        if (chat.lastMessageAt !== undefined) next.lastMessageAt = chat.lastMessageAt;
        if (chat.preview !== undefined) next.preview = chat.preview;
      } else if (chatAt === existingAt) {
        const lastMessageAt = existing?.lastMessageAt ?? chat.lastMessageAt;
        const preview = chat.preview ?? existing?.preview;
        if (lastMessageAt !== undefined) next.lastMessageAt = lastMessageAt;
        if (preview !== undefined) next.preview = preview;
      } else {
        if (existing?.lastMessageAt !== undefined) next.lastMessageAt = existing.lastMessageAt;
        if (existing?.preview !== undefined) next.preview = existing.preview;
      }
    } else {
      if (existing?.lastMessageAt !== undefined) next.lastMessageAt = existing.lastMessageAt;
      const preview = existing?.preview ?? chat.preview;
      if (preview !== undefined) next.preview = preview;
    }
    merged.set(chat.id, next);
  }
  return [...merged.values()];
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
  private chatsWork: Promise<void> = Promise.resolve();
  private syncContactsWork: Promise<void> = Promise.resolve();
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
    await Promise.all([this.credentialsWork, this.incomingWork, this.receiptsWork, this.chatsWork, this.syncContactsWork]);
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
      const result = parseSendTextResult(await session.sendText(contactId, text, messageId));
      if (!result || (messageId !== undefined && result.messageId !== messageId)) throw new Error('MESSAGE_ID_MISMATCH');
      this.emitChats([sentMessageMetadata(contactId, text, result.timestamp)]);
      return { messageId: result.messageId };
    } catch {
      // The application preserves its identity and marks delivery unknown; never retry here.
      throw new ServiceError('WHATSAPP_SEND_UNCERTAIN', 'The result of this send is uncertain.');
    }
  }

  async syncContacts(): Promise<void> {
    const session = this.connectedSession();
    if (!session.syncContacts) throw new ServiceError('WHATSAPP_CONTACT_SYNC_UNAVAILABLE', 'WhatsApp contact sync is unavailable.');
    const work = this.syncContactsWork.then(async () => {
      if (this.session !== session || this.current.phase !== 'connected') throw new Error('DISCONNECTED');
      await session.syncContacts!();
      await this.chatsWork;
      if (this.session !== session || this.current.phase !== 'connected') throw new Error('DISCONNECTED');
    });
    this.syncContactsWork = work.catch(() => {});
    try {
      await work;
    } catch {
      throw new ServiceError('WHATSAPP_CONTACT_SYNC_FAILED', 'Could not sync WhatsApp contacts.');
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

  private emitChats(chats: (DiscoveredChat | null)[]): void {
    const discovered = mergeDiscoveredChats(chats);
    if (!discovered.length) return;
    try { this.options.onChats?.(discovered); } catch { this.update({ errorCode: 'WHATSAPP_DIRECTORY_PROCESSING_FAILED' }); }
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
            if (!active()) return;
            for (const message of event.messages) {
              this.chatsWork = this.chatsWork.then(async () => {
                if (!active()) return;
                const chat = await discoveredFromMessage(message, lid => session.phoneForLid(lid));
                if (active()) this.emitChats([chat]);
              }).catch(() => {
                if (active()) this.update({ errorCode: 'WHATSAPP_DIRECTORY_PROCESSING_FAILED' });
              });
            }
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
          session.on('messaging-history.set', event => {
            if (!active()) return;
            this.chatsWork = this.chatsWork.then(async () => {
              if (!active()) return;
              const messages = await Promise.all(event.messages.map(message => discoveredFromMessage(message, lid => session.phoneForLid(lid))));
              const chatMessages = await Promise.all(event.chats.flatMap(chat => chat.messages?.map(item => item.message).filter((item): item is WAMessage => !!item) ?? [])
                .map(message => discoveredFromMessage(message, lid => session.phoneForLid(lid))));
              const contacts = await Promise.all(event.contacts.map(contact => discoveredFromContact(contact, lid => session.phoneForLid(lid))));
              const chats = await Promise.all(event.chats.map(chat => discoveredFromChat(chat, lid => session.phoneForLid(lid))));
              this.emitChats([
                ...contacts,
                ...chats,
                ...messages,
                ...chatMessages,
              ]);
            }).catch(() => {
              if (active()) this.update({ errorCode: 'WHATSAPP_DIRECTORY_PROCESSING_FAILED' });
            });
          }),
          session.on('chats.upsert', chats => {
            if (!active()) return;
            this.chatsWork = this.chatsWork.then(async () => {
              if (!active()) return;
              this.emitChats(await Promise.all(chats.map(chat => discoveredFromChat(chat, lid => session.phoneForLid(lid)))));
            }).catch(() => {
              if (active()) this.update({ errorCode: 'WHATSAPP_DIRECTORY_PROCESSING_FAILED' });
            });
          }),
          session.on('chats.update', chats => {
            if (!active()) return;
            this.chatsWork = this.chatsWork.then(async () => {
              if (!active()) return;
              this.emitChats(await Promise.all(chats.map(chat => discoveredFromChat(chat, lid => session.phoneForLid(lid)))));
            }).catch(() => {
              if (active()) this.update({ errorCode: 'WHATSAPP_DIRECTORY_PROCESSING_FAILED' });
            });
          }),
          session.on('contacts.upsert', contacts => {
            if (!active()) return;
            this.chatsWork = this.chatsWork.then(async () => {
              if (!active()) return;
              this.emitChats(await Promise.all(contacts.map(contact => discoveredFromContact(contact, lid => session.phoneForLid(lid)))));
            }).catch(() => {
              if (active()) this.update({ errorCode: 'WHATSAPP_DIRECTORY_PROCESSING_FAILED' });
            });
          }),
          session.on('contacts.update', contacts => {
            if (!active()) return;
            this.chatsWork = this.chatsWork.then(async () => {
              if (!active()) return;
              this.emitChats(await Promise.all(contacts.map(contact => discoveredFromContact(contact, lid => session.phoneForLid(lid)))));
            }).catch(() => {
              if (active()) this.update({ errorCode: 'WHATSAPP_DIRECTORY_PROCESSING_FAILED' });
            });
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
