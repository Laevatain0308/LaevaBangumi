function hasOwn(value, key) {
  return Object.hasOwn(value, key);
}

function assignPresent(target, targetKey, source, sourceKey = targetKey) {
  if (hasOwn(source, sourceKey)) target[targetKey] = source[sourceKey];
}

function normalizeImages(images) {
  if (images === undefined || images === null) return images;
  const normalized = {};
  for (const [sourceKey, targetKey] of [
    ["large", "largeUrl"],
    ["common", "commonUrl"],
    ["medium", "mediumUrl"],
    ["small", "smallUrl"],
    ["grid", "gridUrl"],
  ]) assignPresent(normalized, targetKey, images, sourceKey);
  return normalized;
}

function normalizeRating(rating) {
  if (rating === undefined || rating === null) return rating;
  const normalized = {};
  assignPresent(normalized, "score", rating);
  assignPresent(normalized, "rank", rating);
  assignPresent(normalized, "total", rating);
  if (Object.hasOwn(rating, "count")) {
    normalized.counts = Array.from({ length: 10 }, (_, index) => rating.count?.[String(index + 1)] ?? 0);
  }
  return normalized;
}

function normalizeCollection(collection) {
  if (collection === undefined || collection === null) return collection;
  const normalized = {};
  assignPresent(normalized, "wish", collection);
  assignPresent(normalized, "collect", collection);
  assignPresent(normalized, "doing", collection);
  assignPresent(normalized, "onHold", collection, "on_hold");
  assignPresent(normalized, "dropped", collection);
  return normalized;
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return tags;
  return tags.map((tag, position) => ({
    position,
    name: tag.name,
    count: tag.count ?? 0,
    totalCount: tag.total_count ?? tag.total_cont ?? 0,
  }));
}

function normalizeMetaTags(metaTags) {
  if (metaTags === undefined || metaTags === null) return metaTags;
  return metaTags.map((name, position) => ({ position, name }));
}

function normalizeInfobox(infobox) {
  if (infobox === undefined || infobox === null) return infobox;
  return infobox.map((entry, entryPosition) => {
    if (typeof entry.value === "string") {
      return {
        entryPosition,
        key: entry.key,
        valueKind: "scalar",
        values: [{ valuePosition: 0, label: null, value: entry.value }],
      };
    }
    return {
      entryPosition,
      key: entry.key,
      valueKind: "list",
      values: entry.value.map((item, valuePosition) => ({
        valuePosition,
        label: item.k ?? null,
        value: item.v,
      })),
    };
  });
}

export function normalizeSubject(value, { weekday } = {}) {
  const subject = { bangumiId: value.id, name: value.name };
  assignPresent(subject, "nameCn", value, "name_cn");
  assignPresent(subject, "summary", value);
  if (hasOwn(value, "air_date")) subject.airDate = value.air_date;
  else assignPresent(subject, "airDate", value, "date");
  if (hasOwn(value, "air_weekday")) subject.airWeekday = value.air_weekday;
  else if (weekday !== undefined) subject.airWeekday = weekday;
  assignPresent(subject, "platform", value);
  assignPresent(subject, "eps", value);
  assignPresent(subject, "totalEpisodes", value, "total_episodes");
  assignPresent(subject, "volumes", value);
  assignPresent(subject, "series", value);
  assignPresent(subject, "locked", value);
  assignPresent(subject, "nsfw", value);

  return {
    subject,
    images: normalizeImages(value.images),
    rating: normalizeRating(value.rating),
    collection: normalizeCollection(value.collection),
    tags: normalizeTags(value.tags),
    metaTags: normalizeMetaTags(value.meta_tags),
    infobox: normalizeInfobox(value.infobox),
  };
}
