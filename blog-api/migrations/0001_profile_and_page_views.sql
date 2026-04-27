ALTER TABLE users ADD COLUMN avatar_url TEXT;

CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  referrer TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_page_views_slug ON page_views(post_slug);
CREATE INDEX IF NOT EXISTS idx_page_views_viewer ON page_views(post_slug, viewer_id, created_at);
