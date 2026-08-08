# Gmail login + Continue-to-app automation

This repository contains a GitHub Actions workflow and Playwright scripts to:

- log in to a Google account (either via stored Playwright storageState or username/password),
- open a target AI Studio app URL,
- click the "Continue to the app" button if it appears,
- take a screenshot and upload it as an artifact.

Files added
- .github/workflows/refresh-every-15.yml — workflow that runs every 15 minutes and on manual dispatch. Uses a matrix of 5 instances.
- package.json — Node project with Playwright dependency.
- scripts/login-and-click.js — main automation script.
- scripts/save-state.js — helper to save Playwright storageState locally (run locally, then encode/upload to Secrets).
- images/matrix-5x5.svg — simple 5x5 dot matrix image.

Setup
1. Push this branch and open a PR or merge to main.
2. Add these repository secrets (Settings → Secrets and variables → Actions):
   - GMAIL_USERNAME — your Google email (only if you will use username/password login).
   - GMAIL_PASSWORD — your Google password (only if you will use username/password login).
   - AI_STUDIO_URL — the target URL, e.g. https://ai.studio/apps/0ca3bf1d-8647-4aac-aa20-10ebbb576614
   - (Optional) GMAIL_STORAGE_STATE — base64 of Playwright storage state JSON (for stable authenticated runs). See below how to produce it.

How to produce GMAIL_STORAGE_STATE (recommended for reliability)
1. On your local machine with Node & Playwright installed, run:
   npm ci
   npx playwright install
   node scripts/save-state.js

2. A visible browser will open. Log in to Google interactively.
3. After login, go back to the terminal and press ENTER. A file `state.json` will be created.
4. Encode it and copy to the secret:
   - macOS / Linux:
     cat state.json | base64 --wrap=0
   - Windows PowerShell:
     [Convert]::ToBase64String([IO.File]::ReadAllBytes("state.json"))

5. Create a repository secret named `GMAIL_STORAGE_STATE` and paste the base64 string.

Notes & caveats
- Automated Google UI login (username/password) is brittle — Google may challenge or block automated sign-in. Using storageState is more reliable but can still fail if Google invalidates the session.
- GitHub runners are ephemeral. Each job runs, then stops; it will not "stay" on the page between runs. The workflow runs every 15 minutes and will start fresh browser sessions each time.
- Be careful with storing passwords in secrets. Prefer app-specific accounts or storageState.

If you want, I can open a Pull Request with these changes to `main` — tell me to push and open the PR and I'll do it.
