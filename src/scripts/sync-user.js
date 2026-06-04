#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { initDb } from "../db/index.js";
import {
  createSyncInvite,
  createSyncToken,
  createSyncUser,
  revokeSyncToken,
} from "../services/syncTokenService.js";

export function runSyncUserCommand(argv) {
  const [command, ...args] = argv;
  const options = parseOptions(args);
  switch (command) {
    case "create-user": {
      const user = createSyncUser(requireOption(options, "name"));
      return { user };
    }
    case "create-token": {
      const userId = Number(requireOption(options, "user-id"));
      const token = createSyncToken({
        userId,
        label: options.label ?? null,
      });
      return {
        tokenId: token.tokenId,
        rawToken: token.rawToken,
      };
    }
    case "revoke-token": {
      const tokenId = Number(requireOption(options, "token-id"));
      revokeSyncToken(tokenId);
      return { revokedTokenId: tokenId };
    }
    case "create-invite": {
      const maxUses = options["max-uses"] == null ? 1 : Number(options["max-uses"]);
      const invite = createSyncInvite({
        label: options.label ?? null,
        maxUses,
        expiresAt: options["expires-at"] ?? null,
      });
      return {
        inviteId: invite.inviteId,
        rawInviteCode: invite.rawInviteCode,
      };
    }
    default:
      throw new Error(
        "Usage: sync-user.js <create-user|create-token|revoke-token|create-invite> [--name value] [--user-id value] [--label value] [--token-id value] [--max-uses value] [--expires-at value]",
      );
  }
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const value = args[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function requireOption(options, key) {
  const value = options[key];
  if (value == null || String(value).trim() === "") {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function main() {
  initDb();
  const result = runSyncUserCommand(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
