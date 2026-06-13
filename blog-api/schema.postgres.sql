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
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id, created_at);

CREATE TABLE IF NOT EXISTS page_views (
  id BIGSERIAL PRIMARY KEY,
  post_slug TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  referrer TEXT,
  created_at BIGINT NOT NULL DEFAULT (extract(epoch from now())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_page_views_slug ON page_views(post_slug);
CREATE INDEX IF NOT EXISTS idx_page_views_viewer ON page_views(post_slug, viewer_id, created_at);

CREATE TABLE IF NOT EXISTS posts (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  draft BOOLEAN NOT NULL DEFAULT false,
  cover TEXT NOT NULL DEFAULT '',
  is_private BOOLEAN NOT NULL DEFAULT false,
  password_hash TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_url TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  auto_generated BOOLEAN NOT NULL DEFAULT false,
  review_status TEXT NOT NULL DEFAULT 'published',
  reviewed_at BIGINT,
  content TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL DEFAULT (extract(epoch from now())::bigint),
  updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now())::bigint)
);

CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(date);
CREATE INDEX IF NOT EXISTS idx_posts_visibility ON posts(draft, is_private);
CREATE INDEX IF NOT EXISTS idx_posts_review ON posts(review_status, draft, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_source_id ON posts(source_type, source_id) WHERE source_id <> '';
