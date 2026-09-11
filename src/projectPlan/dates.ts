export const DAY_MS = 86_400_000;

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function diffDays(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

export function formatDay(d: Date): string {
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function toInputDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromInputDate(s: string): Date | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}

export function parseFlexibleDate(raw: string): Date | undefined {
  const s = raw.trim();
  if (!s) return undefined;

  const serial = Number(s.replace(",", "."));
  if (Number.isFinite(serial) && serial > 20_000 && serial < 90_000) {
    const epoch = Date.UTC(1899, 11, 30);
    const utc = new Date(epoch + serial * DAY_MS);
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
  }

  const br = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})/.exec(s);
  if (br) {
    let day = Number(br[1]);
    let month = Number(br[2]);
    let year = Number(br[3]);
    if (year < 100) year += 2000;
    if (month > 12 && day <= 12) {
      const tmp = day;
      day = month;
      month = tmp;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(year, month - 1, day);
    }
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const ms = Date.parse(s);
  if (Number.isFinite(ms)) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  return undefined;
}

export function parseDurationDays(raw: string, hoursPerDay = 8): number | undefined {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  const iso = parseIsoDurationDays(s, hoursPerDay);
  if (iso != null) return iso;
  const num = s
    .replace(",", ".")
    .replace(/dias?|days?|d\b|semanas?|weeks?|w\b|horas?|hours?|h\b|hrs?/g, " ")
    .trim();
  const n = Number.parseFloat(num);
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (/semana|week|\bw\b/.test(s)) return n * 5;
  if (/hora|hour|\bh\b/.test(s)) return n / hoursPerDay;
  return n;
}

export function parseIsoDurationDays(raw: string, hoursPerDay = 8): number | undefined {
  const s = raw.trim().toUpperCase();
  if (!s.startsWith("P")) return undefined;
  const day = /P(?:(\d+(?:\.\d+)?)D)?/.exec(s);
  const time = /T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(s);
  let hours = 0;
  if (day?.[1]) hours += Number(day[1]) * hoursPerDay;
  if (time) {
    hours += Number(time[1] || 0);
    hours += Number(time[2] || 0) / 60;
    hours += Number(time[3] || 0) / 3600;
  }
  if (hours <= 0 && !day?.[1]) return undefined;
  return Math.round((hours / hoursPerDay) * 10) / 10;
}

export function recomputePlanRange(minCandidates: Array<Date | undefined>, padStart = 3, padEnd = 14): {
  minDate: Date;
  maxDate: Date;
} {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const d of minCandidates) {
    if (!d) continue;
    const t = startOfDay(d).getTime();
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  if (!Number.isFinite(min)) {
    const today = startOfDay(new Date());
    return { minDate: addDays(today, -7), maxDate: addDays(today, 60) };
  }
  return {
    minDate: addDays(new Date(min), -padStart),
    maxDate: addDays(new Date(max), padEnd),
  };
}
