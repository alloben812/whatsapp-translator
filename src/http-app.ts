import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { isIndividualContactId, ServiceError, type Contact, type SendRequest } from './domain.js';
import { TranslationService } from './service.js';
import { Store } from './store.js';
import { CONTACT_LANGUAGES, DEFAULT_CONTACT_LANGUAGE, isContactLanguage } from './languages.js';
import type { Transcriber } from './transcription.js';

export interface ConnectionState {
  phase: 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out' | 'error';
  qr: string | null;
  account: string | null;
  errorCode: string | null;
}
export interface LiveConnection {
  state(): ConnectionState;
  connect(): Promise<void>;
  resolveContact(phone: string): Promise<{ id: string; name?: string } | null>;
}
export interface TranslatorStatus { ready: boolean; label: string; reason: string | null }
export interface ChatSyncStatus {
  status: 'idle' | 'syncing' | 'ready' | 'error';
  errorCode: string | null;
  lastSyncedAt: string | null;
}
export interface ApplicationOptions {
  store: Store;
  service: TranslationService;
  connection: LiveConnection;
  translatorStatus: () => TranslatorStatus;
  transcriber?: Transcriber;
  speechReady?: () => boolean;
  chatSyncStatus?: () => ChatSyncStatus;
  syncChats?: () => Promise<void>;
  webDirectory: string;
  origin: string;
  password?: string;
  passwordHashFile?: string;
  mode?: 'live' | 'demo';
}

type PasswordVerifier =
  | { kind: 'legacy'; hash: Buffer }
  | { kind: 'scrypt'; cost: number; blockSize: number; parallelization: number; salt: Buffer; hash: Buffer };
type Session = { csrf: string; expires: number; limits: Map<string, { count: number; since: number }> };

const messages: Record<string, string> = {
  invalid_input: 'Проверьте номер, имя и текст сообщения.',
  unknown_contact: 'Сначала выберите добавленного собеседника.',
  invalid_contact: 'Нужен номер личного WhatsApp с кодом страны.',
  invalid_language: 'Выберите язык собеседника из списка.',
  invalid_audio: 'Нужна запись голоса до 60 секунд и 8 МБ.',
  transcription_busy: 'Предыдущая запись ещё распознаётся. Дождитесь результата.',
  transcription_timeout: 'Не удалось распознать запись вовремя. Попробуйте более короткую фразу.',
  transcription_unavailable: 'Распознавание речи временно недоступно. Можно ввести текст вручную.',
  invalid_transcription: 'Не удалось разобрать речь. Повторите запись или введите текст.',
  transcription_output_limit: 'Результат распознавания слишком большой. Запишите более короткую фразу.',
  contact_not_found: 'Этот номер не найден в WhatsApp. Проверьте код страны и номер.',
  whatsapp_unavailable: 'Подключите WhatsApp и дождитесь соединения.',
  translator_unavailable: 'Переводчик пока недоступен. Сообщение не отправлено.',
  idempotency_conflict: 'Этот запрос уже сохранён с другим текстом или собеседником.',
  retry_not_allowed: 'Повторить можно только перевод входящего сообщения с ошибкой.',
  unauthorized: 'Войдите, чтобы открыть переписку.',
  forbidden: 'Обновите страницу и повторите действие.',
  rate_limited: 'Слишком много попыток. Подождите несколько минут.',
  not_found: 'Страница не найдена.',
  request_failed: 'Не удалось выполнить действие. Проверьте состояние переписки.',
};

function fail(code: string): never { throw new ServiceError(code, messages[code] ?? messages.request_failed!); }
function exact(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) fail('invalid_input');
  return input as Record<string, unknown>;
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') fail('invalid_input');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 20000) fail('invalid_input');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { return fail('invalid_input'); }
}
async function audioBody(request: IncomingMessage): Promise<Buffer> {
  const mime = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (!mime || !['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'].includes(mime)) fail('invalid_audio');
  const maximum = 8 * 1024 * 1024;
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) fail('invalid_audio');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum) fail('invalid_audio');
    chunks.push(Buffer.from(chunk));
  }
  if (!bytes) fail('invalid_audio');
  return Buffer.concat(chunks);
}
function cookie(request: IncomingMessage): string | undefined {
  return request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('wa_session='))?.slice(11);
}
function clearSessionCookie(origin: URL): string {
  return `wa_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${origin.protocol === 'https:' ? '; Secure' : ''}`;
}
function throttle(session: Session, key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = session.limits.get(key);
  if (!bucket || now - bucket.since > windowMs) {
    session.limits.set(key, { count: 1, since: now });
    return;
  }
  bucket.count++;
  if (bucket.count > limit) fail('rate_limited');
}
function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
function loadPasswordVerifier(options: ApplicationOptions): PasswordVerifier | null {
  if (options.passwordHashFile) {
    const value = readFileSync(options.passwordHashFile, 'utf8').trim();
    const match = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([0-9a-f]{64})\$([0-9a-f]{128})$/i.exec(value);
    if (!match) throw new Error('Invalid password hash file');
    const costText = match[1]!;
    const blockSizeText = match[2]!;
    const parallelizationText = match[3]!;
    const saltHex = match[4]!;
    const hashHex = match[5]!;
    const cost = Number(costText);
    const blockSize = Number(blockSizeText);
    const parallelization = Number(parallelizationText);
    if (cost !== 16384 || blockSize !== 8 || parallelization !== 1) throw new Error('Unsupported password hash parameters');
    return { kind: 'scrypt', cost, blockSize, parallelization, salt: Buffer.from(saltHex, 'hex'), hash: Buffer.from(hashHex, 'hex') };
  }
  return options.password ? { kind: 'legacy', hash: createHash('sha256').update(options.password).digest() } : null;
}

/** Same-origin owner interface. No incoming message can invoke an HTTP operation. */
export function createApplication(options: ApplicationOptions) {
  const origin = new URL(options.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== options.origin) throw new Error('Invalid application origin');
  const passwordVerifier = loadPasswordVerifier(options);
  if (!passwordVerifier && options.mode !== 'demo') throw new Error('Owner authentication is required');
  const sessions = new Map<string, Session>();
  const localSession = { csrf: randomBytes(32).toString('hex'), expires: Infinity, limits: new Map<string, { count: number; since: number }>() };
  const loginAttempts = new Map<string, { count: number; since: number }>();
  let activePasswordHashes = 0;
  const verifyPassword = async (password: string): Promise<boolean> => {
    if (!passwordVerifier) return true;
    if (passwordVerifier.kind === 'legacy') {
      return timingSafeEqual(passwordVerifier.hash, createHash('sha256').update(password).digest());
    }
    if (activePasswordHashes >= 2) fail('rate_limited');
    activePasswordHashes++;
    try {
      const candidate = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, passwordVerifier.salt, passwordVerifier.hash.length, {
          cost: passwordVerifier.cost, blockSize: passwordVerifier.blockSize, parallelization: passwordVerifier.parallelization, maxmem: 32 * 1024 * 1024,
        }, (error, key) => error ? reject(error) : resolve(key));
      });
      return timingSafeEqual(passwordVerifier.hash, candidate);
    } finally { activePasswordHashes--; }
  };
  const assets = new Map([
    ['/', { type: 'text/html; charset=utf-8', bytes: readFileSync(join(options.webDirectory, 'index.html')) }],
    ['/app.js', { type: 'text/javascript; charset=utf-8', bytes: readFileSync(join(options.webDirectory, 'app.js')) }],
    ['/styles.css', { type: 'text/css; charset=utf-8', bytes: readFileSync(join(options.webDirectory, 'styles.css')) }],
  ]);
  let qrCache: { raw: string; dataUrl: string } | null = null;

  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    void (async () => {
      if (request.headers.host !== origin.host || (request.headers.origin !== undefined && request.headers.origin !== origin.origin) ||
          request.headers['sec-fetch-site'] === 'cross-site') fail('forbidden');
      const path = request.url ?? '';
      if (request.method === 'GET' && assets.has(path)) {
        const asset = assets.get(path)!;
        response.writeHead(200, { 'Content-Type': asset.type }); response.end(asset.bytes); return;
      }
      if (request.method === 'GET' && path === '/health') { send(response, 200, { ok: true }); return; }
      if (path === '/api/login' && request.method === 'POST') {
        const input = exact(await body(request), ['password']);
        if (typeof input.password !== 'string' || input.password.length > 256) fail('invalid_input');
        const now = Date.now();
        for (const [key, attempt] of loginAttempts) if (now - attempt.since > 300000) loginAttempts.delete(key);
        const address = request.socket.remoteAddress ?? 'local';
        const attempt = loginAttempts.get(address) ?? { count: 0, since: now };
        attempt.count++; loginAttempts.set(address, attempt);
        if (attempt.count > 10 || loginAttempts.size > 1000) fail('rate_limited');
        if (!await verifyPassword(input.password)) fail('unauthorized');
        for (const [key, session] of sessions) if (session.expires < now) sessions.delete(key);
        if (sessions.size >= 20) fail('rate_limited');
        const token = randomBytes(32).toString('hex');
        sessions.set(token, { csrf: randomBytes(32).toString('hex'), expires: now + 12 * 3600000, limits: new Map() });
        response.setHeader('Set-Cookie', `wa_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${origin.protocol === 'https:' ? '; Secure' : ''}`);
        loginAttempts.delete(address);
        send(response, 200, { ok: true }); return;
      }
      const sessionCookie = cookie(request);
      const session = passwordVerifier ? sessions.get(sessionCookie ?? '') : localSession;
      if (!session || session.expires < Date.now()) fail('unauthorized');
      const url = new URL(path, origin);
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const requestKeys = url.searchParams.getAll('requestKey');
        if ([...url.searchParams.keys()].some(key => key !== 'requestKey') || requestKeys.length > 1 || (requestKeys[0]?.length ?? 0) > 128) fail('invalid_input');
        const state = options.connection.state();
        if (state.qr && qrCache?.raw !== state.qr) qrCache = { raw: state.qr, dataUrl: await QRCode.toDataURL(state.qr, { errorCorrectionLevel: 'M', margin: 2, width: 320 }) };
        if (!state.qr) qrCache = null;
        const recent = options.store.list();
        const pending = requestKeys[0] ? options.store.byRequestKey(requestKeys[0]) : undefined;
        if (pending && !recent.some(message => message.id === pending.id)) recent.push(pending);
        send(response, 200, {
          mode: options.mode ?? 'live', auth: { required: Boolean(passwordVerifier) }, csrfToken: session.csrf,
          whatsapp: { phase: state.phase, qrDataUrl: qrCache?.dataUrl ?? null, account: state.account, errorCode: state.errorCode },
          translator: options.translatorStatus(), languages: CONTACT_LANGUAGES,
          speech: { ready: Boolean(options.transcriber && options.speechReady?.()), language: 'ru', maxSeconds: 60 },
          contacts: options.store.contacts(), messages: recent,
          chats: options.store.chats(),
          chatSync: options.chatSyncStatus?.() ?? { status: 'idle', errorCode: null, lastSyncedAt: null },
        }); return;
      }
      if (request.method !== 'POST') fail('not_found');
      if (request.headers['x-csrf-token'] !== session.csrf) fail('forbidden');
      if (path === '/api/logout') {
        exact(await body(request), []);
        if (sessionCookie) sessions.delete(sessionCookie);
        response.setHeader('Set-Cookie', clearSessionCookie(origin));
        send(response, 200, { ok: true }); return;
      }
      if (path === '/api/transcribe') {
        throttle(session, 'transcribe', 6, 60000);
        if (!options.transcriber || !options.speechReady?.()) fail('transcription_unavailable');
        const audio = await audioBody(request);
        const text = await options.transcriber.transcribe(audio, 'ru');
        send(response, 200, { text }); return;
      }
      const input = await body(request);
      if (path === '/api/connect') {
        throttle(session, 'connect', 6, 300000);
        exact(input, []); await options.connection.connect(); send(response, 202, { ok: true }); return;
      }
      if (path === '/api/chats/sync') {
        throttle(session, 'chats/sync', 10, 300000);
        exact(input, []);
        if (options.connection.state().phase !== 'connected' || !options.syncChats) fail('whatsapp_unavailable');
        // The controller records completion/errors; HTTP does not retain the request while syncing.
        void options.syncChats().catch(() => {});
        send(response, 202, { ok: true }); return;
      }
      if (path === '/api/chats/open') {
        const value = exact(input, ['contactId']);
        if (typeof value.contactId !== 'string') fail('invalid_input');
        const contact = options.store.openDiscoveredChat(value.contactId);
        options.service.setContacts(options.store.contacts());
        send(response, 200, contact); return;
      }
      if (path === '/api/contacts') {
        const hasLanguage = input !== null && typeof input === 'object' && 'language' in input;
        const value = exact(input, hasLanguage ? ['name', 'phone', 'language'] : ['name', 'phone']);
        const language = hasLanguage ? value.language : DEFAULT_CONTACT_LANGUAGE;
        if (!isContactLanguage(language)) fail('invalid_language');
        if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 ||
            typeof value.phone !== 'string' || !/^\+?[1-9]\d{6,14}$/.test(value.phone)) fail('invalid_input');
        if (options.connection.state().phase !== 'connected') fail('whatsapp_unavailable');
        if (options.store.contacts().length >= 100) fail('invalid_input');
        const found = await options.connection.resolveContact(value.phone.replace(/^\+/, ''));
        if (!found) fail('contact_not_found');
        const contact: Contact = { id: found.id, name: value.name.trim(), language };
        if (!isIndividualContactId(contact.id)) fail('invalid_contact');
        options.store.saveContact(contact);
        options.service.setContacts(options.store.contacts());
        send(response, 201, contact); return;
      }
      if (path === '/api/contact-language') {
        const value = exact(input, ['contactId', 'language']);
        if (typeof value.contactId !== 'string') fail('invalid_input');
        if (!isContactLanguage(value.language)) fail('invalid_language');
        if (!options.store.contacts().some(contact => contact.id === value.contactId)) fail('unknown_contact');
        const contact = options.store.setContactLanguage(value.contactId, value.language);
        options.service.setContacts(options.store.contacts());
        send(response, 200, contact); return;
      }
      if (path === '/api/send') {
        throttle(session, 'message-action', 30, 60000);
        const value = exact(input, ['contactId', 'text', 'idempotencyKey']);
        if (typeof value.contactId !== 'string' || typeof value.text !== 'string' || typeof value.idempotencyKey !== 'string') fail('invalid_input');
        const known = options.store.byRequestKey(value.idempotencyKey);
        if (!known) {
          if (options.connection.state().phase !== 'connected') fail('whatsapp_unavailable');
          if (!options.translatorStatus().ready) fail('translator_unavailable');
        }
        send(response, 200, await options.service.send(value as unknown as SendRequest)); return;
      }
      if (path === '/api/retry-translation') {
        throttle(session, 'message-action', 30, 60000);
        const value = exact(input, ['id']);
        if (typeof value.id !== 'string') fail('invalid_input');
        if (!options.translatorStatus().ready) fail('translator_unavailable');
        send(response, 200, await options.service.retryIncoming(value.id)); return;
      }
      fail('not_found');
    })().catch((error: unknown) => {
      const code = error instanceof ServiceError && error.code in messages ? error.code : 'request_failed';
      const status = code === 'unauthorized' ? 401 : code === 'forbidden' ? 403 : code === 'not_found' ? 404 : code === 'rate_limited' ? 429
        : code === 'transcription_busy' ? 409 : code === 'transcription_timeout' ? 504 : code === 'transcription_unavailable' ? 503
          : code === 'request_failed' ? 500 : 400;
      send(response, status, { error: { code, message: messages[code] } });
    });
  });
  server.requestTimeout = 125000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  return server;
}
