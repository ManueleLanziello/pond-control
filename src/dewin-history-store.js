import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEWIN_HISTORY_TIME_ZONE = 'Europe/Rome';
export const DEWIN_HISTORY_RETENTION_DAYS = 30;
export const DEWIN_HISTORY_SAMPLE_INTERVAL_MS = 10 * 60_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function localDateString(timestamp = Date.now(), timeZone = DEWIN_HISTORY_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function validateHistoryDate(date) {
  if (!DATE_PATTERN.test(date)) throw new RangeError('Data non valida: usare YYYY-MM-DD');
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new RangeError('Data non valida: usare YYYY-MM-DD');
  }
  return date;
}

export class DewinHistoryStore {
  constructor({ directory, timeZone = DEWIN_HISTORY_TIME_ZONE, retentionDays = DEWIN_HISTORY_RETENTION_DAYS, now = () => Date.now() }) {
    this.directory = directory;
    this.timeZone = timeZone;
    this.retentionDays = retentionDays;
    this.now = now;
    this.writeQueue = Promise.resolve();
  }

  dateFor(timestamp = this.now()) {
    return localDateString(timestamp, this.timeZone);
  }

  filePath(date) {
    return path.join(this.directory, `${validateHistoryDate(date)}.json`);
  }

  async read(date = this.dateFor()) {
    const validDate = validateHistoryDate(date);
    try {
      const payload = JSON.parse(await readFile(this.filePath(validDate), 'utf8'));
      return {
        date: validDate,
        samples: Array.isArray(payload?.samples) ? payload.samples : [],
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { date: validDate, samples: [] };
      throw error;
    }
  }

  async appendSample({ timestamp, pond, ambient }) {
    if (!timestamp || !Number.isFinite(pond) || !Number.isFinite(ambient)) return false;
    const operation = this.writeQueue.then(async () => {
      const date = this.dateFor(Date.parse(timestamp));
      const history = await this.read(date);
      const previous = history.samples.at(-1);
      if (previous) {
        const elapsed = Date.parse(timestamp) - Date.parse(previous.timestamp);
        if (!Number.isFinite(elapsed) || elapsed <= 0) return false;
        const changed = previous.pond !== pond || previous.ambient !== ambient;
        if (!changed && elapsed < DEWIN_HISTORY_SAMPLE_INTERVAL_MS) return false;
      }
      history.samples.push({ timestamp, pond, ambient });
      await mkdir(this.directory, { recursive: true });
      const destination = this.filePath(date);
      const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
      await rename(temporary, destination);
      return true;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async prune() {
    await mkdir(this.directory, { recursive: true });
    const today = this.dateFor();
    const [year, month, day] = today.split('-').map(Number);
    const cutoff = localDateString(
      Date.UTC(year, month - 1, day - (this.retentionDays - 1), 12),
      this.timeZone,
    );
    const entries = await readdir(this.directory, { withFileTypes: true });
    const removals = entries
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
      .filter((entry) => entry.name.slice(0, 10) < cutoff)
      .map((entry) => unlink(path.join(this.directory, entry.name)));
    await Promise.all(removals);
    return removals.length;
  }
}
