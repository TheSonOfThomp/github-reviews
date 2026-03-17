import React, { useEffect, useRef, useState } from "react";
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
import { XIcon, EyeIcon, EyeClosedIcon, GrabberIcon, CheckCircleFillIcon } from "@primer/octicons-react";

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
  const [savedExiting, setSavedExiting] = useState(false);
  const [newRepo, setNewRepo] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const tokenDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bannerExitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bannerRemoveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    chrome.storage.sync.get(defaultSettings, (stored) => {
      setSettings(stored as Settings);
    });
  }, []);

  const saveSettings = (updated: Settings) => {
    chrome.storage.sync.set(updated, () => {
      if (bannerExitRef.current) clearTimeout(bannerExitRef.current);
      if (bannerRemoveRef.current) clearTimeout(bannerRemoveRef.current);
      setSaved(true);
      setSavedExiting(false);
      bannerExitRef.current = setTimeout(() => setSavedExiting(true), 2000);
      bannerRemoveRef.current = setTimeout(() => { setSaved(false); setSavedExiting(false); }, 2300);
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

  const handleDragStart = (index: number) => setDraggedIndex(index);

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDrop = (index: number) => {
    if (draggedIndex === null || draggedIndex === index) return;
    const repos = [...settings.repos];
    const [moved] = repos.splice(draggedIndex, 1);
    repos.splice(index, 0, moved);
    const updated = { ...settings, repos };
    setSettings(updated);
    saveSettings(updated);
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  return (
    <ThemeProvider colorMode="auto">
      <BaseStyles
          style={{ height: '100%', padding: "0 16px" }}
      >
        <style>{`
          @keyframes bannerIn {
            from { opacity: 0; transform: translateY(-100%); }
            to   { opacity: 1; transform: translateY(0); }
          }
          @keyframes bannerOut {
            from { opacity: 1; transform: translateY(0); }
            to   { opacity: 0; transform: translateY(-100%); }
          }
        `}</style>
        {saved && (
          <div style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 20px",
            background: "var(--bgColor-success-emphasis)",
            color: "var(--fgColor-onEmphasis)",
            fontSize: "var(--text-body-size-small)",
            fontWeight: "var(--base-text-weight-semibold)",
            animation: `${savedExiting ? "bannerOut" : "bannerIn"} 300ms ease forwards`,
          }}>
            <CheckCircleFillIcon size={16} />
            Settings saved
          </div>
        )}
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
              onChange={(e) => {
                const updated = { ...settings, githubToken: e.target.value };
                setSettings(updated);
                if (tokenDebounceRef.current) clearTimeout(tokenDebounceRef.current);
                tokenDebounceRef.current = setTimeout(() => saveSettings(updated), 800);
              }}
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
              Used to authenticate requests to the GitHub API.{" "}
              Generate a token from your{" "}
              <Link href="https://github.com/settings/tokens/new?scopes=repo" target="_blank" rel="noopener noreferrer">
                GitHub settings.
              </Link>
            </FormControl.Caption>
          </FormControl>
            <aside style={{
              marginTop: 8,
              padding: "8px 12px",
              borderRadius: 6,
              background: "var(--bgColor-muted)",
              borderLeft: "3px solid var(--borderColor-muted)",
              fontSize: "var(--text-body-size-small)",
              lineHeight: 1.6,
            }}>
              <strong>Classic PAT</strong> — use the <code>repo</code> scope. Required for SSO-protected orgs (authorize per org via <em>Configure SSO</em> on the token page).<br />
              <strong>Fine-grained PAT</strong> — set <em>Resource owner</em> to the org, grant <em>Pull requests: Read</em>. Not supported by all orgs.
            </aside>

          <FormControl>
            <FormControl.Label>Repositories to check</FormControl.Label>
            <Stack direction="vertical" gap="condensed">
              {settings.repos.map((repo, index) => (
                <Stack
                  key={repo}
                  direction="horizontal"
                  gap="condensed"
                  align="center"
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDrop={() => handleDrop(index)}
                  onDragEnd={handleDragEnd}
                  style={{
                    opacity: draggedIndex === index ? 0.4 : 1,
                    borderRadius: 6,
                    outline: dragOverIndex === index && draggedIndex !== index
                      ? "2px solid var(--borderColor-accent-emphasis)"
                      : "2px solid transparent",
                    transition: "outline 80ms",
                  }}
                >
                  <span style={{ color: "var(--fgColor-muted)", cursor: "grab", display: "flex", flexShrink: 0 }}>
                    <GrabberIcon size={16} />
                  </span>
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
          </Stack>
        </Stack>
      </BaseStyles>
    </ThemeProvider>
  );
};
