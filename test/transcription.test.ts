import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ServiceError } from '../src/domain.js';
import { CommandTranscriber, createTranscriber, transcriberOptionsFromEnv } from '../src/transcription.js';

function fixture(t: TestContext, script: string) {
  const path = mkdtempSync(join(tmpdir(), 'watr-transcriber-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const entry = join(path, 'transcriber.cjs');
  const modelDir = join(path, 'model');
  rmSync(modelDir, { recursive: true, force: true });
  writeFileSync(entry, script, { mode: 0o600 });
  return { path, command: process.execPath, script: entry, modelDir, timeoutMs: 3_000 };
}

function respond(value: unknown): string {
  return 'process.stdout.write(' + JSON.stringify(JSON.stringify(value)) + ');';
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof ServiceError && error.code === code
    && error.message === 'Speech transcription is unavailable.';
}

test('command receives a temp audio file and fixed local transcription arguments only', async (t) => {
  const previous = process.env.WATR_TRANSCRIBER_TEST_SECRET;
  process.env.WATR_TRANSCRIBER_TEST_SECRET = 'watr-test-secret-must-not-reach-child';
  t.after(() => {
    if (previous === undefined) delete process.env.WATR_TRANSCRIBER_TEST_SECRET;
    else process.env.WATR_TRANSCRIBER_TEST_SECRET = previous;
  });
  const markerDir = mkdtempSync(join(tmpdir(), 'watr-transcriber-marker-'));
  const marker = join(markerDir, 'result.json');
  t.after(() => rmSync(markerDir, { recursive: true, force: true }));
  const options = fixture(t, [
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'const value = Object.fromEntries(args.map((arg, index) => arg.startsWith("--") ? [arg, args[index + 1]] : null).filter(Boolean));',
    'if (process.env.WATR_TRANSCRIBER_TEST_SECRET || process.stdin.readableLength) process.exit(2);',
    'const audio = fs.readFileSync(value["--audio"], "utf8");',
    'fs.writeFileSync(' + JSON.stringify(marker) + ', JSON.stringify({args, audio, exists: fs.existsSync(value["--audio"])}));',
    'process.stdout.write(JSON.stringify({text:"Привет"}));',
  ].join('\n'));
  const transcriber = new CommandTranscriber(options);
  assert.equal(await transcriber.transcribe(Buffer.from('audio bytes'), 'ru'), 'Привет');
  const result = JSON.parse(readFileSync(marker, 'utf8')) as { args: string[]; audio: string; exists: boolean };
  assert.equal(result.audio, 'audio bytes');
  assert.equal(result.exists, true);
  assert.deepEqual(result.args, [
    '--model-dir', options.modelDir,
    '--audio', result.args[3],
    '--language', 'ru',
    '--max-duration-seconds', '60',
    '--compute-type', 'int8',
    '--beam-size', '3',
    '--cpu-threads', '2',
  ]);
  assert.equal(existsSync(result.args[3]!), false);
});

test('input bounds reject empty, oversized and unsupported language requests before spawn', async (t) => {
  const transcriber = new CommandTranscriber({ ...fixture(t, respond({ text: 'ignored' })), maxAudioBytes: 4 });
  await assert.rejects(transcriber.transcribe(Buffer.alloc(0), 'ru'), hasCode('invalid_audio'));
  await assert.rejects(transcriber.transcribe(Buffer.from('12345'), 'ru'), hasCode('invalid_audio'));
  await assert.rejects(transcriber.transcribe(Buffer.from('1234'), 'en'), hasCode('invalid_audio'));
});

test('strict JSON response rejects invalid, oversized and additional fields', async (t) => {
  for (const output of ['not json', 'null', '[]', '{"text":""}',
    '{"text":" ","command":"run"}', '{"text":"ok","recipient":"other"}',
    JSON.stringify({ text: 'a'.repeat(4001) })]) {
    const transcriber = new CommandTranscriber(fixture(t,
      'process.stdout.write(' + JSON.stringify(output) + ');'));
    await assert.rejects(transcriber.transcribe(Buffer.from('audio'), 'ru'), hasCode('invalid_transcription'));
  }
});

test('stdout and stderr limits fail safely without exposing runtime text', async (t) => {
  for (const stream of ['stdout', 'stderr']) {
    const transcriber = new CommandTranscriber({ ...fixture(t,
      'process.' + stream + '.write("private-runtime-text".repeat(100)); setInterval(() => {}, 1000);'),
    maxOutputBytes: 256 });
    await assert.rejects(transcriber.transcribe(Buffer.from('audio'), 'ru'), hasCode('transcription_output_limit'));
  }
});

test('malformed UTF-8 is rejected rather than silently changing transcript text', async (t) => {
  const transcriber = new CommandTranscriber(fixture(t,
    'process.stdout.write(Buffer.concat([Buffer.from("{\\"text\\":\\""), Buffer.from([255]), Buffer.from("\\"}")]))'));
  await assert.rejects(transcriber.transcribe(Buffer.from('audio'), 'ru'), hasCode('invalid_transcription'));
});

test('bounded global queue serializes one waiting transcription and rejects overload', async (t) => {
  const lockDir = mkdtempSync(join(tmpdir(), 'watr-transcriber-lock-'));
  const lock = join(lockDir, 'exclusive.lock');
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  const options = fixture(t, [
    'const fs = require("node:fs"); const lock = ' + JSON.stringify(lock) + ';',
    'const fd = fs.openSync(lock, "wx"); fs.closeSync(fd);',
    'setTimeout(() => { fs.unlinkSync(lock); process.stdout.write(JSON.stringify({text:"Готово"})); }, 100);',
  ].join('\n'));
  const one = new CommandTranscriber({ ...options, script: options.script, maxQueue: 1 });
  const two = new CommandTranscriber({ ...options, script: options.script, maxQueue: 1 });
  const first = one.transcribe(Buffer.from('one'), 'ru');
  const second = two.transcribe(Buffer.from('two'), 'ru');
  await assert.rejects(one.transcribe(Buffer.from('three'), 'ru'), hasCode('transcription_busy'));
  assert.deepEqual(await Promise.all([first, second]), ['Готово', 'Готово']);
  assert.equal(existsSync(lock), false);
});

test('queued work expires before execution, without a delayed model request', async (t) => {
  const options = fixture(t, [
    'setTimeout(() => process.stdout.write(JSON.stringify({text:"Готово"})), 300);',
  ].join('\n'));
  const first = new CommandTranscriber(options).transcribe(Buffer.from('one'), 'ru');
  const queued = new CommandTranscriber({ ...options, timeoutMs: 100 }).transcribe(Buffer.from('two'), 'ru');
  await assert.rejects(queued, hasCode('transcription_busy'));
  assert.equal(await first, 'Готово');
});

test('timeout stops a subprocess group and allows the next transcription', { skip: process.platform === 'win32' }, async (t) => {
  const childCode = 'process.on("SIGTERM", () => {}); '
    + 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "survived"), 1000); '
    + 'setInterval(() => {}, 1000);';
  const markerDir = mkdtempSync(join(tmpdir(), 'watr-transcriber-timeout-'));
  const marker = join(markerDir, 'should-not-be-created');
  t.after(() => rmSync(markerDir, { recursive: true, force: true }));
  const options = fixture(t, [
    'const {spawn} = require("node:child_process");',
    'process.on("SIGTERM", () => {});',
    'spawn(process.execPath, ["-e", ' + JSON.stringify(childCode) + ', ' + JSON.stringify(marker) + '], {stdio:"inherit"});',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  await assert.rejects(new CommandTranscriber({ ...options, timeoutMs: 150 }).transcribe(Buffer.from('audio'), 'ru'),
    hasCode('transcription_timeout'));
  const healthy = new CommandTranscriber(fixture(t, respond({ text: 'Привет' })));
  assert.equal(await healthy.transcribe(Buffer.from('audio'), 'ru'), 'Привет');
  await delay(800);
  assert.equal(existsSync(marker), false);
});

test('probe uses --check and normalizes readiness', async (t) => {
  const transcriber = new CommandTranscriber(fixture(t, [
    'const args = process.argv.slice(2);',
    'if (args[0] !== "--check" || args[1] !== "--model-dir") process.exit(3);',
    'process.stdout.write(JSON.stringify({ready:false,label:"do-not-display",reason:"model_unavailable"}));',
  ].join('\n')));
  assert.deepEqual(await transcriber.probe(), {
    ready: false, label: 'Локальный распознаватель речи', reason: 'model_unavailable',
  });

  const good = new CommandTranscriber(fixture(t, respond({ ready: true, label: 'runtime', reason: null })));
  assert.deepEqual(await good.probe(), { ready: true, label: 'Локальный распознаватель речи', reason: null });
});

test('factory is unavailable until an operator configures the local command', async () => {
  const empty = createTranscriber();
  assert.equal(empty.status.configured, false);
  await assert.rejects(empty.transcriber.transcribe(Buffer.from('audio'), 'ru'), hasCode('transcriber_unconfigured'));
  assert.throws(() => new CommandTranscriber({ command: 'python3', script: '/tmp/transcribe.py', modelDir: '/tmp/model' }),
    { code: 'invalid_transcriber_config' });
  assert.throws(() => new CommandTranscriber({ command: process.execPath, script: '/tmp/transcribe.py', modelDir: '/tmp/model', maxQueue: 2 }),
    { code: 'invalid_transcriber_config' });
  assert.deepEqual(transcriberOptionsFromEnv({
    WATR_TRANSCRIBER_PYTHON: '/venv/bin/python',
    WATR_TRANSCRIBER_SCRIPT: '/app/scripts/transcribe.py',
    WATR_TRANSCRIBER_MODEL_DIR: '/models/small',
  }), {
    command: '/venv/bin/python',
    script: '/app/scripts/transcribe.py',
    modelDir: '/models/small',
  });
});
