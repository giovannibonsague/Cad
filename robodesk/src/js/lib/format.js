// Formatting and strict input parsing. Money is handled as integer cents end to end;
// user text is parsed as a decimal *string*, never through floating point.

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const money = (cents) => usd.format((cents || 0) / 100);

export const int = (n) => new Intl.NumberFormat('en-US').format(n ?? 0);

/** "12.34" / "$1,234.5" / "7" -> integer cents. Throws Error(message) for anything else. */
export function parseMoney(text, { label = 'Amount', allowEmpty = true } = {}) {
  const t = String(text ?? '').trim().replace(/^\$/, '').replace(/,/g, '').trim();
  if (t === '') {
    if (allowEmpty) return 0;
    throw new Error(`${label} is required.`);
  }
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) throw new Error(`${label} must be a positive amount with at most 2 decimals, e.g. 12.50.`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
}

export function centsToInput(cents) {
  const c = Math.max(0, Math.trunc(cents || 0));
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

/** "8.25" (percent) -> 825 basis points. */
export function parsePercentToBp(text, label = 'Rate') {
  const t = String(text ?? '').trim().replace(/%$/, '').trim();
  if (t === '') return 0;
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(t);
  const bp = m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0) : NaN;
  if (!m || bp > 10000) throw new Error(`${label} must be between 0 and 100 with at most 2 decimals.`);
  return bp;
}

export function bpToInput(bp) {
  const v = Math.max(0, Math.trunc(bp || 0));
  const whole = Math.floor(v / 100);
  const frac = String(v % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

export function formatBp(bp) {
  return `${bpToInput(bp)}%`;
}

export function parseWholeNumber(text, { label = 'Value', min = 0, max = 1_000_000 } = {}) {
  const t = String(text ?? '').trim();
  if (!/^\d+$/.test(t)) throw new Error(`${label} must be a whole number.`);
  const n = Number(t);
  if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return n;
}

/** Empty -> null; otherwise a finite number within range. */
export function parseOptionalNumber(text, { label = 'Value', min = 0, max = 1000 } = {}) {
  const t = String(text ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < min || n > max || !/^\d*\.?\d+$|^\d+\.?$/.test(t)) {
    throw new Error(`${label} must be a number between ${min} and ${max}.`);
  }
  return n;
}

const pad = (n) => String(n).padStart(2, '0');
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function relTime(iso, now = Date.now()) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return fmtDate(iso.slice(0, 10));
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const LABELS = {
  project_status: { planning: 'Planning', in_progress: 'In progress', testing: 'Testing', completed: 'Completed', on_hold: 'On hold' },
  task_status: { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' },
  priority: { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' },
  category: {
    sensor: 'Sensor', motor: 'Motor', controller: 'Controller', driver: 'Driver', battery: 'Battery',
    structural: 'Structural', fastener: 'Fastener', wiring: 'Wiring', other: 'Other',
  },
};

export const BADGE_KIND = {
  project_status: { planning: '', in_progress: 'blue', testing: 'cyan', completed: 'green', on_hold: 'amber' },
  task_status: { todo: '', in_progress: 'blue', blocked: 'red', done: 'green' },
  priority: { low: '', medium: 'cyan', high: 'amber', critical: 'red' },
};

export const label = (group, key) => LABELS[group]?.[key] ?? key;

export const plural = (n, one, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;
