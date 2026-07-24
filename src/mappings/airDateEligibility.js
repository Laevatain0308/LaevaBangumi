import { parseAirDate } from "../lib/airDate.js";

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function shanghaiDateParts(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock returned an invalid date");
  const values = Object.fromEntries(shanghaiDateFormatter.formatToParts(date)
    .filter(({ type }) => type !== "literal")
    .map(({ type, value }) => [type, Number(value)]));
  return { year: values.year, month: values.month, day: values.day };
}

export function classifyAirDate(value, now = new Date()) {
  const parsed = parseAirDate(value);
  if (!parsed) return { kind: "invalid", precision: null, eligibleOn: null };
  const today = shanghaiDateParts(now);

  if (parsed.precision === "year") {
    return {
      kind: parsed.year < today.year ? "aired" : "unknown",
      precision: "year",
      eligibleOn: null,
    };
  }
  if (parsed.precision === "month") {
    const aired = parsed.year < today.year
      || (parsed.year === today.year && parsed.month < today.month);
    return { kind: aired ? "aired" : "unknown", precision: "month", eligibleOn: null };
  }

  const todayValue = [today.year, today.month, today.day]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
  if (parsed.value <= todayValue) {
    return { kind: "aired", precision: "day", eligibleOn: null };
  }
  return { kind: "scheduled", precision: "day", eligibleOn: parsed.value };
}
