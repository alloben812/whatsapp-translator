import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { ServiceError, type TranslationDirection, type Translator } from './domain.js';

export interface CommandTranslatorOptions {
  /** An operator-owned broker executable, never message content or a shell expression. */
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxQueue?: number;
  maxOutputBytes?: number;
}

export interface TranslatorReadiness {
  ready: boolean;
  label: string;
  reason: string | null;
}

export interface TranslatorStatus {
  configured: boolean;
  mode: 'command' | 'unconfigured';
  message: string;
}

const LABEL = 'Подписочный переводчик';
const failure = (code: string) => new ServiceError(code, 'Translation is unavailable.');
const REASONS = new Set([
  'allowed', 'controls_not_accepted', 'operator_paused', 'budget_unverified',
  'budget_exhausted', 'auth_unavailable', 'model_unavailable', 'busy',
  'unconfigured', 'unavailable',
]);

interface QueuedRun {
  start: () => void;
  reject: (error: ServiceError) => void;
  timer: NodeJS.Timeout;
}

// One process-wide lane, also shared by health probes. This is not the server's
// cross-process provider lock: the broker still owns admission and execution slots.
const queue: QueuedRun[] = [];
let running = false;
let stopUnconfirmed = false;

function releaseLane(): void {
  running = false;
  if (stopUnconfirmed) {
    for (const item of queue.splice(0)) {
      clearTimeout(item.timer);
      item.reject(failure('translation_unavailable'));
    }
    return;
  }
  const next = queue.shift();
  if (next) {
    clearTimeout(next.timer);
    running = true;
    next.start();
  }
}

function inLane<T>(run: () => Promise<T>, maxQueue: number, timeoutMs: number): Promise<T> {
  if (stopUnconfirmed) return Promise.reject(failure('translation_unavailable'));
  if (running && queue.length >= maxQueue) return Promise.reject(failure('translation_busy'));
  return new Promise<T>((resolve, reject) => {
    const start = () => { void run().then(resolve, reject).finally(releaseLane); };
    if (!running) {
      running = true;
      start();
      return;
    }
    const item: QueuedRun = {
      start,
      reject,
      timer: setTimeout(() => {
        const index = queue.indexOf(item);
        if (index !== -1) queue.splice(index, 1);
        reject(failure('translation_busy'));
      }, timeoutMs),
    };
    queue.push(item);
  });
}

function integerOption(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_translation');
  return value as Record<string, unknown>;
}

/** A narrow JSON transport to a trusted local broker; no CLI auth or API fallback. */
export class CommandTranslator implements Translator {
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly maxQueue: number;
  private readonly maxOutputBytes: number;

  constructor(options: CommandTranslatorOptions) {
    const args = options.args ?? [];
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.maxQueue = options.maxQueue ?? 8;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    if (typeof options.command !== 'string' || !isAbsolute(options.command) || options.command.includes('\0')
      || !Array.isArray(args) || args.length > 32
      || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 4096)
      || !integerOption(this.timeoutMs, 100, 120_000)
      || !integerOption(this.maxQueue, 0, 32)
      || !integerOption(this.maxOutputBytes, 256, 1024 * 1024)) {
      throw new ServiceError('invalid_translator_config', 'Invalid translation broker configuration.');
    }
    this.command = options.command;
    this.args = [...args];
  }

  async translate(text: string, direction: TranslationDirection): Promise<string> {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000
      || (direction !== 'ru-sr' && direction !== 'sr-ru')) throw failure('invalid_input');
    const result = object(await inLane(
      () => this.execute(this.args, JSON.stringify({ text, direction }) + '\n', this.timeoutMs),
      this.maxQueue, this.timeoutMs,
    ));
    if (Object.keys(result).length !== 1 || typeof result.translation !== 'string'
      || !result.translation.trim() || result.translation.length > 8000) throw failure('invalid_translation');
    return result.translation;
  }

  /** Broker --check is a read-only guard, never a synthetic model translation. */
  async probe(): Promise<TranslatorReadiness> {
    try {
      const result = object(await inLane(
        () => this.execute([...this.args, '--check'], '', Math.min(this.timeoutMs, 10_000)),
        this.maxQueue, Math.min(this.timeoutMs, 10_000),
      ));
      if (Object.keys(result).sort().join(',') !== 'label,ready,reason'
        || typeof result.ready !== 'boolean' || typeof result.label !== 'string'
        || result.label.length > 100
        || (result.reason !== null && (typeof result.reason !== 'string' || !REASONS.has(result.reason)))
        || (result.ready && result.reason !== null && result.reason !== 'allowed')) {
        return { ready: false, label: LABEL, reason: 'unavailable' };
      }
      // Do not expose even the broker's display label. UI strings are local.
      return { ready: result.ready, label: LABEL, reason: result.ready ? null : result.reason ?? 'unavailable' };
    } catch (error) {
      return { ready: false, label: LABEL,
        reason: error instanceof ServiceError && error.code === 'translation_busy' ? 'busy' : 'unavailable' };
    }
  }

  private execute(args: string[], input: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // No inherited API keys, session paths, NODE_OPTIONS, proxy variables or
      // shell configuration. Subscription identity belongs to the broker only.
      const child = spawn(this.command, args, {
        shell: false, detached: process.platform !== 'win32', windowsHide: true,
        cwd: tmpdir(), env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let errorCode: string | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      let stopTimer: NodeJS.Timeout | undefined;
      const finish = (error?: string, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        clearTimeout(stopTimer);
        chunks.length = 0;
        if (error) reject(failure(error)); else resolve(value);
      };
      const signal = (kind: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') child.kill(kind);
          else process.kill(-child.pid, kind);
        } catch { /* The matching process group may already have stopped. */ }
      };
      const stop = (code: string) => {
        if (settled || errorCode) return;
        errorCode = code;
        signal('SIGTERM');
        forceTimer = setTimeout(() => signal('SIGKILL'), 250);
        stopTimer = setTimeout(() => {
          // Do not release another model request into an uncertain process lane.
          stopUnconfirmed = true;
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          finish('translation_unavailable');
        }, 1_000);
      };
      const timer = setTimeout(() => stop('translation_timeout'), timeoutMs);
      child.on('error', () => finish('translation_unavailable'));
      child.stdin.on('error', () => stop('translation_unavailable'));
      const consume = (chunk: Buffer, keep: boolean) => {
        if (settled || errorCode) return;
        bytes += chunk.length;
        if (bytes > this.maxOutputBytes) { stop('translation_output_limit'); return; }
        if (keep) chunks.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => consume(chunk, true));
      child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
      child.on('close', (code, exitSignal) => {
        if (settled) return;
        if (errorCode) {
          // The group leader can exit on SIGTERM before an ignoring descendant
          // with detached stdio. Stop that same group before clearing escalation.
          signal('SIGKILL');
          finish(errorCode);
          return;
        }
        if (code !== 0 || exitSignal !== null) { finish('translation_unavailable'); return; }
        try { finish(undefined, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown); }
        catch { finish('invalid_translation'); }
      });
      child.stdin.end(input);
    });
  }
}

export function createTranslator(options: Partial<CommandTranslatorOptions> = {}): {
  translator: Translator;
  status: TranslatorStatus;
} {
  if (!options.command) return {
    translator: { translate: async () => { throw failure('translator_unconfigured'); } },
    status: { configured: false, mode: 'unconfigured', message: 'Переводчик ещё не подключён.' },
  };
  const translator = new CommandTranslator({ ...options, command: options.command });
  return {
    translator,
    status: { configured: true, mode: 'command', message: 'Нужна проверка доступности переводчика.' },
  };
}
