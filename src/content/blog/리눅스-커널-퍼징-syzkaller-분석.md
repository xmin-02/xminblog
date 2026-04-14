---
title: "[리눅스 커널 퍼징] Syzkaller 분석"
description: "Google의 커널 퍼저 Syzkaller의 구조, 동작 원리, 장단점, 세부 기능 분석"
date: 2025-11-01T16:32:00+09:00
category: "학습"
tags: ["fuzzer", "kernel fuzzing", "Linux Kernel", "Syzkaller"]
draft: false
---

#### 요약

Syzkaller는 **unsupervised coverage-guided kernel fuzzer**로, 시스템콜 시퀀스를 자동 생성·실행해 커널의

새로운 코드 경로(coverage)를 찾고 크래시(또는 이상 로그)를 자동으로 수집·리포듀스하는 프로젝트

---

## **1. 개요**

**이름** : Syzkaller

**개발자** : Google

**언어** : Go (golang)

**대상** : Linux Kernel (또는 BSD, Windows 일부 포팅 버전 존재)

**깃허브 링크** : [https://github.com/google/syzkaller](https://github.com/google/syzkaller)

> **핵심 목표**
> 1. 커널 syscall 인터페이스 자동 탐색
> 2. 비정상 입력 조합으로 커널 버그 탐지
> 3. 커버리지 기반으로 테스트 효율 최적화

---

## **2. 장단점**

**Syzkaller의 장점**

1. KCOV를 이용해 실제 실행 경로 정보를 피드백으로 사용해 무작위 입력보다 효율적으로 취약점 가능성이 높은 입력을 찾는다.

2. syz-manager, syz-fuzzer, syz-executor, syz-repro/syz-verifier 등 구성요소로 크래시 수집에서 재현까지 파이프라인을 자동화한다.

3. 여러 VM 인스턴스에서 병렬 퍼징을 돌려 대량 탐지에 유리

4. sys descriptions를 바탕으로 의미 있거나 유효한 입력을 만들 수 있어 커널 인터페이스 규칙을 어느 정도 지킨 테스트가 가능하다.

**Syzkaller의 단점 및 한계**

1. 초기 준비 과정이 커널을 KCOV/KASAN 등으로 빌드하는 등 다소 복잡하고 번거롭다.

2. 커널 동작 때문에 수집되는 커버리지에 노이즈가 발생하고 불필요 경로가 늘어날 수 있다.

3. 효과적인 퍼징을 위해 많은 코어/메모리, 다수의 VM이 필요하며, 장시간 운영 시 성능 저하, corpus 관리 이슈 발생 가능

---

## **3. 동작 원리**

**1. 타깃 정의**

syzkaller는 각 타깃별로 시스템콜과 파라미터 타입을 기술한 메타데이터를 사용한다. 이 기술서를 통해 의미있는 syscall 시퀀스를 생성한다.

**2. 입력 생성 - syz-fuzzer**

fuzzer는 시드 corpus와 coverage 피드백을 바탕으로 syscall 시퀀스를 생성·변형한다. 이 때 새로운 경로를 열 수 있는 입력을 선호한다.

**3. 격리 실행 - syz-executor -> VM**

생성된 프로그램은 syz-executor에 의해 QEMU/GCE/호스트 VM 등에서 실행된다. 실행 중 커널 로그(e.g., oops, panic), 타임아웃, 비정상 종료 등이 발생하면 이를 수집한다.

**4. 커버리지 피드백 수집 - KCOV**

커널 내부 실행 경로는 KCOV(또는 다른 커버리지 방식)를 통해 수집되고 fuzzer로 피드백되어 어떤 입력이 “interesting”한지를 판단한다.

**5. 크래시 처리 및 재현/검증 - syz-manager -> syz-repro, syz-verifier**

크래시가 발생하면 syz-manager가 로그를 수집하고 자동으로 크래시를 재현하는 짧은 program 생성, syz-repro 또는 syz-verifier를 통해 재현 가능한 C/Go 재현기 혹은 dcmd를 생성·검증한다.

---

## **4. 사용법**

**1. 환경 준비**

Go toolchain 설치(프로젝트가 Go로 작성되어 있음).

QEMU/KVM 또는 사용할 클라우드 환경 준비.

Wsl 혹은 로컬에 설치 시 상황에 맞는 기타 환경 준비

**2. 타깃 커널 빌드**

KCOV, KASAN 등 디버깅/커버리지 옵션 활성화 후 커널 빌드

**3. Syzkaller 빌드**

레파지토리 클론 후 make로 syz-manager, syz-fuzzer, executor 등 바이너리 생성.

**4. Maneger 설정**

syz-manager는 JSON 형식의 config를 사용한다(타깃, kernel_src/kernel_obj, image 경로, sshkey, vm 타입 등). pkg/mgrconfig를 참고해 config 작성.

**5. 이미지/VM 등록**

config에 이미지와 kernel(vmlinuz/vmlinux) 경로, count(병렬 VM 수), 메모리 등을 지정하고 manager를 실행하여 타깃 VM을 띄운다.

**6. 퍼징 운영**

manager 웹 UI(통계·진행 상황) 확인, 크래시가 발견되면 자동으로 수집/재현 시도. 운영중 corpus·coverage 모니터링 및 필요 시 설정 튜닝.

---

## **5. 세부 기능**

**syz-manager**

역할: 전체 퍼징 오케스트레이션. 여러 fuzzer/VM 인스턴스 관리, 크래시 수집·triage, corpus 관리, 웹서버를 통한 대시보드 제공.

중요한 파일: pkg/mgrconfig(manager config 타입 정의/파싱). syz-manager 실행 바이너리는 config를 읽고 VM/프로세스를 띄운다.

**syz-fuzzer / syz-executor**

syz-fuzzer: syscall 시퀀스생성, corpus 진화, RPC로 executor에 작업 전달.

syz-executor: 실제로 타깃 커널에서 시스템콜 시퀀스를 실행시키고 커널 로그/커버리지/리턴 상태를 수집한다.

**syz-repro / syz-verifier**

역할: 크래시가 발생했을 때 재현 가능한 최소한의 재현기(reproducer) 자동 생성, 재현 검증. 분석자가 디버깅하기 쉬운 C 소스, dcmd 등의 형태로 출력한다.

**dashboard / syz-hub / syz-cluster / syz-ci**

역할: 대규모/분산 운영을 위한 중앙 허브, CI 통합, 클러스터 운영 스크립트, 통계 대시보드. 조직 규모로 운영할 때 유용.

**sys/ + prog/**

sys/: 타깃별 sys 설명(시스템콜 타입·flags·구조 정의).

prog/: syscall 프로그램 생성·변형·직렬화 로직. 이들로부터 의미 있는 syscall 시퀀스가 만들어진다.

**pkg/***

예: pkg/mgrconfig (manager 설정), pkg/report(버그 리포트 포맷), pkg/vm(VM 드라이버들) 등 여러 공통 모듈이 있다.

---

## **6. 유의사항**

**커널 빌드 옵션**

KCOV/KASAN/DEBUG 옵션은 퍼징 성과에 직접적 영향이 크므로 목적(경로 탐색 vs 메모리 버그 포착)에 맞춰 선택한다. 단, 디버깅 옵션은 성능 저하를 가져오므로 VM 스펙을 넉넉히 잡아야 한다.

**manager config 검증**

pkg/mgrconfig의 필드와 문서 예시를 정확히 맞춰야 manager가 VM을 제대로 띄운다(특히 kernel_src/kernel_obj, image, sshkey 경로).

**노이즈 관리**

KCOV 기반 커버리지는 노이즈가 많을 수 있으니 corpus 선별·coverage 필터링·시간대별 재시작 전략 등을 고려하라. 운영 장기화 시 corpus 크기와 성능 저하 문제를 모니터링하라.

**로그/재현 자동화 검토**

크래시가 쌓이면 빠르게 재현을 돌려서 재현 불가한 케이스(환경 의존성 등)를 분류하는 것이 중요하다. syz-repro/syz-verifier를 적극 활용하라.

**타깃별 문서 읽기**

Linux 외 다른 OS를 타깃으로 할 때는 각 OS 전용 문서(예: Fuchsia/FreeBSD 지침)를 먼저 확인하라. syzkaller는 타깃마다 세부 설정이 많이 다르다.

---

## **7. Syzkaller 로그 예시**

아래는 Syzkaller 퍼징 시 출력되는 로그 중 일부이다.

```
2025/11/01 15:21:09 candidates=0 corpus=0 coverage=0 exec total=0 (0/sec) pending=0 reproducing=0
```

여기서 각 항목은 다음을 의미한다.

**2025/11/01 15:21:09**

타임 스탬프로 로그가 찍힌 일자를 나타낸다. 읽는법 : 년/월/일 시:분:초

**candidates=0**

현재 triage/검증 대기 중인 후보 입력(program) 의 개수이다.

candidates가 점점 늘어나면 triage 병목(검증/재현 작업이 따라오지 못함) 을 의미한다. 후보가 많으면 자동 최소화/검증 스레드 수를 늘리거나 I/O/VM 자원을 늘려 처리 속도를 올리는 걸 고려해야 한다.

**corpus=0**

현재 corpus(보관된 시드/프로그램)의 크기(유일하게 보관된 입력 개수).

corpus가 빠르게 커지면 coverage 증가 가능성이 높다. 반대로 corpus가 늘지 않는데 candidates만 많이 쌓이면 후보 검증 단계에서 탈락이 많다는 뜻이다.

**coverage=0**

수집된 고유 커버리지 포인트(예: unique PCs / basic blocks / edges)의 총 개수.

coverage가 늘어나면 더 많은 코드가 탐색된 것이다. 일정 시간 동안 coverage 정체(plateau)가 길면 mutation/choice table 등 퍼징 전략 조정이 필요하다.

**exec total=0 (0/sec)**

exec total=0 → 지금까지(또는 로그 집계시점 기준) 수행된 총 실행(프로그램 실행) 횟수.

(0/sec) → 최근 집계된 초당 실행률(executions per second).

실행은 syz-executor가 VM 내에서 syscall 시퀀스를 실행한 한 번(시도)마다 1로 카운트된다.

exec/sec는 퍼저 효율(스루풋)을 보여준다. 낮으면 VM/IO 병목, 느린 커널 빌드(디버깅 옵션), 또는 실행환경 문제를 의심해야 한다.

**pending=0**

현재 대기중인(queued) 재현/검증 작업의 수 또는 처리 대기중인 작업을 가리킨다.
pending=0이면 현재 재현/검증 작업이 큐에 쌓여있지 않다는 뜻(즉 즉시 처리 가능하거나 대기중인 재현 없음). 반대로 0이 아닌 값이면 재현 파이프라인에 병목이 있는지 확인해야 한다.

**reproducing=0**

지금 실행 중인(reproducing) 재현 작업(job) 수.

reproducing=0이면 현재 활성 재현 작업이 없음. 만약 pending>0인데 reproducing=0이면 스케줄러가 동작하지 않는 상태일 수 있다.

---

작성된 내용은 공식 깃허브를 참고하여 작성 되었으며, GPT를 통하여 다듬어 작성되었습니다.
