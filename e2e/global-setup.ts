import { execSync } from "node:child_process";
import path from "node:path";

/**
 * Build the extension before the test run so `pnpm test:e2e` is
 * self-contained. Set E2E_SKIP_BUILD=1 to reuse an existing build
 * during development.
 */
export default function globalSetup(): void {
  if (process.env.E2E_SKIP_BUILD === "1") return;
  const root = path.resolve(__dirname, "..");
  execSync("pnpm build", { cwd: root, stdio: "inherit" });
}
