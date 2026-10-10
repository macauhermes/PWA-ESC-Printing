import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import './style.css';

type User = { id: string; username: string; displayName: string; role: string };
type EventItem = { id: string; title: string; content: string; event_date?: string; created_at: string; media: { id: string; kind: string; original_name: string; url: string }[] };
type Job = { id: string; job_date: string; title: string; status: string; detail: string; created_at: string };
type Printer = { id: string; name: string; device: BluetoothDevice; characteristic?: BluetoothRemoteGATTCharacteristic };

const api = async (path: string, token: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch('/api' + path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
};
const b64url = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
const b64 = (s: string) => Uint8Array.from(atob(b64url(s)), c => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
const id = () => crypto.randomUUID();

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('esc-token') || '');
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tab, setTab] = useState('printer');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [printer, setPrinter] = useState<Printer | null>(null);
  const [savedPrinter, setSavedPrinter] = useState<any>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [logins, setLogins] = useState<any[]>([]);
  const [audits, setAudits] = useState<any[]>([]);
  const [eventTitle, setEventTitle] = useState('');
  const [eventContent, setEventContent] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [media, setMedia] = useState<FileList | null>(null);
  const [jobTitle, setJobTitle] = useState('');
  const [jobDetail, setJobDetail] = useState('');

  useEffect(() => { if (token) api('/me', token).then((x) => setUser(x.user)).catch(() => { localStorage.removeItem('esc-token'); setToken(''); setUser(null); }); }, [token]);
  useEffect(() => {
    if (!token || !user) return;
    api('/printer-preference', token).then(setSavedPrinter).catch(() => {});
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, [token, user]);
  useEffect(() => {
    if (!token || !user) return;
    if (tab === 'events') api('/events', token).then(setEvents).catch(err => setMessage(err.message));
    if (tab === 'jobs') api('/jobs', token).then(setJobs).catch(err => setMessage(err.message));
    if (tab === 'logins') api('/logins', token).then(setLogins).catch(err => setMessage(err.message));
    if (tab === 'audit') api('/audit', token).then(setAudits).catch(err => setMessage(err.message));
  }, [tab, token, user]);

  async function login() {
    setBusy(true); setMessage('');
    try {
      const options = await fetch('/api/auth/login/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      const { challengeId, username: loginName, ...publicKey } = options;
      const response = await startAuthentication({ optionsJSON: publicKey });
      const result = await fetch('/api/auth/login/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: loginName, challengeId, response }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      localStorage.setItem('esc-token', result.token); setToken(result.token); setUser(result.user); setMessage('登入成功');
    } catch (e) { setMessage(e instanceof Error ? e.message : '登入失敗'); }
    finally { setBusy(false); }
  }
  async function register() {
    setBusy(true); setMessage('');
    try {
      const options = await fetch('/api/auth/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, displayName: displayName || username }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      const { challengeId, userId, ...publicKey } = options;
      const response = await startRegistration({ optionsJSON: publicKey });
      const result = await fetch('/api/auth/register/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, challengeId, response }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      setMessage(result.verified ? 'Passkey 註冊成功，現在可以登入。' : '註冊未完成');
    } catch (e) { setMessage(e instanceof Error ? e.message : '註冊失敗'); }
    finally { setBusy(false); }
  }
  async function logout() {
    try { if (token) await api('/auth/logout', token, { method: 'POST' }); } catch {}
    localStorage.removeItem('esc-token'); setToken(''); setUser(null); setPrinter(null); setMessage('已登出');
  }

  async function scanPrinter() {
    if (!('bluetooth' in navigator)) { setMessage('此瀏覽器不支援 Web Bluetooth。請使用支援 BLE 的 Chromium 瀏覽器及 HTTPS/localhost。'); return; }
    try {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', '0000ae00-0000-1000-8000-00805f9b34fb'] });
      const selected: Printer = { id: device.id, name: device.name || 'BLE Thermal Printer', device };
      setPrinter(selected);
      await api('/printer-preference', token, { method: 'POST', body: JSON.stringify({ deviceId: device.id, deviceName: selected.name }) });
      setSavedPrinter({ device_id: device.id, device_name: selected.name });
      device.addEventListener('gattserverdisconnected', () => setMessage('打印機已斷線；可重新連接。'));
      setMessage(`已選取 ${selected.name}。瀏覽器不允許網站靜默重連或重新列舉已授權裝置，請使用「連接/選取」按鈕。`);
    } catch (e) { setMessage(e instanceof Error ? e.message : '未選取打印機'); }
  }
  async function connectPrinter() {
    if (!printer) { await scanPrinter(); return; }
    setBusy(true);
    try {
      const server = await printer.device.gatt?.connect();
      if (!server) throw new Error('無法連接 GATT server');
      const services = await server.getPrimaryServices();
      let writable: BluetoothRemoteGATTCharacteristic | undefined;
      for (const service of services) {
        const chars = await service.getCharacteristics();
        writable = chars.find(c => c.properties.writeWithoutResponse || c.properties.write) || writable;
        if (writable) break;
      }
      if (!writable) throw new Error('找不到可寫入的 BLE characteristic。此打印機可能使用廠商專用 BLE 服務或不是 BLE GATT 打印機。');
      setPrinter({ ...printer, characteristic: writable });
      setMessage(`已連接 ${printer.name}，找到可寫入的 characteristic。`);
    } catch (e) { setMessage(e instanceof Error ? e.message : '連接失敗'); }
    finally { setBusy(false); }
  }
  async function printTest() {
    if (!printer?.characteristic) { setMessage('請先選取並連接打印機。'); return; }
    setBusy(true);
    try {
      const text = [
        '        測試付款收據',
        '================================',
        '店名：示範商店',
        '單號：' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14),
        '日期：' + new Date().toLocaleString('zh-TW'),
        '--------------------------------',
        '商品             數量      金額',
        '測試商品            1    $80.00',
        '--------------------------------',
        '小計                    $80.00',
        '總計                    $80.00',
        '付款方式：現金',
        '狀態：測試打印（非真實交易）',
        '',
        '      感謝惠顧，歡迎再次光臨',
        '',
        '',
        ''
      ].join('\n');
      const encoded = await api('/receipt/encode', token, { method: 'POST', body: JSON.stringify({ text, codePage: 'big5' }) });
      const payload = Uint8Array.from(atob(encoded.base64), c => c.charCodeAt(0));
      // ESC @ initialize, ESC t n selects a printer-specific code page. Big5 page index varies by printer.
      const bytes = new Uint8Array([0x1b, 0x40, 0x1b, 0x74, Number(encoded.codePageIndex ?? 0x00), ...payload, 0x1d, 0x56, 0x41, 0x10]);
      const chunkSize = 180;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.slice(i, i + chunkSize);
        if (printer.characteristic.properties.writeWithoutResponse && printer.characteristic.writeValueWithoutResponse) await printer.characteristic.writeValueWithoutResponse(chunk);
        else await printer.characteristic.writeValue(chunk);
      }
      await api('/receipt/print-log', token, { method: 'POST', body: JSON.stringify({ printerName: printer.name, status: 'submitted' }) });
      setMessage('已送出測試收據資料。若中文亂碼，請依打印機手冊調整 Big5 code page index。');
    } catch (e) { setMessage(e instanceof Error ? e.message : '打印失敗'); }
    finally { setBusy(false); }
  }

  async function saveEvent(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const data = new FormData(); data.append('title', eventTitle); data.append('content', eventContent); data.append('eventDate', eventDate);
      if (media) Array.from(media).forEach(f => data.append('media', f));
      await api('/events', token, { method: 'POST', body: data });
      setEventTitle(''); setEventContent(''); setEventDate(''); setMedia(null);
      setEvents(await api('/events', token)); setMessage('事件已保存');
    } catch (err) { setMessage(err instanceof Error ? err.message : '儲存失敗'); }
    finally { setBusy(false); }
  }
  async function saveJob(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try { await api('/jobs', token, { method: 'POST', body: JSON.stringify({ title: jobTitle, detail: jobDetail }) }); setJobTitle(''); setJobDetail(''); setJobs(await api('/jobs', token)); setMessage('工作記錄已建立'); }
    catch (err) { setMessage(err instanceof Error ? err.message : '建立失敗'); }
    finally { setBusy(false); }
  }
  async function subscribePush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('此瀏覽器不支援 Push API');
      const cfg = await fetch('/api/config').then(r => r.json());
      if (!cfg.vapidPublicKey) throw new Error('伺服器尚未設定 VAPID keys');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('通知權限未授予');
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(cfg.vapidPublicKey) });
      await api('/push/subscribe', token, { method: 'POST', body: JSON.stringify(subscription) });
      await api('/push/test', token, { method: 'POST' });
      setMessage('已訂閱推播，並已要求發送測試通知。');
    } catch (e) { setMessage(e instanceof Error ? e.message : '推播訂閱失敗'); }
  }

  const tabs = useMemo(() => [
    ['printer', '藍牙打印'], ['events', '事件管理'], ['jobs', '工作排程'], ['logins', '登入記錄'], ['audit', '操作稽核']
  ], []);
  if (!user) return <main className="auth-shell"><section className="panel auth-panel"><div className="brand">ESC <span>PRINTING</span></div><h1>PWA ESC Printing</h1><p className="muted">以 Passkey 安全登入，管理打印機、事件及記錄。</p><label>使用者名稱<input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" placeholder="例如：operator01" /></label><label>顯示名稱（首次註冊）<input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="操作人員" /></label><div className="actions"><button disabled={busy || !username} onClick={login}>{busy ? '處理中…' : 'Passkey 登入'}</button><button className="secondary" disabled={busy || !username} onClick={register}>註冊 Passkey</button></div><p className="hint">首次使用請先註冊 Passkey。生產環境請關閉公開註冊並改用邀請或管理員建立帳戶。</p>{message && <p className="notice">{message}</p>}</section></main>;

  return <div className="app-shell"><header className="topbar"><div><div className="brand">ESC <span>PRINTING</span></div><small>收據打印 · 事件 · 稽核</small></div><div className="account"><span>{user.displayName || user.username}</span><button className="secondary compact" onClick={logout}>登出</button></div></header>
    <nav className="tabs">{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'tab active' : 'tab'} onClick={() => { setTab(key); setMessage(''); }}>{label}</button>)}</nav>
    <main className="content">
      {message && <div className="notice" role="status">{message}<button className="notice-close" onClick={() => setMessage('')}>×</button></div>}
      {tab === 'printer' && <section className="grid two"><article className="panel"><h2>藍牙熱敏打印機</h2><p className="muted">使用支援 Web Bluetooth 的 Chromium 瀏覽器；需要 HTTPS 或 localhost。</p><div className="printer-card"><div className="printer-icon">▤</div><div><strong>{printer?.name || savedPrinter?.device_name || '尚未選取打印機'}</strong><p className="muted">{printer?.characteristic ? '已連接 · 可寫入' : printer ? '已選取 · 尚未連接' : savedPrinter?.device_name ? '已保存偏好；請重新選取裝置以取得瀏覽器授權' : '尚未連接'}</p></div></div><div className="actions"><button disabled={busy} onClick={scanPrinter}>掃描 / 選取</button><button disabled={busy || !printer} className="secondary" onClick={connectPrinter}>連接</button></div><p className="hint">瀏覽器安全限制：裝置 ID/名稱可保存，但網頁不能在下次造訪時靜默重新取得裝置權限；通常需再次由使用者選取。部分打印機使用廠商專用 BLE 協定。</p></article><article className="panel"><h2>8 cm 測試付款收據</h2><div className="receipt-preview"><div className="receipt-title">測試付款收據</div><hr/><p>店名：示範商店</p><p>測試商品　× 1　$80.00</p><hr/><strong>總計　　$80.00</strong><p>付款方式：現金</p><p className="receipt-footer">非真實交易 · 感謝惠顧</p></div><p className="hint">使用 Big5 編碼；ESC/POS 的 Big5 code page 編號因廠牌與韌體而異，需按打印機手冊設定。</p><button className="full" disabled={busy || !printer?.characteristic} onClick={printTest}>{busy ? '處理中…' : '打印測試收據'}</button></article><article className="panel"><h2>推播通知</h2><p className="muted">訂閱本機瀏覽器通知，方便接收應用程式通知。</p><button onClick={subscribePush}>啟用推播並測試</button></article></section>}
      {tab === 'events' && <section className="grid two"><article className="panel"><h2>建立事件</h2><form onSubmit={saveEvent}><label>標題<input required value={eventTitle} onChange={e => setEventTitle(e.target.value)} /></label><label>內容<textarea rows={5} value={eventContent} onChange={e => setEventContent(e.target.value)} /></label><label>事件日期<input type="datetime-local" value={eventDate} onChange={e => setEventDate(e.target.value)} /></label><label>圖片 / 影片（可多選）<input type="file" accept="image/*,video/*" multiple onChange={e => setMedia(e.target.files)} /></label><p className="hint">每個檔案上限 100 MB；檔案存於伺服器 uploads 目錄，metadata 存於 SQLite。</p><button disabled={busy}>保存事件</button></form></article><article className="panel"><h2>歷史事件 <span className="count">{events.length}</span></h2>{events.length === 0 ? <p className="muted">尚無事件記錄。</p> : events.map(ev => <div className="list-item" key={ev.id}><div className="list-heading"><strong>{ev.title}</strong><small>{ev.event_date || ev.created_at}</small></div><p>{ev.content}</p><div className="media-list">{ev.media?.map(m => m.kind === 'image' ? <a key={m.id} href={m.url} target="_blank" rel="noreferrer"><img src={m.url} alt={m.original_name}/></a> : <video key={m.id} src={m.url} controls />)}</div><button className="danger compact" onClick={async () => { if (confirm('確定刪除此事件及其媒體記錄？')) { await api('/events/' + ev.id, token, { method: 'DELETE' }); setEvents(await api('/events', token)); } }}>刪除</button></div>)}</article></section>}
      {tab === 'jobs' && <section className="grid two"><article className="panel"><h2>建立工作記錄</h2><form onSubmit={saveJob}><label>標題<input required value={jobTitle} onChange={e => setJobTitle(e.target.value)} /></label><label>內容<textarea rows={4} value={jobDetail} onChange={e => setJobDetail(e.target.value)} /></label><button disabled={busy}>新增工作</button></form><p className="hint">系統每日 00:00（Asia/Singapore 預設）建立一筆自動工作記錄。伺服器必須持續運行才能觸發排程；啟動時亦會補上當日缺失記錄。</p></article><article className="panel"><h2>工作歷史 <span className="count">{jobs.length}</span></h2><div className="table-wrap"><table><thead><tr><th>日期</th><th>工作</th><th>狀態</th><th>內容</th></tr></thead><tbody>{jobs.map(j => <tr key={j.id}><td>{j.job_date}</td><td>{j.title}</td><td><span className="status">{j.status}</span></td><td>{j.detail}</td></tr>)}</tbody></table></div></article></section>}
      {tab === 'logins' && <section className="panel"><h2>登入人員及歷史記錄</h2><div className="table-wrap"><table><thead><tr><th>時間</th><th>使用者</th><th>事件</th><th>結果</th><th>說明</th></tr></thead><tbody>{logins.map(l => <tr key={l.id}><td>{l.created_at}</td><td>{l.username}</td><td>{l.event}</td><td>{l.success ? '成功' : '失敗'}</td><td>{l.detail}</td></tr>)}</tbody></table></div></section>}
      {tab === 'audit' && <section className="panel"><h2>操作稽核歷史</h2><div className="table-wrap"><table><thead><tr><th>時間</th><th>人員</th><th>操作</th><th>類型</th><th>對象 ID</th><th>內容</th></tr></thead><tbody>{audits.map(a => <tr key={a.id}><td>{a.created_at}</td><td>{a.username || 'system'}</td><td>{a.action}</td><td>{a.entity_type}</td><td>{a.entity_id}</td><td>{a.detail}</td></tr>)}</tbody></table></div></section>}
    </main><footer>本機持久化 · SQLite · WebAuthn · BLE ESC/POS</footer></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
