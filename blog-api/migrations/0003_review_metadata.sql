ALTER TABLE posts ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE posts ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN source_id TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN auto_generated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN review_status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE posts ADD COLUMN reviewed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_posts_review ON posts(review_status, draft, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_source_id ON posts(source_type, source_id) WHERE source_id <> '';
