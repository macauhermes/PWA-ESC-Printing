import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import './style.css';

type User = { id: string; username: string; displayName: string; role: string };
type EventItem = { id: string; title: string; content: string; event_date?: string; created_at: string; media: { id: string; kind: string; original_name: string; url: string }[] };
type Job = { id: string; job_date: string; title: string; status: string; detail: string; created_at: string };
type Printer = { id: string; name: string; device: BluetoothDevice; characteristic?: BluetoothRemoteGATTCharacteristic };
type AdminClient = { clientId:string; userId:string; username:string; online:number; bluetoothSupported:number; bluetoothConnected:number; printerConnected:number; printerName?:string; printerId?:string; userAgent?:string; lastSeen:string };
type AdminUser = { id:string; username:string; displayName:string; role:string; createdAt:string; passkeyCount:number; activeSessions:number; lastLogin?:string };
type AdminOperation = { id:number; username?:string; action:string; entity_type?:string; entity_id?:string; detail?:string; created_at:string };
type AdminDashboard = { users:AdminUser[]; clients:AdminClient[]; operations:AdminOperation[]; jobs:Job[]; serverTime:string };
type NotificationItem = { id:string; title:string; body:string; targetClientId?:string|null; createdAt:string; isRead:number; readAt?:string };

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
type SavedPrinter = { id: string; name: string; savedAt: string };
function printerStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('esc-printing-local', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('preferences', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function savePrinterLocally(value: SavedPrinter) {
  const db = await printerStore();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('preferences', 'readwrite');
    tx.objectStore('preferences').put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
async function loadPrinterLocally(): Promise<SavedPrinter | null> {
  const db = await printerStore();
  const value = await new Promise<SavedPrinter | null>((resolve, reject) => {
    const request = db.transaction('preferences', 'readonly').objectStore('preferences').get('selected-printer');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

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
  const [codePageIndex, setCodePageIndex] = useState('0');
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
  const [quickTitle, setQuickTitle] = useState('');
  const [quickContent, setQuickContent] = useState('');
  const [quickDate, setQuickDate] = useState('');
  const [quickMedia, setQuickMedia] = useState<FileList | null>(null);
  const [clearSelections, setClearSelections] = useState<string[]>([]);
  const [clearLocalPrinter, setClearLocalPrinter] = useState(true);
  const [clientId] = useState(() => { const old = localStorage.getItem('esc-client-id'); if (old) return old; const next = crypto.randomUUID(); localStorage.setItem('esc-client-id', next); return next; });
  const [adminDashboard, setAdminDashboard] = useState<AdminDashboard | null>(null);
  const [adminWorkTitle, setAdminWorkTitle] = useState('');
  const [adminWorkDate, setAdminWorkDate] = useState(new Date().toISOString().slice(0,10));
  const [adminWorkDetail, setAdminWorkDetail] = useState('');
  const [adminOpTitle, setAdminOpTitle] = useState('');
  const [adminOpContent, setAdminOpContent] = useState('');
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationTitle, setNotificationTitle] = useState('');
  const [notificationBody, setNotificationBody] = useState('');
  const [notificationTarget, setNotificationTarget] = useState('');

  useEffect(() => { if (token) api('/me', token).then((x) => setUser(x.user)).catch(() => { localStorage.removeItem('esc-token'); setToken(''); setUser(null); }); }, [token]);
  useEffect(() => {
    if (!token || !user) return;
    api('/printer-preference', token).then(setSavedPrinter).catch(() => {});
    loadPrinterLocally().then(async saved => {
      if (!saved) return;
      setSavedPrinter({ device_id: saved.id, device_name: saved.name });
      const bluetooth = (navigator as any).bluetooth;
      if (bluetooth?.getDevices) {
        const devices: BluetoothDevice[] = await bluetooth.getDevices();
        const device = devices.find(d => d.id === saved.id);
        if (device) setPrinter({ id: device.id, name: device.name || saved.name, device });
      }
    }).catch(() => {});
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, [token, user]);
  useEffect(() => {
    if (!token || !user) return;
    if (tab === 'events') api('/events', token).then(setEvents).catch(err => setMessage(err.message));
    if (tab === 'jobs') api('/jobs', token).then(setJobs).catch(err => setMessage(err.message));
    if (tab === 'logins') api('/logins', token).then(setLogins).catch(err => setMessage(err.message));
    if (tab === 'audit') api('/audit', token).then(setAudits).catch(err => setMessage(err.message));
  }, [tab, token, user]);

  useEffect(() => {
    if (!token || !user) return;
    let active = true;
    const refreshNotifications = async () => {
      try {
        const rows = await api('/notifications', token);
        if (active) setNotifications(rows);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('401') || msg.includes('Session expired') || msg.includes('Authentication required')) {
          localStorage.removeItem('esc-token'); setToken(''); setUser(null); setTab('printer');
        }
      }
    };
    void refreshNotifications();
    const timer = window.setInterval(refreshNotifications, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [token, user, clientId]);

  useEffect(() => {
    if (!token || !user) return;
    const report = async () => {
      try {
        await api('/client/heartbeat', token, { method: 'POST', body: JSON.stringify({
          clientId, userAgent: navigator.userAgent, bluetoothSupported: 'bluetooth' in navigator,
          bluetoothConnected: Boolean(printer?.device?.gatt?.connected),
          printerConnected: Boolean(printer?.characteristic && printer.device.gatt?.connected),
          printerName: printer?.name || savedPrinter?.device_name || '',
          printerId: printer?.id || savedPrinter?.device_id || ''
        }) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('401') || msg.includes('Session expired') || msg.includes('Authentication required')) {
          localStorage.removeItem('esc-token'); setToken(''); setUser(null); setPrinter(null); setTab('printer');
          setMessage('此客戶端工作階段已被管理員結束，請重新登入。');
        }
      }
    };
    void report();
    const timer = window.setInterval(report, 3000);
    return () => window.clearInterval(timer);
  }, [token, user, clientId, printer, savedPrinter]);

  useEffect(() => {
    if (!token || !user || user.role !== 'admin' || tab !== 'admin') return;
    let alive = true;
    const refresh = async () => {
      try { const data = await api('/admin/dashboard', token); if (alive) setAdminDashboard(data); }
      catch (err) { if (alive) setMessage(err instanceof Error ? err.message : '管理後台讀取失敗'); }
    };
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [token, user, tab]);

  async function refreshAdmin() { setAdminDashboard(await api('/admin/dashboard', token)); }
  async function adminAction(path: string, init: RequestInit, success: string) {
    setBusy(true);
    try { await api(path, token, init); await refreshAdmin(); setMessage(success); }
    catch (err) { setMessage(err instanceof Error ? err.message : '管理操作失敗'); }
    finally { setBusy(false); }
  }
  async function createAdminOperation(e: React.FormEvent) {
    e.preventDefault();
    await adminAction('/admin/operations', { method:'POST', body:JSON.stringify({ title:adminOpTitle, content:adminOpContent }) }, '操作記錄已新增');
    setAdminOpTitle(''); setAdminOpContent('');
  }
  async function sendAdminNotification(e: React.FormEvent) {
    e.preventDefault();
    try {
      await adminAction('/admin/notifications', { method:'POST', body:JSON.stringify({
        title: notificationTitle, body: notificationBody, targetClientId: notificationTarget
      }) }, notificationTarget ? '指定客戶端通知已保存' : '廣播通知已保存');
      setNotificationTitle(''); setNotificationBody('');
    } catch {}
  }
  async function markNotificationRead(notificationId: string) {
    try {
      await api('/notifications/' + encodeURIComponent(notificationId) + '/read', token, { method:'POST' });
      setNotifications(rows => rows.map(n => n.id === notificationId ? { ...n, isRead: 1, readAt: new Date().toISOString() } : n));
    } catch (err) { setMessage(err instanceof Error ? err.message : '更新通知狀態失敗'); }
  }

  async function createAdminWork(e: React.FormEvent) {
    e.preventDefault();
    await adminAction('/admin/jobs', { method:'POST', body:JSON.stringify({ title:adminWorkTitle, jobDate:adminWorkDate, detail:adminWorkDetail }) }, '工作記錄已新增');
    setAdminWorkTitle(''); setAdminWorkDetail('');
  }

  async function login() {
    setBusy(true); setMessage('');
    try {
      const options = await fetch('/api/auth/login/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      const { challengeId, username: loginName, ...publicKey } = options;
      const response = await startAuthentication({ optionsJSON: publicKey });
      const result = await fetch('/api/auth/login/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: loginName, challengeId, response, clientId }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
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
    localStorage.removeItem('esc-token'); setToken(''); setUser(null); setPrinter(null); setTab('printer'); setMessage('已登出');
  }

  async function scanPrinter() {
    if (!('bluetooth' in navigator)) { setMessage('此瀏覽器不支援 Web Bluetooth。請使用支援 BLE 的 Chromium 瀏覽器及 HTTPS/localhost。'); return; }
    try {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', '0000ae00-0000-1000-8000-00805f9b34fb'] });
      const selected: Printer = { id: device.id, name: device.name || 'BLE Thermal Printer', device };
      setPrinter(selected);
      await savePrinterLocally({ id: device.id, name: selected.name, savedAt: new Date().toISOString() });
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
      await api('/printer-action', token, { method: 'POST', body: JSON.stringify({ action: 'connected', deviceId: printer.id, deviceName: printer.name }) });
      setMessage(`已連接 ${printer.name}，找到可寫入的 characteristic。`);
    } catch (e) { setMessage(e instanceof Error ? e.message : '連接失敗'); }
    finally { setBusy(false); }
  }
  async function printTest() {
    if (!printer?.characteristic) { setMessage('請先選取並連接打印機。'); return; }
    setBusy(true);
    try {
      const text = [
        '                 測試付款收據',
        '================================================',
        '店名：示範商店',
        '單號：' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14),
        '日期：' + new Date().toLocaleString('zh-TW'),
        '------------------------------------------------',
        '商品                         數量          金額',
        '測試商品                        1         $80.00',
        '------------------------------------------------',
        '小計                                      $80.00',
        '總計                                      $80.00',
        '付款方式：現金',
        '狀態：測試打印（非真實交易）',
        '',
        '      感謝惠顧，歡迎再次光臨',
        '',
        '',
        ''
      ].join('\n');
      const encoded = await api('/receipt/encode', token, { method: 'POST', body: JSON.stringify({ text, codePage: 'big5', codePageIndex: Number(codePageIndex) }) });
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
  async function saveQuickEvent(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const data = new FormData(); data.append('title', quickTitle); data.append('content', quickContent); data.append('eventDate', quickDate);
      if (quickMedia) Array.from(quickMedia).forEach(f => data.append('media', f));
      await api('/events', token, { method: 'POST', body: data });
      setQuickTitle(''); setQuickContent(''); setQuickDate(''); setQuickMedia(null);
      if (tab === 'events') setEvents(await api('/events', token));
      setMessage('手動事件記錄已建立並持久化保存');
      await api('/audit', token).then(setAudits).catch(() => {});
    } catch (err) { setMessage(err instanceof Error ? err.message : '建立事件失敗'); }
    finally { setBusy(false); }
  }
  async function clearPersistentRecords() {
    if (!clearSelections.length && !clearLocalPrinter) { setMessage('請先選擇要清除的記錄類別。'); return; }
    const labels: Record<string,string> = { events: '事件及媒體檔案', jobs: '工作記錄', logins: '登入歷史', printer_preferences: '伺服器打印機偏好', push_subscriptions: '推播訂閱' };
    const summary = [...clearSelections.map(k => labels[k] || k), ...(clearLocalPrinter ? ['本機 IndexedDB 打印機偏好'] : [])].join('、');
    if (!window.confirm(`確定永久刪除以下持久化記錄？\n${summary}\n此操作無法復原。操作本身會保留一筆稽核記錄。`)) return;
    setBusy(true);
    try {
      await api('/records/clear', token, { method: 'POST', body: JSON.stringify({ categories: clearSelections }) });
      if (clearLocalPrinter) {
        const db = await printerStore();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('preferences', 'readwrite');
          tx.objectStore('preferences').delete('selected-printer');
          tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
        });
        db.close(); setSavedPrinter(null); setPrinter(null);
      }
      setEvents([]); setJobs([]); setLogins([]); setAudits([]);
      setClearSelections([]); setMessage('所選記錄已清除。稽核頁會保留本次清除操作的紀錄。');
    } catch (err) { setMessage(err instanceof Error ? err.message : '清除失敗'); }
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

  const tabs = useMemo(() => {
    const base: [string,string][] = [['printer', '藍牙打印'], ['notifications', '通知' + (notifications.some(n => !n.isRead) ? ' •' : '')], ['events', '事件管理'], ['manual-event', '手動新增事件'], ['jobs', '工作排程']];
    if (user?.role === 'admin') base.push(['logins', '登入記錄'], ['audit', '操作稽核'], ['clear-records', '清除持久化記錄'], ['admin', '管理後台']);
    return base;
  }, [user?.role, notifications]);
  if (!user) return <main className="auth-shell"><section className="panel auth-panel"><div className="brand">ESC <span>PRINTING</span></div><h1>PWA ESC Printing</h1><p className="muted">以 Passkey 安全登入，管理打印機、事件及記錄。</p><label>使用者名稱<input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" placeholder="例如：operator01" /></label><label>顯示名稱（首次註冊）<input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="操作人員" /></label><div className="actions"><button disabled={busy || !username} onClick={login}>{busy ? '處理中…' : 'Passkey 登入'}</button><button className="secondary" disabled={busy || !username} onClick={register}>註冊 Passkey</button></div><p className="hint">首次使用請先註冊 Passkey。生產環境請關閉公開註冊並改用邀請或管理員建立帳戶。</p>{message && <p className="notice">{message}</p>}</section></main>;

  return <div className="app-shell"><header className="topbar"><div><div className="brand">ESC <span>PRINTING</span></div><small>收據打印 · 事件 · 稽核</small></div><div className="account"><span>{user.displayName || user.username}</span><button className="secondary compact" onClick={logout}>登出</button></div></header>
    <nav className="tabs">{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'tab active' : 'tab'} onClick={() => { setTab(key); setMessage(''); }}>{label}</button>)}</nav>
    <main className="content">
      {message && <div className="notice" role="status">{message}<button className="notice-close" onClick={() => setMessage('')}>×</button></div>}
      {tab === 'printer' && <section className="grid two"><article className="panel"><h2>藍牙熱敏打印機</h2><p className="muted">使用支援 Web Bluetooth 的 Chromium 瀏覽器；需要 HTTPS 或 localhost。</p><div className="printer-card"><div className="printer-icon">▤</div><div><strong>{printer?.name || savedPrinter?.device_name || '尚未選取打印機'}</strong><p className="muted">{printer?.characteristic ? '已連接 · 可寫入' : printer ? '已選取 · 尚未連接' : savedPrinter?.device_name ? '已保存偏好；請重新選取裝置以取得瀏覽器授權' : '尚未連接'}</p></div></div><div className="actions"><button disabled={busy} onClick={scanPrinter}>掃描 / 選取</button><button disabled={busy || !printer} className="secondary" onClick={connectPrinter}>連接</button></div><p className="hint">瀏覽器安全限制：裝置 ID/名稱可保存，但網頁不能在下次造訪時靜默重新取得裝置權限；通常需再次由使用者選取。部分打印機使用廠商專用 BLE 協定。</p></article><article className="panel"><h2>8 cm 測試付款收據</h2><div className="receipt-preview"><div className="receipt-title">測試付款收據</div><hr/><p>店名：示範商店</p><p>測試商品　× 1　$80.00</p><hr/><strong>總計　　$80.00</strong><p>付款方式：現金</p><p className="receipt-footer">非真實交易 · 感謝惠顧</p></div><label>ESC/POS 字碼表索引（依打印機手冊）<input type="number" min="0" max="255" value={codePageIndex} onChange={e => setCodePageIndex(e.target.value)} /></label><p className="hint">文字以 Big5 編碼；此索引會送入 ESC t n 指令。不同打印機的 Big5 code page 編號不同，請先依手冊設定並列印測試。</p><button className="full" disabled={busy || !printer?.characteristic} onClick={printTest}>{busy ? '處理中…' : '打印測試收據'}</button></article><article className="panel"><h2>推播通知</h2><p className="muted">訂閱本機瀏覽器通知，方便接收應用程式通知。</p><button onClick={subscribePush}>啟用推播並測試</button></article></section>}
      {tab === 'notifications' && <section className="panel"><div className="admin-heading"><div><h2>通知</h2><p className="muted">通知保存在伺服器 SQLite，每 3 秒自動更新；重新整理或重新登入後仍可查看。</p></div><span className="count">{notifications.filter(n => !n.isRead).length} 則未讀</span></div>{notifications.length === 0 ? <p className="muted">目前沒有通知。</p> : notifications.map(n => <article className="list-item" key={n.id}><div className="list-heading"><strong>{n.title}</strong><small>{n.createdAt}</small></div><p>{n.body}</p><div className="actions"><span className="muted">{n.targetClientId ? '指定給此客戶端' : '全體廣播'}</span>{n.isRead ? <span className="status">已讀</span> : <button className="secondary compact" onClick={() => void markNotificationRead(n.id)}>標記已讀</button>}</div></article>)}</section>}
      {tab === 'events' && <section className="grid two"><article className="panel"><h2>建立事件</h2><form onSubmit={saveEvent}><label>標題<input required value={eventTitle} onChange={e => setEventTitle(e.target.value)} /></label><label>內容<textarea rows={5} value={eventContent} onChange={e => setEventContent(e.target.value)} /></label><label>事件日期<input type="datetime-local" value={eventDate} onChange={e => setEventDate(e.target.value)} /></label><label>圖片 / 影片（可多選）<input type="file" accept="image/*,video/*" multiple onChange={e => setMedia(e.target.files)} /></label><p className="hint">每個檔案上限 100 MB；檔案存於伺服器 uploads 目錄，metadata 存於 SQLite。</p><button disabled={busy}>保存事件</button></form></article><article className="panel"><h2>歷史事件 <span className="count">{events.length}</span></h2>{events.length === 0 ? <p className="muted">尚無事件記錄。</p> : events.map(ev => <div className="list-item" key={ev.id}><div className="list-heading"><strong>{ev.title}</strong><small>{ev.event_date || ev.created_at}</small></div><p>{ev.content}</p><div className="media-list">{ev.media?.map(m => m.kind === 'image' ? <a key={m.id} href={m.url} target="_blank" rel="noreferrer"><img src={m.url} alt={m.original_name}/></a> : <video key={m.id} src={m.url} controls />)}</div><button className="danger compact" onClick={async () => { if (confirm('確定刪除此事件及其媒體記錄？')) { await api('/events/' + ev.id, token, { method: 'DELETE' }); setEvents(await api('/events', token)); } }}>刪除</button></div>)}</article></section>}
      {tab === 'manual-event' && <section className="grid two"><article className="panel"><h2>手動建立事件記錄</h2><p className="muted">此頁專供操作人員即時建立事件；文字與多張圖片／多段影片會寫入伺服器 SQLite 及 uploads 持久化目錄。</p><form onSubmit={saveQuickEvent}><label>事件標題<input required maxLength={200} value={quickTitle} onChange={e => setQuickTitle(e.target.value)} placeholder="例如：設備檢查、付款異常、客戶跟進" /></label><label>事件內容<textarea rows={6} value={quickContent} onChange={e => setQuickContent(e.target.value)} placeholder="記錄事件經過、處理方式及備註" /></label><label>事件日期與時間<input type="datetime-local" value={quickDate} onChange={e => setQuickDate(e.target.value)} /></label><label>附件圖片／影片<input type="file" accept="image/*,video/*" multiple onChange={e => setQuickMedia(e.target.files)} /></label><p className="hint">最多 20 個附件，每個檔案上限 100 MB。允許圖片與影片；保存後可在「事件管理」查看。</p><button disabled={busy || !quickTitle.trim()}>{busy ? '保存中…' : '建立並保存事件記錄'}</button></form></article><article className="panel"><h2>保存說明</h2><ul><li>事件內容及建立時間保存於 SQLite。</li><li>圖片及影片檔案保存於伺服器 uploads 目錄。</li><li>建立操作會寫入操作稽核記錄。</li><li>完成後可前往「事件管理」查看歷史事件及附件。</li></ul></article></section>}
      {tab === 'clear-records' && <section className="grid two"><article className="panel"><h2>清除持久化記錄</h2><p className="muted">勾選需要刪除的資料類別。這是永久刪除操作，請先確認備份。</p>{[['events','事件及其圖片／影片附件'],['jobs','每日及手動工作記錄'],['logins','登入／登出歷史記錄'],['printer_preferences','伺服器保存的打印機偏好'],['push_subscriptions','推播訂閱資料']] .map(([key,label]) => <label className="check-row" key={key}><input type="checkbox" checked={clearSelections.includes(key)} onChange={e => setClearSelections(old => e.target.checked ? [...old,key] : old.filter(x => x !== key))} />{label}</label>)}<label className="check-row"><input type="checkbox" checked={clearLocalPrinter} onChange={e => setClearLocalPrinter(e.target.checked)} />本機瀏覽器 IndexedDB 打印機偏好</label><div className="warning-note">為保留可追溯性，操作稽核記錄不會被此頁清除；系統會追加一筆「清除記錄」操作。使用者帳戶、Passkey 與目前登入工作階段不會被刪除。</div><button className="danger" disabled={busy || (!clearSelections.length && !clearLocalPrinter)} onClick={clearPersistentRecords}>{busy ? '清除中…' : '永久清除所選記錄'}</button></article><article className="panel"><h2>資料保存位置</h2><p>伺服器資料庫：<code>./data/app.sqlite</code></p><p>事件媒體檔案：<code>./uploads/</code></p><p>本機打印機偏好：瀏覽器 IndexedDB（資料庫 <code>esc-printing-local</code>）。</p><p className="hint">清除事件會同時刪除事件資料、附件資料庫索引及對應媒體檔案。清除伺服器資料只影響此應用程式資料，不會清除瀏覽器的網站權限或作業系統藍牙配對。</p></article></section>}
      {tab === 'jobs' && <section className="grid two"><article className="panel"><h2>建立工作記錄</h2><form onSubmit={saveJob}><label>標題<input required value={jobTitle} onChange={e => setJobTitle(e.target.value)} /></label><label>內容<textarea rows={4} value={jobDetail} onChange={e => setJobDetail(e.target.value)} /></label><button disabled={busy}>新增工作</button></form><p className="hint">系統每日 00:00（Asia/Singapore 預設）建立一筆自動工作記錄。伺服器必須持續運行才能觸發排程；啟動時亦會補上當日缺失記錄。</p></article><article className="panel"><h2>工作歷史 <span className="count">{jobs.length}</span></h2><div className="table-wrap"><table><thead><tr><th>日期</th><th>工作</th><th>狀態</th><th>內容</th></tr></thead><tbody>{jobs.map(j => <tr key={j.id}><td>{j.job_date}</td><td>{j.title}</td><td><span className="status">{j.status}</span></td><td>{j.detail}</td></tr>)}</tbody></table></div></article></section>}
      {tab === 'logins' && <section className="panel"><h2>登入人員及歷史記錄</h2><div className="table-wrap"><table><thead><tr><th>時間</th><th>使用者</th><th>事件</th><th>結果</th><th>說明</th></tr></thead><tbody>{logins.map(l => <tr key={l.id}><td>{l.created_at}</td><td>{l.username}</td><td>{l.event}</td><td>{l.success ? '成功' : '失敗'}</td><td>{l.detail}</td></tr>)}</tbody></table></div></section>}

      {tab === 'admin' && user.role === 'admin' && <section className="admin-layout">
        <div className="admin-heading"><div><h2>即時客戶端管理</h2><p className="muted">客戶端每 3 秒回報一次；後台每 3 秒刷新。最後更新：{adminDashboard?.serverTime || '讀取中…'}</p></div><button className="secondary" disabled={busy} onClick={() => refreshAdmin().catch(e => setMessage(e.message))}>立即刷新</button></div>
        <div className="admin-stats"><article className="stat-card"><span>已註冊用戶</span><strong>{adminDashboard?.users.length ?? '—'}</strong></article><article className="stat-card"><span>在線客戶端</span><strong>{adminDashboard?.clients.filter(c => c.online).length ?? '—'}</strong></article><article className="stat-card"><span>已連接打印機</span><strong>{adminDashboard?.clients.filter(c => c.online && c.printerConnected).length ?? '—'}</strong></article><article className="stat-card"><span>工作記錄</span><strong>{adminDashboard?.jobs.length ?? '—'}</strong></article></div>
        <article className="panel"><h2>客戶端即時狀態</h2><p className="hint">「強制登出」會撤銷該客戶端的伺服器工作階段；客戶端最遲在下一次 3 秒心跳時發現並清除本機登入狀態。</p><div className="table-wrap"><table><thead><tr><th>用戶／狀態</th><th>打印機</th><th>Bluetooth</th><th>最近回報</th><th>瀏覽器</th><th>操作</th></tr></thead><tbody>{(adminDashboard?.clients || []).map(c => <tr key={c.clientId}><td><strong>{c.username}</strong><div className={c.online ? 'live-pill online' : 'live-pill'}>{c.online ? '在線' : '離線'}</div><small>{c.clientId.slice(0,8)}…</small></td><td>{c.printerName || '未選取'}<div className={c.printerConnected ? 'live-pill online' : 'live-pill'}>{c.printerConnected ? '打印機已連接' : '打印機未連接'}</div></td><td>{c.bluetoothSupported ? '瀏覽器支援' : '不支援'}<div>{c.bluetoothConnected ? 'GATT 已連接' : 'GATT 未連接'}</div></td><td>{c.lastSeen}</td><td><small>{c.userAgent || '—'}</small></td><td><button className="danger compact" disabled={busy || !c.online} onClick={() => { if (window.confirm('確定強制登出此客戶端？')) void adminAction('/admin/clients/'+encodeURIComponent(c.clientId)+'/logout',{method:'POST'},'已發出強制登出指令'); }}>強制登出</button></td></tr>)}</tbody></table>{!adminDashboard?.clients.length && <p className="muted">尚未收到客戶端心跳。登入中的客戶端會自動出現在此處。</p>}</div></article>
        <article className="panel"><h2>已註冊用戶管理</h2><div className="table-wrap"><table><thead><tr><th>用戶</th><th>角色</th><th>Passkey</th><th>活動工作階段</th><th>最後登入</th><th>註冊時間</th><th>管理</th></tr></thead><tbody>{(adminDashboard?.users || []).map(a => <tr key={a.id}><td><strong>{a.displayName || a.username}</strong><div>{a.username}</div></td><td><select value={a.role} disabled={busy || a.id === user.id} onChange={e => void adminAction('/admin/users/'+a.id+'/role',{method:'POST',body:JSON.stringify({role:e.target.value})},'用戶角色已更新')}><option value="user">一般用戶</option><option value="admin">管理員</option></select></td><td>{a.passkeyCount}</td><td>{a.activeSessions}</td><td>{a.lastLogin || '—'}</td><td>{a.createdAt}</td><td><button className="danger compact" disabled={busy || a.id === user.id} onClick={() => { if(window.confirm('確定刪除此用戶？Passkey、登入工作階段、推播訂閱及其客戶端狀態會一併刪除。')) void adminAction('/admin/users/'+a.id,{method:'DELETE'},'用戶已刪除'); }}>刪除用戶</button></td></tr>)}</tbody></table></div></article>
        <div className="grid two"><article className="panel"><h2>後台新增操作記錄</h2><form onSubmit={createAdminOperation}><label>標題<input required value={adminOpTitle} onChange={e=>setAdminOpTitle(e.target.value)} /></label><label>內容<textarea rows={3} value={adminOpContent} onChange={e=>setAdminOpContent(e.target.value)} /></label><button disabled={busy || !adminOpTitle.trim()}>新增操作記錄</button></form></article><article className="panel"><h2>後台新增工作記錄</h2><form onSubmit={createAdminWork}><label>工作標題<input required value={adminWorkTitle} onChange={e=>setAdminWorkTitle(e.target.value)} /></label><label>日期<input type="date" required value={adminWorkDate} onChange={e=>setAdminWorkDate(e.target.value)} /></label><label>工作內容<textarea rows={3} value={adminWorkDetail} onChange={e=>setAdminWorkDetail(e.target.value)} /></label><button disabled={busy || !adminWorkTitle.trim()}>新增工作記錄</button></form></article></div>
        <article className="panel"><h2>操作記錄管理</h2><div className="table-wrap"><table><thead><tr><th>時間</th><th>人員</th><th>操作</th><th>類型</th><th>內容</th><th>管理</th></tr></thead><tbody>{(adminDashboard?.operations || []).map(op => <tr key={op.id}><td>{op.created_at}</td><td>{op.username || 'system'}</td><td>{op.action}</td><td>{op.entity_type || '—'}</td><td>{(() => { try { const d=JSON.parse(op.detail || 'null'); return d?.title ? d.title+(d.content ? '：'+d.content : '') : (op.detail || op.entity_id || '—'); } catch { return op.detail || op.entity_id || '—'; } })()}</td><td><button className="danger compact" disabled={busy} onClick={() => { if(window.confirm('確定刪除此操作記錄？系統會保留一筆刪除稽核記錄。')) void adminAction('/admin/operations/'+op.id,{method:'DELETE'},'操作記錄已刪除'); }}>刪除</button></td></tr>)}</tbody></table></div></article>
        <article className="panel"><h2>工作記錄管理</h2><div className="table-wrap"><table><thead><tr><th>日期</th><th>標題</th><th>狀態</th><th>內容</th><th>建立時間</th><th>管理</th></tr></thead><tbody>{(adminDashboard?.jobs || []).map(j => <tr key={j.id}><td>{j.job_date}</td><td>{j.title}</td><td>{j.status}</td><td>{j.detail}</td><td>{j.created_at}</td><td><button className="danger compact" disabled={busy} onClick={() => { if(window.confirm('確定刪除此工作記錄？')) void adminAction('/admin/jobs/'+encodeURIComponent(j.id),{method:'DELETE'},'工作記錄已刪除'); }}>刪除</button></td></tr>)}</tbody></table></div></article>
      </section>}
      {tab === 'audit' && <section className="panel"><h2>操作稽核歷史</h2><div className="table-wrap"><table><thead><tr><th>時間</th><th>人員</th><th>操作</th><th>類型</th><th>對象 ID</th><th>內容</th></tr></thead><tbody>{audits.map(a => <tr key={a.id}><td>{a.created_at}</td><td>{a.username || 'system'}</td><td>{a.action}</td><td>{a.entity_type}</td><td>{a.entity_id}</td><td>{a.detail}</td></tr>)}</tbody></table></div></section>}
    </main><footer>本機持久化 · SQLite · WebAuthn · BLE ESC/POS</footer></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
