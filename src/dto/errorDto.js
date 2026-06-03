import { envelope } from "./apiEnvelope.js";

export function errorEnvelope(data, {
  message,
  warnings = null,
  updatedAt = new Date().toISOString(),
  meta = {},
} = {}) {
  const normalizedWarnings = warnings ?? (message ? [message] : []);
  return envelope(data, {
    updatedAt,
    meta: {
      ...meta,
      warnings: normalizedWarnings,
    },
  });
}

export function serverErrorEnvelope(data, error, {
  updatedAt = new Date().toISOString(),
  meta = {},
} = {}) {
  return envelope(data, {
    updatedAt,
    meta: {
      ...meta,
      error: error?.message ?? String(error),
    },
  });
}
