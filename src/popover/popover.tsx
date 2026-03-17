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
  IconButton,
  SegmentedControl,
} from "@primer/react";
import { GearIcon, GitPullRequestIcon, GitPullRequestDraftIcon, SyncIcon } from "@primer/octicons-react";
import type { PullRequest, RepoError } from "../background/fetchPullRequests";

type State =
  | { status: "loading" }
  | { status: "no-token" }
  | { status: "no-repos" }
  | { status: "done"; prs: PullRequest[]; errors: RepoError[]; repos: string[] }
  | { status: "error"; message: string };

type ViewMode = "review" | "mine";

export const PopoverContent = () => {
  const [state, setState] = useState<State>({ status: "loading" });
  const [refreshCount, setRefreshCount] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode | null>(null);

  useEffect(() => {
    chrome.storage.local.get({ viewMode: "review" }, (stored) => {
      setViewMode(stored.viewMode as ViewMode);
    });
  }, []);

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    chrome.storage.local.set({ viewMode: mode });
  };

  useEffect(() => {
    if (viewMode === null) return;
    setState({ status: "loading" });
    chrome.storage.sync.get({ githubToken: "", repos: [] }, (stored) => {
      if (!stored.githubToken) {
        setState({ status: "no-token" });
        return;
      }
      if (!stored.repos?.length) {
        setState({ status: "no-repos" });
        return;
      }

      const action = viewMode === "review" ? "GET_PULL_REQUESTS" : "GET_MY_PULL_REQUESTS";
      chrome.runtime.sendMessage({ action }, (response) => {
        if (chrome.runtime.lastError) {
          setState({ status: "error", message: chrome.runtime.lastError.message ?? "Unknown error" });
          return;
        }
        setState({ status: "done", prs: response?.payload ?? [], errors: response?.errors ?? [], repos: stored.repos });
      });
    });
  }, [refreshCount, viewMode]);

  const handleRefresh = () => setRefreshCount((c) => c + 1);

  const openOptionsPage = (e: React.MouseEvent) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };

  return (
    <ThemeProvider colorMode="auto">
      <BaseStyles style={{ minWidth: 320, maxWidth: 480, padding: "12px 16px", minHeight: "100vh", display: "grid", gridTemplateRows: "1fr auto", gridTemplateColumns: "100%" }}>
        <Stack direction="vertical" gap="normal">
          <Stack direction="horizontal" align="center" style={{ justifyContent: "space-between" }}>
            <Heading as="h2" variant="small">
              GitHub PR Reviews
            </Heading>
            <IconButton
              icon={state.status === "loading" ? Spinner : SyncIcon}
              aria-label="Refresh"
              size="small"
              variant="invisible"
              onClick={handleRefresh}
              disabled={state.status === "loading"}
            />
          </Stack>

          <SegmentedControl aria-label="View mode" fullWidth key={viewMode}>
            <SegmentedControl.Button
              selected={viewMode === "review"}
              onClick={() => handleViewModeChange("review")}
            >
              Review Requests
            </SegmentedControl.Button>
            <SegmentedControl.Button
              selected={viewMode === "mine"}
              onClick={() => handleViewModeChange("mine")}
            >
              My Open PRs
            </SegmentedControl.Button>
          </SegmentedControl>

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

          {state.status === "done" && (
            <PullRequestList prs={state.prs} repos={state.repos} errors={state.errors} viewMode={viewMode!} />
          )}
        </Stack>

        <Link
          href="#"
          onClick={openOptionsPage}
          style={{ fontSize: "var(--text-body-size-small)", display: "inline-flex", alignItems: "center", gap: 4, paddingTop: 8 }}
        >
          <GearIcon size={12} />
          Settings
        </Link>
      </BaseStyles>
    </ThemeProvider>
  );
};

const PullRequestList = ({ prs, repos, errors, viewMode }: { prs: PullRequest[]; repos: string[]; errors: RepoError[]; viewMode: ViewMode }) => {
  const byRepo = prs.reduce<Record<string, PullRequest[]>>((acc, pr) => {
    (acc[pr.repo] ??= []).push(pr);
    return acc;
  }, {});

  const errorByRepo = errors.reduce<Record<string, RepoError>>((acc, err) => {
    acc[err.repo] = err;
    return acc;
  }, {});

  return (
    <Stack direction="vertical" gap="normal">
      {repos.map((repo) => {
        const repoPrs = byRepo[repo] ?? [];
        const repoError = errorByRepo[repo];
        return (
          <Stack key={repo} direction="vertical" gap="condensed">
            <Text size="small" weight="semibold" style={{ color: "var(--fgColor-muted)" }}>
              {repo}
            </Text>
            {repoError && (
              <Text size="small" style={{ color: "var(--fgColor-danger)" }}>
                {repoError.message}{" "}
                {repoError.ssoAuthorizeUrl && (
                  <Link href={repoError.ssoAuthorizeUrl} target="_blank" rel="noopener noreferrer">
                    Authorize SSO →
                  </Link>
                )}
              </Text>
            )}
            {!repoError && repoPrs.length === 0 && (
              <Text size="small" style={{ color: "var(--fgColor-muted)" }}>
                {viewMode === "review" ? "No pull requests awaiting your review." : "No open pull requests."}
              </Text>
            )}
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
        );
      })}
    </Stack>
  );
};

