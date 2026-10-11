# PWA ESC Printing

繁體中文 PWA：一般用戶 BLE 熱敏打印與模擬付款測試收據、Passkey/WebAuthn 登入、手機本機事件暫存與按需上傳、設備工作記錄及跨平台 Web Push。

## 熱敏打印機的常見連接方式

熱敏收據打印機常見的傳輸方式如下；**傳輸方式是否可用，取決於打印機硬件、通訊協定、瀏覽器／作業系統支援，以及打印機是否接受相應的 ESC/POS 或廠商專用指令**。僅看到藍牙名稱或成功配對，不代表網頁一定可以直接打印。

| 方式 | 基本原理 | 常見優點與限制 |
| --- | --- | --- |
| **Bluetooth Low Energy（BLE／GATT）** | 網頁透過 Web Bluetooth 掃描／選取裝置、連接 GATT service，再向可寫入的 characteristic 傳送打印資料。 | 無線、適合近距離移動打印；必須找到打印機支援的 GATT 服務及寫入特徵。瀏覽器支援有限，並非所有 BLE 打印機都使用相同 UUID 或資料協定。 |
| **Bluetooth Classic（SPP／RFCOMM）** | 以傳統藍牙序列埠方式傳輸資料，常見於通用 ESC/POS 便攜式打印機。 | Android 原生 App 常見，但一般網頁的 Web Bluetooth 不提供 Classic SPP 序列埠連線；iPhone／iPad 通常亦不能直接透過通用 SPP 使用，可能需要廠商 SDK 或 MFi 支援。 |
| **Wi-Fi／Ethernet（LAN）** | 打印機連接無線網絡或有線區域網絡，客戶端透過打印機支援的網絡協定傳送資料。 | 適合固定位置或多設備共用；需知道網絡設定及打印協定。一般瀏覽器網頁不能任意直接連接所有本地網絡端口，還會受瀏覽器安全限制影響。 |
| **USB** | 以 USB 線連接手機／電腦，透過作業系統驅動、原生程式或受支援的瀏覽器介面打印。 | 連線穩定，通常適合固定工作站；手機轉接、供電、驅動及瀏覽器支援會因平台而異。一般網頁不能假設可直接控制任意 USB 打印機。 |
| **廠商 SDK／原生打印服務** | 使用打印機品牌提供的 SDK、驅動或系統打印服務。 | 可支援特定品牌功能及專有協定，但通常需要安裝原生 App／驅動或整合對應 SDK，並非通用網頁方案。 |

### 本項目的實作範圍：只實作 BLE

目前本項目只實作 **BLE（Web Bluetooth + GATT）**，沒有實作 Bluetooth Classic／SPP、Wi-Fi／LAN、USB 或各品牌專用 SDK。打印頁會讓用戶選取 BLE 裝置，嘗試連接已知的常見服務 UUID，並在找到可寫入的 GATT characteristic 後分段傳送測試收據資料；這是通用的基本嘗試，**不代表能相容所有 BLE 打印機**。若打印機使用私有服務 UUID、需要廠商專用封包／握手，或只提供 Classic SPP，便可能無法連接或無法正常打印。

- **Android**：請使用支援 Web Bluetooth 的 Chromium 瀏覽器（例如最新版 Chrome），並以 HTTPS 開啟網站。
- **iPhone／iPad**：目前 iOS Safari 不支援本項目所需的 Web Bluetooth，因此即使設備有 BLE，也不能透過目前這個網頁實作直接連接打印。將網站加入主畫面不會自動補上 Web Bluetooth 支援。
- **選購打印機前**：確認規格明確列出 BLE GATT 打印支援，而不只是「Bluetooth」或「Bluetooth 5.x」；最好確認服務／characteristic UUID、資料傳輸方式，以及打印機是否支援所需字元集與 ESC/POS 指令。
- **打印內容**：目前程式以伺服器轉換 Big5 文字，再透過 BLE characteristic 傳送；打印機仍須支援相符字碼表。不同廠牌的 ESC/POS 子集及 code-page 編號可能不同。


## 功能

- 登入頁、一般用戶及管理員後台均顯示系統版本與環境（測試環境／正式環境）。前端每 5 秒檢查伺服器版本及環境；如版本或環境不一致，會阻擋繼續使用並要求強制重新載入。每次功能更新均須同步遞增 `package.json` 與 `package-lock.json` 的版本號，並以相同版本建置／部署前端與伺服器；客戶端心跳會回報版本及環境，管理員可在「用戶管理」查看各客戶端現時版本及是否需要更新。測試環境可設定 `VITE_APP_ENV=test` 及伺服器 `APP_ENV=test`，正式環境使用 `APP_ENV=production`。

- 安裝式 PWA manifest 與 Service Worker。
- 一般用戶在單一「打印」頁重複選取／切換 BLE 裝置、連接 GATT 可寫入 characteristic，並打印較完整的雙欄模擬付款測試收據；可輸入備註，備註會打印在收據上。
- 收據文字由伺服器以 `iconv-lite` 編碼成 Big5；8 cm 紙寬以收據版面呈現。
- 打印機偏好（裝置 ID/名稱）同時存入瀏覽器 IndexedDB 及伺服器 SQLite；在支援 `navigator.bluetooth.getDevices()` 的瀏覽器中，會嘗試恢復先前授權的裝置。
- WebAuthn Passkey 註冊與登入；登入成功、失敗、登出均寫入 SQLite。
- 手機客戶端可在「事件管理」建立事件，附加多張圖片及多段影片；可暫存在手機 IndexedDB（包含附件），或直接上傳。每台瀏覽器客戶端由伺服器派發唯一六位 Base58 設備碼；事件編號由本機流水號、設備碼及建立日期（DDMMYYYY）組成，可在已取得設備碼後離線建立。網絡中斷時事件會保留於本機上傳隊列，遠端恢復後自動重試。
- 上傳的工作記錄會保存用戶、客戶端 ID、事件日期、內容、附件及上傳時的打印機名稱。手機暫存內容不會出現在伺服器；每個事件最多 20 個圖片／影片附件，單檔最大 500 MiB（約 524 MB）。
- Web Push 訂閱、測試推播；管理員可對指定已訂閱設備推播，或廣播給所有已訂閱設備，同時保留站內通知。
- 登入歷史及操作稽核頁面。
- 「通知」頁集中管理員通知發送：可指定已訂閱設備或廣播所有已訂閱設備；管理員不顯示自己的通知收件匣。
- 「用戶管理」頁管理用戶及查看客戶端在線狀態；管理員介面不提供打印頁、選取打印機或打印操作。
- 一般用戶可在手機「個人資料」頁修改顯示名稱、員工編號、員工姓名、電話及電郵；登入用戶名保持唯讀。管理員可查看／修改一般用戶的個人資料，並查看各用戶關聯的設備。
- 管理員後台分設「註冊設備」及「設備用戶」兩個獨立頁面。「註冊設備」頁列出所有設備碼、在線狀態、最近活動及該設備曾註冊／登入的用戶；點擊設備碼進入設備詳情。「設備用戶」頁列出所有一般用戶；點擊用戶名稱進入用戶詳情，可修改帳戶資料或強制刪除用戶。設備詳情列出相關用戶，用戶詳情列出相關連結設備，兩邊均可點擊名稱互相跳轉。手機用戶可在「個人資料」更新顯示名稱、員工編號、員工姓名及聯絡方式，但不能修改登入用戶名。刪除整部設備會撤銷其工作階段、刪除該設備上傳的工作記錄及附件，並永久刪除所有關聯的一般用戶帳戶及 Passkey；登入歷史與操作稽核會保留。此操作無法復原，管理員設備不可透過此頁刪除。
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
npm run dev
```

- Vite 前端：`http://localhost:5173`
- API：`http://localhost:8787`
- SQLite 資料夾及資料表會在 API 啟動時自動建立；一般本機啟動不必先執行 `npm run db:init`。此指令仍保留作為手動初始化／檢查用途。
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

手機用戶在「事件管理」可為每個事件選擇多張圖片或多段影片。按「暫存於手機」會把事件文字和媒體 Blob 保存在 IndexedDB，按「上傳事件及附件」或「直接上傳」才會提交伺服器；上傳成功後，手機草稿才會移除。清除網站資料或更換瀏覽器／設備仍可能導致本機草稿遺失。伺服器接受每個事件最多 20 個媒體檔案、單檔最大 500 MiB（約 524 MB）；部署時請確認反向代理（例如 Nginx 的 `client_max_body_size`）、磁碟空間及網絡限制允許相應大小。瀏覽器 IndexedDB 暫存 Blob 不會把影片傳送到伺服器，立即完成暫存不代表影片已上傳。管理員可在「設備工作記錄」獨立頁查看所有設備工作記錄及媒體連結，並刪除記錄；客戶端每 3 秒重新讀取自己的上傳清單，刪除後會同步更新。一般用戶的「打印」頁只會打印標示為非真實交易的模擬付款收據，並可把備註加入收據；管理員帳號不提供打印功能。

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

**不需要預先建立 `app-data` 或 `app-uploads`，也不需要在 Docker Compose 啟動前執行 `npm run db:init`。** Compose 會自動建立缺少的 bind-mount 來源目錄；`init-storage` 一次性服務會在應用程式啟動前設定資料目錄權限。API 匯入 `server/db.ts` 時會自動建立 SQLite 資料夾及資料表／遷移，因此 Docker 部署的初始化由容器啟動流程完成。

正常首次部署或重建時直接執行：

**重要：若是從舊版 Docker named volumes 升級到主機目錄掛載，仍必須先備份並把舊 volume 內容複製到 `./app-data` 和 `./app-uploads`。** 自動建立目錄不會自動搬移舊 volume 的資料；若直接啟動，應用程式可能會使用新建的空資料目錄。先用 `docker volume ls` 找出舊 volume 的實際名稱（通常是 `<Compose專案名>_app-data` 和 `<Compose專案名>_app-uploads`），並在停止應用程式後複製，例如把下列佔位名稱換成實際名稱：

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

## 客戶手機端公開 API 與用戶驗證

本節列出一般用戶的手機瀏覽器／已安裝 PWA 在註冊、登入、設備心跳、事件工作記錄、打印偏好及通知功能會使用的 API。API 與前端同源，正式環境應透過 HTTPS 存取；以下路徑省略共同前綴 `/api`，例如 `POST /auth/login/options` 的完整路徑是 `POST /api/auth/login/options`。

### 驗證方式與安全邊界

- **一般用戶使用 Passkey（WebAuthn）**：註冊時由伺服器產生註冊選項及一次性 challenge，瀏覽器呼叫系統 Passkey／Face ID／Touch ID／裝置 PIN 或相容的安全金鑰完成簽署，再把回應送回伺服器驗證。登入採用相同的 challenge-response 流程；伺服器會驗證 challenge、網站 Origin、RP ID 及憑證簽章，不會以用戶名稱本身作為登入憑證。
- **註冊流程**：先呼叫 `POST /auth/register/options`，再呼叫 `POST /auth/register/verify`。使用者名稱需為 3–40 個小寫英文字母、數字、點、底線或連字號；員工編號必須是數字，且不可與其他帳戶重複。聯絡人姓名、電話及電郵屬補充資料。現有實作只驗證員工編號格式及唯一性，**不會連接外部人事系統核實員工身份**。
- **登入流程**：呼叫 `POST /auth/login/options` 取得 challenge，再由瀏覽器 Passkey 完成驗證並呼叫 `POST /auth/login/verify`。登入可傳入使用者名稱；省略使用者名稱時，瀏覽器可嘗試使用可探索的 Passkey。成功回應會包含 session `token`、使用者資料、`clientId` 及設備碼。
- **已登入 API**：在 HTTP Header 加上 `Authorization: Bearer <token>`。前端目前把 token 保存在瀏覽器的 `localStorage`（鍵名 `esc-token`），每次 API 請求附帶此 Header。伺服器資料庫只保存 token 的 SHA-256 雜湊；session 有效期為 7 天。過期或無效時通常回傳 HTTP 401，客戶端需重新登入。
- **登出**：`POST /auth/logout` 會撤銷目前 session。客戶端亦應清除本機 token。
- **設備識別**：`clientId` 用於把登入 session 與該瀏覽器／PWA 的狀態、工作記錄及推播訂閱關聯；心跳回應會提供六位 Base58 設備碼。設備碼及 `clientId` 不是密碼，也不能代替 Bearer token。
- **網站設定必須一致**：WebAuthn 的 `APP_ORIGIN` 必須與用戶實際開啟的網址一致，`RP_ID` 必須是相符的網域名稱。正式部署請使用 HTTPS。伺服器可用 `preferredAuthenticatorType: localDevice` 提示瀏覽器優先選擇本機驗證器，但最終顯示 Face ID、其他裝置 QR code 或安全金鑰選項仍由瀏覽器、作業系統、Passkey 儲存位置及裝置設定決定。

### 公開（不需登入）API

| 方法 | 路徑 | 用途／主要回應 |
| --- | --- | --- |
| `GET` | `/health` | 健康檢查；回傳 `ok` 及服務名稱。 |
| `GET` | `/version` | 回傳前端比對版本用的 `version` 及 `environment`；使用 `Cache-Control: no-store`。 |
| `GET` | `/config` | 回傳 WebAuthn RP 名稱、RP ID、預期 Origin 及 VAPID 公開金鑰；不回傳 VAPID 私鑰。 |
| `POST` | `/auth/register/options` | 產生 Passkey 註冊選項及 `challengeId`。JSON 包含 `username`、`employeeNumber`，以及可選的 `employeeName`、`contactPhone`、`contactEmail`。 |
| `POST` | `/auth/register/verify` | 提交 `username`、`challengeId`、WebAuthn `response`，及可選的 `clientId` 完成註冊；成功回傳 `verified`、`clientId`、`deviceCode`。 |
| `POST` | `/auth/login/options` | 產生登入 challenge；可傳入 `username`，省略則使用可探索憑證流程。 |
| `POST` | `/auth/login/verify` | 提交 `challengeId`、WebAuthn `response`、可選的 `username`／`clientId`；成功回傳 session token、user、clientId 及設備碼。 |

註冊與登入 challenge 在伺服器端有效期為 **5 分鐘且只能使用一次**。以上驗證端點雖然不要求既有 Bearer token，但必須完成伺服器端 WebAuthn 驗證才會建立有效帳戶憑證或登入 session。

### 一般用戶登入後使用的 API

除另有註明，以下端點均須附帶 `Authorization: Bearer <token>`。JSON 請求使用 `Content-Type: application/json`；附件上傳使用 `multipart/form-data`。

| 方法 | 路徑 | 用途／主要資料 |
| --- | --- | --- |
| `GET` | `/me` | 驗證 session 並取得目前用戶資料及角色。 |
| `PUT` | `/me` | 更新目前用戶的顯示名稱、員工編號、員工姓名、電話及電郵；登入用戶名不可修改，員工編號必須是唯一數字。 |
| `POST` | `/auth/logout` | 撤銷目前 session。 |
| `POST` | `/client/heartbeat` | 每隔一段時間回報客戶端狀態，包括 `clientId`、瀏覽器 User-Agent、Bluetooth／打印機連線狀態及打印機資料；回傳伺服器時間及設備碼。 |
| `GET` | `/work` | 取得目前登入 session 所關聯客戶端的已上傳工作記錄及附件資料。需先完成客戶端初始化；未初始化時回傳 409。 |
| `POST` | `/work/chunk` | 分段上傳單一圖片／影片附件。表單欄位包括 `chunk`、`uploadId`、`filename`、`mimeType`、`index`、`totalChunks`、`totalSize`、`chunkSize`；每段預期 160 KiB，單檔上限 500 MiB。最後一段成功時回傳 `mediaId`。 |
| `POST` | `/work` | 建立已上傳工作記錄。可傳 `title`、`content`、`eventDate`、`eventCode`、`createdAt`；附件可直接以 `media` 上傳，或以 `uploadedMediaIds` 引用已完成的分段上傳。每個事件最多 20 個附件。成功通常回傳 HTTP 201 及記錄 ID；相同客戶端的 `eventCode` 重試會避免重複建立。 |
| `DELETE` | `/work/:id` | 刪除目前客戶端自己的工作記錄及其附件。 |
| `GET` | `/printer-preference` | 取得一般用戶保存的打印機偏好。 |
| `POST` | `/printer-preference` | 儲存 `deviceId`、`deviceName`。 |
| `POST` | `/printer-action` | 記錄打印機 `connected`、`disconnected` 或 `connection_failed` 狀態及相關資料。 |
| `POST` | `/receipt/encode` | 將 `text` 編碼為 Big5，回傳 Base64、編碼名稱及 `codePageIndex`，供測試收據打印使用。 |
| `POST` | `/receipt/print-log` | 記錄測試收據打印請求的打印機名稱、狀態及備註等稽核資料。 |
| `POST` | `/push/subscribe` | 儲存瀏覽器 Push API 產生的訂閱 JSON（包含 `endpoint`、`keys.p256dh`、`keys.auth`）；需先完成設備初始化及伺服器 VAPID 設定。 |
| `POST` | `/push/test` | 向目前用戶已保存的推播訂閱發送測試通知；回傳 `sent` 及 `total`。 |
| `GET` | `/notifications` | 取得發送給所有客戶端或目前客戶端的通知，以及此客戶端的已讀狀態；需先完成設備初始化。 |
| `POST` | `/notifications/:id/read` | 將指定且目前客戶端有權查看的通知標記為已讀。 |

### 常見 HTTP 狀態碼

- `200`: 請求成功。
- `201`: 新工作記錄建立成功。
- `400`: 請求資料、WebAuthn 回應或附件分段資料無效。
- `401`: 缺少、失效或無效的 Bearer token，或登入驗證失敗。
- `403`: 帳戶、角色或操作不符合權限要求。
- `404`: 指定記錄／通知不存在，或登入帳戶尚未註冊。
- `409`: 資源衝突、客戶端尚未初始化或附件分段次序不一致。
- `413`: 附件超過伺服器允許的大小限制。
- `415`: 附件格式不受支援。
- `503`: 伺服器尚未設定推播所需的 VAPID 金鑰等必要設定。

管理員專用端點（例如 `/admin/*`、`/audit`、`/logins` 及資料清理操作）不屬於一般客戶手機端 API。新增的管理功能包括：`GET /admin/dashboard` 回傳所有用戶、關聯設備及設備清單；`PUT /admin/users/:id/profile` 更新一般用戶個人資料（不可改登入用戶名）；`DELETE /admin/users/:id` 刪除單一用戶；`DELETE /admin/devices/:clientId` 永久刪除整部註冊設備及其關聯一般用戶、Passkey、工作階段與設備上傳工作記錄／附件。刪除設備前端會顯示關聯用戶並要求確認，伺服器亦會保護固定管理員帳戶及目前管理員登入設備；登入歷史及操作稽核會保留。管理員使用伺服器環境變數中的固定帳密登入，並受管理員角色及桌面瀏覽器限制；請勿把管理員憑證放入手機端或前端程式碼。

## 限制及後續工作

- Web Bluetooth 不允許網站任意掃描或在沒有使用者手勢/授權時靜默重新連線。瀏覽器 IndexedDB 保存的裝置 ID 不是可跨裝置/瀏覽器重用的永久硬體識別碼；若瀏覽器不提供 `getDevices()` 或授權被撤銷，使用者可能需要再次選取。
- BLE 服務 UUID 目前列出常見候選值，不能涵蓋所有廠牌。若打印機使用專有 UUID，需加入該 UUID；部分裝置需要特定封包格式、MTU/流控或廠商指令。
- Big5 編碼端已建立，但收據打印的中文正確性需在實際打印機上驗證；調整 code-page index、行寬、字型、切紙指令以符合硬體。
- SQLite 與媒體資料是持久化的，但部署時仍須設定備份、磁碟配額、媒體存取權限及保留政策。客戶端會在事件建立滿 24 小時後隱藏該事件及停止客戶端介面內的預覽入口；這項限制只屬客戶端顯示行為。伺服器資料、附件及管理員後台記錄不受 24 小時限制，也不會因這項規則自動刪除。
- Web Push 需要 HTTPS、有效 VAPID 金鑰、用戶授權及瀏覽器／作業系統支援。推播端點可能失效，伺服器會清除回報 404／410 的端點。
- 本專案是初始實作 scaffold，尚未在實際 BLE 打印機、實際 WebAuthn authenticator、正式 HTTPS/Push 環境中執行整合測試。上線前請執行安全審查及裝置相容性測試。
