[ENGLISH](README.md)

# Superier Highlighter

Obsidian 읽기 보기에서 선택한 부분을 정확하게 하이라이트합니다. 선택한 텍스트와 앞뒤 문맥을 함께 대조하고, `==🔴텍스트==` 형식으로 저장합니다.

**개발자:** [owjxyz](https://github.com/owjxyz)

## 설치

Obsidian을 종료하고 대상 vault 폴더에서 실행합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/owjxyz/Obsidian-Superier-Highlighter/main/install.py | python3 -
```

- 다른 vault에 적용하려면 `python3 -` 뒤에 경로를 추가합니다.
- Python 3.9 이상이 필요합니다. 실행할 때마다 최신 정식 릴리스를 조회하고 배포 파일 세 개의 체크섬을 검증합니다.
- 변경할 파일을 백업하고 다른 설정을 보존합니다. Reader Highlighter Tags의 플러그인 설정을 이전하며, 기존 플러그인은 비활성화하고 파일은 남겨둡니다.
- 단축키는 추가하거나 변경하지 않습니다. 개인 단축키는 [Obsidian Vault Init](https://github.com/owjxyz/Obsidian-Vault-Init)에서 적용합니다.
- 이미 설치된 Superier Highlighter의 설정은 보존합니다.
- 스크립트를 실행할 때 업데이트하며, 상시 자동 업데이트는 등록하지 않습니다. 시험 배포는 제외하고 조회·검증에 실패하면 보관함을 변경하지 않습니다.

수동 설치는 [최신 배포](https://github.com/owjxyz/Obsidian-Superier-Highlighter/releases/latest)에서 `main.js`, `manifest.json`, `styles.css`를 받아 `.obsidian/plugins/superier-highlighter/`에 넣고 활성화합니다. 앱 내 커뮤니티 플러그인 설치는 Obsidian의 등록 승인 후 가능합니다.

## 단축키

**설정 → 단축키 → Superier Highlighter**에서 색상 및 제거 명령에 원하는 키를 지정합니다. 읽기 보기에서 텍스트를 선택하고 지정한 단축키를 누릅니다.

**하이라이트 단축키를 다시 누르면:** 선택 범위를 포함하는 기존 하이라이트가 있을 때 그 하이라이트 전체의 강조와 색상 표시를 제거합니다. 없으면 선택한 부분을 하이라이트합니다. 여러 줄·셀을 선택한 경우 각 줄·셀에서 적용됩니다.

툴바 색상 버튼은 선택 부분의 색만 바꿉니다. 제거 버튼과 하이라이트 제거 명령은 선택한 부분만 지우고 양옆의 하이라이트는 유지합니다.

## 선택 범위

- 첫 줄·마지막 줄·표 셀의 일부를 선택해도 전체로 넓히지 않습니다. 선택 밖의 색상은 유지합니다.
- 앞뒤 문맥, 반복 문단의 순서, 화면과 원문의 출현 개수가 일치해야 합니다. 위치가 불분명하거나 원문이 바뀌었으면 수정하지 않습니다.
- 다른 노트의 임베드를 가로지르는 선택은 처리하지 않습니다. 한 노트 안에서 선택합니다.
- 링크 표시명이나 인라인 코드의 일부만 선택하면 처리하지 않습니다. 화면에 보이는 해당 텍스트 전체를 선택합니다.
- 해석할 수 없는 표시 문법은 처리하지 않을 수 있습니다. 스마트 문단 선택을 켜면 문단 전체를 선택하며, 기본값은 꺼짐입니다.

원본 플러그인의 태그, 각주 주석, 하이라이트 탐색·내보내기, 읽기 위치 기능도 제공합니다.

## 개발

Node.js와 Python이 필요합니다.

```sh
npm ci
npm test
npm run typecheck
npm run build
python3 test_install.py
```

## 원본

DuckTapeKiller의 [Reader Highlighter Tags](https://github.com/DuckTapeKiller/obsidian-reader-highlighter-tags)를 바탕으로 만든 독립 개선판입니다. 원본의 [MIT 라이선스](LICENSE)와 저작권 고지를 유지합니다. 개선판 개발자는 owjxyz입니다.
