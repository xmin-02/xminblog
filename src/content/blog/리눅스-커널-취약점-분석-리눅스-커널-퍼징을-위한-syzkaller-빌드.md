---
title: "[리눅스 커널 취약점 분석] 리눅스 커널 퍼징을 위한 Syzkaller 빌드"
description: "Syzkaller 퍼저 빌드 및 설정, Go 환경 구성부터 퍼징 실행까지의 과정"
date: 2025-11-01T15:23:00+09:00
category: "환경 구축"
tags: ["fuzz", "kernel fuzzing", "Linux Kernel", "Syzkaller"]
draft: false
---

본 블로그는 로컬 환경에서 실시되었으며, wsl과 로컬 환경 동일합니다.

linux-6.17.6 버전을 기준으로 작성 되었으며, 본 블로그의 작업 디렉토리는 /usr/src/kernel 입니다.

시작하기 앞서 의존성을 설치한다.

```bash
sudo apt update
sudo apt install make gcc flex bison libncurses-dev libelf-dev libssl-dev debootstrap qemu-system-x86 git vim
```

## 이미지 빌드

```bash
mkdir /usr/src/kernel/image
cd /usr/src/kernel/image
wget https://raw.githubusercontent.com/google/syzkaller/master/tools/create-image.sh -O create-image.sh
chmod +x create-image.sh
./create-image.sh
```

## QEMU 부팅

```bash
sudo qemu-system-x86_64 \
  -m 2G -smp 2 \
  -kernel /usr/src/kernel/linux-6.17.6/arch/x86/boot/bzImage \
  -append "console=ttyS0 root=/dev/sda earlyprintk=serial net.ifnames=0" \
  -drive file=/usr/src/kernel/image/bullseye.img,format=raw \
  -net user,host=10.0.2.10,hostfwd=tcp:127.0.0.1:10021-:22 \
  -net nic,model=e1000 \
  -enable-kvm -nographic -pidfile vm.pid \
  2>&1 | tee vm.log
```

다른 터미널에서 SSH 접속:

```bash
ssh -i /usr/src/kernel/image/bullseye.id_rsa -p 10021 -o "StrictHostKeyChecking no" root@localhost
```

## Go 빌드

```bash
wget https://dl.google.com/go/go1.23.6.linux-amd64.tar.gz
tar -xf go1.23.6.linux-amd64.tar.gz
mv go goroot
mkdir gopath
export GOPATH=`pwd`/gopath
export GOROOT=`pwd`/goroot
export PATH=$GOPATH/bin:$PATH
export PATH=$GOROOT/bin:$PATH
```

## Syzkaller 빌드

```bash
git clone https://github.com/google/syzkaller
cd syzkaller
make
```

## 퍼징 설정 (my.cfg)

```json
{
  "target": "linux/amd64",
  "http": "127.0.0.1:56741",
  "workdir": "/usr/src/kernel/syzkaller/workdir",
  "kernel_obj": "/usr/src/kernel/linux-6.17.6",
  "image": "/usr/src/kernel/image/bullseye.img",
  "sshkey": "/usr/src/kernel/image/bullseye.id_rsa",
  "syzkaller": "/usr/src/kernel/syzkaller",
  "procs": 8,
  "type": "qemu",
  "vm": {
    "count": 1, "cpu": 2, "mem": 2048,
    "kernel": "/usr/src/kernel/linux-6.17.6/arch/x86/boot/bzImage",
    "cmdline": "console=ttyS0 root=/dev/sda earlyprintk=serial net.ifnames=0"
  }
}
```

실행:

```bash
./bin/syz-manager -config my.cfg
```

Syzkaller Dashboard: http://127.0.0.1:56741
