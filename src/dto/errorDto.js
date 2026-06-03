import { envelope } from "./apiEnvelope.js";

export function errorEnvelope(data, {
  message,
  errorCode = "error",
  warnings = null,
  updatedAt = new Date().toISOString(),
  meta = {},
} = {}) {
  const normalizedWarnings = warnings ?? (message ? [message] : []);
  return envelope(data, {
    updatedAt,
    meta: {
      freshness: "error",
      ...meta,
      warnings: normalizedWarnings,
      error: errorCode,
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
      freshness: "error",
      ...meta,
      warnings: [error?.message ?? String(error)],
      error: "server_error",
    },
  });
}
