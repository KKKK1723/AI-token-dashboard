const FORMATTERS = new Map();

function formatter(timezone) {
  if (!FORMATTERS.has(timezone)) {
    FORMATTERS.set(
      timezone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    );
  }
  return FORMATTERS.get(timezone);
}

export function dateInTimezone(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addUtcDays(dateText, amount) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function rollingDateRange(now, timezone, days = 30) {
  const end = dateInTimezone(now, timezone);
  return { start: addUtcDays(end, -(days - 1)), end };
}
