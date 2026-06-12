// Timezone-safe date utilities.
//
// Two classes of bug these prevent:
//   1. `new Date("YYYY-MM-DD")` parses as UTC midnight. In negative-UTC
//      zones (e.g. US), `.toLocaleDateString()` then renders the day before.
//   2. `new Date().toISOString().split("T")[0]` returns the UTC calendar
//      date, which differs from the user's local date after 8 PM EDT.

export function localToday(): string {
  return formatLocalYMD(new Date());
}

export function formatLocalYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Parse "YYYY-MM-DD" at local noon so TZ offsets can't flip the day.
export function parseLocalDate(dateStr: string): Date {
  return new Date(dateStr + "T12:00:00");
}

export function formatDateDisplay(
  dateStr: string,
  options?: Intl.DateTimeFormatOptions
): string {
  return parseLocalDate(dateStr).toLocaleDateString(undefined, options);
}

// ET calendar date for a Unix-ms timestamp. Polygon daily bars are ET
// sessions; deriving the date via toISOString() (UTC) can roll past
// midnight and label the bar with the wrong day. en-CA renders YYYY-MM-DD.
export function etDateFromMs(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

// DST-safe day arithmetic on YYYY-MM-DD strings: compute in UTC where every
// day is exactly 86,400,000 ms. Local-time setDate() breaks on DST flips.
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}
