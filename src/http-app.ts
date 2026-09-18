import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { isIndividualContactId, ServiceError, type Contact, type SendRequest } from './domain.js';
import { TranslationService } from './service.js';
import { Store } from './store.js';

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
export interface ApplicationOptions {
  store: Store;
  service: TranslationService;
  connection: LiveConnection;
  translatorStatus: () => TranslatorStatus;
  webDirectory: string;
  origin: string;
  password?: string;
  mode?: 'live' | 'demo';
}

const messages: Record<string, string> = {
  invalid_input: 'Проверьте номер, имя и текст сообщения.',
  unknown_contact: 'Сначала выберите добавленного собеседника.',
  invalid_contact: 'Нужен номер личного WhatsApp с кодом страны.',
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
function cookie(request: IncomingMessage): string | undefined {
  return request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('wa_session='))?.slice(11);
}
function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

/** Same-origin owner interface. No incoming message can invoke an HTTP operation. */
export function createApplication(options: ApplicationOptions) {
  const origin = new URL(options.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== options.origin) throw new Error('Invalid application origin');
  if (!options.password && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('Public access requires authentication');
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const localSession = { csrf: randomBytes(32).toString('hex'), expires: Infinity };
  const passwordHash = options.password ? createHash('sha256').update(options.password).digest() : null;
  const loginAttempts = new Map<string, { count: number; since: number }>();
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
        if (passwordHash && !timingSafeEqual(passwordHash, createHash('sha256').update(input.password).digest())) fail('unauthorized');
        for (const [key, session] of sessions) if (session.expires < now) sessions.delete(key);
        if (sessions.size >= 20) fail('rate_limited');
        const token = randomBytes(32).toString('hex');
        sessions.set(token, { csrf: randomBytes(32).toString('hex'), expires: now + 12 * 3600000 });
        response.setHeader('Set-Cookie', `wa_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${origin.protocol === 'https:' ? '; Secure' : ''}`);
        loginAttempts.delete(address);
        send(response, 200, { ok: true }); return;
      }
      const session = passwordHash ? sessions.get(cookie(request) ?? '') : localSession;
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
          mode: options.mode ?? 'live', csrfToken: session.csrf,
          whatsapp: { phase: state.phase, qrDataUrl: qrCache?.dataUrl ?? null, account: state.account, errorCode: state.errorCode },
          translator: options.translatorStatus(), contacts: options.store.contacts(), messages: recent,
        }); return;
      }
      if (request.method !== 'POST') fail('not_found');
      if (request.headers['x-csrf-token'] !== session.csrf) fail('forbidden');
      const input = await body(request);
      if (path === '/api/connect') {
        exact(input, []); await options.connection.connect(); send(response, 202, { ok: true }); return;
      }
      if (path === '/api/contacts') {
        const value = exact(input, ['name', 'phone']);
        if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 ||
            typeof value.phone !== 'string' || !/^\+?[1-9]\d{6,14}$/.test(value.phone)) fail('invalid_input');
        if (options.connection.state().phase !== 'connected') fail('whatsapp_unavailable');
        if (options.store.contacts().length >= 100) fail('invalid_input');
        const found = await options.connection.resolveContact(value.phone.replace(/^\+/, ''));
        if (!found) fail('contact_not_found');
        const contact: Contact = { id: found.id, name: value.name.trim() };
        if (!isIndividualContactId(contact.id)) fail('invalid_contact');
        options.store.saveContact(contact);
        options.service.setContacts(options.store.contacts());
        send(response, 201, contact); return;
      }
      if (path === '/api/send') {
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
        const value = exact(input, ['id']);
        if (typeof value.id !== 'string') fail('invalid_input');
        if (!options.translatorStatus().ready) fail('translator_unavailable');
        send(response, 200, await options.service.retryIncoming(value.id)); return;
      }
      fail('not_found');
    })().catch((error: unknown) => {
      const code = error instanceof ServiceError && error.code in messages ? error.code : 'request_failed';
      const status = code === 'unauthorized' ? 401 : code === 'forbidden' ? 403 : code === 'not_found' ? 404 : code === 'rate_limited' ? 429 : code === 'request_failed' ? 500 : 400;
      send(response, status, { error: { code, message: messages[code] } });
    });
  });
  server.requestTimeout = 125000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  return server;
}
