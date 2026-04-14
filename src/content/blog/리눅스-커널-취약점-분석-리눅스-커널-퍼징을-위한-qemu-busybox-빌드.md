---
title: "[리눅스 커널 취약점 분석] 리눅스 커널 퍼징을 위한 qemu, BusyBox 빌드"
description: "리눅스 커널 퍼징을 위한 QEMU 설치 및 BusyBox 빌드, rootfs 생성 과정"
date: 2025-11-01T02:41:00+09:00
category: "환경 구축"
tags: ["busybox", "fuzz", "Fuzzing", "Linux Kernel", "qemu"]
draft: false
---

본 블로그는 로컬 환경에서 실시되었으며, wsl과 로컬 환경 동일합니다.

linux-6.17.6 버전을 기준으로 작성 되었으며, 본 블로그의 작업 디렉토리는 /usr/src/kernel 입니다.

## qemu 설치

```bash
sudo apt install qemu-utils qemu-system-x86 qemu-kvm
```

이 명령어 한 줄이면 qemu 설치는 끝난다.

qemu를 실행하기 위해선 BusyBox를 빌드 해야한다. https://www.busybox.net/ 에서 원하는 버전을 다운받자.

## BusyBox 빌드

```bash
cd /usr/src/kernel
sudo cp ~/Downloads/busybox-1.37.0.tar.bz2 ./
sudo tar -xvf ./busybox-1.37.0.tar.bz2
cd busybox-1.37.0
make menuconfig
```

menuconfig 옵션:

1. Settings > Build options > build static binary 선택
2. Networking Utilities > inetd 선택 해제
3. Networking Utilities > tc 선택 해제

의존성 설치 후 빌드:

```bash
sudo apt update
sudo apt install -y libncurses-dev libnl-3-dev libnl-genl-3-dev linux-headers-$(uname -r)
sudo make CONFIG_PREFIX=../result install
```

## rootfs 생성

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

## QEMU 실행

```bash
qemu-system-x86_64 \
  -m 4G -smp 4,cores=4,threads=1 \
  -kernel /usr/src/kernel/linux-6.17.6/arch/x86/boot/bzImage \
  -initrd ./rootfs.cpio \
  -append "root=/dev/ram rw console=ttyS0 oops=panic panic=1 quiet" \
  -netdev user,id=t0, -device e1000,netdev=t0,id=nic0 \
  -nographic -cpu host -enable-kvm -s
```

정상 실행되면 exit를 입력해 종료하자.

이상으로 qemu, busybox 빌드에 대해 알아보았다.
