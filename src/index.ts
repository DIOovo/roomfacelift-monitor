import { resolve } from "node:path";
import { runApplication } from "./application.js";
import { redactSecrets } from "./redact.js";

try {
  await runApplication({
    args: process.argv.slice(2),
    environment: process.env,
    onLog: (message) => console.log(message),
    statePath: resolve("data/state.json"),
  });
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
