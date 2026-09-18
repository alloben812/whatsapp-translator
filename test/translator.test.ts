import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ServiceError } from '../src/domain.js';
import { CommandTranslator, createTranslator } from '../src/translator.js';

function fixture(t: TestContext, script: string) {
  const path = mkdtempSync(join(tmpdir(), 'watr-translator-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const entry = join(path, 'broker.cjs');
  writeFileSync(entry, script, { mode: 0o600 });
  return { path, command: process.execPath, args: [entry], timeoutMs: 3_000 };
}

function respond(value: unknown): string {
  return 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write('
    + JSON.stringify(JSON.stringify(value)) + '));';
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof ServiceError && error.code === code
    && error.message === 'Translation is unavailable.';
}

test('command receives text only over JSON stdin, preserves direction and inherits no secrets', async (t) => {
  const previous = process.env.WATR_TRANSLATOR_TEST_SECRET;
  process.env.WATR_TRANSLATOR_TEST_SECRET = 'watr-test-secret-must-not-reach-child';
  t.after(() => {
    if (previous === undefined) delete process.env.WATR_TRANSLATOR_TEST_SECRET;
    else process.env.WATR_TRANSLATOR_TEST_SECRET = previous;
  });
  const options = fixture(t, [
    'let input = ""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", c => input += c);',
    'process.stdin.on("end", () => {',
    'if (process.env.WATR_TRANSLATOR_TEST_SECRET || process.argv.length !== 2) process.exit(2);',
    'const request = JSON.parse(input);',
    'process.stdout.write(JSON.stringify({translation: JSON.stringify(request)}));',
    '});',
  ].join('\n'));
  const translator = new CommandTranslator(options);
  const original = 'Привет\n$(touch SHOULD_NOT_EXIST); " / --tools all';
  assert.deepEqual(JSON.parse(await translator.translate(original, 'ru-sr')), { text: original, direction: 'ru-sr' });
  assert.deepEqual(JSON.parse(await translator.translate('Zdravo!', 'sr-ru')), { text: 'Zdravo!', direction: 'sr-ru' });
});

test('strict JSON response rejects invalid, oversized and additional fields', async (t) => {
  for (const output of ['not json', 'null', '[]', '{"translation":""}',
    '{"translation":" ","command":"run"}', '{"translation":"ok","recipient":"other"}',
    JSON.stringify({ translation: 'a'.repeat(8001) })]) {
    const translator = new CommandTranslator(fixture(t,
      'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(' + JSON.stringify(output) + '));'));
    await assert.rejects(translator.translate('Привет', 'ru-sr'), hasCode('invalid_translation'));
  }
});

test('stdout and stderr limits fail safely without exposing provider text', async (t) => {
  for (const stream of ['stdout', 'stderr']) {
    const translator = new CommandTranslator({ ...fixture(t,
      'process.stdin.resume(); process.' + stream + '.write("secret-provider-text".repeat(100)); setInterval(() => {}, 1000);'),
    maxOutputBytes: 256 });
    await assert.rejects(translator.translate('Привет', 'ru-sr'), hasCode('translation_output_limit'));
  }
});

test('malformed UTF-8 is rejected rather than silently changing a translation', async (t) => {
  const translator = new CommandTranslator(fixture(t,
    'process.stdin.resume(); process.stdin.on("end", () => {'
    + 'process.stdout.write(Buffer.concat([Buffer.from("{\\"translation\\":\\""), Buffer.from([255]), Buffer.from("\\"}")]))'
    + '});'));
  await assert.rejects(translator.translate('Привет', 'ru-sr'), hasCode('invalid_translation'));
});

test('nonzero exit and missing executable expose only normalized errors', async (t) => {
  const translator = new CommandTranslator(fixture(t,
    'process.stdin.resume(); process.stderr.write("private-token"); process.exit(1);'));
  await assert.rejects(translator.translate('Привет', 'ru-sr'), hasCode('translation_unavailable'));
  const absent = new CommandTranslator({ command: '/nonexistent/watr-broker' });
  await assert.rejects(absent.translate('Привет', 'ru-sr'), hasCode('translation_unavailable'));
});

test('bounded global queue serializes separate instances and rejects overload', async (t) => {
  const options = fixture(t, [
    'const fs = require("node:fs"); const lock = process.argv[2];',
    'const fd = fs.openSync(lock, "wx"); fs.closeSync(fd);',
    'process.stdin.resume(); process.stdin.on("end", () => {',
    'setTimeout(() => { fs.unlinkSync(lock); process.stdout.write(JSON.stringify({translation:"Zdravo"})); }, 100);',
    '});',
  ].join('\n'));
  options.args.push(join(options.path, 'exclusive.lock'));
  const one = new CommandTranslator({ ...options, maxQueue: 1 });
  const two = new CommandTranslator({ ...options, maxQueue: 1 });
  const first = one.translate('Один', 'ru-sr');
  const second = two.translate('Два', 'ru-sr');
  await assert.rejects(one.translate('Три', 'ru-sr'), hasCode('translation_busy'));
  assert.deepEqual(await Promise.all([first, second]), ['Zdravo', 'Zdravo']);
});

test('queued work expires before execution, without a delayed model request', async (t) => {
  const options = fixture(t, [
    'process.stdin.resume(); process.stdin.on("end", () => {',
    'setTimeout(() => process.stdout.write(JSON.stringify({translation:"Zdravo"})), 300);',
    '});',
  ].join('\n'));
  const first = new CommandTranslator(options).translate('Один', 'ru-sr');
  const queued = new CommandTranslator({ ...options, timeoutMs: 100 }).translate('Два', 'ru-sr');
  await assert.rejects(queued, hasCode('translation_busy'));
  assert.equal(await first, 'Zdravo');
});

test('timeout stops a subprocess group and allows the next translation', { skip: process.platform === 'win32' }, async (t) => {
  const childCode = 'process.on("SIGTERM", () => {}); '
    + 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "survived"), 1000); '
    + 'setInterval(() => {}, 1000);';
  const options = fixture(t, [
    'const {spawn} = require("node:child_process");',
    'const marker = process.argv[2];',
    'process.on("SIGTERM", () => {}); process.stdin.resume();',
    'spawn(process.execPath, ["-e", ' + JSON.stringify(childCode) + ', marker], {stdio:"inherit"});',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const marker = join(options.path, 'should-not-be-created');
  options.args.push(marker);
  await assert.rejects(new CommandTranslator({ ...options, timeoutMs: 150 }).translate('Тест', 'ru-sr'), hasCode('translation_timeout'));
  const healthy = new CommandTranslator(fixture(t, respond({ translation: 'Zdravo' })));
  assert.equal(await healthy.translate('Привет', 'ru-sr'), 'Zdravo');
  await delay(800);
  assert.equal(existsSync(marker), false);
});

test('timeout kills an ignoring descendant even when its leader exits and stdio is detached',
  { skip: process.platform === 'win32' }, async (t) => {
    const childCode = 'process.on("SIGTERM", () => {}); '
      + 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "survived"), 650);';
    const options = fixture(t, [
      'const {spawn} = require("node:child_process"); process.stdin.resume();',
      'spawn(process.execPath, ["-e", ' + JSON.stringify(childCode) + ', process.argv[2]], {stdio:"ignore"});',
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const marker = join(options.path, 'should-not-be-created');
    options.args.push(marker);
    await assert.rejects(new CommandTranslator({ ...options, timeoutMs: 200 }).translate('Тест', 'ru-sr'), hasCode('translation_timeout'));
    await delay(700);
    assert.equal(existsSync(marker), false);
  });

test('probe uses --check only and preserves a normalized quota denial', async (t) => {
  const translator = new CommandTranslator(fixture(t, [
    'if (process.argv[2] !== "--check") process.exit(3);',
    'let input = ""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {',
    'if (input) process.exit(2);',
    'process.stdout.write(JSON.stringify({ready:false,label:"do-not-display",reason:"budget_unverified"}));',
    '});',
  ].join('\n')));
  assert.deepEqual(await translator.probe(), {
    ready: false, label: 'Подписочный переводчик', reason: 'budget_unverified',
  });
});

test('probe never mistakes configured command or raw error for readiness', async (t) => {
  for (const result of [
    { ready: true, label: 'private', reason: 'budget_unverified' },
    { ready: false, label: 'private', reason: 'provider-secret' },
    { ready: true, label: 'private', reason: null, token: 'secret' },
  ]) {
    const translator = new CommandTranslator(fixture(t, respond(result)));
    assert.deepEqual(await translator.probe(), { ready: false, label: 'Подписочный переводчик', reason: 'unavailable' });
  }
  const good = new CommandTranslator(fixture(t, respond({ ready: true, label: 'broker', reason: null })));
  assert.deepEqual(await good.probe(), { ready: true, label: 'Подписочный переводчик', reason: null });
});

test('factory is unavailable until an operator configures the broker', async () => {
  const empty = createTranslator();
  assert.equal(empty.status.configured, false);
  await assert.rejects(empty.translator.translate('Привет', 'ru-sr'), hasCode('translator_unconfigured'));
  assert.throws(() => new CommandTranslator({ command: 'sh -c pretend' }), { code: 'invalid_translator_config' });
  assert.throws(() => new CommandTranslator({ command: process.execPath, maxQueue: -1 }), { code: 'invalid_translator_config' });
  assert.throws(() => new CommandTranslator({ command: process.execPath, timeoutMs: Infinity }), { code: 'invalid_translator_config' });
});
