# xmin.blog

Personal security/AI/development blog built with Astro plus a separate API backend.

## Architecture

- **Frontend:** Astro static site (`dist/`).
- **Public API:** `https://api.xmin.blog`.
- **Home-server API target:** `blog-api/home-server.mjs` running the same Worker fetch handler on Node.
- **DB:** PostgreSQL 16 on vm-db (`192.168.45.70:5432`) for production; SQLite is local smoke-test fallback only.
- **Content source:** Markdown files under `src/content/blog`; admin writes still commit post/image files to GitHub through `GITHUB_TOKEN`.

Cloudflare Worker/D1 files remain for rollback/reference, but the intended backend direction is home-server API + PostgreSQL.

## Commands

```bash
npm ci
npm run dev
npm run build
npm run preview
```

API:

```bash
cd blog-api
npm ci
npm run typecheck
npm run build:node
npm run start:home
```

## Configuration

Frontend API base defaults to `https://api.xmin.blog` and can be overridden at build time:

```bash
PUBLIC_API_BASE=https://api.xmin.blog npm run build
```

Home API environment template:

```bash
cp blog-api/.env.home.example blog-api/.env.home
```

Required secrets:

- `GITHUB_TOKEN`
- `ADMIN_PASSWORD`
- `JWT_SECRET`

## Deployment notes

See [`docs/home-server.md`](docs/home-server.md) for vm-public Docker, vm-db PostgreSQL, Traefik, migration notes, and the DNS/tunnel cutover checklist.

## Quality gates

CI runs:

- frontend install/build/audit
- API install/typecheck
- home-server API bundle build
- `/health` smoke test against the Node home API
