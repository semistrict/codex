#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function readAuth() {
  const authPath = process.env.CODEX_AUTH_PATH ?? path.join(os.homedir(), ".codex", "auth.json");
  const raw = fs.readFileSync(authPath, "utf8");
  const parsed = JSON.parse(raw);
  const accessToken = parsed?.tokens?.access_token;
  const accountId = parsed?.tokens?.account_id;
  if (!accessToken || !accountId) {
    throw new Error(`missing chatgpt tokens in ${authPath}`);
  }
  return { accessToken, accountId };
}

function run() {
  const { accessToken, accountId } = readAuth();
  const args = [
    "wrangler",
    "dev",
    "--port",
    process.env.WRANGLER_PORT ?? "8787",
    "--var",
    `CHATGPT_ACCESS_TOKEN:${accessToken}`,
    "--var",
    `CHATGPT_ACCOUNT_ID:${accountId}`,
    "--var",
    `OPENAI_MODEL:${process.env.OPENAI_MODEL ?? "gpt-5"}`,
  ];
  const modelProxyUrl = process.env.MODEL_HTTP_PROXY_URL;
  if (modelProxyUrl) {
    args.push("--var", `MODEL_HTTP_PROXY_URL:${modelProxyUrl}`);
  }
  const child = spawn("npx", args, {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
