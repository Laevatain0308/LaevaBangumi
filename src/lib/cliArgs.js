const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);

export function parseCliArgs(argv = process.argv.slice(2)) {
  const options = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--") {
      positionals.push(arg);
      continue;
    }

    if (arg.startsWith("--no-")) {
      options[arg.slice(5)] = "false";
      continue;
    }

    const raw = arg.slice(2);
    const eqIndex = raw.indexOf("=");
    if (eqIndex !== -1) {
      options[raw.slice(0, eqIndex)] = raw.slice(eqIndex + 1);
      continue;
    }

    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) {
      options[raw] = next;
      i++;
    } else {
      options[raw] = "true";
    }
  }

  return { options, positionals };
}

export function getStringArg(args, name, fallback = null) {
  const value = args.options[name];
  return value == null || value === "" ? fallback : value;
}

export function getIntArg(args, name, fallback = null) {
  const value = getStringArg(args, name, null);
  if (value == null) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function getNumberArg(args, name, fallback = null) {
  const value = getStringArg(args, name, null);
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getBoolArg(args, name, fallback = false) {
  const value = getStringArg(args, name, null);
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (FALSE_VALUES.has(normalized)) return false;
  if (TRUE_VALUES.has(normalized)) return true;
  return fallback;
}

