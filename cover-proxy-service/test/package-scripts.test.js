import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("npm start boots the listening server entrypoint", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.scripts.start, "node src/server.js");
});
