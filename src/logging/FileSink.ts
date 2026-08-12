import type { LogLevel } from '../Logger.js';
import { compressorFor } from '../persistence/object-storage/Compression.js';
import {
  AppendOnlyFile,
  deleteFile,
  ensureDirectory,
  joinPath,
  listDirectory,
  readFileBytes,
  writeFileBytes,
} from './AppendOnlyFile.js';
import { BatchingSink } from './BatchingSink.js';
import {
  DEFAULT_FILE_SINK_DIRECTORY,
  DEFAULT_FILE_SINK_EXTENSION,
  DEFAULT_FILE_SINK_FORMAT,
  DEFAULT_FILE_SINK_MAX_AGE_MS,
  DEFAULT_FILE_SINK_MAX_FILES,
  DEFAULT_FILE_SINK_MAX_FILE_BYTES,
  DEFAULT_FILE_SINK_MIN_LEVEL,
  DEFAULT_FILE_SINK_PREFIX,
  DEFAULT_FILE_SINK_ROTATE_INTERVAL,
  FileSinkOptionsValidator,
  type FileRotateInterval,
  type FileSinkFormat,
  type FileSinkOptions,
  type FileSinkOptionsType,
} from './FileSinkOptions.js';
import { formatJsonLine, formatTextLine } from './LogFormat.js';
import type { LogRecord } from './LogRecord.js';

const ENCODER = new TextEncoder();

/**
 * Writes records to timestamped files on disk, rolling over on size and on
 * the clock, with retention and optional compression.
 *
 *     const fileSink = new FileSink(FileSinkOptions.create()
 *       .withDirectory('/var/log/my-app')
 *       .withRotateInterval('daily'));
 *
 * Files are named `log-<yyyy-MM-dd>-<HH-mm-ss>.txt`, stamped when the file
 * is opened.
 *
 * **Rolling over opens a new file; the active one is never renamed.**
 * Windows will not rename a file that is open, and the rotation libraries
 * in the JS ecosystem converged on the same answer for the same reason.
 * It also means a crash can never leave a half-renamed file: whatever is
 * on disk is a complete file, under the name it was always going to have.
 *
 * **A record is never split across two files.**  The rotation check runs
 * before each line, not per batch, so a batch that crosses the size limit
 * finishes the current line, rolls, and continues in the new file.
 *
 * **A directory that cannot be written disables the sink** rather than
 * failing every batch forever.  A read-only mount is a permanent
 * condition; retrying it once per flush would produce a console message
 * every two seconds for the life of the process, and the application would
 * still be running fine.
 */
export class FileSink extends BatchingSink {
  private readonly format: FileSinkFormat;
  private readonly directory: string;
  private readonly prefix: string;
  private readonly extension: string;
  private readonly maxFileBytes: number;
  private readonly rotateInterval: FileRotateInterval;
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;
  private readonly compressRotated: boolean;
  /** Matches this sink's own files — and only those — for retention. */
  private readonly ownFilePattern: RegExp;

  private file: AppendOnlyFile | undefined;
  /** Period key of the open file, e.g. `2026-08-12` — `''` when interval is off. */
  private currentPeriod = '';
  private disabled = false;

  constructor(options: FileSinkOptions = {}) {
    const settings = validated(options);
    super('file', settings.minLevel ?? DEFAULT_FILE_SINK_MIN_LEVEL, settings.delivery);
    this.format = settings.format ?? DEFAULT_FILE_SINK_FORMAT;
    this.directory = settings.directory ?? DEFAULT_FILE_SINK_DIRECTORY;
    this.prefix = settings.prefix ?? DEFAULT_FILE_SINK_PREFIX;
    this.extension = settings.extension ?? DEFAULT_FILE_SINK_EXTENSION;
    this.maxFileBytes = settings.maxFileBytes ?? DEFAULT_FILE_SINK_MAX_FILE_BYTES;
    this.rotateInterval = settings.rotateInterval ?? DEFAULT_FILE_SINK_ROTATE_INTERVAL;
    this.maxFiles = settings.maxFiles ?? DEFAULT_FILE_SINK_MAX_FILES;
    this.maxAgeMs = settings.maxAgeMs ?? DEFAULT_FILE_SINK_MAX_AGE_MS;
    this.compressRotated = settings.compressRotated ?? false;
    this.ownFilePattern = new RegExp(
      `^${escapeForRegExp(this.prefix)}-(\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2})(?:-\\d+)?\\.`
      + `${escapeForRegExp(this.extension)}(?:\\.gz)?$`,
    );
  }

  /** Path of the file currently being written, or `undefined` before the first record. */
  get currentPath(): string | undefined {
    return this.file?.path;
  }

  protected async emitBatch(records: readonly LogRecord[]): Promise<void> {
    for (const record of records) {
      if (this.disabled) return;
      const line = this.format === 'json' ? formatJsonLine(record) : formatTextLine(record);
      const bytes = ENCODER.encode(line + '\n');
      await this.prepareFor(bytes.length, record.timestampMs);
      if (this.disabled) return;
      await this.file!.write(bytes);
    }
  }

  protected override async closeTransport(): Promise<void> {
    const file = this.file;
    this.file = undefined;
    await file?.close();
  }

  /**
   * Make sure there is an open file with room for `byteLength`, rolling
   * over first if the size limit or the clock boundary says so.
   */
  private async prepareFor(byteLength: number, timestampMs: number): Promise<void> {
    const period = periodKeyFor(timestampMs, this.rotateInterval);
    if (this.file === undefined) {
      await this.openFor(timestampMs, period);
      return;
    }
    const outOfRoom = this.maxFileBytes > 0 && this.file.bytesWritten + byteLength > this.maxFileBytes;
    const outOfPeriod = period !== this.currentPeriod;
    if (!outOfRoom && !outOfPeriod) return;

    const rotated = this.file.path;
    await this.file.close();
    this.file = undefined;
    await this.openFor(timestampMs, period);
    // Housekeeping after the new file is open, so a slow gzip cannot stall
    // the records waiting behind it.
    await this.finishRotated(rotated);
    await this.applyRetention();
  }

  private async openFor(timestampMs: number, period: string): Promise<void> {
    try {
      await ensureDirectory(this.directory);
      const path = await this.nextFreePath(timestampMs);
      this.file = await AppendOnlyFile.open(path);
      this.currentPeriod = period;
    } catch (error) {
      // Permanent by nature — a read-only mount does not become writable
      // between two flushes — so stop rather than report it forever.
      this.disabled = true;
      this.reporter.report(`cannot write to ${this.directory}; file logging disabled`, error);
    }
  }

  /**
   * `log-2026-08-12-09-41-02.txt`, with `-2`, `-3`, … appended if that name
   * is taken.  Two systems starting in the same second, or a restart inside
   * one, must not append to each other's file.
   */
  private async nextFreePath(timestampMs: number): Promise<string> {
    const stamp = stampFor(timestampMs);
    const existing = new Set(await listDirectory(this.directory).catch(() => []));
    const base = `${this.prefix}-${stamp}`;
    if (!existing.has(`${base}.${this.extension}`)) {
      return joinPath(this.directory, `${base}.${this.extension}`);
    }
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base}-${suffix}.${this.extension}`;
      if (!existing.has(candidate)) return joinPath(this.directory, candidate);
    }
  }

  /** gzip a file that has just been closed, if that was asked for. */
  private async finishRotated(path: string): Promise<void> {
    if (!this.compressRotated) return;
    try {
      const raw = await readFileBytes(path);
      const compressed = await compressorFor('gzip').compress(raw);
      await writeFileBytes(`${path}.gz`, compressed);
      await deleteFile(path);
    } catch (error) {
      // The uncompressed file is still there and still readable, which is
      // the outcome that matters; compression is an optimisation.
      this.reporter.report('compressing a rotated file failed', error);
    }
  }

  /**
   * Delete rotated files beyond the count or the age limit.
   *
   * Only files matching this sink's own prefix, extension and timestamp
   * shape are ever considered — never the open file, and never anything
   * else that happens to live in the directory.  A log directory shared
   * with a sibling service, or with a file somebody put there on purpose,
   * has to survive intact.
   */
  private async applyRetention(): Promise<void> {
    if (this.maxFiles <= 0 && this.maxAgeMs <= 0) return;
    try {
      const names = await listDirectory(this.directory);
      const openName = this.file?.path;
      const own = names
        .map((name) => ({ name, stamp: this.ownFilePattern.exec(name)?.[1] }))
        .filter((entry): entry is { name: string; stamp: string } => entry.stamp !== undefined)
        // The stamp sorts lexicographically the same way it sorts
        // chronologically, so this is newest-first without a stat call.
        .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));

      const doomed: string[] = [];
      const cutoffMs = this.maxAgeMs > 0 ? Date.now() - this.maxAgeMs : undefined;
      own.forEach((entry, index) => {
        const tooMany = this.maxFiles > 0 && index >= this.maxFiles;
        const tooOld = cutoffMs !== undefined && parseStamp(entry.stamp) < cutoffMs;
        if (tooMany || tooOld) doomed.push(entry.name);
      });

      for (const name of doomed) {
        const path = await joinPath(this.directory, name);
        if (path === openName) continue;
        await deleteFile(path);
      }
    } catch (error) {
      this.reporter.report('log-file retention failed', error);
    }
  }
}

/**
 * Spread and validate before `super()`.
 *
 * A derived constructor cannot run statements that touch `this` before the
 * base call, and validating afterwards would mean the base class had
 * already built a queue for options that turn out to be invalid.
 */
function validated(options: FileSinkOptions): Partial<FileSinkOptionsType> {
  const settings = { ...(options as Partial<FileSinkOptionsType>) };
  new FileSinkOptionsValidator().validate(settings);
  return settings;
}

/** `yyyy-MM-dd-HH-mm-ss` in local time — what a reader's clock showed. */
function stampFor(timestampMs: number): string {
  const at = new Date(timestampMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + `-${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
}

/**
 * The part of the stamp that has to stay constant within one file.  A
 * record whose key differs from the open file's starts a new one, which is
 * what makes "daily" mean midnight rather than 24 hours after startup.
 */
function periodKeyFor(timestampMs: number, interval: FileRotateInterval): string {
  if (interval === 'off') return '';
  const stamp = stampFor(timestampMs);
  return interval === 'hourly' ? stamp.slice(0, 13) : stamp.slice(0, 10);
}

/** Turn a `yyyy-MM-dd-HH-mm-ss` stamp back into epoch milliseconds. */
function parseStamp(stamp: string): number {
  const [year, month, day, hour, minute, second] = stamp.split('-').map(Number) as [
    number, number, number, number, number, number,
  ];
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
