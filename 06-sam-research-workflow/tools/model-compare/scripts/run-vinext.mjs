import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const mode = process.argv[2] || "dev";
const forwarded = process.argv.slice(3);
const cli = path.resolve("node_modules", "vinext", "dist", "cli.js");

const child = spawn(process.execPath, ["--use-system-ca", cli, mode, ...forwarded], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    WRANGLER_LOG_PATH:
      process.env.WRANGLER_LOG_PATH || `.wrangler/wrangler-${mode}.log`,
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  if (code && code !== 0) {
    console.error(`vinext ${mode} ended with exit code ${code}.`);
  }
  process.exitCode = code ?? 1;
});
