import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

function validPasswordShape(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 256;
}

function assertPassword(password) {
  if (!validPasswordShape(password)) {
    throw new TypeError("password must be between 8 and 256 characters");
  }
}

export function normalizeUsername(value) {
  const username = String(value ?? "").trim().toLowerCase();
  if (username.length < 1 || username.length > 64) {
    throw new TypeError("username must be between 1 and 64 characters");
  }
  return username;
}

export function hashPassword(password, { randomBytesImpl = randomBytes } = {}) {
  assertPassword(password);
  const salt = randomBytesImpl(16).toString("base64url");
  const digest = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${digest}`;
}

export function verifyPassword(password, storedHash) {
  if (!validPasswordShape(password) || typeof storedHash !== "string") return false;

  const parts = storedHash.split("$");
  if (parts.length !== 3) return false;
  const [scheme, salt, encoded] = parts;
  if (
    scheme !== "scrypt"
    || !/^[A-Za-z0-9_-]{22}$/.test(salt)
    || !/^[A-Za-z0-9_-]{86}$/.test(encoded)
  ) {
    return false;
  }

  try {
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(encoded, "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
