# CI/CD 처음 해보기 — Node.js + Docker + GitHub Actions

Docker Desktop을 설치한 김에 CI/CD 파이프라인을 직접 한 번 돌려본 기록.
간단한 Node.js 앱을 만들어서 GitHub에 push하면 → GitHub Actions가 자동으로 테스트하고 → Docker 이미지를 빌드해서 → Docker Hub에 올리는 흐름까지를 목표로 했다.

```
로컬 코드 변경
   ↓ git push
GitHub 저장소
   ↓ Actions 자동 트리거
GitHub Actions 러너
   ├─ Job 1: Test (npm test)
   └─ Job 2: Docker Build & Push
        ↓
Docker Hub (moonprod/cicd-practice)
   ↓ docker pull
어디서든 동일한 컨테이너 실행
```

---

## 단계별 진행

### 1. 프로젝트 폴더와 Express 앱 만들기

```bash
mkdir -p ~/Desktop/DX/cicd-practice
cd ~/Desktop/DX/cicd-practice
```

`package.json`:

```json
{
  "name": "cicd-practice",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "node test.js"
  },
  "dependencies": {
    "express": "^4.19.2"
  }
}
```

`index.js` — 두 개의 엔드포인트(`/`, `/health`)를 가진 아주 단순한 서버:

```javascript
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({
    message: 'Hello from CI/CD practice!',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
```

`test.js` — `/health` 엔드포인트가 정상 응답하는지 검증하는 스모크 테스트:

```javascript
const http = require('http');
const app = require('./index');

const server = app.listen(0, () => {
  const port = server.address().port;
  http.get(`http://localhost:${port}/health`, (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      const body = JSON.parse(data);
      if (res.statusCode === 200 && body.status === 'ok') {
        console.log('PASS: /health returned ok');
        server.close();
        process.exit(0);
      } else {
        console.error('FAIL', res.statusCode, body);
        server.close();
        process.exit(1);
      }
    });
  });
});
```

설치 후 로컬에서 테스트 통과 확인:

```bash
npm install
npm test
# > PASS: /health returned ok
```

### 2. Dockerfile 작성과 로컬 컨테이너 실행

`Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
```

`.dockerignore`도 만들어서 `node_modules`, `.git` 같은 건 이미지에 안 들어가게 했다.

빌드 → 실행 → curl로 응답 확인:

```bash
docker build -t cicd-practice:local .
docker run -d --name cicd-test -p 3000:3000 cicd-practice:local
curl http://localhost:3000/health
# {"status":"ok"}
docker rm -f cicd-test
```

> TODO: 컨테이너 실행 후 curl 응답 스크린샷 첨부

### 3. GitHub 저장소 만들고 push

GitHub 웹에서 빈 저장소(`cicd-practice`) 생성 (README/gitignore/license 모두 체크 해제 — 빈 저장소여야 충돌 없이 push됨).

```bash
git init -b main
git config user.name "MOONProd"
git config user.email "본인 이메일"
git add .
git commit -m "Initial commit: Express app with Dockerfile"
git remote add origin https://github.com/MOONProd/cicd-practice.git
git push -u origin main
```

> 여기서 인증 관련 함정 두 개를 만났다 → 아래 "막혔던 부분" 참고.

### 4. Docker Hub 토큰 발급 + GitHub Secrets 등록

GitHub Actions가 Docker Hub에 이미지를 push하려면 자격증명이 필요한데, 비밀번호 직접 넣지 않고 **액세스 토큰**을 쓰는 게 표준이다.

- Docker Hub → Account settings → Personal access tokens → `Generate new token` (Read & Write 권한)
- GitHub 저장소 → Settings → Secrets and variables → Actions → 두 개 등록:
  - `DOCKERHUB_USERNAME` : 본인 Docker ID
  - `DOCKERHUB_TOKEN` : 위에서 발급받은 토큰

> TODO: GitHub Secrets에 두 개 등록된 화면 스크린샷

### 5. GitHub Actions 워크플로우 작성

`.github/workflows/ci.yml`:

```yaml
name: CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm test

  build-and-push:
    name: Build and push Docker image
    runs-on: ubuntu-latest
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ${{ secrets.DOCKERHUB_USERNAME }}/cicd-practice:latest
            ${{ secrets.DOCKERHUB_USERNAME }}/cicd-practice:${{ github.sha }}
```

핵심 두 가지:

- `needs: test` — 테스트가 실패하면 빌드/push 자체가 안 일어남
- `if: ... refs/heads/main` — PR에서는 테스트만 돌고, main에 머지된 이후에만 이미지 push (PR마다 push되면 Docker Hub가 난잡해짐)

이미지 태그는 두 개로 박았다:

- `:latest` — 항상 최신을 가리킴
- `:<커밋해시>` — 특정 시점으로 롤백/추적 가능

### 6. push → 자동 빌드 확인 → Docker Hub에서 pull

```bash
git add .github/workflows/ci.yml
git commit -m "Add GitHub Actions CI/CD workflow"
git push
```

GitHub 저장소의 **Actions** 탭에서 워크플로우가 자동으로 실행되는 게 보인다. `test` job이 통과한 뒤 `build-and-push`가 이어서 도는 구조.

> TODO: GitHub Actions 두 job 모두 녹색 체크 화면 스크린샷
> TODO: Docker Hub의 Tags 탭 스크린샷 (`latest` + 커밋 해시)

마지막으로 Docker Hub에서 직접 받아서 실행:

```bash
docker pull moonprod/cicd-practice:latest
docker run -d --name cicd-from-hub -p 3001:3000 moonprod/cicd-practice:latest
curl http://localhost:3001/
# {"message":"Hello from CI/CD practice!","version":"1.0.0",...}
```

여기서 한 사이클 완료. 로컬 push 한 번으로 클라우드에서 빌드된 이미지가 다시 내 로컬로 돌아오는 흐름을 직접 본 셈.

---

## 막혔던 부분 (실제로 부딪힌 함정들)

### 함정 1. Docker Desktop을 깔았는데 `docker` 명령어가 없다

Docker Desktop을 설치하고 바로 터미널에서 `docker --version`을 쳤는데:

```
zsh: command not found: docker
```

원인은 단순했다. **Docker Desktop 앱을 한 번 실행해야** CLI 심볼릭 링크가 `/usr/local/bin/docker`에 깔린다. Spotlight에서 Docker 검색해서 한 번 띄우고 메뉴바에 고래 아이콘이 뜬 뒤 다시 터미널에서 치니 정상 동작.

> 교훈: macOS에서 Docker Desktop은 "설치 ≠ 사용 가능". 앱을 최소 한 번은 실행해야 한다.

### 함정 2. GitHub push에서 403 에러 (PAT 권한 부족)

GitHub는 더 이상 비밀번호로 HTTPS push를 못 받기 때문에 **Personal Access Token (PAT)**가 필요하다. 처음엔 보안적으로 더 엄격한 **Fine-grained PAT**를 발급받았는데:

```
fatal: unable to access 'https://github.com/MOONProd/cicd-practice.git/':
The requested URL returned error: 403
```

403은 **인증은 됐지만 권한이 없다**는 뜻. Fine-grained PAT는 권한 항목을 잘게 쪼개놔서 초보자가 빠뜨리기 너무 쉽다 (특히 `Contents: Read and write`를 명시적으로 켜야 한다는 걸 모르고 넘어감).

해결: **Classic PAT**로 갈아탔다. 스코프에서 `repo` 하나만 체크하면 끝. 훨씬 단순하다.

> 교훈: 처음 해보는 거라면 Classic PAT가 마음 편하다. Fine-grained는 권한 흐름이 익숙해진 뒤에.

### 함정 3. workflow 파일 push에서 또 막힘 (workflow 스코프 누락)

첫 push는 성공했는데, `.github/workflows/ci.yml`을 추가해서 두 번째 push할 때:

```
! [remote rejected] main -> main (refusing to allow a Personal Access Token
to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)
```

GitHub는 **워크플로우 파일을 만들거나 수정하는 건 별도 스코프(`workflow`)**를 요구한다. 보안상 워크플로우는 코드보다 더 위험할 수 있어서(악의적 워크플로우로 시크릿 탈취 가능) 일반 push 권한과 분리해놓은 듯.

해결: PAT 설정 페이지로 돌아가서 `workflow` 스코프를 추가로 체크 → `Update token`. 토큰 값 자체는 그대로라 keychain에 다시 저장할 필요 없었음.

> 교훈: GitHub Actions를 쓰려면 PAT에 `repo` + `workflow` 두 개 다 필요하다. 처음 PAT 만들 때 같이 체크해두면 함정 2-1 회피.

### 함정 4. Apple Silicon Mac에서 `docker pull` 실패 (multi-arch 이슈)

CI/CD가 다 성공한 후에 Docker Hub에서 이미지를 pull하려는데:

```
Error response from daemon: no matching manifest for linux/arm64/v8
in the manifest list entries: no match for platform in manifest: not found
```

원인: 내 Mac은 **Apple Silicon (arm64)**인데 GitHub Actions의 Ubuntu 러너에서 빌드된 이미지는 **linux/amd64** 전용이었다. arm64에 맞는 매니페스트가 없으니 못 받겠다는 뜻.

당장 우회: `--platform` 플래그로 amd64 이미지를 강제로 받아 에뮬레이션 실행.

```bash
docker pull --platform linux/amd64 moonprod/cicd-practice:latest
docker run --platform linux/amd64 -p 3001:3000 moonprod/cicd-practice:latest
```

제대로 된 해결: 워크플로우의 `build-push-action` 단계에 `platforms` 옵션을 넣어서 multi-arch로 빌드하면 된다 (TODO: 다음에 적용).

```yaml
- uses: docker/build-push-action@v6
  with:
    context: .
    push: true
    platforms: linux/amd64,linux/arm64   # ← 이 한 줄
    tags: ...
```

> 교훈: M1/M2 Mac에서 Linux 서버용 이미지를 만들 때는 multi-arch 빌드를 처음부터 고려해야 한다. 안 그러면 "내 컴퓨터에서는 안 돌아가는데 서버에서는 돌아가는" 정반대 상황이 생긴다.

---

## 정리

처음엔 Docker, GitHub, GitHub Actions, Docker Hub 네 군데를 왔다갔다 해야 해서 머릿속이 복잡했는데, 한 번 끝까지 돌려보니 흐름이 단순했다:

> **나는 코드만 push, 나머지(테스트/빌드/배포)는 Actions가 처리**

위에 적힌 함정 4개는 전부 "튜토리얼에는 안 적혀 있는데 누구나 부딪히는" 것들이라, 다음에 누가 같은 걸 해본다면 이 글이 도움이 되길.
