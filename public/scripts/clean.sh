#!/bin/bash
set -euo pipefail

# 안전한 디스크 정리 예제 스크립트
# 실제 삭제는 하지 않고, 사용자가 직접 검토할 수 있는 명령만 출력합니다.

echo "[안전 모드] 이 스크립트는 파일을 삭제하지 않습니다."
echo
echo "디스크 사용량 확인:"
echo "  df -h"
echo
echo "APT 캐시 크기 확인:"
echo "  sudo du -sh /var/cache/apt 2>/dev/null || true"
echo
echo "30일 이상 지난 /tmp 파일 미리보기:"
echo "  sudo find /tmp -xdev -type f -mtime +30 -print | head -100"
echo
echo "직접 검토한 뒤 필요한 명령만 수동으로 실행하세요."
