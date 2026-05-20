# xmin.blog home-server backend

Current target architecture after this change:

- Frontend: static Astro site.
- API: `blog-api` running on the home server with Node.
- Public API domain: keep `https://api.xmin.blog`, but point it to the home server reverse proxy or Cloudflare Tunnel.
- DB: local SQLite file at `blog-api/data/blog.sqlite` by default.
- Post/image content: still written to the GitHub repo through `GITHUB_TOKEN` so the existing static content workflow keeps working.

## Local smoke run

```bash
cd blog-api
cp .env.home.example .env.home
# edit .env.home
set -a && . ./.env.home && set +a
npm ci
npm run start:home
curl http://127.0.0.1:8787/health
```

The server runs the same Worker `fetch()` handler through `home-server.mjs`, with a small D1-compatible SQLite adapter.

## Production service

Example files are included:

- `blog-api/systemd/xmin-blog-api.service`
- `blog-api/nginx/api.xmin.blog.conf`

Typical deployment outline:

```bash
sudo useradd --system --home /srv/xminblog --shell /usr/sbin/nologin xminblog
sudo mkdir -p /srv/xminblog
sudo chown -R xminblog:xminblog /srv/xminblog
git clone https://github.com/xmin-02/xminblog.git /srv/xminblog
cd /srv/xminblog/blog-api
cp .env.home.example .env.home
# edit secrets in .env.home
npm ci
npm run build:node
sudo cp systemd/xmin-blog-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xmin-blog-api
```

Then expose `127.0.0.1:8787` as `https://api.xmin.blog` through nginx, Caddy, or Cloudflare Tunnel.

## D1 to SQLite migration

The schema is compatible with the current D1 tables:

- `users`
- `comments`
- `likes`
- `page_views`

Recommended safe migration path:

1. Put the blog in a short maintenance window.
2. Export D1 data from Cloudflare/Wrangler or the dashboard.
3. Import rows into `blog-api/data/blog.sqlite` using the same table names.
4. Start the home API locally and verify:
   - `/health`
   - `/api/posts`
   - admin login
   - comments/likes/profile pages
5. Switch `api.xmin.blog` DNS/tunnel to the home server.
6. Keep the old Worker route disabled or as rollback only.

## Security notes

- Write endpoints now require a live admin JWT; the old `X-Admin-Password` write fallback is not accepted.
- In-process rate limiting protects obvious abuse, but a reverse proxy limit is still recommended.
- Keep `GITHUB_TOKEN`, `ADMIN_PASSWORD`, and `JWT_SECRET` outside git.
- Back up `blog-api/data/blog.sqlite`, `*.sqlite-wal`, and `*.sqlite-shm` together.
