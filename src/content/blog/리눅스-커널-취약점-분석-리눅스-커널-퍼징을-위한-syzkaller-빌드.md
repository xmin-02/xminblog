---
title: "[리눅스 커널 취약점 분석] 리눅스 커널 퍼징을 위한 Syzkaller 빌드"
description: "Syzkaller 퍼저 빌드 및 설정, Go 환경 구성부터 퍼징 실행까지의 과정"
date: 2025-11-01T15:23:00+09:00
category: "환경 구축"
tags: ["fuzz", "kernel fuzzing", "Linux Kernel", "Syzkaller"]
draft: false
---

# [리눅스 커널 취약점 분석] 리눅스 커널 퍼징을 위한 Syzkaller 빌드

본 블로그는 로컬 환경에서 실시되었으며, wsl과 로컬 환경 동일합니다.

linux-6.17.6 버전을 기준으로 작성 되었으며, 모든 설치 과정은 동일하니 linux-6.17.6 부분만 각자 다운받은 버전으로 변경하면 됩니다.

본 블로그의 작업 디렉토리는 /usr/src/kernel 입니다.

## 의존성 설치

시작하기 앞서 의존성을 설치한다.

```bash
sudo apt update
sudo apt install make gcc flex bison libncurses-dev libelf-dev libssl-dev debootstrap qemu-system-x86 git vim
```

## 이미지 빌드

다음 명령을 통해 image를 빌드한다.

```bash
mkdir /usr/src/kernel/image
cd /usr/src/kernel/image
wget https://raw.githubusercontent.com/google/syzkaller/master/tools/create-image.sh -O create-image.sh
chmod +x create-image.sh
./create-image.sh
```

## QEMU 부팅 테스트

이어서 빌드한 내용을 기반으로 qemu를 부팅한다.

```bash
sudo qemu-system-x86_64 \
        -m 2G \
        -smp 2 \
        -kernel /usr/src/kernel/linux-6.17.6/arch/x86/boot/bzImage \
        -append "console=ttyS0 root=/dev/sda earlyprintk=serial net.ifnames=0" \
        -drive file=/usr/src/kernel/image/bullseye.img,format=raw \
        -net user,host=10.0.2.10,hostfwd=tcp:127.0.0.1:10021-:22 \
        -net nic,model=e1000 \
        -enable-kvm \
        -nographic \
        -pidfile vm.pid \
        2>&1 | tee vm.log
```

정상적으로 부팅이 되었다면 아래 명령어를 다른 터미널에서 입력 시 접속이 될것이다.

```bash
ssh -i /usr/src/kernel/image/bullseye.id_rsa -p 10021 -o "StrictHostKeyChecking no" root@localhost
```

qemu가 정상 부팅 된다면 다음과 같을 것이다.

![QEMU 부팅 모습](https://blog.kakaocdn.net/dna/brEWgU/dJMcah3L3EY/AAAAAAAAAAAAAAAAAAAAAL91aX1qoDLXF8SnPCiv281XnsDsS018r-_6PrkUKIln/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1777561199&allow_ip=&allow_referer=&signature=dD14uxvfZZj2iYfrdrebhKHgpmE%3D)

## Go 빌드

이제 Syzkaller를 빌드하기 위해 go를 빌드한다.

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

이어서 바로 Syzkaller를 빌드한다.

```bash
git clone https://github.com/google/syzkaller
cd syzkaller
make
```

## 퍼징 설정 및 실행

이어서 my.cfg 파일을 만들어 아래 내용을 넣어주고 주면 퍼징을 수행할 수 있다.

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
		"count": 1,
		"cpu": 2,
		"mem": 2048,
		"kernel": "/usr/src/kernel/linux-6.17.6/arch/x86/boot/bzImage",
		"cmdline": "console=ttyS0 root=/dev/sda earlyprintk=serial net.ifnames=0"
	}
}
```

my.cfg 파일을 만든 뒤 실행 명령어는 다음과 같다.

```bash
./bin/syz-manager -config my.cfg
```

정상적으로 퍼징이 수행되면 다음과 같은 모습이다.

![Syzkaller 퍼징 실행](https://blog.kakaocdn.net/dna/bzybag/dJMcaa4Enpu/AAAAAAAAAAAAAAAAAAAAAO3rmJI3HDoHQdFEXL6mrQ9r_LyN0IsQR8FS0mAHFWe6/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1777561199&allow_ip=&allow_referer=&signature=REkZ0QM%2FtYC8A%2FV8urdtp2ds2gY%3D)

이제 Syzkaller가 정상 작동 한다는 것을 알 수 있다. 잘 빌드가 된 것이다.

Syzkaller는 퍼징 현황을 실시간으로 볼 수 있는 Syzkaller Dashboard가 지원된다.

http://127.0.0.1:56741

위 링크로 접속하면 Syzkaller Dashboard를 확인 가능하다.

