export function normalizeBangumiCalendar(calendar) {
  return (Array.isArray(calendar) ? calendar : [])
    .map((day) => ({
      weekday: normalizeWeekday(day?.weekday),
      items: Array.isArray(day?.items) ? day.items.filter((item) => item?.id) : [],
    }))
    .filter((day) => day.weekday?.id);
}

function normalizeWeekday(weekday) {
  if (!weekday) return null;
  return {
    en: weekday.en ?? null,
    cn: weekday.cn ?? null,
    ja: weekday.ja ?? null,
    id: Number.parseInt(weekday.id, 10) || null,
  };
}
