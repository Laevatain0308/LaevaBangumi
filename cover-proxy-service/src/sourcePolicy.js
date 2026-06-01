const DEFAULT_ALLOWED_HOSTS = [
  "lain.bgm.tv",
  "bgm.tv",
  "bangumi.tv",
  "chii.in",
];

export function allowedHostsFromEnv(value = process.env.COVER_ALLOWED_HOSTS) {
  return String(value || DEFAULT_ALLOWED_HOSTS.join(","))
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedCoverSource(sourceUrl, allowedHosts = allowedHostsFromEnv()) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  return allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}
