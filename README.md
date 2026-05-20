# xmin.blog

Personal security/AI/development blog built with Astro plus a separate API backend.

## Architecture

- **Frontend:** Astro static site (`dist/`).
- **Public API:** `https://api.xmin.cloud` by default; `https://api.xmin.blog` remains a compatibility alias.
- **Home-server API target:** `blog-api/home-server.mjs` running the same Worker fetch handler on Node.
- **DB:** PostgreSQL 16 on vm-db (`192.168.45.70:5432`) for production; SQLite is local smoke-test fallback only.
- **Content source:** Server-managed mode stores posts in PostgreSQL (`posts` table) and uploaded images in a vm-public volume served from `/uploads/*`.

Cloudflare Worker/D1 and the GitHub content writer remain for rollback/reference, but the intended backend direction is home-server API + PostgreSQL + local upload volume.

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
npm run import:markdown
```

## Configuration

Frontend API base defaults to `https://api.xmin.cloud` and can be overridden at build time:

```bash
PUBLIC_API_BASE=https://api.xmin.cloud npm run build
```

Home API environment template:

```bash
cp blog-api/.env.home.example blog-api/.env.home
```

Required home-server secrets:

- `DATABASE_URL`
- `ADMIN_PASSWORD`
- `JWT_SECRET`

Content ownership settings:

- `CONTENT_BACKEND=db`
- `UPLOAD_DIR=/app/data/uploads`
- `PUBLIC_UPLOAD_BASE=https://api.xmin.cloud/uploads` or the selected public API host

`GITHUB_TOKEN` is optional in server-managed mode and is only needed for rollback to the legacy GitHub writer.

## Deployment notes

See [`docs/home-server.md`](docs/home-server.md) for vm-public Docker, vm-db PostgreSQL, Traefik, markdown/import migration, uploaded-image storage, and the DNS/tunnel cutover checklist.

## Quality gates

CI runs:

- frontend install/build/audit
- API install/typecheck
- home-server API bundle build
- `/health` and `/api/posts` smoke tests against the Node home API
