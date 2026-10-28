# SmartEMobilityHub — môi trường local, Auth và Parking

Giữ React/Vite JSX → Express CommonJS → SQLite. CR-01 bổ sung Auth split screen, Parking đặt/đến/trả/hủy thật và một lệnh demo dùng dữ liệu bền vững. HTTP duy nhất ở [contract của harness](<../Codex Workspace/contracts/http-api.md>); P6 assignment riêng vẫn conditional/unresolved.

## CR-01 — cách chạy hiện hành

Mở PowerShell tại thư mục chứa README này (`SmartEMobilityHub`). Chỉ cài dependencies một lần khi checkout chưa cài hoặc lockfile thay đổi; Node24/npm11 là môi trường đã kiểm:

```powershell
npm --prefix backend ci --no-audit --no-fund
npm --prefix frontend/EMobilityHub ci --no-audit --no-fund
```

Mỗi lần sử dụng, chỉ chạy:

```powershell
npm run dev:demo
```

Mở **http://localhost:5173**. Backend dùng http://localhost:3000. Launcher kiểm cổng, chạy Backend trước, chờ readiness rồi chạy Frontend; log cả hai trong cùng console. **Ctrl+C** dừng hai child processes thuộc launcher. Không kill các Node/Chrome khác. Cổng bận hoặc service lỗi: báo lỗi và đóng companion, không đổi cổng ngầm. Không chạy npm ci khi startup.

Lần đầu tạo instance `cr01-demo`, nạp schema/fixture trong transaction và tạo signing key ngẫu nhiên một lần. Lần sau giữ nguyên DB/key/users/reservations, không chạy seed hay schema initializer. Init lỗi giữ marker incomplete và từ chối dùng lại, không báo ready hoặc tự xóa dữ liệu; chọn instance mới để tiếp tục. Không mở/sửa `acceptance-p7`, `class-demo`, DB demo cũ hoặc DB nhóm.

| Dữ liệu | Đường dẫn từ root |
| --- | --- |
| Synthetic template, version controlled | backend/demo/demo-data.json |
| SQLite thực tế, persistent, ignored | backend/.tmp/local-demos/cr01-demo/smart_mobility.demo.db |
| Signing key riêng, ignored, không chia sẻ | backend/.tmp/local-demos/cr01-demo/.env |
| Ownership/readiness marker | backend/.tmp/local-demos/cr01-demo/owner.json |

**Tài khoản DEMO-ONLY công khai:** `student@demo.example`, `rider@demo.example`, `guest@demo.example`; mật khẩu chung `CampusDemo!2026`. Chỉ dành cho dữ liệu tổng hợp trên localhost, không dùng lại cho tài khoản thật/deploy. DB lưu scrypt có salt riêng, không plaintext hoặc Auth bypass. Student ban đầu giữ CAMPUS-02 (RESERVED); Rider dùng CAMPUS-03; Guest giữ METRO-02. Ba Hub/12 spaces có AVAILABLE/RESERVED/OCCUPIED và một Hub trống. Mỗi account chỉ một active Parking reservation.

Đăng ký account của bạn qua UI bình thường; account/hash và thao tác Parking nằm trong SQLite. Không xóa/thay DB/.env nếu muốn giữ account và session. Logout/expiry không xóa account; cookie hết hạn sau1giờ thì đăng nhập lại. Restart cùng key cho phép cookie còn hạn phục hồi session.

Kiểm dữ liệu/path an toàn, không in key/token:

```powershell
npm run demo:status
```

Thử persistence: đăng ký/login → hủy chỗ demo hiện tại nếu cần → đặt một chỗ trống → refresh → xác nhận đến bãi → Ctrl+C → chạy lại `npm run dev:demo` → refresh thấy OCCUPIED → trả chỗ → restart thấy AVAILABLE. Không chạy `demo:seed` để reset trạng thái.

Muốn dataset mới hoàn toàn, chọn **tên instance khác** một cách tường minh (không xóa instance cũ):

```powershell
$env:DEMO_NAME = 'fresh-demo-01'
npm run dev:demo
# Sau Ctrl+C, bỏ lựa chọn để về cr01-demo:
Remove-Item Env:DEMO_NAME
```

Tên phải là lowercase slug1..32, không đường dẫn. Tên đã tồn tại luôn được tái dùng, kể cả instance P7 rỗng; không tự thêm fixture. Dùng cùng `DEMO_NAME` với `npm run demo:status` để xem đúng instance. Không có lệnh reset tự động.

Đổi cổng khi cần: `$env:PORT='3001'; $env:VITE_DEV_PORT='5174'; npm run dev:demo`. Launcher đồng bộ API/CORS theo hai cổng, chỉ localhost HTTP và từ chối `FRONTEND_ORIGIN`/`VITE_API_BASE_URL` mâu thuẫn hoặc `COOKIE_SECURE=true` trên HTTP. Normal demo không đọc backend/.env thật hoặc dùng caller DATABASE_PATH/JWT_SECRET để đổi target/key.

Parking enforce ownership/transitions và giới hạn một active/user ở Backend trên mọi Hub. Request lỗi mạng có thể đã commit: dialog yêu cầu **Tải lại trạng thái**, không tự gửi lại POST. Dữ liệu legacy nhiều active/user không bị tự sửa; owner có thể trả từng chỗ. Dữ liệu reservation↔space mâu thuẫn trả safe integrity error để kiểm tra riêng. Vehicle/Charging vẫn ghi chưa triển khai, không có số liệu/business API giả.

Kiểm thử tái sử dụng (isolated memory/temp DB, không sửa stable demo):

```powershell
npm --prefix backend test
npm --prefix backend run test:db
npm --prefix frontend/EMobilityHub test
npm --prefix frontend/EMobilityHub run lint
npm --prefix frontend/EMobilityHub run build
npm --prefix frontend/EMobilityHub run test:browser
```

Chrome tests dùng3000/5173; dừng demo trước khi chạy. Chỉ trong môi trường managed gặp sandbox/Page.enable timeout, đặt `$env:P4_BROWSER_NO_SANDBOX='1'` cho disposable local test profile rồi bỏ biến sau test. `SEMH_EVIDENCE_ROOT` có thể chọn nơi lưu screenshots/evidence. Node test runner dùng namespace local-demo dưới OS temp, tách instance thủ công; tests đóng process/DB rồi xóa đúng owned fixtures. Các lệnh cài ở trên là prerequisite; CR-01 dùng dependencies đã cài theo lockfile, không tuyên bố vừa kiểm clean-machine install.

## Hướng dẫn lịch sử P1–P7

Phần dưới giữ cách chạy từng module/CLI P7 và mốc coverage trước CR-01. Các giới hạn read-only, Auth card và bước manual init/register/seed là **lịch sử**, được cách chạy CR-01 ở trên thay thế cho demo thông thường; các CLI opt-in vẫn tồn tại để tương thích.

## Công cụ và cài dependency

Đã kiểm tra trên Windows với Node v24.15.0, npm 11.12.1. Dùng Node 24 để phù hợp dependencies/native SQLite trong lockfile. Hai module npm độc lập; không chạy npm install ở thư mục gốc.

```powershell
$projectRoot = 'C:\Users\Dell\Downloads\Cac mon dang hoc\Software Engineers\Code btl\SmartEMobilityHub'
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
npm ci --no-audit --no-fund
Set-Location -LiteralPath (Join-Path $projectRoot 'frontend\EMobilityHub')
npm ci --no-audit --no-fund
```

npm ci dùng phiên bản đã khóa; không thêm JWT/cookie/hash/router libraries trong P1.

## Chuẩn bị env an toàn

Mỗi app đọc env của chính module. Các lệnh dưới đây chỉ copy khi chưa có file, không ghi đè cấu hình local:

```powershell
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
Set-Location -LiteralPath (Join-Path $projectRoot 'frontend\EMobilityHub')
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
```

Không commit hoặc in nội dung .env. .env.example vẫn trackable. JWT_SECRET chỉ được đặt ở BE; tuyệt đối không thêm secret vào VITE_*.

| Module/config | Baseline |
| --- | --- |
| BE NODE_ENV | development; test dành cho startup cô lập; production chưa phải cấu hình deploy |
| BE HOST / PORT | localhost / 3000; HOST chỉ loopback, PORT hợp lệ 1..65535 |
| BE FRONTEND_ORIGIN | http://localhost:5173, exact origin không path/trailing slash |
| BE DATABASE_PATH | ../database/smart_mobility.demo.db, resolve từ backend/ |
| BE JWT_SECRET | Bắt buộc khi chạy Auth server: 32 random bytes dưới dạng 64 hex, decode thành bytes trước sign/verify. Config/DB unit tests không ký JWT vẫn có thể thiếu secret. |
| BE COOKIE_SECURE | false cho localhost HTTP; true cho HTTPS/TLS termination. Nếu bỏ trống, mặc định theo scheme FRONTEND_ORIGIN; HTTPS không cho override false. Request TLS trực tiếp luôn Secure. |
| FE VITE_API_BASE_URL | http://localhost:3000; public HTTP(S) origin, không credentials/path |
| FE VITE_DEV_PORT | 5173; strictPort=true, không tự nhảy sang cổng khác |

BE [env.js](backend/src/config/env.js) load backend/.env bằng đường dẫn cố định, không theo cwd; environment đã có ưu tiên hơn file. Không load .env khi import module. Config được validate trước khi mở DB/listen. Nếu đổi port FE, sửa FRONTEND_ORIGIN tương ứng; nếu đổi port BE, sửa VITE_API_BASE_URL tương ứng.

FE [vite.config.js](frontend/EMobilityHub/vite.config.js) chỉ load VITE_* từ root FE, validate config, giữ React Compiler/plugin hiện có. Client duy nhất tại src/Services/http.js dùng public VITE_API_BASE_URL; không server secret trong bundle.

## SQLite isolation và lifecycle

- Schema duy nhất: [database/schema_sqlite.sql](database/schema_sqlite.sql), không sửa trong P1.
- Demo path đã duyệt: database/smart_mobility.demo.db. P1 chỉ cho đường dẫn cấu hình resolve đúng file này; từ chối team database database/smart_mobility.db và đường dẫn khác.
- Relative DATABASE_PATH luôn resolve từ backend/. Đường dẫn tuyệt đối trỏ đúng file demo cũng được chấp nhận.
- [db.js](backend/src/config/db.js) chỉ export factories; require/import không mở DB hoặc tạo file.
- openDemoDatabase nhận đường dẫn tuyệt đối đã resolve; từ chối file/parent bị redirect qua link hoặc file hardlink. Chỉ khởi tạo schema CREATE IF NOT EXISTS, không reset/delete/seed dữ liệu.
- createTestDatabase mặc định tự tạo file SQLite dưới một thư mục OS temp duy nhất; không đọc DATABASE_PATH hoặc .env. Tùy chọn memory=true dùng :memory:.
- cleanup đóng kết nối rồi chỉ xóa đúng thư mục temp factory sở hữu; kiểm tra absolute target, temp parent, prefix và link trước khi xóa. Không có tham số xóa demo/team DB.
- NODE_ENV=test startup chỉ chấp nhận DATABASE_PATH=:memory:; không cho đưa demo/team DB vào startup tests. Tests file-based dùng factory riêng.
- Mọi connection bật foreign_keys; schema initialization được bọc transaction. Không tự đổi state/ghi dữ liệu demo.
- Server load config → mở DB rõ ràng → tạo app → listen; lỗi listen đóng DB. Shutdown đóng HTTP rồi DB; shutdown có giới hạn chờ kết nối.
- Config/DB unit tests không cần secret thật. Auth app/server P3 bắt buộc secret trước mở DB/listen; HTTP tests inject secret ngẫu nhiên riêng, không đọc .env thật.

## Chạy backend

Tạo secret trong environment của chính cửa sổ PowerShell, không in giá trị và không ghi vào source. Có thể giữ secret ổn định trong backend/.env ignored do bạn quản lý; không đưa vào frontend. Chỉ kiểm tra format/độ dài không chứng minh entropy: dùng generator mật mã bên dưới, không tự chọn chuỗi dễ đoán.

```powershell
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
if (-not $env:JWT_SECRET) {
    $env:JWT_SECRET = (& node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
}
```

Giữ cùng secret qua các lần chạy cần dùng session cũ; đổi secret làm JWT cũ không hợp lệ. Không chạy lệnh echo/in JWT_SECRET. .env.example để trống có chủ ý và không phải cấu hình Auth chạy được nếu chưa cung cấp secret.

Trong cửa sổ PowerShell thứ nhất:

```powershell
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
npm start
# Hoặc dùng reload khi phát triển:
# npm run dev
```

Startup local lần đầu sẽ tạo database/smart_mobility.demo.db và các bảng, chưa có dữ liệu seed. Không mở hoặc reset smart_mobility.db của nhóm. Nếu có DB quan trọng ở đường dẫn khác, không đổi cấu hình để trỏ vào đó.

Từ cửa sổ khác, kiểm tra hạ tầng:

```powershell
Invoke-RestMethod -Uri 'http://localhost:3000/'
```

Mong đợi HTTP 200 với ok=true và message API trong data. Đây là kiểm tra server hạ tầng; chưa phải Auth/Parking E2E.

Config không hợp lệ hoặc thiếu/sai JWT_SECRET phải in thông báo an toàn và exit 1 trước mở DB/listen. parseConfig/loadConfig thuần vẫn cho thiếu secret để DB/config checks độc lập; createApp/startServer bắt buộc secret. Không có default signing key hoặc Auth bypass.

## Chạy frontend

Trong cửa sổ PowerShell thứ hai, đặt lại $projectRoot nếu là shell mới:

```powershell
$projectRoot = 'C:\Users\Dell\Downloads\Cac mon dang hoc\Software Engineers\Code btl\SmartEMobilityHub'
Set-Location -LiteralPath (Join-Path $projectRoot 'frontend\EMobilityHub')
npm run dev
```

Mở http://localhost:5173/#/login. P4 phục hồi session trước khi hiện Login hoặc protected view; Register/Login/Logout đã nối Auth backend thật. Parking/Overview dùng dashboard đọc dữ liệu SQLite thật; nếu DB chưa có Hub sẽ hiện empty state, không dữ liệu giả. Nếu cổng bận Vite fail thay vì âm thầm đổi cổng.

## Chạy kiểm tra P1

```powershell
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
npm run test:p1
npm run test:db
# npm test hiện cũng chạy bộ Node tests thật, không còn placeholder.

Set-Location -LiteralPath (Join-Path $projectRoot 'frontend\EMobilityHub')
npm run lint
npm run build

Set-Location -LiteralPath $projectRoot
git -c core.excludesFile= diff --check
```

Node tests bao phủ config/defaults/invalid inputs/load order/cwd, schema/FK/insert-read, DB isolation/cleanup, import không mở SQLite, HTTP startup/shutdown, CLI startup đúng/sai, port conflict và ignore probes. Mọi DB test là memory hoặc OS temp; không dùng demo/team DB cho setup destructive. test:db là smoke riêng, có assertions/exit code thật và tự cleanup.

Để chạy riêng nhóm checks:

```powershell
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
node --test test/environment.test.js
node --test test/database.test.js
node --test test/server.test.js
node --test test/ignore.test.js
```

Không chạy test script bằng cách trỏ DATABASE_PATH sang DB nhóm; test startup từ chối điều đó. Nếu cần kiểm tra env bằng CLI, các tests đã thử Node server thực với env test và cổng OS cấp để tránh chiếm cổng người dùng.

## Dừng dịch vụ

Trong mỗi cửa sổ đang chạy npm start/npm run dev, nhấn Ctrl+C. Backend xử lý SIGINT/SIGTERM, đóng HTTP rồi SQLite; Vite dừng riêng ở cửa sổ FE. Không dùng lệnh kill toàn bộ node.exe, xóa DB hoặc reset Git để dừng app.

## Kiểm tra Register P2

Nguồn HTTP duy nhất trong workspace là [contracts/http-api.md](<../Codex Workspace/contracts/http-api.md>); không định nghĩa API khác trong README. Register chỉ tạo account, không tự login hoặc cấp cookie. PowerShell/CLI gọi endpoint cũng phải gửi Origin đúng FRONTEND_ORIGIN và application/json; không có bypass cho demo.

```powershell
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
node --test test/password.test.js test/register.test.js
npm test
```

Lệnh đầu chạy bộ hash/Register; npm test chạy tất cả P1/P2/P3. HTTP tests tạo file SQLite trong OS temp bằng factory P1, kiểm tra schema/FK/validation/duplicates/Origin/CORS/errors và persistence khi close/reopen, rồi chỉ cleanup thư mục tự sở hữu. Tests tự inject JWT secret test-only khi tạo Auth app; không cần credential cấu hình thủ công, không dùng DB demo/team. Tests không in credential/hash/token/secret.

Password helpers dùng lại cho P3 tại [password.service.js](backend/src/services/password.service.js): hashPassword(password), verifyPassword(password, record). Wrong password trả false; malformed/unsupported record ném PasswordRecordError, caller phải xử lý an toàn. Parameters/format v1 nằm trong service và behavioral tests, không có plaintext fallback. Duplicate check dùng cùng normalizeEmail với Register; so Unicode case ở JavaScript vì SQLite NOCASE mặc định chỉ hỗ trợ ASCII.

## Auth backend P3 và tích hợp P4

```powershell
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
node --test test/token.test.js test/auth.test.js
npm run test:p1
node --test test/password.test.js test/register.test.js
npm test
npm run test:db
```

Giữ API theo contract duy nhất đã link phía trên. FE P4 gửi credentials: include và JSON, POST kèm Origin do browser đặt đúng http://localhost:5173. Dùng backend http://localhost:3000; không trộn 127.0.0.1 vì là hostname khác, cookie host-only và Origin guard sẽ khác. P3 HTTP fixtures dùng localhost/localhost; P1/P2 loopback transport tests không phải bằng chứng cookie browser cross-host.

Middleware [auth.js](backend/src/middleware/auth.js) export createRequireAuth({config,db,tokens}), verify JWT rồi đọc Users hiện hành và đặt public identity frozen tại req.auth. Router P5 sau này nhận cùng config/db/token service từ app; không tin user_id/role của caller. Me không gia hạn JWT hoặc ghi DB; invalid session/account clear cookie, lỗi DB/500 giữ cookie cho Retry.

P3 cần jsonwebtoken 9.0.3. cookie-parser không tải được do registry EACCES và thiếu cache; đọc cookie bằng package cookie 0.7.2 đã có trong Express, nay khai báo direct dependency. Không dùng signed-cookie/JSON-cookie features; JWT tự được verify trong token service. Lockfile thêm 13 entries, không đổi phiên bản dependency có sẵn. Install thực tế dùng public npm cache offline tại backend/.tmp/npm-cache ignored; package URLs/integrities vẫn là registry, không phụ thuộc đường dẫn file cache để cài lại khi có mạng.

Cookie HttpOnly/Lax/Path=/, không Domain; maxAge Express là 3600000 ms. Clear dùng cùng scope không mang maxAge cũ. Logout chỉ xóa browser cookie: bản JWT sao chép có thể còn dùng được tới exp. Không refresh token, global revocation hoặc session table. No-store cho Auth responses.

Test client cookie jar chỉ mô phỏng host/Secure/deletion/credentials, không thay browser/SameSite E2E. Secure=true đã kiểm tra attribute/helper; chưa có live TLS deployment. Server hiện là HTTP loopback; HTTPS/TLS termination là môi trường riêng, không được coi đã nghiệm thu chỉ vì bật flag.

## Auth frontend P4 và kiểm tra browser

Auth UI là approved derived design từ SPEC trong harness, không có sẵn trong HTML. Shared colors/font/brand dùng HTML; card 464px, padding26px, controls40px, focus rõ; không UI/router/state framework mới. Login/Logout dùng hash replace, routes public/protected có guard. Register success về Login với email/banner trong memory; không auto login.

Session store dùng useSyncExternalStore, AbortController và generation guard: StrictMode cleanup/response cũ không ghi đè Login/Logout mới. Me/restoring lỗi mạng/5xx hiện Retry và ẩn protected content, không giả logout. Me recheck khi đổi hash/focus/visibility; P5 dùng cùng runtime HTTP client và terminal-auth callback cho API protected. Không tự đếm exp hoặc refresh token.

```powershell
Set-Location -LiteralPath (Join-Path $projectRoot 'frontend\EMobilityHub')
npm run lint
npm run build
npm test
# Dừng các dev/backend servers đang chiếm 3000/5173 trước lệnh browser test.
npm run test:browser
```

Unit tests dùng Node test runner, không framework mới. Browser test tự chạy Express P3 với SQLite memory/schema/FK và key ngẫu nhiên test-only, Vite localhost5173/BE3000, Chrome/Edge với profile OS temp riêng; không .env BE hoặc demo/team DB. Nếu cổng bận test fail, không kill service khác. BROWSER_PATH có thể trỏ executable Chrome/Edge có sẵn; nếu không có browser, script ghi BROWSER_NOT_RUN/skip, không coi đó là browser PASS.

Trong managed sandbox phiên P4, Chrome/Edge mặc định timeout Page.enable; diagnostic có Access is denied, nguyên nhân gốc chưa xác định đầy đủ. Lệnh đã chạy thành công tại môi trường này:

```powershell
$env:P4_BROWSER_NO_SANDBOX = '1'
npm run test:browser
Remove-Item Env:P4_BROWSER_NO_SANDBOX
```

Flag trên chỉ thêm --no-sandbox cho browser test có profile tạm, không đổi app/backend safeguards; mặc định test không bật flag. Dùng cho fixture localhost tin cậy trong môi trường cần flag, không dùng profile browser cá nhân. Browser/HTTP servers được đóng và profile test được cleanup. Screenshots/evidence.json ở frontend/EMobilityHub/.tmp/p4-browser-* ignored; không chứa JWT/password/key, chỉ cookie attributes đã lọc.

Đã kiểm tra browser Auth: Register validation/loading/exact fields/EMAIL_EXISTS, Login lỗi và Enter, HttpOnly cookie, refresh không protected flash, Me503/network Retry, Logout failure/retry/deletion, Back/Forward/hash unknown, expired/invalid/disabled account, focus/labels/password visibility, desktop1440 và narrow390/320 không overflow. Đây là P4 Auth integration trên localhost HTTP; chưa nghiệm thu Parking/P7 hoặc live TLS. Kiểm tra người dùng thủ công chưa chạy riêng.

Để tự thử giao diện: chạy BE/FE bằng hai cửa sổ như trên, tạo một tài khoản thử mới tại Register, kiểm tra banner/email ở Login, đăng nhập, reload protected dashboard, logout rồi dùng Back. Dừng BE và reload để kiểm tra Retry; chạy lại BE với cùng key để phục hồi session. DevTools chỉ xem thuộc tính cookie, không copy/in token.

## Giới hạn và việc tiếp theo

- Register/Login/Logout/Me backend đã có; Origin/media/size guards dùng chung cho cả ba POST, errors/envelope theo contract. P5 có Parking GET/UI; seed demo vẫn chờ P7.
- CORS/JWT/cookie backend có HTTP tests và P4 có browser Auth integration; full Parking/E2E milestone để P5/P7 khi được giao.
- Build/lint/HTTP infrastructure checks không chứng minh browser hoặc application E2E.
- P5 Parking FE/GET đã triển khai; P7 demo/persistence integration chờ task riêng. P6 POST riêng vẫn conditional/unresolved.


## Parking P5 — chạy và kiểm tra UX

Dùng dependencies hiện có; P5 không thêm package hoặc đổi lockfile. HTTP contract duy nhất được liên kết ở phần Register phía trên. Backend chỉ thêm hai GET được bảo vệ; không có Parking write endpoint.

PowerShell cửa sổ BE (không in secret; environment đang có hoặc backend/.env ignored vẫn được hỗ trợ):

```powershell
$projectRoot = 'C:\Users\Dell\Downloads\Cac mon dang hoc\Software Engineers\Code btl\SmartEMobilityHub'
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
if (-not $env:JWT_SECRET) {
    $env:JWT_SECRET = (& node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
}
$env:NODE_ENV = 'development'
$env:HOST = 'localhost'
$env:PORT = '3000'
$env:COOKIE_SECURE = 'false'
$env:FRONTEND_ORIGIN = 'http://localhost:5173'
$env:DATABASE_PATH = '../database/smart_mobility.demo.db'
npm start
```

Giữ cửa sổ và key để restart phục hồi cookie cũ. Không đổi DATABASE_PATH sang smart_mobility.db hoặc chạy reset/seed. Startup vẫn có CREATE IF NOT EXISTS theo factory P1; P5 không thay startup/schema hoặc chuẩn bị dữ liệu demo.

PowerShell cửa sổ FE:

```powershell
$projectRoot = 'C:\Users\Dell\Downloads\Cac mon dang hoc\Software Engineers\Code btl\SmartEMobilityHub'
Set-Location -LiteralPath (Join-Path $projectRoot 'frontend\EMobilityHub')
$env:VITE_API_BASE_URL = 'http://localhost:3000'
$env:VITE_DEV_PORT = '5173'
npm run dev
```

Mở http://localhost:5173/#/login. Tạo dummy account của bạn ở Register, ví dụ p5-demo@example.com với mật khẩu thử từ 8–128 ký tự; đăng ký không tự login. Đăng nhập, mở #/parking hoặc #/overview, chọn Hub từ API, xem rows/counts/ownership. Tìm theo mã chỗ, thử Tất cả/Còn trống/Của tôi và Xem đặt chỗ; link chỉ lọc chỗ của mình trong Hub. Đổi Hub reset search/filter. Reload chờ Me rồi tải dữ liệu lại; Logout xóa protected view và Back vẫn bị guard. Nhấn Ctrl+C ở từng cửa sổ để dừng BE/FE; không kill mọi node.exe.

| Tình huống | Hành vi/khắc phục |
| --- | --- |
| SQLite chưa có Hubs | Hiện Chưa có Mobility Hub và Tải lại; không tự seed. P7 mới chuẩn bị demo opt-in khi được giao. |
| Hub chưa có ParkingSpaces | Count 0/0, bảng empty khác với filtered-empty. |
| Search/filter không khớp | Hiện empty-results và Hiển thị tất cả; summary vẫn toàn Hub. |
| Backend offline | Initial Me có SessionGate Retry; lỗi Parking khi đang đăng nhập giữ dashboard + Retry. |
| Cookie hết hạn | Me/protected GET trả terminal code, identity/data bị clear và về Login; không refresh token. |
| API origin sai | Lỗi kết nối/CORS; sửa VITE_API_BASE_URL khớp BE, FRONTEND_ORIGIN khớp FE rồi restart tương ứng. |
| Port bận | Vite strictPort hoặc BE bind fail; dừng đúng server bạn sở hữu hoặc cấu hình hai origin/cổng đồng bộ theo phần env. |
| Capacity khác số rows | Notice riêng; không tự sửa DB. |
| Reservation mâu thuẫn | Safe data-integrity error + Retry; không chọn owner hoặc sửa DB trên GET. |

Tests dùng memory/temp fixtures, không chuẩn bị demo DB:

```powershell
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
npm test
npm run test:db
Set-Location -LiteralPath (Join-Path $projectRoot 'frontend\EMobilityHub')
npm run lint
npm run build
npm test
# Cần 3000/5173 trống; ưu tiên sandbox mặc định.
npm run test:browser
# Chỉ nếu môi trường managed cần workaround P4, dùng profile test tạm:
$env:P4_BROWSER_NO_SANDBOX = '1'
npm run test:browser
Remove-Item Env:P4_BROWSER_NO_SANDBOX
```

Browser runner chạy P4/P5 tuần tự để không tranh cổng, đóng services/browser và cleanup owned profile. Khi có HTML tại DOCS_ROOT, P5 mở bản gốc read-only và đo/chụp so sánh 1440/1024/720/390/320. Screenshots/evidence được giữ tại .tmp/p5-browser-* ignored, không có token/secret. Nếu thiếu browser, skip BROWSER_NOT_RUN không phải PASS. P5 tests có cả real API/SQLite success và injected network/5xx failures; không inject success Parking fixtures vào production components.

P5 coverage hiện tại: BE136/136, FE17/17, browser P4+P5 19/19, lint/build và SQLite smoke đạt trên localhost HTTP. Live TLS và P7 restart/demo-seed chưa được nghiệm thu. Chi tiết evidence và limits ở handoff P5 trong harness.


## P7 — Demo file-backed an toàn và restart

Đây là đường chạy khuyến nghị cho buổi demo mới. Nó không mở hoặc thay đổi database/smart_mobility.demo.db hoặc smart_mobility.db đang có. Normal npm start/P1 guards vẫn giữ nguyên; demo:start dùng cùng Express/Auth/SQLite/server lifecycle, qua factory được validate riêng.

### Prerequisites và cấu hình

Node24/npm11 đã dùng trong P7. Từ thư mục gốc checkout, cài theo hai lockfiles nếu máy chưa có dependencies:

```powershell
$projectRoot = (Get-Location).Path
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
npm ci --no-audit --no-fund
Set-Location -LiteralPath (Join-Path $projectRoot 'frontend\EMobilityHub')
npm ci --no-audit --no-fund
```

Giữ các .env.example trong từng module làm mẫu. Không đưa JWT_SECRET vào frontend/VITE_ hoặc commit file local. P7 dùng dependencies đang cài và npm ls để kiểm consistency; không chạy lại npm ci trên workspace đang phát triển. Bước install trên là prerequisite từ checkout sạch, cần registry/cache phù hợp; không gọi nó là một install mới đã được kiểm chứng trong P7.

### Tạo instance mới và key ổn định một lần

Ở cửa sổ BE (đặt lại projectRoot theo vị trí checkout nếu mở shell mới):

```powershell
Set-Location -LiteralPath (Join-Path $projectRoot 'backend')
npm run demo:init -- --name=class-demo
npm run demo:status -- --name=class-demo
$env:HOST = 'localhost'
$env:PORT = '3000'
$env:FRONTEND_ORIGIN = 'http://localhost:5173'
$env:COOKIE_SECURE = 'false'
npm run demo:start -- --name=class-demo
```

Tên instance chỉ lowercase slug1..32, không path. Init từ chối thư mục đã tồn tại, kể cả init dở; chọn tên mới thay vì xóa/ghi đè. Đích cố định backend/.tmp/local-demos/class-demo/smart_mobility.demo.db, có owner.json. Guards từ chối redirected parent/file, symlink/hardlink và marker sai. Không có --database/--path tùy ý.

Init tạo schema gốc và .env riêng có32 random bytes biểu diễn64 hex. Key không được in. .tmp và DB/key bị Git ignore; .env dùng file mode0600 khi OS hỗ trợ, không phải mã hóa. Không đọc/copy key này vào chat/docs. demo:start chỉ đọc key của instance và giữ nó qua restart, không có fallback. JWT_SECRET/DATABASE_PATH từ environment không redirect đường chạy này; normal backend/.env không được đọc bởi launcher. HOST/PORT/FRONTEND_ORIGIN/COOKIE_SECURE vẫn được validate bằng config hiện có.

URL mặc định http://localhost:3000. Cổng bận: fail an toàn, không kill tiến trình khác. Thiếu/sai key/marker: fail closed, không tái tạo key hoặc mở DB khác. Init/seed không chạy khi GET hoặc startup thường.

### Frontend và walkthrough

Cửa sổ FE, từ root checkout:

```powershell
$projectRoot = (Get-Location).Path
Set-Location -LiteralPath (Join-Path $projectRoot 'frontend\EMobilityHub')
$env:VITE_API_BASE_URL = 'http://localhost:3000'
$env:VITE_DEV_PORT = '5173'
npm run dev
```

1. Mở http://localhost:5173/#/register. Tạo dummy student, ví dụ demo-student@example.com, với mật khẩu thử8..128 ký tự của bạn. Register201 tạo user STUDENT/ACTIVE và scrypt; không tự login.
2. Login. Ban đầu dashboard báo chưa có Hub: đây là SQLite rỗng thật, không lỗi và không dữ liệu giả.
3. Trong cửa sổ thứ ba tại backend, opt-in seed cho đúng account vừa đăng ký:

```powershell
npm run demo:seed -- --name=class-demo --student-email=demo-student@example.com
npm run demo:status -- --name=class-demo
```

4. Bấm Tải lại trong UI hoặc reload. Dataset có3 Hubs: Campus4 spaces, Metro2, Empty0;6 spaces,4 Reservations. Hai chỗ Campus của account được chọn, các chỗ khác thuộc synthetic user không có mật khẩu public. Status chỉ in counts/path, không credentials/identity.
5. Xem #/parking và #/overview; chọn Campus/Metro/Empty, tìm DEMO-A-01, thử Tất cả/Còn trống/Của tôi và reset. Summary theo toàn Hub; banner chỉ lọc mine. Không có action đặt/đến/trả.
6. Refresh: Me/restoring trước protected view, rồi tải SQL data.
7. Trong cửa sổ BE nhấn Ctrl+C, chờ dừng; giữ nguyên instance/DB/key. Refresh FE khi BE tắt sẽ có SessionGate Retry, không giả logout.
8. Chạy lại đúng lệnh dưới, không chạy init lại hoặc đổi key:

```powershell
npm run demo:start -- --name=class-demo
```

9. Retry/reload: cookie còn hạn được chấp nhận; user/Hubs/spaces vẫn còn. Logout rồi Back/#/parking/#/overview không vượt guard.
10. Ctrl+C riêng ở hai cửa sổ BE/FE. Không taskkill hàng loạt, reset DB hoặc git clean.

Seed chỉ INSERT thiếu và kiểm tra các fixtures đã có; chạy lại cùng account không thêm duplicates. Nếu ID/field đã tồn tại nhưng khác, transaction rollback, không UPDATE/REPLACE/reset. Không dùng seed để gán lại owner cho account khác: tạo instance mới. Seed là công cụ dữ liệu synthetic riêng, không phải Parking write API hoặc cách hoàn thành P6.

### Ba loại persistence khác nhau

- **SQLite:** user/hash/Hubs/spaces/reservations nằm trong file; dừng backend không xóa chúng.
- **JWT:** chỉ hợp lệ đến exp và với cùng signing key. Đổi key làm session cũ không hợp lệ, không làm mất tài khoản SQLite.
- **Browser cookie:** backend restart không xóa cookie browser. Cookie có lifetime3600s; nếu hết hạn/bị xóa thì Login lại bằng account đã persist. Logout clear cookie, không global revoke token đã sao chép.

### Failure/recovery và verification

Offline/wrong API base hoặc CORS mismatch → error/Retry, không protected flash hoặc false logout. Sai credentials → lỗi chung; account disabled/unsupported role → terminal rejection. DB busy/error → safe503/500, không SQL leakage. Unknown Hub/empty Hub/filtered-empty là các trạng thái riêng. Đổi cổng phải đồng bộ PORT↔VITE_API_BASE_URL và VITE_DEV_PORT↔FRONTEND_ORIGIN; Vite strictPort không tự đổi cổng.

```powershell
# backend
npm test
npm run test:db
# frontend/EMobilityHub
npm run lint
npm run build
npm test
npm run test:browser
```

P7 thêm backend local-demo.test.js (CLI/API + hai process restart, saved key/JWT/no GET writes, collision/path safety) và browser persistence.browser.test.mjs (file-backed browser/cookie restart, actual offline/CORS/wrong API base/port/Logout failure). Browser suite chạy tuần tự, test DB là instance p7-test-<random> mới và cleanup đúng sở hữu. Screenshots ở frontend/EMobilityHub/.tmp/p7-browser-* ignored. Default browser sandbox được ưu tiên; chỉ khi môi trường managed báo Page.enable timeout mới dùng P4_BROWSER_NO_SANDBOX=1 cho các test profiles disposable như phần browser P4 phía trên. Không bật flag cho browsing thường hoặc app.

P6 vẫn CONDITIONAL/UNRESOLVED: cần xác nhận Register INSERT Users có đáp ứng POST riêng hay còn table/nghiệp vụ nào khác. P7 chỉ nghiệm thu approved Auth/Parking read-only. Không deploy/liveTLS, full reservation lifecycle hoặc global token revocation.


Kết quả P7 đã chạy: Backend140/140; frontend17/17 + lint/build; browser P4/P5/P7 tổng28/28,0 skip với flag cho owned temporary profiles; SQLite smoke, syntax và npm ls đều đạt. Native dangling-symlink fixture bị OS từ chối tạo nên NOT_RUN; hardlink/path/marker/collision được kiểm. Trong automation PTY, Ctrl+C không forward tới npm child; smoke đã dừng đúng PID/start-time/path thuộc task. Graceful shutdown/restart được kiểm riêng bằng IPC tới CLI child và server.close; thao tác Ctrl+C trong native PowerShell của người dùng chưa được chạy thủ công. Không liveTLS/multi-browser/pixel-perfect claim. Xem deliverables/p7-review.md ở harness để biết failures/retests và acceptance evidence.
