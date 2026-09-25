# GitHub Reviews

A [Chrome Extension](https://developer.chrome.com/docs/extensions/get-started) built with React that surfaces the PRs awaiting your review (and your own open PRs) in a toolbar popup.

## Install

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/nakeggihheppfmnkmpnglbdkpbicbhdd).

![The extension popup listing open PRs](https://raw.githubusercontent.com/TheSonOfThomp/github-reviews/ci/e2e-screenshots/36166125622/popup-clears-the-cache-whe-f1782-e-then-renders-the-new-repo-dark--test-finished-1.png)

## Build

Build your extension using `pnpm build`.

## Test

To test your extension, first toggle "Developer Mode" in the Chrome extensions page.
Then, click "Load Unpacked", and select the `build/manifest.json` in this repository.

You will now be able to see the extension in Chrome.

You will need to click the "reload" arrow whenever you rebuild the extension, (and refresh a web page to reload any `content.js` scripts)

## Watch

Run `pnpm watch` to continuously watch for changes

