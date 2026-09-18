import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { ServiceError } from './domain.js';

export type TranscriptionLanguage = 'ru' | 'sr';

export interface Transcriber {
  transcribe(bytes: Buffer, language: string): Promise<string>;
}

export interface CommandTranscriberOptions {
  command: string;
  script: string;
  modelDir: string;
  timeoutMs?: number;
  maxAudioBytes?: number;
  maxDurationSeconds?: number;
  maxQueue?: number;
  maxOutputBytes?: number;
  maxTextChars?: number;
  beamSize?: number;
  cpuThreads?: number;
  computeType?: 'int8';
}

export interface TranscriberReadiness {
  ready: boolean;
  label: string;
  reason: string | null;
}

export interface TranscriberStatus {
  configured: boolean;
  mode: 'command' | 'unconfigured';
  message: string;
}

export const DEFAULT_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_AUDIO_SECONDS = 60;

const LABEL = 'Локальный распознаватель речи';
const failure = (code: string) => new ServiceError(code, 'Speech transcription is unavailable.');
const LANGUAGES = new Set(['ru', 'sr']);
const REASONS = new Set(['unconfigured', 'runtime_unavailable', 'model_unavailable', 'busy', 'unavailable']);

interface QueuedRun {
  start: () => void;
  reject: (error: ServiceError) => void;
  timer: NodeJS.Timeout;
}

const queue: QueuedRun[] = [];
let running = false;
let stopUnconfirmed = false;

function releaseLane(): void {
  running = false;
  if (stopUnconfirmed) {
    for (const item of queue.splice(0)) {
      clearTimeout(item.timer);
      item.reject(failure('transcription_unavailable'));
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
  if (stopUnconfirmed) return Promise.reject(failure('transcription_unavailable'));
  if (running && queue.length >= maxQueue) return Promise.reject(failure('transcription_busy'));
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
        reject(failure('transcription_busy'));
      }, timeoutMs),
    };
    queue.push(item);
  });
}

function integerOption(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_transcription');
  return value as Record<string, unknown>;
}

function validatePath(value: string): boolean {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\0');
}

export class CommandTranscriber implements Transcriber {
  private readonly command: string;
  private readonly script: string;
  private readonly modelDir: string;
  private readonly timeoutMs: number;
  private readonly maxAudioBytes: number;
  private readonly maxDurationSeconds: number;
  private readonly maxQueue: number;
  private readonly maxOutputBytes: number;
  private readonly maxTextChars: number;
  private readonly beamSize: number;
  private readonly cpuThreads: number;
  private readonly computeType: 'int8';

  constructor(options: CommandTranscriberOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    this.maxDurationSeconds = options.maxDurationSeconds ?? DEFAULT_MAX_AUDIO_SECONDS;
    this.maxQueue = options.maxQueue ?? 1;
    this.maxOutputBytes = options.maxOutputBytes ?? 32 * 1024;
    this.maxTextChars = options.maxTextChars ?? 4000;
    this.beamSize = options.beamSize ?? 3;
    this.cpuThreads = options.cpuThreads ?? 2;
    this.computeType = options.computeType ?? 'int8';
    if (!validatePath(options.command) || !validatePath(options.script) || !validatePath(options.modelDir)
      || !integerOption(this.timeoutMs, 100, 120_000)
      || !integerOption(this.maxAudioBytes, 1, DEFAULT_MAX_AUDIO_BYTES)
      || !integerOption(this.maxDurationSeconds, 1, DEFAULT_MAX_AUDIO_SECONDS)
      || !integerOption(this.maxQueue, 0, 1)
      || !integerOption(this.maxOutputBytes, 256, 1024 * 1024)
      || !integerOption(this.maxTextChars, 1, 16_000)
      || !integerOption(this.beamSize, 1, 5)
      || !integerOption(this.cpuThreads, 1, 4)
      || this.computeType !== 'int8') {
      throw new ServiceError('invalid_transcriber_config', 'Invalid speech transcription configuration.');
    }
    this.command = options.command;
    this.script = options.script;
    this.modelDir = options.modelDir;
  }

  async transcribe(bytes: Buffer, language: string): Promise<string> {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > this.maxAudioBytes
      || !LANGUAGES.has(language)) throw failure('invalid_audio');
    const result = object(await inLane(
      () => this.executeWithTempFile(bytes, language as TranscriptionLanguage, this.timeoutMs),
      this.maxQueue, this.timeoutMs,
    ));
    if (Object.keys(result).length !== 1 || typeof result.text !== 'string'
      || !result.text.trim() || result.text.length > this.maxTextChars) throw failure('invalid_transcription');
    return result.text.trim();
  }

  async probe(): Promise<TranscriberReadiness> {
    try {
      const result = object(await inLane(
        () => this.execute([
          this.script, '--check',
          '--model-dir', this.modelDir,
        ], Math.min(this.timeoutMs, 10_000)),
        this.maxQueue, Math.min(this.timeoutMs, 10_000),
      ));
      if (Object.keys(result).sort().join(',') !== 'label,ready,reason'
        || typeof result.ready !== 'boolean' || typeof result.label !== 'string'
        || result.label.length > 100
        || (result.reason !== null && (typeof result.reason !== 'string' || !REASONS.has(result.reason)))
        || (result.ready && result.reason !== null)) {
        return { ready: false, label: LABEL, reason: 'unavailable' };
      }
      return { ready: result.ready, label: LABEL, reason: result.ready ? null : result.reason ?? 'unavailable' };
    } catch (error) {
      return { ready: false, label: LABEL,
        reason: error instanceof ServiceError && error.code === 'transcription_busy' ? 'busy' : 'unavailable' };
    }
  }

  private async executeWithTempFile(bytes: Buffer, language: TranscriptionLanguage, timeoutMs: number): Promise<unknown> {
    const directory = await mkdtemp(join(tmpdir(), 'watr-transcription-'));
    const audioPath = join(directory, 'input.audio');
    try {
      await writeFile(audioPath, bytes, { mode: 0o600 });
      return await this.execute([
        this.script,
        '--model-dir', this.modelDir,
        '--audio', audioPath,
        '--language', language,
        '--max-duration-seconds', String(this.maxDurationSeconds),
        '--compute-type', this.computeType,
        '--beam-size', String(this.beamSize),
        '--cpu-threads', String(this.cpuThreads),
      ], timeoutMs);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private execute(args: string[], timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        shell: false, detached: process.platform !== 'win32', windowsHide: true,
        cwd: tmpdir(),
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          PYTHONNOUSERSITE: '1',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          OMP_NUM_THREADS: String(this.cpuThreads),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
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
          stopUnconfirmed = true;
          child.stdout.destroy(); child.stderr.destroy();
          finish('transcription_unavailable');
        }, 1_000);
      };
      const timer = setTimeout(() => stop('transcription_timeout'), timeoutMs);
      child.on('error', () => finish('transcription_unavailable'));
      const consume = (chunk: Buffer, keep: boolean) => {
        if (settled || errorCode) return;
        bytes += chunk.length;
        if (bytes > this.maxOutputBytes) { stop('transcription_output_limit'); return; }
        if (keep) chunks.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => consume(chunk, true));
      child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
      child.on('close', (code, exitSignal) => {
        if (settled) return;
        if (errorCode) {
          signal('SIGKILL');
          finish(errorCode);
          return;
        }
        if (code !== 0 || exitSignal !== null) { finish('transcription_unavailable'); return; }
        try {
          const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
          finish(undefined, parsed);
        } catch {
          finish('invalid_transcription');
        }
      });
    });
  }
}

export function createTranscriber(options: Partial<CommandTranscriberOptions> = {}): {
  transcriber: Transcriber;
  status: TranscriberStatus;
} {
  if (!options.command || !options.script || !options.modelDir) return {
    transcriber: { transcribe: async () => { throw failure('transcriber_unconfigured'); } },
    status: { configured: false, mode: 'unconfigured', message: 'Распознавание голоса ещё не подключено.' },
  };
  const transcriber = new CommandTranscriber({
    ...options,
    command: options.command,
    script: options.script,
    modelDir: options.modelDir,
  });
  return {
    transcriber,
    status: { configured: true, mode: 'command', message: 'Нужна проверка доступности распознавания речи.' },
  };
}

export function defaultTranscriberOptions(modelDir: string): Pick<CommandTranscriberOptions, 'command' | 'script' | 'modelDir'> {
  return {
    command: '/usr/bin/python3',
    script: join(process.cwd(), 'scripts', basename('transcribe.py')),
    modelDir,
  };
}

export function transcriberOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<CommandTranscriberOptions> {
  const options: Partial<CommandTranscriberOptions> = {};
  if (env.WATR_TRANSCRIBER_PYTHON) options.command = env.WATR_TRANSCRIBER_PYTHON;
  if (env.WATR_TRANSCRIBER_SCRIPT) options.script = env.WATR_TRANSCRIBER_SCRIPT;
  if (env.WATR_TRANSCRIBER_MODEL_DIR) options.modelDir = env.WATR_TRANSCRIBER_MODEL_DIR;
  return options;
}
