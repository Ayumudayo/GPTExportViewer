# GPTExportViewer

GPTExportViewer는 ChatGPT Export Data를 로컬에서 열어 보는 Windows 데스크톱 앱입니다.

## 무엇을 볼 수 있나

- 여러 ChatGPT export를 날짜 기준으로 전환해서 확인
- 세션 목록, 대화 내용, 모델/메시지 수 같은 기본 정보 확인
- 대화 검색과 자동 로딩으로 긴 export 탐색
- 한 개 또는 여러 개의 세션을 JSON 파일로 저장

## 사용 흐름

1. ChatGPT Export Data 압축 파일을 원하는 경로에 풀어 둡니다.
2. 앱을 처음 실행하면 표시되는 폴더 선택 화면에서 export가 들어 있는 소스 폴더를 선택합니다.
3. `Sessions`에서 대화를 읽을 수 있습니다.
4. 세션을 우클릭하면 선택한 세션을 JSON으로 저장할 수 있습니다.
5. `Library`에서 export 안의 이미지를 탐색합니다.

소스 폴더에는 단일 export 폴더를 지정해도 되고, 여러 export 폴더를 모아 둔 상위 폴더를 지정해도 됩니다.
이후 소스 폴더를 바꾸려면 좌측 상단의 `Settings`를 사용합니다.
폴더에 새 export를 추가했거나 삭제했다면 `Settings` 옆의 새로고침 버튼으로 소스 폴더를 다시 스캔합니다.

## 데이터 저장

원본 ChatGPT export 파일은 앱이 수정하지 않습니다.
설정, 인덱스, 캐시는 Windows의 user app data 폴더 아래에 저장됩니다.
마지막으로 선택한 export와 창 크기도 같은 설정 파일에 저장됩니다.

```text
%LOCALAPPDATA%\GPTExportViewer
```

세션을 저장하면 앱 데이터 폴더 아래의 `Saved Sessions`에 JSON 파일이 생성됩니다.

## 빌드

### 요구사항

이 프로젝트는 Tauri/Rust 기반 Windows 데스크톱 앱입니다.

- Windows 10/11
- Microsoft Edge WebView2 Runtime (110.0.1531.0 이상)
- Node.js와 npm
- Rust와 Cargo
- Windows MSVC Build Tools

### 명령어

```powershell
npm install
npm run desktop:dev
npm run desktop:build
```

빌드 결과물:

```text
src-tauri/target/release/GPTExportViewer.exe
```
