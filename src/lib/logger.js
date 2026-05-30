function stamp() {
  return new Date().toISOString();
}

function formatMeta(meta) {
  if (meta == null) return "";
  if (typeof meta === "string") return ` ${meta}`;
  return ` ${JSON.stringify(meta)}`;
}

export function debug(scope, message, meta) {
  if (process.env.LOG_LEVEL !== "debug") return;
  console.log(`[${stamp()}] [${scope}] ${message}${formatMeta(meta)}`);
}

export function log(scope, message, meta) {
  console.log(`[${stamp()}] [${scope}] ${message}${formatMeta(meta)}`);
}

export function warn(scope, message, meta) {
  console.warn(`[${stamp()}] [${scope}] ${message}${formatMeta(meta)}`);
}

export function error(scope, message, errOrMeta) {
  const meta = errOrMeta instanceof Error
    ? { message: errOrMeta.message, stack: errOrMeta.stack }
    : errOrMeta;
  console.error(`[${stamp()}] [${scope}] ${message}${formatMeta(meta)}`);
}
