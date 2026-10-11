# PWA ESC Printing

繁體中文 PWA：一般用戶 BLE 熱敏打印與模擬付款測試收據、Passkey/WebAuthn 登入、手機本機事件暫存與按需上傳、設備工作記錄及跨平台 Web Push。

## 功能

- 安裝式 PWA manifest 與 Service Worker。
- 一般用戶在單一「打印」頁重複選取／切換 BLE 裝置、連接 GATT 可寫入 characteristic，並打印較完整的雙欄模擬付款測試收據；可輸入備註，備註會打印在收據上。
- 收據文字由伺服器以 `iconv-lite` 編碼成 Big5；8 cm 紙寬以收據版面呈現。
- 打印機偏好（裝置 ID/名稱）同時存入瀏覽器 IndexedDB 及伺服器 SQLite；在支援 `navigator.bluetooth.getDevices()` 的瀏覽器中，會嘗試恢復先前授權的裝置。
- WebAuthn Passkey 註冊與登入；登入成功、失敗、登出均寫入 SQLite。
- 手機客戶端可在「事件管理」建立事件，附加多張圖片及多段影片；可暫存在手機 IndexedDB（包含附件），或直接上傳。每台瀏覽器客戶端由伺服器派發唯一六位 Base58 設備碼；事件編號由本機流水號、設備碼及建立日期（DDMMYYYY）組成，可在已取得設備碼後離線建立。網絡中斷時事件會保留於本機上傳隊列，遠端恢復後自動重試。
- 上傳的工作記錄會保存用戶、客戶端 ID、事件日期、內容、附件及上傳時的打印機名稱。手機暫存內容不會出現在伺服器；每個事件最多 20 個圖片／影片附件，單檔最大 250 MB。
- Web Push 訂閱、測試推播；管理員可對指定已訂閱設備推播，或廣播給所有已訂閱設備，同時保留站內通知。
- 登入歷史及操作稽核頁面。
- 「通知」頁集中管理員通知發送：可指定已訂閱設備或廣播所有已訂閱設備；管理員不顯示自己的通知收件匣。
- 「用戶管理」頁管理用戶及查看客戶端在線狀態；管理員介面不提供打印頁、選取打印機或打印操作。
- 獨立的「設備工作記錄」管理頁列出所有設備已上傳的工作記錄及媒體附件，管理員可永久刪除記錄與檔案；客戶端工作記錄列表每 3 秒同步刷新，刪除後會自動消失。
- 管理員導覽列不顯示「事件管理」，一般用戶仍可建立本機暫存事件並按需上傳。
- 客戶端通知中心：管理員可廣播所有客戶端或指定已識別客戶端；通知和各客戶端的已讀狀態保存於 SQLite，客戶端每 3 秒輪詢更新，離線後重新連線仍可查看。
- 客戶端每 3 秒向 API 回報心跳；管理頁每 3 秒刷新狀態，使用 HTTP 輪詢實現即時監控，無需額外 WebSocket 服務。
- SQLite 使用 WAL；資料庫預設位置 `./data/app.sqlite`，媒體預設存放 `./uploads`。

## 需求

- Node.js 20+（建議 LTS）及 npm。
- BLE 打印需使用支援 Web Bluetooth 的 Chromium 瀏覽器（桌面 Chrome/Edge 或相容 Android 瀏覽器）；iOS Safari 不支援 Web Bluetooth。Web Push 可在 Android 支援 Push API 的瀏覽器使用；iPhone／iPad 需 iOS/iPadOS 16.4 或更新版本，先將網站加入主畫面，再從主畫面開啟 Web App。
- Web Bluetooth、WebAuthn、Service Worker、Push API 在正式環境通常需要 HTTPS；localhost 可用於開發。
- BLE 熱敏打印機必須提供可寫入的 GATT characteristic。許多打印機使用專有服務 UUID、私有協定或只支援藍牙 Classic SPP；此類設備不能保證可由 Web Bluetooth 直接打印。
- Big5 字元集與 ESC/POS 的 code-page 編號是兩件事。打印機必須有相符的 Big5 字型/字碼表，且不同廠牌的 `ESC t n` 編號可能不同；目前預設 index 0 只是一個保守預設，需按打印機手冊調整。

## 本機啟動

```bash
npm install
cp .env.example .env
npm run db:init
npm run dev
```

- Vite 前端：`http://localhost:5173`
- API：`http://localhost:8787`
- 預設允許自行註冊 Passkey。一般用戶在登入頁輸入 3–40 字元使用者名稱及顯示名稱，按「註冊 Passkey」，完成裝置生物辨識/安全金鑰流程，再使用同一使用者名稱登入。
- 一般用戶可公開註冊 Passkey，不需要管理員預先建立帳戶。
- 唯一管理員使用 `.env` 中的 `ADMIN_USERNAME` 與 `ADMIN_PASSWORD` 固定帳密，僅桌面版顯示管理員登入選項；管理 API 也會拒絕以 Passkey 登入的管理員工作階段及常見手機 User-Agent。
- 請務必把範例 `ADMIN_PASSWORD` 換成高強度唯一密碼。管理員帳號不能透過公開 Passkey 註冊建立，其他一般用戶不能自行升級為管理員。

## WebAuthn 設定

正式環境設定：

- `APP_ORIGIN`: 使用者實際開啟的 HTTPS 網址，包含正確的 scheme/host/port。
- `RP_ID`: 該網站網域名稱，不包含 scheme 或 port。
- `SESSION_SECRET`: 請設為高熵隨機值（目前 session token 使用 SHA-256 雜湊存入 DB）。
- `ADMIN_USERNAME` 與 `ADMIN_PASSWORD`: 唯一管理員的固定登入憑證，僅放在伺服器環境變數，不要放入前端程式或提交真實 `.env` 到 GitHub。
- 設定反向代理 HTTPS、備份 SQLite 及 uploads，限制管理端點的網路存取。

手機用戶在「事件管理」可為每個事件選擇多張圖片或多段影片。按「暫存於手機」會把事件文字和媒體 Blob 保存在 IndexedDB，按「上傳事件及附件」或「直接上傳」才會提交伺服器；上傳成功後，手機草稿才會移除。清除網站資料或更換瀏覽器／設備仍可能導致本機草稿遺失。伺服器接受每個事件最多 20 個媒體檔案、單檔最大 250 MB；部署時請確認反向代理（例如 Nginx 的 `client_max_body_size`）、磁碟空間及網絡限制允許相應大小。瀏覽器 IndexedDB 暫存 Blob 不會把影片傳送到伺服器，立即完成暫存不代表影片已上傳。管理員可在「設備工作記錄」獨立頁查看所有設備工作記錄及媒體連結，並刪除記錄；客戶端每 3 秒重新讀取自己的上傳清單，刪除後會同步更新。一般用戶的「打印」頁只會打印標示為非真實交易的模擬付款收據，並可把備註加入收據；管理員帳號不提供打印功能。

## Web Push

產生 VAPID 金鑰：

```bash
npx web-push generate-vapid-keys
```

將 public/private key 與 `VAPID_SUBJECT` 放入 `.env`，重新啟動伺服器。登入一般用戶帳號後，進入「通知」頁並按「啟用／修復推播訂閱」，在瀏覽器／系統提示時允許通知。按鈕會先處理通知權限，再建立或重用 Push 訂閱並發送測試通知。推播需要 HTTPS、有效 VAPID 金鑰及支援 Push API 的瀏覽器。iPhone／iPad 必須先在 Safari 使用「分享」→「加入主畫面」，再從主畫面圖示開啟 Web App；直接在 Safari 分頁中開啟時，系統會提示安裝要求。Android 請使用最新版 Chrome 或其他支援 Web Push 的瀏覽器，並允許通知。

## 生產建置

```bash
npm run build
npm start
```

將應用部署在 HTTPS 網域，並確保程序管理器在伺服器重啟後啟動 API。SQLite 與 uploads 必須放在持久化磁碟，不可使用每次部署會清空的暫存檔案系統。午夜排程只有在 Node 服務正在運行時才會觸發；服務啟動時會補上當日缺少的工作記錄。

## Docker Compose 部署

Docker 映像使用 Node.js 26.11，建置 Vite 前端及 Express API，容器內 API 監聽 `8787`（不是 Next.js 的 `3000`）。SQLite 與上傳檔案使用相對於 `docker-compose.yml` 的主機目錄 `./app-data` 和 `./app-uploads`，不再存放於 Docker 預設 named-volume 空間；容器重建後，資料仍保留在專案目錄內。

首次部署前，請在專案目錄執行：

```bash
cp .env.example .env
# 編輯 .env，設定 ADMIN_USERNAME、ADMIN_PASSWORD、SESSION_SECRET；
# 正式環境請確認 VAPID 金鑰及其他設定。
```

Compose 設定目前使用既有反向代理 Docker network `db_default`，並設定網域 `pwa.jasonhoi.com`。請先確認該網絡已由你的反向代理建立：

```bash
docker network ls
# 若尚未建立，而且反向代理確實預期使用此名稱，才建立：
docker network create db_default
```

建立與 `docker-compose.yml` 同層的資料目錄（請確保 Docker 執行帳號對這些目錄有讀寫權限）：

```bash
mkdir -p ./app-data ./app-uploads
```

**若是從舊版 named volumes 升級，請先備份並把舊 volume 內容複製到這兩個目錄，再啟動新版 Compose。** 否則新掛載的空目錄會遮蔽舊 volume 中的資料，應用程式會看不到原有 SQLite 與上傳檔案。先用 `docker volume ls` 找出舊 volume 的實際名稱（通常是 `<Compose專案名>_app-data` 和 `<Compose專案名>_app-uploads`），並在停止應用程式後複製，例如把下列佔位名稱換成實際名稱：

```bash
docker compose down
# 請替換為 docker volume ls 顯示的實際 volume 名稱
DATA_VOLUME=<舊的_app-data_volume名稱>
UPLOADS_VOLUME=<舊的_app-uploads_volume名稱>
docker run --rm -v "${DATA_VOLUME}:/from:ro" -v "$PWD/app-data:/to" alpine sh -c 'cp -a /from/. /to/'
docker run --rm -v "${UPLOADS_VOLUME}:/from:ro" -v "$PWD/app-uploads:/to" alpine sh -c 'cp -a /from/. /to/'
```

啟動與檢查：

```bash
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail=200 app
```

健康檢查端點為容器內的 `http://127.0.0.1:8787/api/health`。若使用不同網域，請同步修改 `docker-compose.yml` 的 `APP_ORIGIN`、`RP_ID`、`VIRTUAL_HOST`、`LETSENCRYPT_HOST` 和電郵設定。Passkey/WebAuthn 的 `APP_ORIGIN` 必須與使用者實際開啟的 HTTPS 網址一致。不要刪除同層的 `./app-data` 或 `./app-uploads` 目錄，否則會失去持久化資料。

## 限制及後續工作

- Web Bluetooth 不允許網站任意掃描或在沒有使用者手勢/授權時靜默重新連線。瀏覽器 IndexedDB 保存的裝置 ID 不是可跨裝置/瀏覽器重用的永久硬體識別碼；若瀏覽器不提供 `getDevices()` 或授權被撤銷，使用者可能需要再次選取。
- BLE 服務 UUID 目前列出常見候選值，不能涵蓋所有廠牌。若打印機使用專有 UUID，需加入該 UUID；部分裝置需要特定封包格式、MTU/流控或廠商指令。
- Big5 編碼端已建立，但收據打印的中文正確性需在實際打印機上驗證；調整 code-page index、行寬、字型、切紙指令以符合硬體。
- SQLite 與媒體資料是持久化的，但部署時仍須設定備份、磁碟配額、媒體存取權限及保留政策。客戶端事件在建立滿 24 小時後會從客戶端清單隱藏，媒體 URL 也會拒絕讀取；伺服器資料及檔案目前不會自動刪除，管理員仍可在後台稽核。
- Web Push 需要 HTTPS、有效 VAPID 金鑰、用戶授權及瀏覽器／作業系統支援。推播端點可能失效，伺服器會清除回報 404／410 的端點。
- 本專案是初始實作 scaffold，尚未在實際 BLE 打印機、實際 WebAuthn authenticator、正式 HTTPS/Push 環境中執行整合測試。上線前請執行安全審查及裝置相容性測試。
