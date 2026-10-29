import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_CAPACITY,
  DEFAULT_MAX_DELAY,
  DEFAULT_MIN_DELAY,
  DUPLICATE,
  JITTER_DIVISOR,
  LATE,
  MAX_CAPACITY,
  SEQUENCE_HALF,
  SEQUENCE_MAX,
  SEQUENCE_MODULUS,
  STALE,
  STATUSES,
  STORED,
  TOO_FAR
} from "../src/index.js";
import * as api from "../src/index.js";

const root = new URL("..", import.meta.url);

test("public exports stay limited to the documented surface", () => {
  assert.deepEqual(Object.keys(api).sort(), [
    "DEFAULT_CAPACITY",
    "DEFAULT_MAX_DELAY",
    "DEFAULT_MIN_DELAY",
    "DUPLICATE",
    "JITTER_DIVISOR",
    "JitterBuffer",
    "LATE",
    "MAX_CAPACITY",
    "SEQUENCE_HALF",
    "SEQUENCE_MAX",
    "SEQUENCE_MODULUS",
    "STALE",
    "STATUSES",
    "STORED",
    "TOO_FAR"
  ]);
  assert.equal(STORED, "stored");
  assert.equal(DUPLICATE, "duplicate");
  assert.equal(LATE, "late");
  assert.equal(STALE, "stale");
  assert.equal(TOO_FAR, "too-far");
  assert.deepEqual(STATUSES, ["stored", "duplicate", "late", "stale", "too-far"]);
  assert.equal(Object.isFrozen(STATUSES), true);
  assert.equal(SEQUENCE_MODULUS, 65536);
  assert.equal(SEQUENCE_MAX, 65535);
  assert.equal(SEQUENCE_HALF, 32768);
  assert.equal(JITTER_DIVISOR, 16);
  assert.equal(MAX_CAPACITY, 32767);
  assert.equal(DEFAULT_MIN_DELAY, 0);
  assert.equal(DEFAULT_MAX_DELAY, Number.POSITIVE_INFINITY);
  assert.equal(DEFAULT_CAPACITY, 64);
});

test("package metadata names the module and the author", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal(pkg.name, "@aneron/jitter-buffer");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.author, "Vadim Gubin");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.sideEffects, false);
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.main, "./src/index.js");
  assert.equal(pkg.exports, "./src/index.js");
  const license = readFileSync(new URL("LICENSE", root), "utf8");
  assert.equal(license.includes("Copyright (c) 2026 Vadim Gubin"), true);
  assert.equal(license.includes("anerongames"), false);
  const readme = readFileSync(new URL("README.md", root), "utf8");
  for (const heading of [
    "## Purpose",
    "## Install",
    "## Usage",
    "## API",
    "## Design",
    "## License"
  ]) {
    assert.equal(readme.includes(heading), true, heading);
  }
  assert.equal(readme.includes("## Design notes"), false);
  assert.equal(readme.includes("## API reference"), false);
  assert.equal(readme.includes("[130, 150, 170]"), true);
  assert.equal(readme.includes("[65535, 0, 1]"), true);
  assert.equal(readme.includes("losses` is `[5]`"), true);
  assert.equal(readme.includes("`[65535, 0]`"), true);
  assert.equal(readme.includes("jitter is `2`"), true);
  assert.equal(readme.includes("delay is `5`"), true);
});

test("source files do not contain comments, clocks, timers, or network calls", () => {
  const files = readdirSync(new URL("src/", root));
  assert.deepEqual(files, ["index.js"]);
  const source = readFileSync(new URL("src/index.js", root), "utf8");
  assert.equal(source.includes("/*"), false);
  assert.equal(source.includes("//"), false);
  assert.equal(source.includes("import "), false);
  assert.equal(source.includes("require("), false);
  assert.equal(source.includes("node:"), false);
  for (const token of [
    "Date",
    "setTimeout",
    "setInterval",
    "Math.random",
    "process",
    "fetch(",
    "globalThis",
    "queueMicrotask",
    "setImmediate",
    "performance"
  ]) {
    assert.equal(source.includes(token), false, token);
  }
});

test("the lockfile resolves only from the npm registry", () => {
  const lockPath = new URL("package-lock.json", root);
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(lock.lockfileVersion >= 2, true);
  const text = readFileSync(lockPath, "utf8");
  assert.equal(text.includes("git+"), false);
  assert.equal(text.includes("github:"), false);
  assert.equal(text.includes("registry.yarnpkg.com"), false);
  let resolved = 0;
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      if (typeof value.resolved === "string") {
        resolved += 1;
        assert.equal(
          value.resolved.startsWith("https://registry.npmjs.org/"),
          true,
          value.resolved
        );
      }
      for (const key of Object.keys(value)) {
        walk(value[key]);
      }
    }
  };
  walk(lock);
  assert.equal(resolved > 0, true);
});
