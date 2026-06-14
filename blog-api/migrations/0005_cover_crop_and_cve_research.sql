ALTER TABLE posts ADD COLUMN cover_crop TEXT NOT NULL DEFAULT '';

UPDATE posts
SET category = 'CVE Research',
    title = CASE
      WHEN title LIKE '[CVE] %' THEN '[CVE Research] ' || substr(title, 7)
      ELSE title
    END,
    updated_at = unixepoch()
WHERE lower(category) = 'cve'
   OR title LIKE '[CVE] %';

UPDATE posts
SET category = 'Security News',
    updated_at = unixepoch()
WHERE lower(category) IN ('security-news', 'security news');
