# PWA ESC Printing

繁體中文 PWA 範例：BLE 熱敏打印、Big5 測試收據、Passkey/WebAuthn 登入、事件與多媒體、每日工作記錄、Web Push，以及持久化操作稽核。

## 功能

- 安裝式 PWA manifest 與 Service Worker。
- Web Bluetooth 掃描/選取 BLE 裝置，連接 GATT 可寫入 characteristic，分段傳送 ESC/POS 測試收據。
- 收據文字由伺服器以 `iconv-lite` 編碼成 Big5；8 cm 紙寬以收據版面呈現。
- 打印機偏好（裝置 ID/名稱）同時存入瀏覽器 IndexedDB 及伺服器 SQLite；在支援 `navigator.bluetooth.getDevices()` 的瀏覽器中，會嘗試恢復先前授權的裝置。
- WebAuthn Passkey 註冊與登入；登入成功、失敗、登出均寫入 SQLite。
- 事件建立，支援多張圖片及多段影片上傳，metadata 與檔案持久化。
- 工作記錄管理；排程每天午夜建立每日工作記錄，啟動時補上當日缺漏。
- Web Push 訂閱、測試推播。
- 登入歷史及操作稽核頁面。
- 管理後台：用戶／角色管理、客戶端在線狀態、打印機與 Bluetooth 狀態、強制登出、操作記錄及工作記錄新增／刪除。
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
- 預設允許自行註冊 Passkey。首次在登入頁輸入 3–40 字元使用者名稱及顯示名稱，按「註冊 Passkey」，完成裝置生物辨識/安全金鑰流程，再使用同一使用者名稱登入。
- `ADMIN_USERNAMES=admin,supervisor` 可指定管理員帳戶。首次使用時，先讓指定帳戶註冊 Passkey；伺服器會將這些帳戶設為管理員。現有帳戶會在服務啟動時同步角色。
- `ALLOW_SELF_REGISTRATION=false` 可關閉公開註冊；目前沒有管理員邀請 UI，生產環境需另外建立受控帳戶開通流程。

## WebAuthn 設定

正式環境設定：

- `APP_ORIGIN`: 使用者實際開啟的 HTTPS 網址，包含正確的 scheme/host/port。
- `RP_ID`: 該網站網域名稱，不包含 scheme 或 port。
- `SESSION_SECRET`: 請設為高熵隨機值（目前 session token 使用 SHA-256 雜湊存入 DB）。
- 設定反向代理 HTTPS、備份 SQLite 及 uploads，限制管理端點的網路存取。

登入事件可在「登入記錄」查看。操作紀錄在「操作稽核」查看。管理員登入後會看到「管理後台」頁，可管理註冊用戶、監視每個客戶端的在線狀態、打印機名稱及 Bluetooth/GATT 連接狀態，並強制撤銷指定客戶端的登入工作階段。客戶端以 3 秒心跳回報狀態；被強制登出的客戶端最遲於下一次心跳時清除本機登入狀態。管理員亦可新增／刪除操作記錄與工作記錄。為保留追溯性，刪除操作本身會另寫入稽核記錄。日誌應避免存入密碼、Passkey 私密材料或不必要的敏感內容。

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

## 限制及後續工作

- Web Bluetooth 不允許網站任意掃描或在沒有使用者手勢/授權時靜默重新連線。瀏覽器 IndexedDB 保存的裝置 ID 不是可跨裝置/瀏覽器重用的永久硬體識別碼；若瀏覽器不提供 `getDevices()` 或授權被撤銷，使用者可能需要再次選取。
- BLE 服務 UUID 目前列出常見候選值，不能涵蓋所有廠牌。若打印機使用專有 UUID，需加入該 UUID；部分裝置需要特定封包格式、MTU/流控或廠商指令。
- Big5 編碼端已建立，但收據打印的中文正確性需在實際打印機上驗證；調整 code-page index、行寬、字型、切紙指令以符合硬體。
- SQLite 與媒體資料是持久化的，但部署時仍須設定備份、磁碟配額、媒體存取權限及保留政策。
- Web Push 已支援訂閱與測試通知；目前尚未提供完整通知偏好/群發管理 UI。
- 本專案是初始實作 scaffold，尚未在實際 BLE 打印機、實際 WebAuthn authenticator、正式 HTTPS/Push 環境中執行整合測試。上線前請執行安全審查及裝置相容性測試。
