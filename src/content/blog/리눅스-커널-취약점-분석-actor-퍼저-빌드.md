---
title: "[리눅스 커널 취약점 분석] ACTOR 퍼저 빌드"
description: "WSL 환경에서 ACTOR 커널 퍼저를 빌드하고 실행하는 과정을 단계별로 정리한 글입니다."
date: 2025-10-19T03:35:09+09:00
category: "보안"
tags: ["리눅스 커널", "퍼징", "ACTOR", "커널 취약점", "보안"]
draft: false
---

## 빌드 환경

필자는 WSL 환경에서 빌드를 진행하였다.

CPU : 16코어

MEM : 32GB

---

## ACTOR: Action-Guided Kernel Fuzzing 빌드

작업 디렉토리 : /usr/src/kernel

```bash
git clone https://github.com/ucsb-seclab/actor.git
cd actor
```

해당 레포지토리 클론 후 클론 한 디렉토리로 이동한다.

```bash
git clone https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git
cd linux
git checkout 2241ab53cbb5cdb08a6b2d4688feb13971058f65
git apply ../setup/kernel/v6-2-rc5.patch
```

이어서, 리눅스 파일을 클론하고, 체크아웃 설정, 패치 적용을 진행한다.

```bash
make clean
make mrproper
make menuconfig
# ESC 두 번 눌러서 menuconfig 종료
./scripts/kconfig/merge_config.sh .config ../setup/kernel/actor.config
make -j"$(nproc)"
```

그런 다음 커널 빌드를 수행한다.

```bash
cd /usr/src/kernel/actor/semantic-inference
docker build -t sem-infer .
cd ..
```

이어서 정적 분석을 위한 도커를 빌드한다.

이 때 도커 빌드에 에러가 난다면 **/usr/src/kernel/actor/semantic-inference/Dockerfile** 파일을 다음과 같이 수정한다.

```bash
FROM debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive
RUN apt update && apt install -y llvm-14 clang-14 clang cmake flex bison bc libelf-dev libssl-dev
ADD ktypes.cpp CMakeLists.txt actor_static.config /plugin/
WORKDIR /plugin/
RUN mkdir build && cd build && cmake .. && make

RUN echo "clang-14 -g -fexperimental-new-pass-manager -fpass-plugin=/plugin/build/libktypesPass.so \"\$@\"" > /bin/clang-ktypes && chmod +x /bin/clang-ktypes
CMD make -C /kernel/ -j `nproc` CC=clang-ktypes
```

또 안 된다면 GPT에게 여쭤보자

```bash
docker run -ti -v "/usr/src/kernel/actor/linux":/kernel --entrypoint /bin/bash sem-infer
```

빌드한 도커를 실행 한다.

## 해당 명령어는 도커 내부에서 실행

```bash
cd /kernel
make olddefconfig CC=clang-ktypes
CC=clang-ktypes ./scripts/kconfig/merge_config.sh .config /plugin/actor_static.config
make -C /kernel/ -j `nproc` CC=clang-ktypes 2> /kernel/ptrs.txt
exit
```

도커 내부에서 해당 명령어 실행 한다.

이어서 퍼저 설정인데 오류가 많다.

```bash
cd src/github.com/google/syzkaller/
export GO111MODULE=off
export GOPATH=/usr/src/kernel/actor
make -j"$(nproc)"
cd ../../../../
```

이어서 IVSHMEM를 빌드한다

```bash
cd setup/ivshmem/kernel_module/uio
make
cd ../../../../
```

이어서 uio.ko, uio_ivshmem.ko 파일을 qemu에 올려줘야 한다. 이를 위해 image가 있어야 한다. 기존 파일이 있다면 파일명을 image로 바꿔서 /usr/src/kernel/actor 경로로 옮긴다. 아니라면 아래 명령어를 수행한다.

```bash
sudo apt install debootstrap
mkdir image 
cd image
wget https://raw.githubusercontent.com/google/syzkaller/master/tools/create-image.sh -O create-image.sh
chmod +x create-image.sh
./create-image.sh
cd ..
```

이어서 qemu를 부팅한다.

```bash
qemu-system-x86_64 -kernel linux/arch/x86/boot/bzImage -append "console=ttyS0 root=/dev/sda debug earlyprintk=serial slub_debug=QUZ nokaslr" -hda image/bullseye.img -net user,hostfwd=tcp::10021-:22 -net nic -enable-kvm -nographic -m 4G -smp 2
```

이어서 별도의 터미널에서 scp를 통해 필요한 두 파일을 전송한다.

```bash
scp -i image/bullseye.id_rsa -P10021 linux/drivers/uio/uio.ko root@localhost:
scp -i image/bullseye.id_rsa -P10021 setup/ivshmem/kernel_module/uio/uio_ivshmem.ko root@localhost:
```

두개의 파일을 전송한 다음 qemu는 init 0을 입력 해 종료한다.

---

## actor 실행

작업 디렉토리를 만들고, ptrs.txt 파일을 복사한다.

```bash
mkdir -p out/workdir
cp linux/ptrs.txt out/workdir/
```

이제 퍼징을 수행한다.

```bash
cd setup/actor
../../src/github.com/google/syzkaller/bin/syz-manager -config actor.config
```

---

## 참고 문헌

[1] [https://www.usenix.org/conference/usenixsecurity23/presentation/fleischer](https://www.usenix.org/conference/usenixsecurity23/presentation/fleischer)

[2] [https://github.com/ucsb-seclab/actor?tab=readme-ov-file](https://github.com/ucsb-seclab/actor?tab=readme-ov-file)

