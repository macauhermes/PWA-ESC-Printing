# PWA ESC Printing

繁體中文 PWA：BLE 熱敏打印、固定測試收據、Passkey/WebAuthn 登入、手機本機事件暫存與按需上傳、設備工作記錄及 Web Push。

## 功能

- 安裝式 PWA manifest 與 Service Worker。
- Web Bluetooth 掃描/選取 BLE 裝置，連接 GATT 可寫入 characteristic，分段傳送 ESC/POS 測試收據。
- 收據文字由伺服器以 `iconv-lite` 編碼成 Big5；8 cm 紙寬以收據版面呈現。
- 打印機偏好（裝置 ID/名稱）同時存入瀏覽器 IndexedDB 及伺服器 SQLite；在支援 `navigator.bluetooth.getDevices()` 的瀏覽器中，會嘗試恢復先前授權的裝置。
- WebAuthn Passkey 註冊與登入；登入成功、失敗、登出均寫入 SQLite。
- 手機客戶端可在「事件管理」建立事件並先暫存於本機；只有按下「上傳系統」才會保存到 SQLite，管理後台可按設備查看已上傳的工作。
- 上傳的工作記錄會保存用戶、客戶端 ID、事件日期、內容及上傳時的打印機名稱。手機暫存內容不會出現在伺服器。
- Web Push 訂閱、測試推播。
- 登入歷史及操作稽核頁面。
- 管理後台：查看客戶端在線狀態、打印機與 Bluetooth 狀態，以及各設備主動上傳的工作記錄。
- 客戶端通知中心：管理員可廣播所有客戶端或指定已識別客戶端；通知和各客戶端的已讀狀態保存於 SQLite，客戶端每 3 秒輪詢更新，離線後重新連線仍可查看。
- 客戶端每 3 秒向 API 回報心跳；管理頁每 3 秒刷新狀態，使用 HTTP 輪詢實現即時監控，無需額外 WebSocket 服務。
- SQLite 使用 WAL；資料庫預設位置 `./data/app.sqlite`，媒體預設存放 `./uploads`。

## 需求

- Node.js 20+（建議 LTS）及 npm。
- 支援 Web Bluetooth 的 Chromium 瀏覽器（桌面 Chrome/Edge 或相容 Android 瀏覽器）。iOS Safari 通常不支援 Web Bluetooth。
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

手機用戶在「事件管理」建立工作後，可先按「暫存於手機」留在該瀏覽器，也可按「上傳系統」將該項工作提交至伺服器。只有已上傳的工作會出現在管理後台，並附有用戶、客戶端 ID、上傳時間及上傳時的打印機名稱。手機本機暫存使用 localStorage；清除網站資料或更換瀏覽器／設備可能導致暫存遺失。管理員可查看各設備的工作記錄及即時連線狀態。列印功能目前仍使用固定的測試收據，不會將事件內容列印成正式收據。

## Web Push

產生 VAPID 金鑰：

```bash
npx web-push generate-vapid-keys
```

將 public/private key 與 `VAPID_SUBJECT` 放入 `.env`，重新啟動伺服器。登入後在「藍牙打印」頁按「啟用推播並測試」，授予瀏覽器通知權限。推播需要 HTTPS 和支援 Push API 的瀏覽器。

## 生產建置

```bash
npm run build
npm start
```

將應用部署在 HTTPS 網域，並確保程序管理器在伺服器重啟後啟動 API。SQLite 與 uploads 必須放在持久化磁碟，不可使用每次部署會清空的暫存檔案系統。午夜排程只有在 Node 服務正在運行時才會觸發；服務啟動時會補上當日缺少的工作記錄。

## Docker Compose 部署

Docker 映像使用 Node.js 26.11，建置 Vite 前端及 Express API，容器內 API 監聽 `8787`（不是 Next.js 的 `3000`）。SQLite 與上傳檔案使用 Docker named volumes，容器重建後仍會保留。

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

啟動與檢查：

```bash
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail=200 app
```

健康檢查端點為容器內的 `http://127.0.0.1:8787/api/health`。若使用不同網域，請同步修改 `docker-compose.yml` 的 `APP_ORIGIN`、`RP_ID`、`VIRTUAL_HOST`、`LETSENCRYPT_HOST` 和電郵設定。Passkey/WebAuthn 的 `APP_ORIGIN` 必須與使用者實際開啟的 HTTPS 網址一致。不要刪除 `app-data` 或 `app-uploads` volumes，否則會失去持久化資料。

## 限制及後續工作

- Web Bluetooth 不允許網站任意掃描或在沒有使用者手勢/授權時靜默重新連線。瀏覽器 IndexedDB 保存的裝置 ID 不是可跨裝置/瀏覽器重用的永久硬體識別碼；若瀏覽器不提供 `getDevices()` 或授權被撤銷，使用者可能需要再次選取。
- BLE 服務 UUID 目前列出常見候選值，不能涵蓋所有廠牌。若打印機使用專有 UUID，需加入該 UUID；部分裝置需要特定封包格式、MTU/流控或廠商指令。
- Big5 編碼端已建立，但收據打印的中文正確性需在實際打印機上驗證；調整 code-page index、行寬、字型、切紙指令以符合硬體。
- SQLite 與媒體資料是持久化的，但部署時仍須設定備份、磁碟配額、媒體存取權限及保留政策。
- Web Push 已支援訂閱與測試通知；目前尚未提供完整通知偏好/群發管理 UI。
- 本專案是初始實作 scaffold，尚未在實際 BLE 打印機、實際 WebAuthn authenticator、正式 HTTPS/Push 環境中執行整合測試。上線前請執行安全審查及裝置相容性測試。
