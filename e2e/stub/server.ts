import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { Server, IncomingMessage, ServerResponse } from "node:http";

export const STUB_USER = "stub-user";

const AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#1f883d"/></svg>'
  );

const pr = (number: number, repo: string, batch: string, title: string, extra: object) => ({
  id: number,
  number,
  title: `${batch} — ${title}`,
  html_url: `https://github.com/${repo}/pull/${number}`,
  user: { login: "someone-else", avatar_url: AVATAR },
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
  draft: false,
  requested_reviewers: [{ login: STUB_USER }],
  ...extra,
});

/**
 * Local HTTPS stand-in for api.github.com. The E2E browser maps
 * api.github.com to this server via --host-resolver-rules, so no real
 * GitHub traffic happens and no credentials are needed.
 *
 * Behavior:
 * - GET /user            → { login: "stub-user" }
 * - GET /repos/<repo>/pulls → PRs tagged with a per-response batch label
 *   ("Batch A", "Batch B", …) so tests can tell one fetch from the next
 * - repos whose path contains "sso" get a 403 with an X-GitHub-SSO header
 *   to exercise the SSO-authorization error path
 */
export class GitHubStubServer {
  port = 0;
  /** Artificial delay for /repos/... responses, to expose cache-first rendering. */
  delayMs = 0;
  /** Every /repos/... response, in order (for asserting fetch counts). */
  repoFetches: string[] = [];

  private server?: Server;
  private batch = 0;

  async start(): Promise<void> {
    const cert = fs.readFileSync(path.join(__dirname, "cert.pem"));
    const key = fs.readFileSync(path.join(__dirname, "key.pem"));
    this.server = https.createServer({ cert, key }, (req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    this.port = (this.server!.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const sendJson = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.end(JSON.stringify(body));
    };

    if (req.url === "/user") {
      sendJson(200, { login: STUB_USER });
      return;
    }

    const pulls = req.url?.match(/^\/repos\/([^/]+\/[^/]+)\/pulls/);
    if (pulls) {
      const repo = pulls[1];
      this.repoFetches.push(repo);

      if (repo.includes("sso")) {
        sendJson(
          403,
          { message: "Resource protected by organization SSO enforcement" },
          { "X-GitHub-SSO": "required; url=https://github.com/orgs/acme/sso?token=abc123" }
        );
        return;
      }

      const batch = `Batch ${String.fromCharCode(65 + this.batch++)}`;
      const body = [
        pr(1, repo, batch, "fix login flow", {}),
        pr(2, repo, batch, "refactor cache layer", {}),
        // Authored by the stub user but not requesting their review —
        // only visible in the "My Open PRs" view
        pr(13, repo, batch, "my own PR", {
          user: { login: STUB_USER, avatar_url: AVATAR },
          requested_reviewers: [],
        }),
      ];
      setTimeout(() => sendJson(200, body), this.delayMs);
      return;
    }

    sendJson(404, {});
  }
}
