-- PostgreSQL schema for the home-server blog API.

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  created_at BIGINT NOT NULL DEFAULT (extract(epoch from now())::bigint)
);

CREATE TABLE IF NOT EXISTS comments (
  id BIGSERIAL PRIMARY KEY,
  post_slug TEXT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (extract(epoch from now())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments(post_slug);

CREATE TABLE IF NOT EXISTS likes (
  id BIGSERIAL PRIMARY KEY,
  post_slug TEXT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL DEFAULT (extract(epoch from now())::bigint),
  UNIQUE(post_slug, user_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_slug ON likes(post_slug);

CREATE TABLE IF NOT EXISTS page_views (
  id BIGSERIAL PRIMARY KEY,
  post_slug TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  referrer TEXT,
  created_at BIGINT NOT NULL DEFAULT (extract(epoch from now())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_page_views_slug ON page_views(post_slug);
CREATE INDEX IF NOT EXISTS idx_page_views_viewer ON page_views(post_slug, viewer_id, created_at);
