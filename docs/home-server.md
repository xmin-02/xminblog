# xmin.blog home-server backend

This follows the home infrastructure map from `/Users/sumin/Desktop/home_server_migration_guide.md`.

## Target architecture

| Role | Target |
|---|---|
| Frontend | Astro static site |
| Public API domain | `https://api.xmin.cloud` recommended by the home-server domain policy, or keep `https://api.xmin.blog` by CNAME/router alias |
| API runtime | Docker container on vm-public LXC 106 (`192.168.45.60`) |
| DB | PostgreSQL 16 on vm-db LXC 107 (`192.168.45.70:5432`) |
| Uploaded images | Persistent vm-public volume mounted at `/app/data/uploads`, served by the API under `/uploads/*` |
| Edge | Traefik v3 + cloudflared on vm-edge (`192.168.45.20`) |
| Content writes | Server-managed: posts in PostgreSQL, images on vm-public disk. GitHub writer remains only for rollback. |

`blog-api/home-server.mjs` runs the existing Worker `fetch()` handler on Node and adapts its D1-style SQL calls to PostgreSQL. SQLite remains as a local-only smoke-test fallback.

## 1. Create PostgreSQL DB/role on vm-db

Run in pgAdmin (`https://db.xmin.dev`) or psql:

```sql
CREATE ROLE xminblog LOGIN PASSWORD 'replace-with-strong-password';
CREATE DATABASE xminblog OWNER xminblog ENCODING 'UTF8';
REVOKE ALL ON DATABASE xminblog FROM PUBLIC;
```

Connection string:

```text
postgresql://xminblog:replace-with-strong-password@192.168.45.70:5432/xminblog
```

If vm-public cannot connect, update `pg_hba.conf` on vm-db for the `192.168.45.0/24` LAN and reload PostgreSQL.

## 2. Deploy API container on vm-public

```bash
ssh sumin@pve
sudo pct exec 106 -- bash

mkdir -p /opt/xminblog
cd /opt/xminblog
git clone https://github.com/xmin-02/xminblog.git .
cd blog-api
cp .env.home.example .env.home
# edit DATABASE_URL, ADMIN_PASSWORD, JWT_SECRET, PUBLIC_UPLOAD_BASE
# GITHUB_TOKEN is not required when CONTENT_BACKEND=db.

mkdir -p data/uploads
docker compose -f docker-compose.home.example.yml up -d --build
docker compose -f docker-compose.home.example.yml logs -f
```

The compose file binds `0.0.0.0:3001:3000`, which is required so vm-edge can reach vm-public. It also mounts `./data/uploads:/app/data/uploads`; include that path in vm-public backups.

Health check from vm-public:

```bash
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:3001/api/posts
```

## 3. Import existing markdown posts into PostgreSQL

Run this once after the container has been built and `.env.home` has the production `DATABASE_URL`:

```bash
cd /opt/xminblog/blog-api
set -a
. ./.env.home
set +a

CONTENT_ROOT=../src/content/blog \
MIRROR_REMOTE_IMAGES=1 \
npm run import:markdown
```

What it does:

- creates/updates the `posts` schema;
- preserves existing slugs, title, description, date, category, tags, draft/private state, and private post password hashes;
- imports markdown body into `posts.content`;
- mirrors remote markdown images into `UPLOAD_DIR` when possible and rewrites markdown image URLs to `PUBLIC_UPLOAD_BASE/uploads` style URLs.

If a legacy remote image URL is expired or blocked, the importer logs a warning and keeps the original URL so the post import does not fail. Re-run is safe: existing post rows are upserted and image filenames are content-hash based.

Local dry run without production PostgreSQL:

```bash
cd blog-api
DB_DRIVER=sqlite \
SQLITE_PATH=/tmp/xmin-import-test.sqlite \
CONTENT_ROOT=../src/content/blog \
UPLOAD_DIR=/tmp/xmin-import-uploads \
PUBLIC_UPLOAD_BASE=http://127.0.0.1:3001/uploads \
MIRROR_REMOTE_IMAGES=0 \
npm run import:markdown
```

## 4. Register Traefik route on vm-edge

Recommended public domain from the guide is `.cloud`:

```bash
ssh sumin@192.168.45.20
cat /opt/xminblog/blog-api/traefik-api.xmin.cloud.yml > ~/edge/traefik/dynamic/xmin-blog-api.yml
# or paste the file content manually

docker logs traefik --tail 20 | grep -i xmin-blog-api
```

Expected route:

```text
Host(`api.xmin.cloud`) -> http://192.168.45.60:3001
```

External verification:

```bash
curl -i https://api.xmin.cloud/health
curl -i https://api.xmin.cloud/api/posts
```

If you want to keep `https://api.xmin.blog`, add a second Traefik Host rule/alias or point the old DNS name to the `.cloud` route and build the frontend with the matching API base.

## 5. Frontend API base

Default remains `https://api.xmin.blog` for compatibility. For the guide's `.cloud` public API, build with:

```bash
PUBLIC_API_BASE=https://api.xmin.cloud npm run build
```

The CSP header allows both `https://api.xmin.blog` and `https://api.xmin.cloud` in `connect-src`, so either API base works after redeploy.

## 6. Existing interaction data migration

Current interaction tables:

- `users`
- `comments`
- `likes`
- `page_views`

Safe path:

1. Put the blog in a short maintenance window.
2. Export D1 data from Cloudflare/Wrangler/dashboard.
3. Create the PostgreSQL schema with `blog-api/schema.postgres.sql`.
4. Import each table, preserving IDs and epoch-second `created_at` values.
5. Reset sequences after importing IDs:

```sql
SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE((SELECT MAX(id) FROM users), 1));
SELECT setval(pg_get_serial_sequence('comments', 'id'), COALESCE((SELECT MAX(id) FROM comments), 1));
SELECT setval(pg_get_serial_sequence('likes', 'id'), COALESCE((SELECT MAX(id) FROM likes), 1));
SELECT setval(pg_get_serial_sequence('page_views', 'id'), COALESCE((SELECT MAX(id) FROM page_views), 1));
```

6. Start the API and verify:
   - `/health`
   - `/api/posts`
   - admin login
   - `/api/upload` returns an `/uploads/*` URL and that URL is reachable
   - comments/likes/profile pages
7. Switch `api.xmin.blog` or `api.xmin.cloud` route to the home server.
8. Keep Cloudflare Worker/D1 as rollback until the home-server path is stable.

## 7. Cutover checklist

Before changing DNS or public routing:

- [ ] `DATABASE_URL`, `ADMIN_PASSWORD`, `JWT_SECRET`, `CONTENT_BACKEND=db`, `UPLOAD_DIR`, and `PUBLIC_UPLOAD_BASE` are set in `.env.home`.
- [ ] `docker compose -f docker-compose.home.example.yml up -d --build` is healthy on vm-public.
- [ ] `npm run import:markdown` imported all existing markdown posts.
- [ ] D1 interaction data is imported or intentionally deferred.
- [ ] `curl -fsS http://127.0.0.1:3001/health` succeeds on vm-public.
- [ ] `curl -fsS http://192.168.45.60:3001/health` succeeds from vm-edge.
- [ ] `curl -fsS https://api.xmin.cloud/health` succeeds through Traefik/cloudflared.
- [ ] Admin login works and `/api/upload` stores a file under `data/uploads`.
- [ ] Frontend is rebuilt with the chosen `PUBLIC_API_BASE` and deployed.
- [ ] Backup job covers vm-db PostgreSQL and vm-public `blog-api/data/uploads`.

## 8. Security and operations

- Write endpoints require a live admin JWT; legacy `X-Admin-Password` write fallback is disabled.
- In-process rate limits protect login/signup/comment/like/view/upload/private-post verify endpoints. Add Traefik/Cloudflare rate limits for hard enforcement.
- Keep secrets in `/opt/xminblog/blog-api/.env.home`; never commit them.
- Backups should include vm-db PostgreSQL dumps and vm-public uploaded images. Add offsite R2 backup when ready.
- Build Docker images for `linux/amd64` if publishing to a registry for vm-public.
