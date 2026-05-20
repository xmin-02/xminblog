# Home-server backup / restore runbook

블로그의 운영 데이터는 홈서버 API가 관리한다.

- DB: PostgreSQL (`DATABASE_URL` in `.env.home`)
- 업로드 이미지: `blog-api/data/uploads`
- 백업 스크립트: `blog-api/scripts/backup-home-server.sh`

## 즉시 백업

로컬 Mac에서 원격 vm-public에 SSH 가능할 때:

```bash
REMOTE=sumin@192.168.45.60 \
REMOTE_DIR=/home/sumin/xminblog/blog-api \
./blog-api/scripts/backup-home-server.sh
```

vm-public 안에서 직접 실행할 때:

```bash
cd /home/sumin/xminblog/blog-api
./scripts/backup-home-server.sh
```

기본 보관 위치는 `~/blog-api-backups/<UTC timestamp>/` 이고, 최근 14개만 유지한다.

## cron 예시

vm-public에서 매일 04:30 UTC 백업:

```cron
30 4 * * * cd /home/sumin/xminblog/blog-api && ./scripts/backup-home-server.sh >> /home/sumin/blog-api-backups/backup.log 2>&1
```

## 복원

```bash
# DB 복원 전, 새 DB/역할 생성 및 DATABASE_URL 설정 후 실행
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" /path/to/blog-api.dump

# 업로드 복원
mkdir -p /home/sumin/xminblog/blog-api/data
tar -C /home/sumin/xminblog/blog-api/data -xzf /path/to/uploads.tar.gz
```

복원 후 검증:

```bash
curl -fsS https://api.xmin.cloud/health
curl -fsS https://api.xmin.cloud/api/posts | jq 'length'
curl -I https://api.xmin.cloud/uploads/<known-image-file>
```
