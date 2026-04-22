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
