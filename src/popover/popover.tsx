import React, { useEffect, useState } from "react";
import "@primer/primitives/dist/css/functional/themes/light.css";
import "@primer/primitives/dist/css/functional/themes/dark.css";
import "@primer/css/dist/primer.css";
import {
  ThemeProvider,
  BaseStyles,
  Heading,
  Text,
  Link,
  Spinner,
  Stack,
} from "@primer/react";
import { GearIcon, GitPullRequestIcon, GitPullRequestDraftIcon } from "@primer/octicons-react";
import type { PullRequest } from "../background/fetchPullRequests";

type State =
  | { status: "loading" }
  | { status: "no-token" }
  | { status: "no-repos" }
  | { status: "done"; prs: PullRequest[] }
  | { status: "error"; message: string };

export const PopoverContent = () => {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    chrome.storage.sync.get({ githubToken: "", repos: [] }, (stored) => {
      if (!stored.githubToken) {
        setState({ status: "no-token" });
        return;
      }
      if (!stored.repos?.length) {
        setState({ status: "no-repos" });
        return;
      }

      chrome.runtime.sendMessage({ action: "GET_PULL_REQUESTS" }, (response) => {
        if (chrome.runtime.lastError) {
          setState({ status: "error", message: chrome.runtime.lastError.message ?? "Unknown error" });
          return;
        }
        setState({ status: "done", prs: response?.payload ?? [] });
      });
    });
  }, []);

  const openOptionsPage = (e: React.MouseEvent) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };

  return (
    <ThemeProvider colorMode="auto">
      <BaseStyles style={{ minWidth: 320, maxWidth: 480, padding: "12px 16px" }}>
        <Stack direction="vertical" gap="normal">
          <Heading as="h2" variant="small">
            GitHub PR Reviews
          </Heading>

          {state.status === "loading" && (
            <Stack direction="horizontal" gap="condensed" align="center">
              <Spinner size="small" />
              <Text size="small">Loading pull requests…</Text>
            </Stack>
          )}

          {state.status === "no-token" && (
            <Text size="small">
              No GitHub token set.{" "}
              <Link href="#" onClick={openOptionsPage}>
                Open settings
              </Link>{" "}
              to add one.
            </Text>
          )}

          {state.status === "no-repos" && (
            <Text size="small">
              No repositories configured.{" "}
              <Link href="#" onClick={openOptionsPage}>
                Open settings
              </Link>{" "}
              to add some.
            </Text>
          )}

          {state.status === "error" && (
            <Text size="small" style={{ color: "var(--fgColor-danger)" }}>
              Error: {state.message}
            </Text>
          )}

          {state.status === "done" && state.prs.length === 0 && (
            <Text size="small" style={{ color: "var(--fgColor-muted)" }}>
              No open pull requests.
            </Text>
          )}

          {state.status === "done" && state.prs.length > 0 && (
            <PullRequestList prs={state.prs} />
          )}

          <Link
            href="#"
            onClick={openOptionsPage}
            style={{ fontSize: "var(--text-body-size-small)", display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <GearIcon size={12} />
            Settings
          </Link>
        </Stack>
      </BaseStyles>
    </ThemeProvider>
  );
};

const PullRequestList = ({ prs }: { prs: PullRequest[] }) => {
  const byRepo = prs.reduce<Record<string, PullRequest[]>>((acc, pr) => {
    (acc[pr.repo] ??= []).push(pr);
    return acc;
  }, {});

  return (
    <Stack direction="vertical" gap="normal">
      {Object.entries(byRepo).map(([repo, repoPrs]) => (
        <Stack key={repo} direction="vertical" gap="condensed">
          <Text size="small" weight="semibold" style={{ color: "var(--fgColor-muted)" }}>
            {repo}
          </Text>
          {repoPrs.slice(0, 10).map((pr) => (
            <Stack key={pr.id} direction="horizontal" gap="condensed" align="center">
              {pr.draft
                ? <span style={{ flexShrink: 0, color: "var(--fgColor-muted)", display: "flex" }}><GitPullRequestDraftIcon size={16} /></span>
                : <span style={{ flexShrink: 0, color: "var(--fgColor-open)", display: "flex" }}><GitPullRequestIcon size={16} /></span>
              }
              <img
                src={pr.user.avatar_url}
                alt={pr.user.login}
                width={20}
                height={20}
                style={{ borderRadius: "50%", flexShrink: 0 }}
              />
              <Link
                href={pr.html_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  opacity: pr.draft ? 0.6 : 1,
                }}
              >
                #{pr.number} {pr.title}
              </Link>
            </Stack>
          ))}
          {repoPrs.length > 10 && (
            <Link
              href={`https://github.com/${repo}/pulls`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: "var(--text-body-size-small)" }}
            >
              +{repoPrs.length - 10} more — view all on GitHub
            </Link>
          )}
        </Stack>
      ))}
    </Stack>
  );
};

