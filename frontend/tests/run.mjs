/**
 * Runs the TypeScript unit tests without adding a test framework.
 *
 * esbuild bundles each `tests/*.test.ts` into a temporary ESM file (the app's
 * modules are TypeScript with Vite-specific imports), then Node's built-in test
 * runner executes the bundle. No jsdom, no browser: these tests cover pure
 * logic only.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests");
const outDir = await mkdtemp(path.join(tmpdir(), "homeledger-tests-"));

try {
  const files = (await readdir(testsDir)).filter((name) => name.endsWith(".test.ts")).sort();
  if (!files.length) {
    console.error("tests/: 没有找到 *.test.ts");
    process.exitCode = 1;
  }
  const outputs = [];
  for (const file of files) {
    const outfile = path.join(outDir, file.replace(/\.ts$/, ".mjs"));
    outputs.push(outfile);
    await build({
      entryPoints: [path.join(testsDir, file)],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      sourcemap: "inline",
      define: { "import.meta.env": "{}" },
      logLevel: "warning",
    });
  }
  if (!process.exitCode) {
    const child = spawn(process.execPath, ["--test", ...outputs], {
      cwd: root,
      stdio: "inherit",
    });
    process.exitCode = await new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
    });
  }
} finally {
  // Keep the temp directory on failure so a stack trace remains inspectable?
  // No: sourcemaps are inline, and leaving files behind is worse.
  await rm(outDir, { recursive: true, force: true });
}
