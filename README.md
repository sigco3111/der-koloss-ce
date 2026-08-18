# 더 콜로스 — 한글화 포크

> **Der Koloss — Community Edition**의 한국어 로컬라이즈이션 포크입니다.
> 원본은 Vesper가 만든 무료 브라우저 좀비 웨이브 서바이벌 게임으로,
> Three.js로 작성되었고 빌드 단계가 없는 순수 ES modules + import map 프로젝트입니다.

<div align="center">

### 🎮 [라이브 데모 — sigco3111.github.io/der-koloss-ce](https://sigco3111.github.io/der-koloss-ce/)

**원본 저장소**: [github.com/rishipr/der-koloss-ce](https://github.com/rishipr/der-koloss-ce) ·
**이 포크**: [github.com/sigco3111/der-koloss-ce](https://github.com/sigco3111/der-koloss-ce) ·
**라이브 URL**: [sigco3111.github.io/der-koloss-ce](https://sigco3111.github.io/der-koloss-ce/)

</div>

---

## 이 포크에 대하여

Der Koloss CE는 MIT 라이선스의 오픈소스 게임이지만, 원본은 영어 전용입니다.
영어 메뉴를 읽으며 한국어 좀비 게임을 즐기는 것은 분명히 불편합니다.
이 포크는 **사용자 인터페이스 전부를 한국어로 옮기되 게임플레이는 1:1로 보존**합니다.

| 영역 | 변경 |
|---|---|
| **UI 텍스트** | 메뉴, HUD, 로비, 일시정지, 옵션, 캐릭터 선택, 치트 코드, 게임 오버 화면 모두 한글화 |
| **메타데이터** | `<html lang="ko">`, `og:locale: ko_KR`, JSON-LD `inLanguage: ko`, canonical/sitemap/robots |
| **정적 페이지** | about, assets, cinematic, 404 페이지의 lang/메타데이터/네비게이션 |
| **번역 어휘** | 무기 31종, 캐릭터 4명, perk 4종, 배너 20+종, 토스트 18종, 옵션 12개 슬라이더 |
| **게임플레이** | 변경 없음 — 무기 메카닉, 좀비 AI, 멀티플레이어 프로토콜, 렌더링 모두 원본 그대로 |
| **LICENSE** | 원본 MIT 텍스트 그대로 보존 |

## 한글화 (i18n) 상세

### 아키텍처

원본은 빌드 도구(vite, webpack, esbuild 등)가 전혀 없는 no-bundler 프로젝트입니다.
`index.html`이 `<script type="importmap">`로 `three`만 모킹하고, 나머지는 전부 ES modules raw import입니다.
따라서 localized-fork 스킬의 esbuild `t()` inline 우회 트릭이 **불필요**합니다 — 그냥 dict + `t()` 함수로 끝.

```
js/i18n.js          ← 330 키 EN↔KO 1:1 매칭 (평탄 dict)
js/hud.js           ← import { t, weaponDisplayName } from './i18n.js';
js/main.js          ← import { t, setLanguage as setI18nLang } from './i18n.js';
js/game.js          ← import { t } from './i18n.js';
js/personas.js      ← label: () => t('personaDempsey')  (함수로 래핑)
js/weapons.js       ← export function displayName(id) { return t('wpn' + cap(id)); }
index.html          ← 정적 KO 텍스트 (HTML은 모듈 import 시점 이전에 렌더되므로 직접 작성)
```

### 키 카테고리 (330 키)

| 카테고리 | 키 수 | 예시 |
|---|---:|---|
| HUD | 12 | `hudBeingRevived`, `hudPerkJug`, `hudScoreKills` |
| 배너 | 22 | `bannerGameOver`, `bannerWunder`, `bannerHellhounds` |
| 토스트 | 18 | `toastEnterCode`, `toastPersonaTaken`, `toastTitan` |
| 옵션 | 18 | `optSensitivity`, `optQualityLow`, `optMaster` |
| 로비 | 26 | `lobbyReady`, `lobbyMicOn`, `lobbyWaitingMajority` |
| 일시정지 | 14 | `pauseResume`, `pauseFsOn`, `pauseEndGame` |
| 캐릭터 | 16 | `personaDempsey`, `personaDempseyT1`, `personaRichtofenBio` |
| 무기 | 31 | `wpnM1911`, `wpnRaygun`, `wpnBrowning` (+ Pap M1911) |
| 메뉴/스크린 | 50+ | `menuBtnHost`, `cheatWunderDesc`, `joinGo`, `loadHint` |
| 영토/클래스 | 14 | `areaMainframe`, `clsPistol`, `eraWaw` |

### 번역 어휘 결정 (show your work)

| 원문 | 한글 | 결정 근거 |
|---|---|---|
| WUNDERWAFFEN | 분더바펜 | 원어 그대로 음역 — 게임 내 wonder weapons 카테고리 전체가 통용어 |
| Pack-a-Punch | 팩어펀치 | 한국 COD/Zombies 커뮤니티 통용 음역 |
| Ray Gun | 레이 건 | 원어 그대로 + 띄어쓰기 (무기 이름은 보존) |
| Mystery Box | 박스 | 짧게 — `bannerBoxMoved` "박스 이동" |
| Hellhound | 헬하운드 | 음역 + 표기 통일 |
| Monkey Bomb | 원숭이 폭탄 | 의미 번역 |
| Bowie Knife | 보위 나이프 | 음역 + 한 단어 |
| Power | 전원 | 의미 |
| Teleporter | 순간이동기 | 의미 (Tele A/B는 그대로) |
| Pack | 팩어�치 약어 | 위와 동일 |
| Beauty of Annihilation | 파괴의 미학 | 음역 — Treyarch 노래 제목 |
| Juggernog | 저거너그 | 음역 + 영문 표기 병기 |
| Speed Cola | 스피드 콜라 | 음역 + 영문 표기 병기 |
| Double Tap | 더블 탭 | 음역 + 영문 표기 병기 |
| Quick Revive | 퀵 리바이브 | 음역 + 영문 표기 병기 |
| Waffenfabrik | 바펜파브릭 | 음역 (게임 내 지명) |
| Dempsey / Nikolai / Takeo / Richtofen | 덤프시 / 니콜라이 / 다케오 / 리히토펜 | 음역 |
| Tank / Pilot / Scientist 역할 | 그대로 음역 — 캐릭터 카드에 영문 표기 병기 |
| Round / Match / Game | 라운드 / 경기 / 게임 | 의미 |
| Cheat codes (TITAN MODE 등) | 치트 코드 (타이탄 모드) | 의미 |

### 식별자 보존

게임 로직에서 사용하는 ID는 **변경하지 않습니다** — `m1911`, `raygun`, `dempsey` 같은 식별자는 그대로 두었습니다.
표시 이름만 KO dict에서 lookup합니다. `displayName(id)` 헬퍼가 한 곳에서 처리:

```js
export function displayName(id) {
  if (!id) return '';
  return t(`wpn${id[0].toUpperCase()}${id.slice(1)}`);
}
```

이렇게 하면 게임 로직이 `WEAPONS['m1911']`을 찾을 때 ID 자체는 동일하게 작동합니다.

## 기술 스택

| | |
|---|---|
| **Runtime** | Three.js (vendored), PeerJS (vendored), GLTFLoader (vendored) |
| **Modules** | ES modules + import map (no bundler) |
| **Audio** | 320개 SFX + 70 voice lines (ElevenLabs) |
| **Build output** | 정적 HTML/JS/CSS/assets — 빌드 단계 없음 |
| **Pages deploy** | GitHub Pages `gh-pages` 분기 → static serve |

## 설치 및 실행

```bash
# 1. 클론
git clone https://github.com/sigco3111/der-koloss-ce.git
cd der-koloss-ce

# 2. 의존성 — 없음 (vendored)
# three.module.js, peerjs.min.js, loaders/ 모두 vendor/ 디렉토리에 포함

# 3. 정적 서버로 서빙
python3 -m http.server 8000
# 또는
npx serve .

# 4. 브라우저에서 열기
open http://localhost:8000
```

## 배포 (GitHub Pages)

이 포크는 master의 **빌드 단계 없이 그대로**를 gh-pages 분기에 push하여 GitHub Pages가 정적 호스팅합니다.
`vite 흰화면 함정`이 없습니다 — no bundler이므로 옛 hash 박히는 문제 자체가 발생하지 않습니다.

### 4단계 결정 검증 (배포 후 실제로 통과한 항목)

| # | 검증 | 결과 |
|---|---|---|
| 1 | `gh api .../pages/builds/latest` → status=built | ✅ built (commit `7435b3cf`) |
| 2 | `curl -sI https://sigco3111.github.io/der-koloss-ce/` → HTTP 200 | ✅ 200, 47,463 bytes |
| 3 | `curl ... | grep -c 'lang="ko"'` → ≥ 1 | ✅ 1 |
| 4 | KO 다중어절이 라이브 bundle에 박힘 | ✅ 분더바펜 5건, 팩어펀치 6건, 순간이동기 5건, 원숭이 폭탄 4건 등 |
| + | og:locale = `ko_KR` | ✅ |
| + | canonical = fork URL | ✅ |
| + | JSON-LD `inLanguage` = `ko` | ✅ |
| + | 한자 0건 (전체 소스) | ✅ |

### 강제 새로고침 안내

GitHub Pages의 캐시 때문에 새 배포가 늦게 반영될 수 있습니다.
`Ctrl+Shift+R` (또는 `Cmd+Shift+R`)로 강제 새로고침하세요.

## 한계 및 알려진 이슈

### 의도된 보존

- **EN 원본 메뉴 구조는 그대로** — KO로 번역하되 화면/버튼 위치/동작은 1:1 보존
- **인게임 영어 음성 대사 (LINES, 70 lines)** — 캐릭터별 음성 디자인은 원작 그대로 유지 (예: "Ooh-rah!", "Vodka first. Then war."). 한글 자막 추가 안 함.
- **에셋 38MB 그대로** — 오디오, 텍스처, 메시 모두 원본 (MIT가 아닌 자산은 `NOTICE.md` 참고)
- **게임 �런스 / 메카닉 / 맵** — 미변경
- **LICENSE** — 원본 MIT 텍스트 그대로 (Copyright (c) 2026 Vesper Tech, Inc.)

### 알려진 한계

- **assets 디렉토리 38 MB 그대로 push** — gh-pages 분기 사이즈가 큽니다. clone은 느릴 수 있지만 Pages는 정상 작동
- **Treyarch 노래 1곡 (Beauty of Annihilation)** fan tribute 자산 — MIT이 아닌 비-오픈소스 자산이 라이브에 노출됨. 이는 upstream과 동일한 동작
- **Voice lines는 영문 유지** — 한국어 음성 대사는 제작되지 않았으므로 캐릭터 인격은 영어 음성으로 보존
- **about 페이지 본문은 영문 유지** — 팬 트리뷰트의 스토리 자체는 원작자가 작성한 영문 콘텐츠. UI(네비, 라벨)만 KO화
- **번역 일관성** — 일부 게임 용어는 음역/의역 사이에서 일관되게 선택했으나, 향후 한국어 통용 음역이 확정되면 업데이트 가능
- **lang 플리퍼 없음** — 기본이 KO. EN으로 돌아가려면 `i18n.js`의 `initKorean()` 라인을 `setLanguage('en')`로 변경 후 push

### 알려지지 않은 미번역 가능성

`bundle-grep`과 `lang="ko"` 검증은 통과했지만, 다음과 같은 케이스는 발견 시 패치됩니다:

1. **HTML 모듈 �플릿 리터럴** — `Mouse.ts`의 `PROMPT_INVITE`처럼 모듈-레벨 상수에 박힌 EN 문자열
2. **`notice(...)` 호출의 인라인 보간** — `notice(\`Could not ${action}\`)` 같은 형식
3. **runtime throw 메시지** — `throw new Error('Invalid state: ' + state)` 같은 디버그 메시지

이런 종류의 누락은 headless DOM 프로브로 발견되며, 발견되면 i18n.js에 키를 추가하고 t()로 감�니다.

## 라이선스 및 크레딧

### 원본

- **저작자**: [Vesper](https://vesper.inc/) (Vesper Tech, Inc.)
- **저장소**: [github.com/rishipr/der-koloss-ce](https://github.com/rishipr/der-koloss-ce)
- **LICENSE**: MIT (Copyright (c) 2026 Vesper Tech, Inc.) — [`LICENSE`](LICENSE) 그대로 보존
- **음성 디자인**: ElevenLabs
- **CC0 자산**: Quaternius (좀비 메시), ambientCG (표면 텍스처)
- **Treyarch 노래 1곡**: fan tribute — [`NOTICE.md`](NOTICE.md) 참고

### 변경 파일 (12개)

- **신규**: `js/i18n.js`
- **패치**: `js/hud.js`, `js/main.js`, `js/game.js`, `js/weapons.js`, `js/personas.js`, `js/assets-page.js`, `index.html`, `about/index.html`, `assets/index.html`, `cinematic.html`, `404.html`, `README.md`

### 이 포크

- **저작자**: sigco3111 (한글화)
- **저장소**: [github.com/sigco3111/der-koloss-ce](https://github.com/sigco3111/der-koloss-ce)
- **라이브**: [sigco3111.github.io/der-koloss-ce](https://sigco3111.github.io/der-koloss-ce)
- **방법론**: localized-fork 스킬 — Hermes Agent 프로파일 `korean-fork`

---

<div align="center">

[🎮 라이브 게임 플레이](https://sigco3111.github.io/der-koloss-ce/) ·
[📂 원본 저장소](https://github.com/rishipr/der-koloss-ce) ·
[📖 프로젝트 소개](https://sigco3111.github.io/der-koloss-ce/about/) ·
[🎵 에셋 자료실](https://sigco3111.github.io/der-koloss-ce/assets/) ·
[🚨 404 페이지](https://sigco3111.github.io/der-koloss-ce/404.html) ·
[� MIT LICENSE](https://github.com/sigco3111/der-koloss-ce/blob/main/LICENSE)

</div>
