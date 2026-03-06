import React, { useEffect, useState } from "react";
import "@primer/primitives/dist/css/functional/themes/light.css";
import "@primer/primitives/dist/css/functional/themes/dark.css";
import "@primer/css/dist/primer.css";
import {
  ThemeProvider,
  BaseStyles,
  Heading,
  FormControl,
  TextInput,
  Button,
  Text,
  Stack,
  IconButton,
  Link,
} from "@primer/react";
import { XIcon, EyeIcon, EyeClosedIcon } from "@primer/octicons-react";

interface Settings {
  githubToken: string;
  repos: string[];
}

const defaultSettings: Settings = {
  githubToken: "",
  repos: [],
};

export const OptionsPage = () => {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [saved, setSaved] = useState(false);
  const [newRepo, setNewRepo] = useState("");
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    chrome.storage.sync.get(defaultSettings, (stored) => {
      setSettings(stored as Settings);
    });
  }, []);

  const saveSettings = (updated: Settings) => {
    chrome.storage.sync.set(updated, () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  const handleSave = () => {
    saveSettings(settings);
  };

  const handleAddRepo = () => {
    const trimmed = newRepo
      .trim()
      .replace(/^https?:\/\/(www\.)?github\.com\//, "")
      .replace(/\/+$/, "");
    if (!trimmed || settings.repos.includes(trimmed)) return;
    const updated = { ...settings, repos: [...settings.repos, trimmed] };
    setSettings(updated);
    saveSettings(updated);
    setNewRepo("");
  };

  const handleRemoveRepo = (repo: string) => {
    const updated = {
      ...settings,
      repos: settings.repos.filter((r) => r !== repo),
    };
    setSettings(updated);
    saveSettings(updated);
  };

  return (
    <ThemeProvider colorMode="auto">
      <BaseStyles
          style={{ height: '100%', padding: "0 16px" }}
      >
        <Stack
          direction="vertical"
          gap="normal"
          style={{ maxWidth: 480, padding: "0 16px" }}
        >
          <Heading as="h1" variant="large">
            GitHub Reviews — Settings
          </Heading>

          <FormControl>
            <FormControl.Label>GitHub Personal Access Token</FormControl.Label>
            <TextInput
              type={showToken ? "text" : "password"}
              value={settings.githubToken}
              onChange={(e) =>
                setSettings({ ...settings, githubToken: e.target.value })
              }
              placeholder="ghp_..."
              monospace
              block
              trailingAction={
                <TextInput.Action
                  onClick={() => setShowToken((v) => !v)}
                  icon={showToken ? EyeClosedIcon : EyeIcon}
                  aria-label={showToken ? "Hide token" : "Show token"}
                />
              }
            />
            <FormControl.Caption>
              Used to authenticate requests to the GitHub API. <br /> Generate a token with <code>Pull Request</code> scope from your <Link href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer">GitHub settings</Link       >.
            </FormControl.Caption>
          </FormControl>

          <FormControl>
            <FormControl.Label>Repositories to check</FormControl.Label>
            <Stack direction="vertical" gap="condensed">
              {settings.repos.map((repo) => (
                <Stack key={repo} direction="horizontal" gap="condensed" align="center">
                  <Text
                    size="small"
                    style={{
                      flex: 1,
                      padding: "6px 8px",
                      borderRadius: 6,
                      background: "var(--bgColor-muted)",
                      fontFamily: "monospace",
                    }}
                  >
                    {repo}
                  </Text>
                  <IconButton
                    icon={XIcon}
                    aria-label={`Remove ${repo}`}
                    size="small"
                    variant="invisible"
                    onClick={() => handleRemoveRepo(repo)}
                  />
                </Stack>
              ))}
              <Stack direction="horizontal" gap="condensed">
                <TextInput
                  value={newRepo}
                  onChange={(e) => setNewRepo(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddRepo()}
                  placeholder="owner/repo"
                  style={{ flex: 1 }}
                />
                <Button onClick={handleAddRepo} disabled={!newRepo.trim()}>
                  Add
                </Button>
              </Stack>
            </Stack>
            <FormControl.Caption>
              Add repos in <code>owner/repo</code> format.
            </FormControl.Caption>
          </FormControl>

          <Stack direction="horizontal" gap="normal" align="center">
            <Button variant="primary" onClick={handleSave}>
              Save
            </Button>
            {saved && (
              <Text size="small" style={{ color: "var(--fgColor-success)" }}>
                ✓ Saved!
              </Text>
            )}
          </Stack>
        </Stack>
      </BaseStyles>
    </ThemeProvider>
  );
};
