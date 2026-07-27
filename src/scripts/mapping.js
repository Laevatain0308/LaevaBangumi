#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { log, warn, error } from "../lib/logger.js";
import { parseMappingCommand, printMappingResult } from "../mappings/mappingCli.js";

async function main() {
  const command = parseMappingCommand(process.argv.slice(2));
  const [{ initDb, sqlite }, { loadResourceSourceRegistry }, { runMappingCommand }] = await Promise.all([
    import("../db/index.js"),
    import("../resourceSources/pluginRegistry.js"),
    import("../mappings/mappingCli.js"),
  ]);
  initDb();
  const registry = await loadResourceSourceRegistry({
    manifestPath: new URL("../../config/resource-sources.json", import.meta.url),
    db: sqlite,
    logger: { log, warn, error },
  });
  return runMappingCommand({ command, sqlite, registry, logger: { log, error } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(printMappingResult).catch((cause) => {
    console.error(cause.message ?? String(cause));
    process.exitCode = 1;
  });
}
