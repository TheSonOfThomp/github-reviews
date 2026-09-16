---
"chrome-extension": minor
---

Added a DEMO build mode (`pnpm build:demo`) that renders deterministic Faker.js data with pravatar.cc placeholder avatars instead of hitting the GitHub API — no token or repos required. Faker and demo data are tree-shaken out of normal production builds.
