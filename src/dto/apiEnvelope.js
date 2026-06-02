export function envelope(data, { updatedAt = new Date().toISOString(), meta = {} } = {}) {
  return { data, updatedAt, meta };
}
