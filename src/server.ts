import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { TranslationService } from './service.js';
import { WhatsAppConnection } from './whatsapp.js';
import { CommandTranslator, createTranslator } from './translator.js';
import { createApplication, type TranslatorStatus } from './http-app.js';
import { CommandTranscriber, createTranscriber } from './transcription.js';

process.umask(0o077);

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const dataDirectory = resolve(process.env.WA_DATA_DIR ?? join(root, '.state', 'live'));
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const info = lstatSync(dataDirectory);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(dataDirectory) !== dataDirectory ||
      (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error('Invalid private data directory');
  const host = process.env.WA_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Application must listen on loopback');
  const port = Number(process.env.WA_PORT ?? '8787');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid application port');
  const origin = process.env.WA_ORIGIN ?? `http://${host === '::1' ? '[::1]' : host}:${port}`;
  const socketPath = process.env.WA_SOCKET_PATH;
  if (!socketPath && !process.env.WA_PASSWORD) throw new Error('TCP access requires owner authentication');
  if (socketPath) {
    if (!isAbsolute(socketPath) || socketPath !== resolve(socketPath)) throw new Error('Invalid private socket path');
    const directory = lstatSync(dirname(socketPath));
    if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(dirname(socketPath)) !== dirname(socketPath) ||
        directory.uid !== process.getuid?.() || (directory.mode & 0o027)) throw new Error('Invalid private socket directory');
    if (existsSync(socketPath)) {
      const previous = lstatSync(socketPath);
      if (!previous.isSocket() || previous.uid !== process.getuid?.()) throw new Error('Invalid existing socket');
      unlinkSync(socketPath);
    }
  }
  const args: unknown = JSON.parse(process.env.WA_TRANSLATOR_ARGS ?? '[]');
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('Invalid broker arguments');
  const translation = createTranslator({
    ...(process.env.WA_TRANSLATOR_COMMAND ? { command: process.env.WA_TRANSLATOR_COMMAND } : {}),
    args, timeoutMs: 75_000, maxQueue: 8,
  });
  const speech = createTranscriber({
    ...(process.env.WA_STT_PYTHON ? { command: process.env.WA_STT_PYTHON } : {}),
    script: join(root, 'scripts', 'transcribe.py'),
    ...(process.env.WA_STT_MODEL ? { modelDir: process.env.WA_STT_MODEL } : {}),
    maxAudioBytes: 8 * 1024 * 1024, maxDurationSeconds: 60,
    maxQueue: 0, timeoutMs: 70_000, cpuThreads: 2, beamSize: 3,
  });
  let speechReady = false;
  const checkSpeech = async () => {
    if (speech.transcriber instanceof CommandTranscriber) speechReady = (await speech.transcriber.probe()).ready;
  };
  let readiness: TranslatorStatus = { ready: false, label: 'Claude Sonnet', reason: 'unconfigured' };
  let checking = false;
  const refresh = async () => {
    if (checking || !(translation.translator instanceof CommandTranslator)) return;
    checking = true;
    try { readiness = { ...await translation.translator.probe(), label: process.env.WA_TRANSLATOR_LABEL ?? 'Claude Sonnet' }; }
    finally { checking = false; }
  };
  const store = new Store(join(dataDirectory, 'messages.sqlite'));
  let service!: TranslationService;
  const incoming = new Set<Promise<unknown>>();
  const connection = new WhatsAppConnection({
    authDirectory: join(dataDirectory, 'whatsapp-auth'),
    onIncoming: event => {
      const work = service.receive(event);
      incoming.add(work);
      void work.finally(() => incoming.delete(work)).catch(() => {});
      return work;
    },
    onReceipt: event => { store.receipt(event.contactId, event.messageId, event.status); },
  });
  service = new TranslationService(store, translation.translator, connection, store.contacts());
  const server = createApplication({
    store, service, connection, translatorStatus: () => readiness, webDirectory: join(root, 'web'), origin,
    transcriber: speech.transcriber, speechReady: () => speechReady,
    ...(process.env.WA_PASSWORD ? { password: process.env.WA_PASSWORD } : {}),
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    if (socketPath) server.listen(socketPath, accept);
    else server.listen(port, host, accept);
  });
  if (socketPath) chmodSync(socketPath, 0o660);
  void refresh();
  void checkSpeech();
  const timer = setInterval(() => { void refresh(); }, 30_000);
  timer.unref();
  // A new installation stays disconnected until the owner asks for a QR.
  // A previously paired account reconnects on service restart.
  if (existsSync(join(dataDirectory, 'whatsapp-auth', 'creds.json'))) void connection.connect().catch(() => {});
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true; clearInterval(timer);
    const closed = new Promise<void>(accept => server.close(() => accept()));
    const deadline = setTimeout(() => process.exit(1), 80000); deadline.unref();
    void (async () => {
      await connection.close();
      server.closeIdleConnections();
      await Promise.allSettled([...incoming]);
      await closed;
      store.close(); clearTimeout(deadline); process.exit(0);
    })().catch(() => process.exit(1));
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

void main().catch(() => { process.exitCode = 1; });
