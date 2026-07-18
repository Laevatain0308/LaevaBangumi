#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { initDb, sqlite } from "../db/index.js";
import { createAccountRepository } from "../accounts/accountRepository.js";
import { createAccountService } from "../accounts/accountService.js";

const ALLOWED_OPTIONS = {
  add: new Set(["username", "password"]),
  "set-password": new Set(["username", "password"]),
  delete: new Set(["username"]),
  list: new Set(),
};

const USAGE = "Usage: account.js <add|set-password|delete|list> [--username value] [--password value]";

function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (typeof flag !== "string" || !flag.startsWith("--")) {
      throw new Error(`Unexpected argument: ${flag}`);
    }
    const key = flag.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown option for command: ${flag}`);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${flag}`);

    const value = args[index + 1];
    if (value == null || String(value).startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    options[key] = value;
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

export function runAccountCommand(argv, { service }) {
  const [command, ...args] = argv;
  const allowed = ALLOWED_OPTIONS[command];
  if (!allowed) throw new Error(USAGE);
  const options = parseOptions(args, allowed);

  switch (command) {
    case "add":
      return {
        account: service.addAccount({
          username: requireOption(options, "username"),
          password: requireOption(options, "password"),
        }),
      };
    case "set-password":
      return service.setPassword({
        username: requireOption(options, "username"),
        password: requireOption(options, "password"),
      });
    case "delete":
      return service.deleteAccount(requireOption(options, "username"));
    case "list":
      return { accounts: service.listAccounts() };
    default:
      throw new Error(USAGE);
  }
}

function main() {
  initDb();
  const repository = createAccountRepository({ sqlite });
  const service = createAccountService({ repository });
  const result = runAccountCommand(process.argv.slice(2), { service });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
