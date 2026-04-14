---
title: "[리눅스 커널 퍼징] Syzkaller 분석"
description: "Google의 커널 퍼저 Syzkaller의 구조, 동작 원리, 장단점, 세부 기능 분석"
date: 2025-11-01T16:32:00+09:00
category: "학습"
tags: ["fuzzer", "kernel fuzzing", "Linux Kernel", "Syzkaller"]
draft: false
---

# [리눅스 커널 퍼징] Syzkaller 분석

Syzkaller는 "an unsupervised coverage-guided kernel fuzzer"로서, 자동으로 syscall 시퀀스를 생성하고 실행하여 새로운 커널 코드 경로를 발견하고 크래시를 수집합니다.

## 1. 개요

| 항목 | 내용 |
|------|------|
| 이름 | Syzkaller |
| 개발자 | Google |
| 언어 | Go (golang) |
| 대상 | Linux Kernel (BSD/Windows 포트 가능) |
| GitHub | [https://github.com/google/syzkaller](https://github.com/google/syzkaller) |

**핵심 목표:**
1. 커널 syscall 인터페이스 자동 탐색
2. 비정상 입력 조합을 통한 커널 버그 탐지
3. 커버리지 피드백을 통한 테스트 효율 최적화

## 2. 장점과 한계

### 장점
- KCOV 기반 피드백으로 랜덤 퍼징 대비 효율적인 취약점 탐지
- 크래시 수집부터 재현까지 자동화된 파이프라인
- 다수 VM 인스턴스에서 병렬 퍼징 가능
- sys description을 통한 의미론적으로 유효한 입력 생성

### 한계
- 복잡한 초기 설정 (KCOV/KASAN 커널 컴파일 필요)
- 커널 동작으로 인한 커버리지 노이즈
- 상당한 리소스와 장시간 실행 필요

## 3. 동작 원리

### Target Definition
syscall과 파라미터 타입을 지정하는 메타데이터

### Input Generation
syz-fuzzer가 corpus와 coverage signal을 이용하여 syscall 시퀀스를 생성

### Isolated Execution
syz-executor가 QEMU/VM에서 프로그램을 실행하고, 커널 로그와 크래시를 수집

### Coverage Feedback
KCOV가 실행 경로를 전달하여 "흥미로운" 입력을 판별

### Crash Processing
syz-manager가 로그를 수집하고, syz-repro가 최소 재현자를 생성

## 4. 사용법

1. Go 툴체인 및 가상화 환경 준비
2. KCOV/KASAN 디버깅 옵션으로 커널 컴파일
3. Syzkaller 바이너리 컴파일
4. JSON config로 manager 설정
5. 이미지/VM 등록
6. 웹 대시보드로 퍼징 모니터링

## 5. 주요 구성 요소

| 구성 요소 | 역할 |
|-----------|------|
| syz-manager | 퍼징 오케스트레이션, VM 관리, 크래시 분류 |
| syz-fuzzer / syz-executor | 시퀀스 생성 및 syscall 실행 |
| syz-repro / syz-verifier | 재현자 자동 생성 및 검증 |
| sys/ + prog/ | syscall 명세 및 시퀀스 생성 로직 |

![Syzkaller 구조](https://blog.kakaocdn.net/dna/3lgdZ/dJMcae0hCnY/AAAAAAAAAAAAAAAAAAAAAFnb36DLqfxXVI1hjowN7sCQ8nUldx3AEzzSk3d-INHH/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1777561199&allow_ip=&allow_referer=&signature=j6%2BAjfL4zGCn%2B0qhfpTSFz1hNNI%3D)

## 6. 주의사항

- 커널 빌드 옵션을 목적에 맞게 설정
- manager config 경로를 정확히 검증
- KCOV 커버리지 노이즈를 필터링으로 관리
- corpus 성장과 성능 저하를 모니터링
- OS별 문서를 참조

## 7. 로그 출력 해석

퍼징 실행 시 출력되는 주요 메트릭:

| 메트릭 | 설명 |
|--------|------|
| candidates | 분류 대기 중인 항목 |
| corpus | 저장된 시드 프로그램 수 |
| coverage | 발견된 고유 코드 경로 수 |
| exec total/sec | 총 실행 횟수 및 처리량 |
| pending | 재현 대기 큐 |
| reproducing | 활성 재현 작업 수 |

