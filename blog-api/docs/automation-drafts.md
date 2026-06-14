# Automation Drafts

`npm run automate:drafts` collects vulnerability/security feeds and writes blog posts as:

- `draft = true`
- `auto_generated = true`
- `review_status = pending`

The iOS admin app can review, edit, publish, or reject these drafts through the existing review APIs.

## Sources

- CVE drafts: NVD CVE API 2.0
- Exploitation signal: CISA Known Exploited Vulnerabilities JSON catalog
- Security news digest: BoanNews official RSS feeds by default, with optional recent CISA KEV additions
- AI draft body, when `OPENAI_API_KEY` is set: OpenAI Responses API

## Local Dry Run

```bash
cd blog-api
DB_DRIVER=sqlite \
SQLITE_PATH=./data/automation-smoke.sqlite \
AUTOMATION_DRY_RUN=1 \
npm run automate:drafts -- --kind=all
```

## Production Run

Docker home-server deployment:

```bash
docker exec blog-api npm run automate:drafts
```

Host Node deployment:

```bash
cd /home/sumin/xminblog/blog-api
npm run automate:drafts
```

Useful environment variables:

```env
OPENAI_API_KEY=optional-openai-api-key
AI_DRAFTS=1
OPENAI_DRAFT_MODEL=gpt-5.4-mini
OPENAI_DRAFT_MAX_OUTPUT_TOKENS=2600
NVD_API_KEY=optional-nvd-api-key
CVE_LOOKBACK_DAYS=3
CVE_DRAFT_LIMIT=10
CVE_MIN_CVSS_SCORE=8
NVD_MAX_PAGES=3
NVD_RESULTS_PER_PAGE=200
AUTOMATION_TIME_ZONE=Asia/Seoul
AUTOMATION_UTC_OFFSET=+09:00
SECURITY_NEWS_WINDOW_START_HOUR=9
SECURITY_NEWS_ITEM_LIMIT=8
SECURITY_NEWS_INCLUDE_KEV=0
SECURITY_NEWS_FEEDS=https://www.boannews.com/media/news_rss.xml?mkind=1,https://www.boannews.com/media/news_rss.xml?skind=5,https://www.boannews.com/media/news_rss.xml?kind=5
```

If `OPENAI_API_KEY` is missing or `AI_DRAFTS=0`, the script writes the deterministic template-only draft. If the OpenAI call fails, the script falls back to that template unless `AI_DRAFT_REQUIRED=1` is set.

Daily production automation runs both flows once:

- CVE: creates up to 10 pending drafts per run.
- Security news: creates one daily digest draft per date. At 09:00 Asia/Seoul, it summarizes items from the previous day 09:00:00 through the current day 08:59:59. `SECURITY_NEWS_ITEM_LIMIT` controls how many source items can be summarized inside that single digest.

## systemd Timer

The included service targets the Docker deployment and runs the script inside the `blog-api` container once per day at 09:00 Asia/Seoul.

```bash
sudo cp systemd/xmin-blog-automation.service /etc/systemd/system/
sudo cp systemd/xmin-blog-automation.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xmin-blog-automation.timer
systemctl list-timers xmin-blog-automation.timer
```

Run once manually:

```bash
sudo systemctl start xmin-blog-automation.service
journalctl -u xmin-blog-automation.service -n 80 --no-pager
```
