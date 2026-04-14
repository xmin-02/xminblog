---
title: "[리눅스 커널 취약점 분석] 리눅스 커널 퍼징을 위한 qemu, BusyBox 빌드"
description: "리눅스 커널 퍼징을 위한 QEMU 설치 및 BusyBox 빌드, rootfs 생성 과정"
date: 2025-11-01T02:41:00+09:00
category: "환경 구축"
tags: ["busybox", "fuzz", "Fuzzing", "Linux Kernel", "qemu"]
draft: false
---

# [리눅스 커널 취약점 분석] 리눅스 커널 퍼징을 위한 qemu, BusyBox 빌드

본 블로그는 로컬 환경에서 실시되었으며, wsl과 로컬 환경 동일합니다.

linux-6.17.6 버전을 기준으로 작성 되었으며, 모든 설치 과정은 동일하니 linux-6.17.6 부분만 각자 다운받은 버전으로 변경하면 됩니다.

본 블로그의 작업 디렉토리는 /usr/src/kernel 입니다.

## qemu 설치

```bash
sudo apt install qemu-utils qemu-system-x86 qemu-kvm
```

이 명령어 한 줄이면 qemu 설치는 끝난다.

## BusyBox 빌드

![BusyBox 다운로드 페이지](https://blog.kakaocdn.net/dna/chuty9/dJMcacaj5dl/AAAAAAAAAAAAAAAAAAAAAJ9HaP3XbEU0ypCknQq1Cp9gQdYDZUAVWpvAQP1IJdVb/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1777561199)

```bash
cd /usr/src/kernel
sudo cp ~/Downloads/busybox-1.37.0.tar.bz2 ./
sudo tar -xvf ./busybox-1.37.0.tar.bz2
cd busybox-1.37.0
make menuconfig
```

menuconfig 설정 옵션:
1. Settings -> Build options -> build static binary 선택
2. Networking Utilities -> inetd 선택 해제
3. Networking Utilities -> tc 선택 해제

```bash
sudo apt update
sudo apt install -y libncurses-dev libnl-3-dev libnl-genl-3-dev linux-headers-$(uname -r)
sudo make CONFIG_PREFIX=../result install
```

![BusyBox 빌드 출력](https://blog.kakaocdn.net/dna/3SFkq/dJMcaaXSCcK/AAAAAAAAAAAAAAAAAAAAAIL4A5VXv6PzouEpp17CfrxJI8f8CEB7duwQk3li9unC/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1777561199)

busybox 빌드 출력이 성공하면 계속 진행:

```bash
cd ../result/
mkdir var dev etc lib proc tmp sys

cat << 'EOF' > ./init
#!/bin/sh

mount -t proc none /proc
mount -t sysfs none /sys
mount -t devtmpfs devtmpfs /dev

exec 0</dev/console
exec 1>/dev/console
exec 2>/dev/console

echo "7 4 1 7" > /proc/sys/kernel/printk

cp /proc/kallsyms /tmp/kallsyms

setsid cttyhack setuidgid 1000 sh

umount /proc
umount /sys
poweroff -d 0 -f
EOF

chmod 755 ./init
find .| cpio -o --format=newc > ../rootfs.cpio
```

```bash
cd ../
mkdir rootfs
mv ./rootfs.cpio ./rootfs
cd ./rootfs
cpio -id -v < rootfs.cpio

find .| cpio -o --format=newc > ../rootfs.cpio
cd ../
```

## QEMU 실행 테스트

```bash
cd /usr/src/kernel
qemu-system-x86_64 \
-m 4G -smp 4,cores=4,threads=1 \
-kernel /usr/src/kernel/linux-6.17.6/arch/x86/boot/bzImage \
-initrd  ./rootfs.cpio \
-append "root=/dev/ram rw console=ttyS0 oops=panic panic=1 quiet" \
-netdev user,id=t0, -device e1000,netdev=t0,id=nic0 \
-nographic  \
-cpu host \
-enable-kvm \
-s
```

![QEMU 실행 성공](https://blog.kakaocdn.net/dna/u6WyR/dJMcaiVUFZT/AAAAAAAAAAAAAAAAAAAAAG3S2Upg2wx5Jyld945UsheE2LD7cLTzNLugtmm3xr3e/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1777561199)

저런 라인이 뜬다면 잘 실행 된 것이다. exit를 입력해 종료하자.

이상으로 qemu, busybox 빌드에 대해 알아보았다.

