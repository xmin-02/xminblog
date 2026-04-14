---
title: "[리눅스 커널 퍼징] Syzkaller 분석"
description: "Google의 커널 퍼저 Syzkaller의 구조, 동작 원리, 장단점, 세부 기능 분석"
date: 2025-11-01T16:32:00+09:00
category: "학습"
tags: ["fuzzer", "kernel fuzzing", "Linux Kernel", "Syzkaller"]
draft: false
---

## 요약

Syzkaller는 unsupervised coverage-guided kernel fuzzer로, 시스템콜 시퀀스를 자동 생성하고 실행해 커널의 새로운 코드 경로(coverage)를 찾고 크래시를 자동으로 수집 및 재현하는 프로젝트이다.

## 1. 개요

- **이름**: Syzkaller
- **개발자**: Google
- **언어**: Go (golang)
- **대상**: Linux Kernel
- **깃허브**: https://github.com/google/syzkaller

**핵심 목표**
1. 커널 syscall 인터페이스 자동 탐색
2. 비정상 입력 조합으로 커널 버그 탐지
3. 커버리지 기반으로 테스트 효율 최적화

## 2. 장단점

### 장점
1. KCOV를 이용해 실제 실행 경로 정보를 피드백으로 사용
2. 크래시 수집에서 재현까지 파이프라인 자동화
3. 여러 VM 인스턴스에서 병렬 퍼징
4. sys descriptions 기반 의미 있는 입력 생성

### 단점
1. 초기 준비 과정이 복잡
2. 커버리지 노이즈 발생 가능
3. 많은 리소스 필요, 장시간 운영 시 성능 저하

## 3. 동작 원리

### 타깃 정의
시스템콜과 파라미터 타입을 기술한 메타데이터로 의미있는 syscall 시퀀스를 생성한다.

### 입력 생성 (syz-fuzzer)
시드 corpus와 coverage 피드백을 바탕으로 syscall 시퀀스를 생성 및 변형한다.

### 격리 실행 (syz-executor)
생성된 프로그램은 QEMU/GCE/호스트 VM에서 실행되며, 커널 로그, 타임아웃, 비정상 종료를 수집한다.

### 커버리지 피드백 (KCOV)
커널 내부 실행 경로는 KCOV를 통해 수집되고 fuzzer로 피드백된다.

### 크래시 처리 (syz-manager -> syz-repro)
크래시 발생 시 자동으로 재현 가능한 최소한의 재현기를 생성한다.

## 4. 세부 기능

### syz-manager
전체 퍼징 오케스트레이션, VM 관리, 크래시 수집, 대시보드 제공.

### syz-fuzzer / syz-executor
syscall 시퀀스 생성, 실제 커널에서 실행, 로그/커버리지 수집.

### syz-repro / syz-verifier
크래시 재현기 자동 생성 및 검증.

## 5. 로그 예시

```
2025/11/01 15:21:09 candidates=0 corpus=0 coverage=0 exec total=0 (0/sec) pending=0 reproducing=0
```

- **candidates**: triage 대기 중인 후보 입력 수
- **corpus**: 보관된 시드/프로그램 크기
- **coverage**: 고유 커버리지 포인트 수
- **exec total**: 총 실행 횟수와 초당 실행률
- **pending**: 대기중인 재현/검증 작업 수
- **reproducing**: 실행 중인 재현 작업 수

작성된 내용은 공식 깃허브를 참고하여 작성 되었으며, GPT를 통하여 다듬어 작성되었습니다.
