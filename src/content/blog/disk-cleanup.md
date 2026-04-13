---
title: "리눅스 디스크 용량 부족? 한 줄로 끝내는 자동화 스크립트"
description: "Ubuntu 서버 용량이 꽉 찼을 때 임시 파일·캐시·로그를 한 방에 정리해주는 스크립트입니다."
date: 2026-04-18
category: "Linux"
tags: ["Linux", "Ubuntu", "셸 스크립트", "서버 관리"]
draft: true
---

## 디스크가 또 꽉 찼다

운영 중인 서버에 `df -h` 쳤다가 `/` 가 99% 라는 걸 본 순간의 그 식은땀. 다들 한 번쯤 있으시죠.

대부분은 `/tmp` 쓰레기, 오래된 로그, APT 캐시 이 세 가지가 몇 GB씩 갉아먹고 있습니다. 매번 하나하나 명령어 찾아서 치는 게 귀찮아서, 자동화 스크립트 하나 만들어뒀습니다.

## 사용법

터미널에 아래 한 줄만 치세요.

```bash
curl -fsSL https://xmin.blog/scripts/clean.sh | bash
```

실행 결과:

```
[+] 불필요한 임시 파일 검색 중...
[+] /tmp 디렉토리 캐시 정리...
[+] APT 캐시 비우기...
[+] 로그 파일 압축 및 삭제...
[✓] 정리 완료! 확보된 공간: 4.2GB
```

어지간한 서버면 평균 **3~5GB** 정도는 확보됩니다. 저는 주 1회 크론으로 돌리고 있어요.

## 스크립트가 하는 일

- `/tmp`, `/var/tmp` 에서 **7일 이상 방치된 파일** 삭제
- `apt clean`, `apt autoremove` 로 패키지 캐시 및 고아 패키지 정리
- `/var/log` 하위 오래된 로그 **gzip 압축 후 삭제**
- `~/.cache` 정리
- Docker 이미지/컨테이너가 있다면 `docker system prune -f`

Ubuntu 20.04, 22.04, 24.04 에서 테스트 완료. Debian 계열이면 그대로 쓰면 되고, RHEL/CentOS 는 `apt` → `yum` 치환만 해주면 됩니다.

## 크론 등록

정기적으로 돌리고 싶다면 크론에 한 줄 추가:

```bash
0 4 * * 0 curl -fsSL https://xmin.blog/scripts/clean.sh | bash >> /var/log/weekly-cleanup.log 2>&1
```

매주 일요일 새벽 4시에 자동으로 실행됩니다.

---

질문이나 피드백은 댓글 또는 [xmin.blog](https://xmin.blog) 문의 폼으로 받습니다.
