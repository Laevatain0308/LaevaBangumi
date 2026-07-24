export function parseAirDate(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (/^\d{4}$/.test(text) && text !== "0000") {
    return { value: text, precision: "year", year: Number(text) };
  }
  if (/^\d{4}-\d{2}$/.test(text)) {
    const [year, month] = text.split("-").map(Number);
    if (year > 0 && month >= 1 && month <= 12) {
      return { value: text, precision: "month", year, month };
    }
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (
      year > 0
      && check.getUTCFullYear() === year
      && check.getUTCMonth() === month - 1
      && check.getUTCDate() === day
    ) {
      return { value: text, precision: "day", year, month, day };
    }
  }
  return null;
}
