export class BangumiPayloadError extends Error {
  constructor(message, { path = "$", code = "invalid_payload" } = {}) {
    super(`${path}: ${message}`);
    this.name = "BangumiPayloadError";
    this.path = path;
    this.code = code;
  }
}

function hasOwn(value, key) {
  return Object.hasOwn(value, key);
}

function fail(message, path, code) {
  throw new BangumiPayloadError(message, { path, code });
}

function assertPlainObject(value, path, message = "must be an object") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(message, path);
}

function assertPositiveInteger(value, path) {
  if (!Number.isInteger(value) || value <= 0) fail("must be a positive integer", path);
}

function assertInteger(value, path) {
  if (!Number.isInteger(value)) fail("must be an integer", path);
}

function assertNonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) fail("must be a non-negative integer", path);
}

function assertNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("must be a finite number", path);
}

function assertString(value, path) {
  if (typeof value !== "string") fail("must be a string", path);
}

function assertBoolean(value, path) {
  if (typeof value !== "boolean") fail("must be a boolean", path);
}

function assertIntegerInRange(value, min, max, path) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`must be an integer from ${min} to ${max}`, path);
}

function validateOptional(value, key, assertion) {
  if (hasOwn(value, key) && value[key] !== null) assertion(value[key], `$.${key}`);
}

function validateOptionalSubjectFields(value) {
  for (const key of ["name_cn", "summary", "date", "air_date", "platform"]) {
    validateOptional(value, key, assertString);
  }
  for (const key of ["eps", "total_episodes", "volumes"]) {
    validateOptional(value, key, assertInteger);
  }
  if (hasOwn(value, "air_weekday") && value.air_weekday !== null) {
    assertIntegerInRange(value.air_weekday, 1, 7, "$.air_weekday");
  }
  for (const key of ["series", "locked", "nsfw"]) {
    validateOptional(value, key, assertBoolean);
  }
}

function validateImages(value, path) {
  if (value === undefined || value === null) return;
  assertPlainObject(value, path);
  for (const key of ["large", "common", "medium", "small", "grid"]) {
    if (hasOwn(value, key) && value[key] !== null) assertString(value[key], `${path}.${key}`);
  }
}

function validateRating(value, path) {
  if (value === undefined || value === null) return;
  assertPlainObject(value, path);
  for (const key of ["score", "rank", "total"]) {
    if (!hasOwn(value, key) || value[key] === null) continue;
    if (key === "score") assertNumber(value[key], `${path}.${key}`);
    else assertNonNegativeInteger(value[key], `${path}.${key}`);
  }
  if (!hasOwn(value, "count") || value.count === null) return;
  assertPlainObject(value.count, `${path}.count`);
  for (let score = 1; score <= 10; score += 1) {
    const key = String(score);
    if (hasOwn(value.count, key)) assertNonNegativeInteger(value.count[key], `${path}.count.${key}`);
  }
}

function validateCollection(value, path) {
  if (value === undefined || value === null) return;
  assertPlainObject(value, path);
  for (const key of ["wish", "collect", "doing", "on_hold", "dropped"]) {
    if (hasOwn(value, key) && value[key] !== null) assertNonNegativeInteger(value[key], `${path}.${key}`);
  }
}

function validateTags(value, path) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) fail("must be an array", path);
  value.forEach((tag, index) => {
    const itemPath = `${path}[${index}]`;
    assertPlainObject(tag, itemPath);
    assertString(tag.name, `${itemPath}.name`);
    if (hasOwn(tag, "count") && tag.count !== null) assertNonNegativeInteger(tag.count, `${itemPath}.count`);
    for (const key of ["total_count", "total_cont"]) {
      if (hasOwn(tag, key) && tag[key] !== null) assertNonNegativeInteger(tag[key], `${itemPath}.${key}`);
    }
  });
}

function validateMetaTags(value, path) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) fail("must be an array", path);
  value.forEach((tag, index) => assertString(tag, `${path}[${index}]`));
}

function validateInfobox(value, path) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) fail("must be an array", path);
  value.forEach((entry, entryIndex) => {
    const entryPath = `${path}[${entryIndex}]`;
    assertPlainObject(entry, entryPath);
    assertString(entry.key, `${entryPath}.key`);
    if (typeof entry.value === "string") return;
    if (!Array.isArray(entry.value)) fail("must be a string or array", `${entryPath}.value`);
    entry.value.forEach((item, valueIndex) => {
      const valuePath = `${entryPath}.value[${valueIndex}]`;
      assertPlainObject(item, valuePath);
      if (hasOwn(item, "k") && item.k !== null) assertString(item.k, `${valuePath}.k`);
      assertString(item.v, `${valuePath}.v`);
    });
  });
}

export function validateAnimeSubject(value, { expectedId } = {}) {
  assertPlainObject(value, "$", "subject must be an object");
  assertPositiveInteger(value.id, "$.id");
  if (value.type !== 2) fail("type must be numeric 2", "$.type", "unsupported_type");
  assertString(value.name, "$.name");
  if (expectedId !== undefined && value.id !== expectedId) {
    fail(`expected ID ${expectedId}, received ${value.id}`, "$.id", "id_mismatch");
  }
  validateOptionalSubjectFields(value);
  validateImages(value.images, "$.images");
  validateRating(value.rating, "$.rating");
  validateCollection(value.collection, "$.collection");
  validateTags(value.tags, "$.tags");
  validateMetaTags(value.meta_tags, "$.meta_tags");
  validateInfobox(value.infobox, "$.infobox");
  return value;
}

export function validateCalendarPayload(value) {
  if (!Array.isArray(value)) fail("calendar must be an array", "$");
  return value.map((day, dayIndex) => {
    const path = `$[${dayIndex}]`;
    assertPlainObject(day, path, "calendar day must be an object");
    assertPlainObject(day.weekday, `${path}.weekday`, "weekday must be an object");
    assertIntegerInRange(day.weekday.id, 1, 7, `${path}.weekday.id`);
    if (!Array.isArray(day.items)) fail("items must be an array", `${path}.items`);
    return { weekday: day.weekday.id, items: day.items };
  });
}
