# Superior Highlighter (Legacy)

Obsidian 읽기 보기에서 선택한 부분을 정확하게 하이라이트합니다. 선택한 텍스트와 앞뒤 문맥을 함께 대조하고, `==🔴텍스트==` 형식으로 저장합니다.

**개발자:** [WooJIN OH (owjxyz)](https://github.com/owjxyz)

[GitHub 저장소](https://github.com/owjxyz/Obsidian-Superier-Highlighter) · [Obsidian 커뮤니티 등록 페이지](https://obsidian.md/plugins?id=superier-highlighter)

[ENGLISH](README.md)

## 설치

Obsidian의 **설정 → 커뮤니티 플러그인 → 탐색**에서 **WooJIN OH**의 **Superior Highlighter (Legacy)**를 검색한 뒤 설치하고 활성화합니다. [커뮤니티 등록 페이지](https://obsidian.md/plugins?id=superier-highlighter)에서도 열 수 있습니다.

터미널 설치 프로그램을 사용하려면 아래 절차를 따릅니다.

Obsidian을 종료하고 대상 vault 폴더에서 실행합니다.

**macOS (터미널)**

```sh
curl -fsSL https://raw.githubusercontent.com/owjxyz/Obsidian-Superier-Highlighter/main/install.py | python3 -
```

**Windows (PowerShell)**

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/owjxyz/Obsidian-Superier-Highlighter/main/install.py | py -3 -
```

반드시 `curl.exe`로 실행합니다. Windows PowerShell 5.1에서 `curl`은 `Invoke-WebRequest`의 별칭이므로 `-fsSL` 옵션을 인식하지 못합니다. `py`를 찾을 수 없지만 `python --version`이 Python 3.9 이상을 표시한다면 `py -3 -`를 `python -`로 바꿉니다.

- 다른 vault에 적용하려면 `python3 -`(macOS) 또는 `py -3 -`(Windows) 뒤에 경로를 추가합니다. 공백이 있는 경로는 따옴표로 감쌉니다. 명령어 끝부분 예: `python3 - "/Users/you/Obsidian Vault"` 또는 `py -3 - "C:\Users\you\Documents\Obsidian Vault"`.
- Python 3.9 이상이 필요합니다. 실행할 때마다 최신 정식 릴리스를 조회하고 배포 파일 세 개의 체크섬을 검증합니다.
- 변경할 파일을 백업하고 다른 설정을 보존합니다. Reader Highlighter Tags의 플러그인 설정을 이전하며, 기존 플러그인은 비활성화하고 파일은 남겨둡니다.
- 단축키는 추가하거나 변경하지 않습니다. 개인 단축키는 [Obsidian Vault Init](https://github.com/owjxyz/Obsidian-Vault-Init)에서 적용합니다.
- 이미 설치된 Superior Highlighter (Legacy)의 설정은 보존합니다.
- 스크립트를 실행할 때 업데이트하며, 상시 자동 업데이트는 등록하지 않습니다. 시험 배포는 제외하고 조회·검증에 실패하면 보관함을 변경하지 않습니다.

수동 설치는 [최신 배포](https://github.com/owjxyz/Obsidian-Superier-Highlighter/releases/latest)에서 `main.js`, `manifest.json`, `styles.css`를 받아 `.obsidian/plugins/superier-highlighter/`에 넣고 활성화합니다.

## 단축키

**설정 → 단축키 → Superior Highlighter (Legacy)**에서 색상 및 제거 명령에 원하는 키를 지정합니다. 읽기 보기에서 텍스트를 선택하고 지정한 단축키를 누릅니다.

**색상 하이라이트 단축키:** 선택 범위를 포함하는 기존 하이라이트와 같은 색이면 그 하이라이트 전체를 해제합니다. 다른 색이면 선택 부분의 색상만 변경하고, 선택 밖의 색상은 유지합니다. 강조가 없는 부분에는 선택한 색을 적용합니다. 여러 줄·셀에서는 각 줄·셀에 이 규칙을 적용합니다.

일반 하이라이트 토글 단축키는 색상과 관계없이 선택 범위를 포함하는 기존 하이라이트 전체를 해제하며, 없으면 선택 부분을 강조합니다.

툴바 색상 버튼은 선택 부분의 색만 바꿉니다. 제거 버튼과 하이라이트 제거 명령은 선택한 부분만 지우고 양옆의 하이라이트는 유지합니다.

## 선택 범위

- 첫 줄·마지막 줄·표 셀의 일부를 선택해도 전체로 넓히지 않습니다. 선택 밖의 색상은 유지합니다.
- 앞뒤 문맥, 반복 문단의 순서, 화면과 원문의 출현 개수가 일치해야 합니다. 위치가 불분명하거나 원문이 바뀌었으면 수정하지 않습니다.
- 다른 노트의 임베드를 가로지르는 선택은 처리하지 않습니다. 한 노트 안에서 선택합니다.
- 링크 표시명이나 인라인 코드의 일부만 선택하면 처리하지 않습니다. 화면에 보이는 해당 텍스트 전체를 선택합니다.
- 해석할 수 없는 표시 문법은 처리하지 않을 수 있습니다. 스마트 문단 선택을 켜면 문단 전체를 선택하며, 기본값은 꺼짐입니다.

## 하이라이트 관리

현재 노트의 하이라이트 탐색·검색·색상 편집·개별 및 전체 제거, 인접 하이라이트 병합, 일괄 색상 변경, 기존 HTML 강조의 변환과 마지막 작업 되돌리기를 제공합니다.

태그 관리, 각주 주석, 인용 복사, 전체 보관함 연구 보기, 내보내기, PDF 지원, 읽기 위치 추적 기능은 제거했습니다. 노트에 이미 저장된 태그·각주·인용문은 그대로 유지하며, 기존 플러그인 설정에서는 지원하는 하이라이트 옵션만 불러옵니다.

## 데이터 접근

선택한 텍스트가 속한 노트(임베드 원본 포함)를 읽고 수정합니다. 보관함 전체 검사나 PDF 처리는 수행하지 않습니다. 하이라이트 탐색기의 **Copy**는 선택한 항목의 텍스트만 시스템 클립보드에 쓰며, 기존 클립보드는 읽지 않습니다. 노트 본문·파일 경로·클립보드 내용을 서버로 전송하지 않습니다.

## 배포 검증

릴리즈 자동화는 main 브랜치 변경과 버전 태그를 GitHub Actions에서 빌드·검사하고, 저장소에 기록된 체크섬을 확인한 뒤 `main.js`, `manifest.json`, `styles.css`의 빌드 출처 증명(GitHub artifact attestations)을 생성합니다. 버전 태그일 때만 같은 파일로 릴리즈 초안을 준비하며, 정식 공개는 별도로 진행합니다. **Verify release provenance**를 브랜치에서 수동 실행하면 빌드와 출처 증명만 수행하고 릴리즈는 생성하지 않습니다.

이 자동화로 만든 배포 파일을 내려받은 뒤 `gh attestation verify main.js --repo owjxyz/Obsidian-Superier-Highlighter`로 출처를 검증할 수 있습니다(`manifest.json`, `styles.css`도 동일). `SHA256SUMS`는 터미널 설치 프로그램의 무결성 검증에 필요하므로 추가 배포 파일로 유지합니다. Obsidian은 이 파일을 내려받지 않습니다. 자동화 추가만으로 기존 릴리즈가 변경되지는 않습니다.

## 개발

Node.js와 Python이 필요합니다.

```sh
npm ci
npm test
npm run typecheck
npm run build
python3 test_metadata.py
python3 test_install.py
```

Windows PowerShell에서는 마지막 두 명령어를 `py -3 test_metadata.py`, `py -3 test_install.py`로 실행합니다(위 안내에 따라 `python`을 사용하는 환경에서는 `py -3` 대신 `python` 사용). `npm` 명령어는 두 운영체제에서 동일합니다.

## 원본

DuckTapeKiller의 [Reader Highlighter Tags](https://github.com/DuckTapeKiller/obsidian-reader-highlighter-tags)를 바탕으로 만든 독립 개선판입니다. 원본의 [MIT 라이선스](LICENSE)와 저작권 고지를 유지합니다. 개선판 개발자는 WooJIN OH (owjxyz)입니다.
