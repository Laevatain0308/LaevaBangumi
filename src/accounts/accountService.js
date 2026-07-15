import { createHash, randomBytes } from "node:crypto";
import {
  hashPassword,
  normalizeUsername,
  verifyPassword,
} from "./password.js";

const INVALID_CREDENTIALS = Object.freeze({ invalidCredentials: true });

function tokenHash(rawToken) {
  return createHash("sha256").update(rawToken).digest("hex");
}

function validateDeviceId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new TypeError("deviceId must be between 1 and 128 characters");
  }
  return value;
}

function validateOptionalDeviceField(name, value) {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 128) {
    throw new TypeError(`${name} must be null or at most 128 characters`);
  }
  return value;
}

function validateDevice({ deviceId, deviceName, platform, appVersion }) {
  return {
    deviceId: validateDeviceId(deviceId),
    deviceName: validateOptionalDeviceField("deviceName", deviceName),
    platform: validateOptionalDeviceField("platform", platform),
    appVersion: validateOptionalDeviceField("appVersion", appVersion),
  };
}

function isUsernameConstraint(error) {
  return error?.code === "SQLITE_CONSTRAINT_UNIQUE"
    && error.message?.includes("UNIQUE constraint failed: accounts.username");
}

export function createAccountService({
  repository,
  clock: _clock = () => new Date(),
  randomBytesImpl = randomBytes,
}) {
  function addAccount({ username: usernameValue, password }) {
    const username = normalizeUsername(usernameValue);
    const passwordHash = hashPassword(password, { randomBytesImpl });
    return repository.transaction(() => {
      if (repository.findAccountByUsername(username)) {
        throw new Error(`account ${username} already exists`);
      }
      try {
        const account = repository.createAccount({ username, passwordHash });
        return {
          username: account.username,
          createdAt: account.createdAt,
          passwordChangedAt: account.passwordChangedAt,
        };
      } catch (error) {
        if (isUsernameConstraint(error)) {
          throw new Error(`account ${username} already exists`, { cause: error });
        }
        throw error;
      }
    });
  }

  function setPassword({ username: usernameValue, password }) {
    const username = normalizeUsername(usernameValue);
    const passwordHash = hashPassword(password, { randomBytesImpl });
    return repository.transaction(() => {
      const result = repository.replacePasswordAndRevokeTokens({ username, passwordHash });
      if (!result) throw new Error(`account ${username} does not exist`);
      return {
        account: {
          username: result.account.username,
          passwordChangedAt: result.account.passwordChangedAt,
        },
        revokedTokenCount: result.revokedTokenCount,
      };
    });
  }

  function deleteAccount(usernameValue) {
    const username = normalizeUsername(usernameValue);
    return repository.transaction(() => {
      const account = repository.deleteAccount(username);
      if (!account) throw new Error(`account ${username} does not exist`);
      return account;
    });
  }

  function listAccounts() {
    return repository.listAccounts();
  }

  function login({
    username: usernameValue,
    password,
    deviceId,
    deviceName,
    platform,
    appVersion,
  }) {
    try {
      return repository.transaction(() => {
        const username = normalizeUsername(usernameValue);
        const device = validateDevice({ deviceId, deviceName, platform, appVersion });
        const account = repository.findAccountByUsername(username);
        if (!account || !verifyPassword(password, account.passwordHash)) {
          throw INVALID_CREDENTIALS;
        }

        const rawToken = `lbat_${randomBytesImpl(32).toString("base64url")}`;
        repository.rotateDeviceToken({
          accountId: account.accountId,
          device,
          tokenHash: tokenHash(rawToken),
        });
        return {
          account: { username: account.username },
          deviceId: device.deviceId,
          token: rawToken,
        };
      });
    } catch (error) {
      if (error === INVALID_CREDENTIALS) return null;
      throw error;
    }
  }

  function authenticate(rawToken) {
    if (typeof rawToken !== "string" || !rawToken.startsWith("lbat_")) return null;
    const auth = repository.findActiveToken(tokenHash(rawToken));
    if (!auth) return null;
    if (!repository.touchToken(auth.tokenId)) return null;
    return auth;
  }

  function logout(tokenId) {
    return repository.revokeToken(tokenId);
  }

  function status(auth) {
    return {
      username: auth.username,
      currentDevice: auth.device,
      devices: repository.listDevices(auth.accountId),
    };
  }

  return {
    addAccount,
    setPassword,
    deleteAccount,
    listAccounts,
    login,
    authenticate,
    logout,
    status,
  };
}
