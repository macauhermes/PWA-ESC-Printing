import React, { useEffect, useMemo, useState } from 'react';
import packageJson from '../package.json';
import { createRoot } from 'react-dom/client';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import './style.css';

const APP_VERSION = packageJson.version;
const BUILD_ENVIRONMENT = import.meta.env.VITE_APP_ENV || (import.meta.env.PROD ? 'production' : 'test');
const environmentLabel = (value: string) => value === 'production' ? '正式環境' : '測試環境';
type User = { id: string; username: string; displayName: string; role: string };
type EventItem = { id: string; title: string; content: string; event_date?: string; created_at: string; media: { id: string; kind: string; original_name: string; url: string }[] };
type Job = { id: string; job_date: string; title: string; status: string; detail: string; created_at: string };
type Printer = { id: string; name: string; device: BluetoothDevice; characteristic?: BluetoothRemoteGATTCharacteristic };
type AdminClient = { clientId:string; userId:string; username:string; online:number; bluetoothSupported:number; bluetoothConnected:number; printerConnected:number; printerName?:string; printerId?:string; pushSubscribed?:number; userAgent?:string; lastSeen:string };
type AdminUser = { id:string; username:string; displayName:string; role:string; createdAt:string; passkeyCount:number; activeSessions:number; lastLogin?:string };
type AdminOperation = { id:number; username?:string; action:string; entity_type?:string; entity_id?:string; detail?:string; created_at:string };
type WorkMedia = { id?:string; kind:string; originalName:string; mimeType:string; url?:string; name?:string; size?:number; blob?:Blob };
type DeviceWork = { id:string; clientId:string; userId:string; username:string; title:string; content:string; eventDate?:string|null; createdAt:string; printerName?:string|null; eventCode?:string|null; media?:WorkMedia[] };
type LocalDraft = { id:string; title:string; content:string; eventDate:string; createdAt:string; eventCode:string; syncStatus?:'draft'|'queued'|'uploading'|'failed'; media:WorkMedia[] };
type MediaViewer = { src:string; kind:'image'|'video'; name:string; revokeOnClose:boolean; recordCreatedAt?:string };
type UploadProgress = { loaded:number; total:number; percent:number|null; bytesPerSecond:number };
type LocalStorageInfo = { quotaBytes:number; usageBytes:number; measured:boolean };
const DEFAULT_STORAGE_LIMIT_BYTES = 5 * 1024 ** 3;
type AdminDashboard = { users:AdminUser[]; clients:AdminClient[]; operations:AdminOperation[]; jobs:Job[]; deviceWork:DeviceWork[]; serverTime:string };
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
function uploadFormDataWithProgress(path: string, token: string, data: FormData, onProgress: (progress: UploadProgress) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastLoaded = 0;
    let lastAt = Date.now();
    let lastSpeed = 0;
    xhr.open('POST', '/api' + path);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = event => {
      const now = Date.now();
      const elapsed = (now - lastAt) / 1000;
      if (elapsed >= 0.5) {
        lastSpeed = Math.max(0, event.loaded - lastLoaded) / elapsed;
        lastLoaded = event.loaded;
        lastAt = now;
      }
      const snapshot = { loaded: event.loaded, total: event.lengthComputable ? event.total : 0, percent: event.lengthComputable && event.total > 0 ? Math.min(100, Math.round(event.loaded / event.total * 100)) : null, bytesPerSecond: lastSpeed };
      window.requestAnimationFrame(() => onProgress(snapshot));
    };
    xhr.onerror = () => reject(new Error('網絡連線中斷，請檢查網絡後重試。'));
    xhr.onabort = () => reject(new Error('上傳已取消。'));
    xhr.onload = () => {
      let body: any = {};
      try { body = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status < 200 || xhr.status >= 300) reject(new Error(body.error || `HTTP ${xhr.status}`));
      else resolve(body);
    };
    xhr.send(data);
  });
}
const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
const formatSpeed = (bytesPerSecond: number) => `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`;
const b64url = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
const b64 = (s: string) => Uint8Array.from(atob(b64url(s)), c => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
const id = () => crypto.randomUUID();
type SavedPrinter = { id: string; name: string; savedAt: string };
function printerStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('esc-printing-local', 2);
    request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('preferences')) db.createObjectStore('preferences', { keyPath: 'id' }); if (!db.objectStoreNames.contains('workDrafts')) db.createObjectStore('workDrafts', { keyPath: 'id' }); };
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
async function nextLocalEventSequence(): Promise<number> {
  const db = await printerStore();
  const value = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction('preferences', 'readwrite');
    const store = tx.objectStore('preferences');
    const request = store.get('event-sequence');
    let next = 1;
    request.onsuccess = () => { next = Number(request.result?.value || 0) + 1; store.put({ id:'event-sequence', value:next }); };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(next);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return value;
}
function makeEventCode(sequence: number, deviceCode: string, date = new Date()) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  return `${String(sequence).padStart(4, '0')}-${deviceCode}-${day}${month}${year}`;
}
const DAY_MS = 24 * 60 * 60 * 1000;
function timestampMs(value: string | undefined) {
  if (!value) return 0;
  const normalized = value.includes('T') || /Z$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z';
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}
function remainingMs(createdAt: string, now: number) { return Math.max(0, DAY_MS - (now - timestampMs(createdAt))); }
function countdownLabel(createdAt: string, now: number) {
  const ms = remainingMs(createdAt, now);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms % 3600000 / 60000);
  const seconds = Math.floor(ms % 60000 / 1000);
  return { label: ms <= 0 ? '已到期' : `剩餘 ${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`, percent: Math.max(0, ms / DAY_MS * 100), expired: ms <= 0 };
}
function mediaBytes(drafts: LocalDraft[]) {
  return drafts.reduce((total, draft) => total + draft.media.reduce((sum, item) => sum + Number(item.blob?.size ?? item.size ?? 0), 0), 0);
}
async function assertLocalDraftCapacity(value: LocalDraft) {
  const existing = await loadLocalDrafts();
  const isNewDraft = !existing.some(item => item.id === value.id);
  const addedBytes = isNewDraft ? value.media.reduce((sum, item) => sum + Number(item.blob?.size ?? item.size ?? 0), 0) : 0;
  try {
    const storage = navigator.storage;
    if (storage?.estimate) {
      const estimate = await storage.estimate();
      const quota = Number(estimate.quota || 0);
      const usage = Number(estimate.usage || 0);
      if (quota > 0 && Number.isFinite(quota)) {
        if (usage + addedBytes > quota * 0.95) {
          throw new Error(`本機儲存空間不足：新增附件後可能超過瀏覽器配額的 95%。可用估算空間約 ${Math.max(0, quota * 0.95 - usage) / 1024 ** 3 < 0.01 ? (Math.max(0, quota * 0.95 - usage) / 1024 ** 2).toFixed(0) + ' MB' : (Math.max(0, quota * 0.95 - usage) / 1024 ** 3).toFixed(2) + ' GB'}。請先同步或刪除不需要的本機暫存附件。`);
        }
        return;
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('本機儲存空間不足')) throw error;
    // Unsupported / failed estimate: enforce a conservative 5 GiB app-level cap below.
  }
  const fallbackUsage = mediaBytes(existing) + addedBytes;
  if (fallbackUsage > DEFAULT_STORAGE_LIMIT_BYTES) {
    throw new Error('無法檢查瀏覽器實際配額；本機暫存按 5 GB 保守上限管理。新增附件會超出此上限，請先同步或刪除不需要的本機暫存附件。');
  }
}
async function saveLocalDraft(value: LocalDraft) {
  await assertLocalDraftCapacity(value);
  const db = await printerStore();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('workDrafts', 'readwrite');
    tx.objectStore('workDrafts').put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error?.name === 'QuotaExceededError' ? new Error('瀏覽器拒絕保存：本機儲存配額已滿。請先同步或刪除不需要的暫存附件。') : tx.error);
    tx.onabort = () => reject(tx.error?.name === 'QuotaExceededError' ? new Error('瀏覽器拒絕保存：本機儲存配額已滿。請先同步或刪除不需要的暫存附件。') : tx.error);
  });
  db.close();
}
async function loadLocalDrafts(): Promise<LocalDraft[]> {
  const db = await printerStore();
  const value = await new Promise<LocalDraft[]>((resolve, reject) => { const request = db.transaction('workDrafts', 'readonly').objectStore('workDrafts').getAll(); request.onsuccess = () => resolve((request.result || []).sort((a:LocalDraft,b:LocalDraft) => b.createdAt.localeCompare(a.createdAt))); request.onerror = () => reject(request.error); });
  db.close(); return value;
}
async function deleteLocalDraft(id: string) {
  const db = await printerStore();
  await new Promise<void>((resolve, reject) => { const tx = db.transaction('workDrafts', 'readwrite'); tx.objectStore('workDrafts').delete(id); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
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
  const [adminMode, setAdminMode] = useState(false);
  const [adminUsernameInput, setAdminUsernameInput] = useState('');
  const [adminPasswordInput, setAdminPasswordInput] = useState('');
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 801px)').matches);
  const [tab, setTab] = useState('print');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [printer, setPrinter] = useState<Printer | null>(null);
  const [savedPrinter, setSavedPrinter] = useState<any>(null);
  const [codePageIndex, setCodePageIndex] = useState('0');
  const [printNote, setPrintNote] = useState('');
  const [events, setEvents] = useState<EventItem[]>([]);
  const [localDrafts, setLocalDrafts] = useState<LocalDraft[]>([]);
  const [localStorageInfo, setLocalStorageInfo] = useState<LocalStorageInfo>({ quotaBytes: DEFAULT_STORAGE_LIMIT_BYTES, usageBytes: 0, measured: false });
  const [workMedia, setWorkMedia] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [deviceCode, setDeviceCode] = useState(() => localStorage.getItem('esc-device-code') || '');
  const [remoteOnline, setRemoteOnline] = useState(false);
  const [serverVersion, setServerVersion] = useState('');
  const [serverEnvironment, setServerEnvironment] = useState('');
  const [updateRequired, setUpdateRequired] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [uploadedWork, setUploadedWork] = useState<DeviceWork[]>([]);
  const [mediaViewer, setMediaViewer] = useState<MediaViewer | null>(null);
  const [workTitle, setWorkTitle] = useState('');
  const [workContent, setWorkContent] = useState('');
  const [workDate, setWorkDate] = useState(() => new Date().toISOString().slice(0,16));
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
  function openMediaViewer(media: WorkMedia, recordCreatedAt?: string) {
    if (recordCreatedAt && remainingMs(recordCreatedAt, Date.now()) <= 0) { setMessage('此事件已超過 24 小時，無法再查看附件。'); return; }
    const src = media.url || (media.blob ? URL.createObjectURL(media.blob) : '');
    if (!src) { setMessage('無法預覽此附件：找不到檔案內容或網址。'); return; }
    setMediaViewer({ src, kind: media.kind === 'video' || media.mimeType?.startsWith('video/') ? 'video' : 'image', name: media.originalName || media.name || '附件', revokeOnClose: !media.url && Boolean(media.blob), recordCreatedAt });
  }
  function closeMediaViewer() {
    if (mediaViewer?.revokeOnClose) URL.revokeObjectURL(mediaViewer.src);
    setMediaViewer(null);
  }
  useEffect(() => {
    if (mediaViewer?.recordCreatedAt && remainingMs(mediaViewer.recordCreatedAt, clockNow) <= 0) closeMediaViewer();
  }, [mediaViewer, clockNow]);
  useEffect(() => {
    if (!mediaViewer) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMediaViewer(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mediaViewer]);

  useEffect(() => { if (token) api('/me', token).then((x) => { setUser(x.user); if (x.user.role === 'admin') setTab('users'); }).catch(() => { localStorage.removeItem('esc-token'); setToken(''); setUser(null); setTab('print'); }); }, [token]);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 801px)');
    const update = () => { setIsDesktop(query.matches); if (!query.matches) setAdminMode(false); };
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (!response.ok) throw new Error('API unavailable');
        const versionResponse = await fetch('/api/version', { cache: 'no-store' });
        if (!versionResponse.ok) throw new Error('Version endpoint unavailable');
        const versionInfo: { version: string; environment: string } = await versionResponse.json();
        if (active) {
          setRemoteOnline(true);
          setServerVersion(versionInfo.version);
          setServerEnvironment(versionInfo.environment);
          if (versionInfo.version !== APP_VERSION) setUpdateRequired(true);
        }
      } catch { if (active) setRemoteOnline(false); }
    };
    void check();
    const timer = window.setInterval(check, 5000);
    const onOnline = () => void check();
    const onOffline = () => setRemoteOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!token || !user) return;
    if (user.role === 'admin') { setPrinter(null); setSavedPrinter(null); return; }
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
  useEffect(() => { loadLocalDrafts().then(setLocalDrafts).catch(() => setMessage('讀取手機暫存失敗，請檢查瀏覽器儲存空間。')); }, []);
  useEffect(() => {
    let active = true;
    const refreshStorageInfo = async () => {
      const fallbackUsage = mediaBytes(localDrafts);
      try {
        const estimate = await navigator.storage?.estimate();
        if (estimate && Number(estimate.quota) > 0) {
          if (active) setLocalStorageInfo({ quotaBytes: Number(estimate.quota), usageBytes: Number(estimate.usage || 0), measured: true });
          return;
        }
      } catch { /* use conservative fallback when storage estimation is unavailable */ }
      if (active) setLocalStorageInfo({ quotaBytes: DEFAULT_STORAGE_LIMIT_BYTES, usageBytes: fallbackUsage, measured: false });
    };
    void refreshStorageInfo();
    return () => { active = false; };
  }, [localDrafts]);

  useEffect(() => {
    if (!token || !user) return;
    if (tab === 'events') {
      let active = true;
      const refresh = () => api('/work', token).then(rows => { if (active) setUploadedWork(rows); }).catch(err => { if (active) setMessage(err.message); });
      void refresh();
      const timer = window.setInterval(refresh, 3000);
      return () => { active = false; window.clearInterval(timer); };
    }
    if (tab === 'jobs') api('/jobs', token).then(setJobs).catch(err => setMessage(err.message));
    if (tab === 'logins') api('/logins', token).then(setLogins).catch(err => setMessage(err.message));
    if (tab === 'audit') api('/audit', token).then(setAudits).catch(err => setMessage(err.message));
  }, [tab, token, user]);

  useEffect(() => {
    if (!token || !user) return;
    if (user.role === 'admin') { setNotifications([]); return; }
    let active = true;
    const refreshNotifications = async () => {
      try {
        const rows = await api('/notifications', token);
        if (active) setNotifications(rows);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('401') || msg.includes('Session expired') || msg.includes('Authentication required')) {
          localStorage.removeItem('esc-token'); setToken(''); setUser(null); setTab('print');
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
        const heartbeat = await api('/client/heartbeat', token, { method: 'POST', body: JSON.stringify({
          clientId, userAgent: navigator.userAgent, bluetoothSupported: 'bluetooth' in navigator,
          bluetoothConnected: Boolean(printer?.device?.gatt?.connected),
          printerConnected: Boolean(printer?.characteristic && printer.device.gatt?.connected),
          printerName: printer?.name || savedPrinter?.device_name || '',
          printerId: printer?.id || savedPrinter?.device_id || ''
        }) });
        if (heartbeat.deviceCode) { localStorage.setItem('esc-device-code', heartbeat.deviceCode); setDeviceCode(heartbeat.deviceCode); }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('401') || msg.includes('Session expired') || msg.includes('Authentication required')) {
          localStorage.removeItem('esc-token'); setToken(''); setUser(null); setPrinter(null); setTab('print');
          setMessage('此客戶端工作階段已被管理員結束，請重新登入。');
        }
      }
    };
    void report();
    const timer = window.setInterval(report, 3000);
    return () => window.clearInterval(timer);
  }, [token, user, clientId, printer, savedPrinter]);

  useEffect(() => {
    if (!token || !user || user.role !== 'admin' || !['users', 'device-work', 'notifications'].includes(tab)) return;
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
    e.preventDefault(); setBusy(true);
    try {
      const result = await api('/admin/notifications', token, { method:'POST', body:JSON.stringify({ title: notificationTitle, body: notificationBody, targetClientId: notificationTarget }) });
      await refreshAdmin(); setMessage(result.message || '通知已發送。');
      setNotificationTitle(''); setNotificationBody('');
    } catch (err) { setMessage(err instanceof Error ? err.message : '通知發送失敗'); }
    finally { setBusy(false); }
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
      if (result.deviceCode) { localStorage.setItem('esc-device-code', result.deviceCode); setDeviceCode(result.deviceCode); }
      localStorage.setItem('esc-token', result.token); setToken(result.token); setUser(result.user); setMessage('登入成功');
    } catch (e) { setMessage(e instanceof Error ? e.message : '登入失敗'); }
    finally { setBusy(false); }
  }
  async function adminLogin() {
    setBusy(true); setMessage('');
    try {
      const result = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminUsernameInput, password: adminPasswordInput, clientId })
      }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      localStorage.setItem('esc-token', result.token);
      setToken(result.token); setUser(result.user); setTab('users'); setMessage('管理員登入成功');
      setAdminPasswordInput('');
    } catch (e) { setMessage(e instanceof Error ? e.message : '管理員登入失敗'); }
    finally { setBusy(false); }
  }
  async function register() {
    setBusy(true); setMessage('');
    try {
      const options = await fetch('/api/auth/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, displayName: displayName || username }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      const { challengeId, userId, ...publicKey } = options;
      const response = await startRegistration({ optionsJSON: publicKey });
      const result = await fetch('/api/auth/register/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, challengeId, response, clientId }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      if (result.deviceCode) { localStorage.setItem('esc-device-code', result.deviceCode); setDeviceCode(result.deviceCode); }
      setMessage(result.verified ? `Passkey 註冊成功，設備碼：${result.deviceCode || '待同步'}。現在可以登入。` : '註冊未完成');
    } catch (e) { setMessage(e instanceof Error ? e.message : '註冊失敗'); }
    finally { setBusy(false); }
  }
  async function logout() {
    try { if (token) await api('/auth/logout', token, { method: 'POST' }); } catch {}
    localStorage.removeItem('esc-token'); setToken(''); setUser(null); setPrinter(null); setTab('print'); setMessage('已登出');
  }

  async function scanPrinter() {
    if (!('bluetooth' in navigator)) { setMessage('此瀏覽器不支援 Web Bluetooth。請使用支援 BLE 的 Chromium 瀏覽器及 HTTPS/localhost。'); return; }
    try {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', '0000ae00-0000-1000-8000-00805f9b34fb'] });
      const selected: Printer = { id: device.id, name: device.name || 'BLE Thermal Printer', device };
      if (printer?.device.gatt?.connected && printer.device.id !== device.id) printer.device.gatt.disconnect();
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
      const width = (value: string) => Array.from(value).reduce((sum, char) => sum + ((char.codePointAt(0) || 0) > 0xff ? 2 : 1), 0);
      const columns = (left: string, right: string, maxWidth = 42) => { let fitted = ''; for (const char of Array.from(left)) { if (width(fitted + char) > maxWidth - width(right) - 1) break; fitted += char; } return fitted + ' '.repeat(Math.max(1, maxWidth - width(fitted) - width(right))) + right; };
      const now = new Date(); const orderNo = 'TEST-' + now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      const noteLines = (printNote.trim() || '（未填寫）').split(/\r?\n/).map(line => '備註：' + line);
      const text = [
        '                 示範商店', '                 付款收據', '==================================================', '地址：澳門示範路 88 號', '電話：+853 2888 1234',
        '單號：' + orderNo, '日期：' + now.toLocaleString('zh-TW'), '收銀員：測試帳戶', '--------------------------------------------------', columns('商品／項目', '數量／金額'),
        columns('咖啡飲品（測試） x 1', '$28.00'), columns('午餐套餐（測試） x 2', '$96.00'), columns('會員折扣', '-$6.00'), '--------------------------------------------------',
        columns('小計', '$118.00'), columns('稅項（示範）', '$0.00'), columns('應付總額', '$118.00'), columns('現金付款', '$120.00'), columns('找零', '$2.00'),
        '付款方式：現金（模擬）', '交易參考：DEMO-NOT-A-REAL-PAYMENT', '狀態：打印測試，非真實交易', '--------------------------------------------------', ...noteLines, '', '             感謝惠顧，歡迎再次光臨', '', '', ''
      ].join('\n');
      const encoded = await api('/receipt/encode', token, { method: 'POST', body: JSON.stringify({ text, codePage: 'big5', codePageIndex: Number(codePageIndex) }) });
      const payload = Uint8Array.from(atob(encoded.base64), c => c.charCodeAt(0));
      const bytes = new Uint8Array([0x1b, 0x40, 0x1b, 0x74, Number(encoded.codePageIndex ?? 0x00), ...payload, 0x1d, 0x56, 0x41, 0x10]);
      const chunkSize = 180; for (let i = 0; i < bytes.length; i += chunkSize) { const chunk = bytes.slice(i, i + chunkSize); if (printer.characteristic.properties.writeWithoutResponse && printer.characteristic.writeValueWithoutResponse) await printer.characteristic.writeValueWithoutResponse(chunk); else await printer.characteristic.writeValue(chunk); }
      await api('/receipt/print-log', token, { method: 'POST', body: JSON.stringify({ printerName: printer.name, status: 'submitted', note: printNote.trim() }) });
      setMessage('已送出模擬付款測試收據；此內容不代表真實交易。若中文亂碼，請依打印機手冊調整 Big5 code page index。');
    } catch (e) { setMessage(e instanceof Error ? e.message : '打印失敗'); } finally { setBusy(false); }
  }

  async function createEventCode() {
    const code = deviceCode || localStorage.getItem('esc-device-code') || '';
    if (!code) throw new Error('此設備尚未取得後台派發的設備碼。請先在可連線時完成註冊或登入，再建立離線事件。');
    return makeEventCode(await nextLocalEventSequence(), code, new Date());
  }
  function draftFromForm(eventCode: string, syncStatus: LocalDraft['syncStatus'] = 'draft', createdAt = new Date().toISOString()): LocalDraft {
    return {
      id: crypto.randomUUID(), title: workTitle.trim(), content: workContent.trim(), eventDate: workDate,
      createdAt, eventCode, syncStatus,
      media: workMedia.map(file => ({ name:file.name, originalName:file.name, kind:file.type.startsWith('video/') ? 'video' : 'image', mimeType:file.type, size:file.size, blob:file }))
    };
  }
  function clearWorkForm() {
    setWorkTitle(''); setWorkContent(''); setWorkDate(new Date().toISOString().slice(0,16)); setWorkMedia([]);
  }
  function isConnectivityFailure(error: unknown) {
    const text = error instanceof Error ? error.message : String(error || '');
    return /網絡連線中斷|Failed to fetch|NetworkError|Load failed|HTTP 5\d\d|連線逾時/i.test(text);
  }
  async function uploadCurrentWork() {
    const title = workTitle.trim(); if (!title) { setMessage('請輸入事件標題'); return; }
    setBusy(true);
    let eventCode = '';
    const createdAt = new Date().toISOString();
    try {
      eventCode = await createEventCode();
      if (!remoteOnline) {
        const draft = draftFromForm(eventCode, 'queued', createdAt);
        await saveLocalDraft(draft); setLocalDrafts(old => [draft, ...old]); clearWorkForm();
        setMessage(`遠端未連線，事件 ${eventCode} 已加入本機上傳隊列，恢復連線後會自動重試。`);
        return;
      }
      const data = new FormData(); data.append('title', title); data.append('content', workContent.trim()); data.append('eventDate', workDate); data.append('eventCode', eventCode); data.append('createdAt', createdAt);
      workMedia.forEach(file => data.append('media', file, file.name));
      setUploadProgress({ loaded:0, total:0, percent:0, bytesPerSecond:0 });
      await uploadFormDataWithProgress('/work', token, data, setUploadProgress);
      setUploadedWork(await api('/work', token));
      clearWorkForm();
      setMessage(`事件已上傳。事件編號：${eventCode}`);
    } catch (err) {
      if (isConnectivityFailure(err) && eventCode && workTitle.trim()) {
        try {
          const draft = draftFromForm(eventCode, 'queued', createdAt);
          await saveLocalDraft(draft); setLocalDrafts(old => [draft, ...old]); clearWorkForm();
          setMessage(`遠端連線中斷，事件 ${eventCode} 已加入本機上傳隊列，稍後會自動重試。`);
        } catch { setMessage('上傳失敗，而且無法保存至本機隊列。請勿關閉頁面，檢查裝置儲存空間後重試。'); }
      } else setMessage(err instanceof Error ? err.message : '上傳事件失敗；表單內容仍保留，請重試。');
    } finally { setBusy(false); window.setTimeout(() => setUploadProgress(null), 1200); }
  }

  async function saveLocalWork(e: React.FormEvent) {
    e.preventDefault(); const title = workTitle.trim(); if (!title) { setMessage('請輸入事件標題'); return; }
    setBusy(true);
    try {
      const draft = draftFromForm(await createEventCode());
      await saveLocalDraft(draft); setLocalDrafts(old => [draft, ...old]); clearWorkForm();
      setMessage(`事件已暫存在手機。事件編號：${draft.eventCode}`);
    } catch (err) { setMessage(err instanceof Error ? err.message : '手機暫存失敗；可能是裝置儲存空間不足。請減少影片大小後再試。'); }
    finally { setBusy(false); }
  }

  async function uploadLocalWork(draft: LocalDraft) {
    if (!draft.eventCode) {
      try {
        draft = { ...draft, eventCode: await createEventCode(), syncStatus: draft.syncStatus || 'draft' };
        await saveLocalDraft(draft);
        setLocalDrafts(old => old.map(item => item.id === draft.id ? draft : item));
      } catch (err) { setMessage(err instanceof Error ? err.message : '無法為舊暫存記錄補發事件編號。'); return; }
    }
    if (remainingMs(draft.createdAt, Date.now()) <= 0) {
      await deleteLocalDraft(draft.id).catch(() => {}); setLocalDrafts(old => old.filter(item => item.id !== draft.id));
      setMessage('此事件已超過 24 小時，已從客戶端移除。'); return;
    }
    if (!remoteOnline) {
      const queued = { ...draft, syncStatus:'queued' as const };
      await saveLocalDraft(queued); setLocalDrafts(old => old.map(item => item.id === draft.id ? queued : item));
      setMessage(`遠端未連線，事件 ${draft.eventCode} 保留在本機上傳隊列。`); return;
    }
    const uploading = { ...draft, syncStatus:'uploading' as const };
    setBusy(true); setLocalDrafts(old => old.map(item => item.id === draft.id ? uploading : item));
    await saveLocalDraft(uploading).catch(() => {});
    try {
      const data = new FormData(); data.append('title', draft.title); data.append('content', draft.content); data.append('eventDate', draft.eventDate); data.append('eventCode', draft.eventCode); data.append('createdAt', draft.createdAt);
      draft.media.forEach(file => { if (file.blob) data.append('media', file.blob, file.name || file.originalName || 'attachment'); });
      setUploadProgress({ loaded:0, total:0, percent:0, bytesPerSecond:0 });
      await uploadFormDataWithProgress('/work', token, data, setUploadProgress);
      await deleteLocalDraft(draft.id); setLocalDrafts(old => old.filter(item => item.id !== draft.id));
      setUploadedWork(await api('/work', token)); setMessage(`事件 ${draft.eventCode} 及 ${draft.media.length} 個附件已上傳。`);
    } catch (err) {
      const status = isConnectivityFailure(err) ? 'queued' as const : 'failed' as const;
      const retained = { ...draft, syncStatus:status };
      await saveLocalDraft(retained).catch(() => {});
      setLocalDrafts(old => old.map(item => item.id === draft.id ? retained : item));
      setMessage(status === 'queued' ? `事件 ${draft.eventCode} 上傳中斷，已保留在隊列，稍後自動重試。` : (err instanceof Error ? err.message : '上傳失敗；本機事件仍保留，可手動重試。'));
    } finally { setBusy(false); window.setTimeout(() => setUploadProgress(null), 1200); }
  }
  async function deleteLocalWork(draftId: string) {
    if (!window.confirm('確定刪除此手機暫存事件？')) return;
    await deleteLocalDraft(draftId).catch(() => {}); setLocalDrafts(old => old.filter(item => item.id !== draftId)); setMessage('已刪除手機暫存事件。');
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
    const labels: Record<string,string> = { events: '事件及媒體檔案', jobs: '工作記錄', work: '各設備上傳工作', logins: '登入歷史', printer_preferences: '伺服器打印機偏好', push_subscriptions: '推播訂閱' };
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
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('此瀏覽器不支援 Web Push。請更新 Safari／Chrome，並確認網站使用 HTTPS。');
      if (!('Notification' in window)) throw new Error('此瀏覽器不支援通知權限。');
      const ua = navigator.userAgent;
      const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
      if (isIOS && !isStandalone) throw new Error('iPhone／iPad 必須先在 Safari 按「分享」→「加入主畫面」，再從主畫面開啟此 Web App，才能啟用推播。');
      // Request permission directly from the button gesture before any network awaits (required on iOS).
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('通知權限未授予；請在瀏覽器或系統設定中允許通知。');
      const configResponse = await fetch('/api/config');
      if (!configResponse.ok) throw new Error(`讀取推播設定失敗（HTTP ${configResponse.status}）`);
      const cfg = await configResponse.json();
      if (!cfg.vapidPublicKey) throw new Error('伺服器尚未設定 VAPID_PUBLIC_KEY。');
      const reg = await navigator.serviceWorker.ready;
      let subscription = await reg.pushManager.getSubscription();
      if (!subscription) subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(cfg.vapidPublicKey) });
      await api('/push/subscribe', token, { method: 'POST', body: JSON.stringify(subscription) });
      const result = await api('/push/test', token, { method: 'POST' });
      setMessage(`已完成 Web App 推播訂閱；測試通知送出 ${result.sent}/${result.total} 個訂閱端點。`);
    } catch (e) { setMessage(e instanceof Error ? e.message : '推播訂閱失敗'); }
  }

  useEffect(() => {
    if (!localDrafts.length) return;
    const expired = localDrafts.filter(draft => remainingMs(draft.createdAt, clockNow) <= 0);
    if (!expired.length) return;
    setLocalDrafts(current => current.filter(draft => remainingMs(draft.createdAt, clockNow) > 0));
    void Promise.all(expired.map(draft => deleteLocalDraft(draft.id).catch(() => {})));
  }, [clockNow, localDrafts]);
  useEffect(() => {
    if (!remoteOnline || !token || !user || busy) return;
    const timer = window.setInterval(() => {
      const queued = localDrafts.find(draft => draft.syncStatus === 'queued' && remainingMs(draft.createdAt, Date.now()) > 0);
      if (queued) void uploadLocalWork(queued);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [remoteOnline, token, user, busy, localDrafts]);
  const tabs = useMemo(() => {
    const base: [string,string][] = user?.role === 'admin'
      ? [['notifications', '通知'], ['users', '用戶管理'], ['device-work', '設備工作記錄'], ['logins', '登入記錄'], ['audit', '操作稽核'], ['clear-records', '清除持久化記錄']]
      : [['print', '打印'], ['notifications', '通知' + (notifications.some(n => !n.isRead) ? ' •' : '')], ['events', '事件管理']];
    return base;
  }, [user?.role, notifications]);
  const displayedVersion = serverVersion || APP_VERSION;
  const displayedEnvironment = environmentLabel(serverEnvironment || BUILD_ENVIRONMENT);
  const forceRefresh = async () => {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
    }
    if ('caches' in window) {
      const cacheNames = await window.caches.keys();
      await Promise.all(cacheNames.map(cacheName => window.caches.delete(cacheName)));
    }
    window.location.replace(`${window.location.pathname}?forceUpdate=${Date.now()}`);
  };
  if (updateRequired) return <main className="auth-shell"><section className="panel auth-panel update-required" role="alert"><div className="brand">ESC <span>PRINTING</span></div><h1>需要更新系統</h1><p>伺服器已更新至 v{serverVersion}，目前裝置仍在使用 v{APP_VERSION}。為確保功能及資料相容，請先更新再繼續使用。</p><p className="version-label">環境：{displayedEnvironment}</p><button className="full" onClick={() => void forceRefresh()}>立即強制更新並重新載入</button></section></main>;
  if (!user) return <><div className={`remote-status ${remoteOnline ? 'online' : 'offline'}`} role="status"><span className="remote-light" />{remoteOnline ? '遠端已連線' : '遠端未連線'} </div><main className="auth-shell"><section className="panel auth-panel"><div className="brand">ESC <span>PRINTING</span></div><small className="version-label">v{displayedVersion} · {displayedEnvironment}</small><h1>PWA ESC Printing</h1>
    {isDesktop && <div className="actions"><button className={adminMode ? 'secondary' : ''} onClick={() => { setAdminMode(false); setMessage(''); }}>一般用戶</button><button className={adminMode ? '' : 'secondary'} onClick={() => { setAdminMode(true); setMessage(''); }}>管理員登入</button></div>}
    {adminMode && isDesktop ? <><p className="muted">管理員請使用伺服器 .env 設定的固定帳號及密碼登入。</p><label>管理員帳號<input value={adminUsernameInput} onChange={e => setAdminUsernameInput(e.target.value)} autoComplete="username" /></label><label>管理員密碼<input type="password" value={adminPasswordInput} onChange={e => setAdminPasswordInput(e.target.value)} autoComplete="current-password" onKeyDown={e => { if (e.key === 'Enter' && adminUsernameInput && adminPasswordInput && !busy) void adminLogin(); }} /></label><button className="full" disabled={busy || !adminUsernameInput || !adminPasswordInput} onClick={() => void adminLogin()}>{busy ? '登入中…' : '管理員登入'}</button></> : <><p className="muted">一般用戶使用 Passkey 安全登入。任何人均可自行註冊，不需要管理員批准。</p><label>使用者名稱<input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" placeholder="例如：operator01" /></label><label>顯示名稱（首次註冊）<input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="操作人員" /></label><div className="actions"><button disabled={busy || !username} onClick={login}>{busy ? '處理中…' : 'Passkey 登入'}</button><button className="secondary" disabled={busy || !username} onClick={register}>註冊 Passkey</button></div><p className="hint">首次使用請先註冊 Passkey。管理員帳號僅能透過桌面版的固定帳密登入。</p></>}
    {message && <p className="notice">{message}</p>}</section></main></>;

  return <div className="app-shell"><header className="topbar"><div className="mobile-brand-block"><div className="brand">ESC <span>PRINTING</span></div><span className={`remote-status inline header-remote-status ${remoteOnline ? 'online' : 'offline'}`} role="status" aria-label={remoteOnline ? '遠端已連線' : '遠端未連線'} title={remoteOnline ? '遠端已連線' : '遠端未連線'}><span className="remote-light" /></span><small className="mobile-header-meta"><span>v{displayedVersion}</span><span>{displayedEnvironment}</span>{user.role !== 'admin' && <span>設備碼 {deviceCode || '同步中'}</span>}</small></div><div className="account"><span>{user.displayName || user.username}</span>{user.role !== 'admin' && <span className="device-code">設備碼 {deviceCode || '同步中'}</span>}<button className="secondary compact" onClick={logout}>登出</button><span className={`remote-status inline account-remote-status ${remoteOnline ? 'online' : 'offline'}`} role="status"><span className="remote-light" />{remoteOnline ? '遠端連線' : '遠端離線'}</span></div></header>
    {uploadProgress && <div className="upload-progress global-upload-progress" role="status" aria-live="polite"><div className="upload-progress-heading"><strong>附件上傳中</strong><span>{uploadProgress.percent === null ? `${formatBytes(uploadProgress.loaded)} 已傳送` : `${uploadProgress.percent}%`}</span></div><progress max={100} value={uploadProgress.percent ?? 0} /><div className="upload-progress-details"><span>{formatBytes(uploadProgress.loaded)}{uploadProgress.total ? ` / ${formatBytes(uploadProgress.total)}` : ' 已傳送'}</span><span>目前速度約 {uploadProgress.bytesPerSecond > 0 ? formatSpeed(uploadProgress.bytesPerSecond) : '計算中…'}</span></div></div>}<nav className="tabs">{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'tab active' : 'tab'} onClick={() => { setTab(key); setMessage(''); }}>{label}</button>)}</nav>
    <main className="content">
      {message && <div className="notice" role="status">{message}<button className="notice-close" onClick={() => setMessage('')}>×</button></div>}
            {tab === 'print' && user.role !== 'admin' && <section className="grid two">
        <article className="panel"><h2>打印</h2><p className="muted">可重複按「選取打印機」重新開啟裝置選擇器，切換到其他支援 BLE GATT 的打印機。需要 HTTPS；iPhone／iPad 的 Safari 不支援 Web Bluetooth。</p>
          <div className="printer-card"><div className="printer-icon">▤</div><div><strong>{printer?.name || savedPrinter?.device_name || '尚未選取打印機'}</strong><p className="muted">{printer?.characteristic ? '已連接 · 可打印' : printer ? '已選取 · 尚未連接' : '請選取打印機'}</p></div></div>
          <div className="actions"><button disabled={busy} onClick={() => void scanPrinter()}>選取打印機</button><button className="secondary" disabled={busy || !printer} onClick={() => void connectPrinter()}>{printer?.characteristic ? '重新連接' : '連接打印機'}</button></div>
          <label>測試收據備註（會打印在收據上，最多 500 字）<textarea rows={3} maxLength={500} value={printNote} onChange={e => setPrintNote(e.target.value)} placeholder="例如：櫃檯 A／紙卷更換後測試／設備編號 PR-01" /></label>
          <label>ESC/POS 字碼表索引（依打印機手冊）<input type="number" min="0" max="255" value={codePageIndex} onChange={e => setCodePageIndex(e.target.value)} /></label>
          <p className="hint">測試收據使用模擬商品與付款金額，不代表真實交易。文字以 Big5 編碼；不同打印機的 Big5 code page 編號可能不同。</p>
          <div className="actions"><button disabled={busy || !printer?.characteristic} onClick={() => void printTest()}>{busy ? '打印中…' : '打印測試'}</button></div></article>
        <article className="panel"><h2>測試付款收據預覽</h2><div className="receipt-preview">
          <div className="receipt-title">示範商店 · 付款收據</div><p>地址：澳門示範路 88 號</p><p>電話：+853 2888 1234</p><hr/>
          <p>單號：TEST-20261011-001</p><p>日期：{new Date().toLocaleString('zh-TW')}</p><p>收銀員：測試帳戶</p><hr/>
          <div className="receipt-columns"><span>商品／項目</span><span>數量／金額</span></div><div className="receipt-columns"><span>咖啡飲品（測試）× 1</span><span>$28.00</span></div>
          <div className="receipt-columns"><span>午餐套餐（測試）× 2</span><span>$96.00</span></div><div className="receipt-columns"><span>會員折扣</span><span>-$6.00</span></div><hr/>
          <div className="receipt-columns"><span>小計</span><span>$118.00</span></div><div className="receipt-columns"><span>稅項（示範）</span><span>$0.00</span></div>
          <div className="receipt-columns total"><span>應付總額</span><span>$118.00</span></div><div className="receipt-columns"><span>現金付款</span><span>$120.00</span></div><div className="receipt-columns"><span>找零</span><span>$2.00</span></div>
          <p>付款方式：現金（模擬）</p><p>交易參考：DEMO-NOT-A-REAL-PAYMENT</p><p>狀態：打印測試，非真實交易</p><hr/>
          <p>備註：{printNote.trim() || '（未填寫）'}</p><p className="receipt-footer">感謝惠顧，歡迎再次光臨</p></div></article>
      </section>}
      {tab === 'notifications' && user.role === 'admin' && <section className="panel"><h2>發送通知</h2><p className="muted">通知集中於此頁管理。通知會保存到客戶端站內通知中心；如已設定 VAPID，亦會向指定已訂閱設備或所有已訂閱設備發送 Web Push。管理員不顯示自己的通知收件匣。</p><form onSubmit={sendAdminNotification}><label>接收對象<select value={notificationTarget} onChange={e=>setNotificationTarget(e.target.value)}><option value="">廣播所有已訂閱設備</option>{(adminDashboard?.clients || []).filter(c => Number(c.pushSubscribed || 0) > 0).map(c=><option key={c.clientId} value={c.clientId}>{c.username} · {c.clientId.slice(0,8)}… {c.online ? '（在線）' : '（離線）'} · 已訂閱推播</option>)}</select></label><label>通知標題<input required maxLength={200} value={notificationTitle} onChange={e=>setNotificationTitle(e.target.value)} placeholder="例如：系統維護通知" /></label><label>通知內容<textarea required maxLength={5000} rows={4} value={notificationBody} onChange={e=>setNotificationBody(e.target.value)} placeholder="輸入要通知客戶端的訊息" /></label><button disabled={busy || !notificationTitle.trim() || !notificationBody.trim()}>{notificationTarget ? '推播指定設備' : '廣播所有已訂閱設備'}</button></form></section>}
            {tab === 'notifications' && user.role !== 'admin' && <section className="panel"><div className="admin-heading"><div><h2>通知</h2><p className="muted">通知保存在伺服器 SQLite，每 3 秒自動更新；重新登入後仍可查看。啟用 Web App 推播後，即使 App 在背景也可接收系統通知（視瀏覽器及作業系統支援而定）。</p></div><span className="count">{notifications.filter(n => !n.isRead).length} 則未讀</span></div><div className="actions"><button disabled={busy} onClick={() => void subscribePush()}>啟用／修復推播訂閱</button></div><p className="hint">iPhone／iPad：請先將網站加入主畫面並從主畫面開啟；Android：請使用最新版 Chrome 或支援 Web Push 的瀏覽器。兩者均須使用 HTTPS 並允許通知。</p>{notifications.length === 0 ? <p className="muted">目前沒有通知。</p> : notifications.map(n => <article className="list-item" key={n.id}><div className="list-heading"><strong>{n.title}</strong><small>{n.createdAt}</small></div><p>{n.body}</p><div className="actions"><span className="muted">{n.targetClientId ? '指定給此客戶端' : '全體廣播'}</span>{n.isRead ? <span className="status">已讀</span> : <button className="secondary compact" onClick={() => void markNotificationRead(n.id)}>標記已讀</button>}</div></article>)}</section>}{tab === 'events' && user.role !== 'admin' && <section className="grid two">
        <article className="panel"><h2>建立事件</h2><p className="muted">新事件預設只儲存在這部手機的瀏覽器，不會自動上傳。需要時可手動上傳系統，或使用目前已連接的熱敏打印機列印固定測試收據。</p>
          <div className="storage-capacity" role="status" aria-live="polite"><div className="storage-capacity-heading"><strong>本機暫存容量（估算）</strong><strong>上限 {(localStorageInfo.quotaBytes / 1024 ** 3).toFixed(2)} GB</strong></div><p>已使用 {(localStorageInfo.usageBytes / 1024 ** 3).toFixed(2)} GB · 剩餘估算 {Math.max(0, localStorageInfo.quotaBytes - localStorageInfo.usageBytes) / 1024 ** 3 < 0.01 ? (Math.max(0, localStorageInfo.quotaBytes - localStorageInfo.usageBytes) / 1024 ** 2).toFixed(0) + ' MB' : (Math.max(0, localStorageInfo.quotaBytes - localStorageInfo.usageBytes) / 1024 ** 3).toFixed(2) + ' GB'}</p><progress max="100" value={Math.min(100, localStorageInfo.usageBytes / Math.max(1, localStorageInfo.quotaBytes) * 100)} /><small>{localStorageInfo.measured ? '容量為瀏覽器回報的此 PWA 網站儲存配額估算（包含快取及其他網站資料），並非整部手機的總磁碟容量。' : '此瀏覽器無法提供可靠配額；暫以 5 GB 作為本機暫存上限，已使用量按本機事件附件估算。'}</small>{localStorageInfo.usageBytes / Math.max(1, localStorageInfo.quotaBytes) >= 0.8 && <p className="storage-warning">儲存空間已使用 {Math.round(localStorageInfo.usageBytes / Math.max(1, localStorageInfo.quotaBytes) * 100)}%，建議先同步事件或刪除不需要的本機暫存附件。</p>}</div><form onSubmit={saveLocalWork}><label>事件標題<input required maxLength={200} value={workTitle} onChange={e=>setWorkTitle(e.target.value)} placeholder="例如：設備檢查、付款異常、客戶跟進" /></label><label>事件內容／工作備註<textarea rows={5} maxLength={10000} value={workContent} onChange={e=>setWorkContent(e.target.value)} placeholder="記錄事件經過、處理方式及備註" /></label><label className="event-date-field">事件日期與時間<input className="event-datetime-input" type="datetime-local" value={workDate} onChange={e=>setWorkDate(e.target.value)} /></label><label>圖片／影片附件（可多選）<input type="file" accept="image/*,video/*" multiple onChange={e=>setWorkMedia(Array.from(e.target.files || []))} /></label><p className="muted">已選取 {workMedia.length} 個附件；每個事件最多 20 個圖片／影片，單一檔案上限 100 MB。</p>
          {workMedia.map((file,i)=><p className="muted" key={file.name+i}>{file.type.startsWith('video/')?'影片':'圖片'}：{file.name}（{(file.size/1024/1024).toFixed(1)} MB）</p>)}<div className="actions"><button type="submit" disabled={busy || !workTitle.trim()}>暫存於手機</button><button type="button" disabled={busy || !workTitle.trim()} onClick={()=>void uploadCurrentWork()}>上傳事件及附件</button></div></form>
          <p className="hint">手機暫存只保存在目前瀏覽器／裝置；清除網站資料或更換裝置可能導致暫存遺失。暫存內容不會出現在後台，直到按下「上傳系統」。</p>
        </article>
        <article className="panel"><div className="admin-heading"><div><h2>手機暫存事件</h2><p className="muted">尚未上傳：{localDrafts.length} 項</p></div></div>
          {!localDrafts.some(draft => remainingMs(draft.createdAt, clockNow) > 0) ? <p className="muted">目前沒有手機暫存事件。</p> : localDrafts.filter(draft => remainingMs(draft.createdAt, clockNow) > 0).map(draft=><div className="list-item" key={draft.id}><div className="list-heading"><strong>{draft.title}</strong><small>{draft.eventDate || draft.createdAt}</small></div><p className="event-code">事件編號：{draft.eventCode || '上傳時補發'}</p><p className="muted">{draft.content || '（沒有備註）'}</p><div className="expiry-countdown"><div className="expiry-heading"><span>本機保存倒計時</span><strong>{countdownLabel(draft.createdAt, clockNow).label}</strong></div><div className="expiry-track"><span style={{width:`${countdownLabel(draft.createdAt, clockNow).percent}%`}} /></div></div><p className="muted">附件：{draft.media.length} 個 · {draft.syncStatus === 'queued' ? '等待連線，自動重試中' : draft.syncStatus === 'uploading' ? '正在上傳…' : draft.syncStatus === 'failed' ? '上次上傳失敗，請手動重試' : '尚未上傳'}</p>{draft.media.length > 0 && <div className="media-list">{draft.media.map((m,i)=><button type="button" className="media-open-button" key={m.id || m.name || i} onClick={()=>openMediaViewer(m, draft.createdAt)}>{m.kind === 'video' || m.mimeType?.startsWith('video/') ? '▶ 播放影片' : '檢視圖片'}：{m.originalName || m.name || ('附件 '+(i+1))}</button>)}</div>}<div className="actions"><button disabled={busy} onClick={()=>void uploadLocalWork(draft)}>上傳事件及附件</button><button className="danger compact" disabled={busy} onClick={()=>void deleteLocalWork(draft.id)}>刪除暫存</button></div></div>)}
        </article>
        <article className="panel"><h2>已上傳事件</h2><p className="muted">只顯示目前登入客戶端已上傳至系統的工作記錄。點擊附件會在頁面內開啟預覽，不會離開目前畫面。</p>{!uploadedWork.some(item => remainingMs(item.createdAt, clockNow) > 0) ? <p className="muted">尚無 24 小時內的已上傳事件。</p> : uploadedWork.filter(item => remainingMs(item.createdAt, clockNow) > 0).map(item=><div className="list-item" key={item.id}><div className="list-heading"><strong>{item.title}</strong><small>{item.eventDate || item.createdAt}</small></div>{item.eventCode && <p className="event-code">事件編號：{item.eventCode}</p>}<p className="muted">{item.content || '（沒有備註）'}</p><div className="expiry-countdown"><div className="expiry-heading"><span>客戶端可查看時間</span><strong>{countdownLabel(item.createdAt, clockNow).label}</strong></div><div className="expiry-track"><span style={{width:`${countdownLabel(item.createdAt, clockNow).percent}%`}} /></div></div><span className="status">已上傳</span><div className="media-list">{(item.media || []).map((m,i)=><button type="button" className="media-open-button" key={m.id || i} onClick={()=>openMediaViewer(m, item.createdAt)}>{m.kind==='video' || m.mimeType?.startsWith('video/') ? '▶ 播放影片' : '檢視圖片'}：{m.originalName || m.name || ('附件 '+(i+1))}</button>)}</div></div>)}</article>
      </section>}
      {tab === 'clear-records' && <section className="grid two"><article className="panel"><h2>清除持久化記錄</h2><p className="muted">勾選需要刪除的資料類別。這是永久刪除操作，請先確認備份。</p>{[['events','事件及其圖片／影片附件'],['jobs','每日及手動工作記錄'],['logins','登入／登出歷史記錄'],['printer_preferences','伺服器保存的打印機偏好'],['push_subscriptions','推播訂閱資料']] .map(([key,label]) => <label className="check-row" key={key}><input type="checkbox" checked={clearSelections.includes(key)} onChange={e => setClearSelections(old => e.target.checked ? [...old,key] : old.filter(x => x !== key))} />{label}</label>)}<label className="check-row"><input type="checkbox" checked={clearLocalPrinter} onChange={e => setClearLocalPrinter(e.target.checked)} />本機瀏覽器 IndexedDB 打印機偏好</label><div className="warning-note">為保留可追溯性，操作稽核記錄不會被此頁清除；系統會追加一筆「清除記錄」操作。使用者帳戶、Passkey 與目前登入工作階段不會被刪除。</div><button className="danger" disabled={busy || (!clearSelections.length && !clearLocalPrinter)} onClick={clearPersistentRecords}>{busy ? '清除中…' : '永久清除所選記錄'}</button></article><article className="panel"><h2>資料保存位置</h2><p>伺服器資料庫：<code>./data/app.sqlite</code></p><p>事件媒體檔案：<code>./uploads/</code></p><p>本機打印機偏好：瀏覽器 IndexedDB（資料庫 <code>esc-printing-local</code>）。</p><p className="hint">清除事件會同時刪除事件資料、附件資料庫索引及對應媒體檔案。清除伺服器資料只影響此應用程式資料，不會清除瀏覽器的網站權限或作業系統藍牙配對。</p></article></section>}
      {tab === 'jobs' && <section className="grid two"><article className="panel"><h2>建立工作記錄</h2><form onSubmit={saveJob}><label>標題<input required value={jobTitle} onChange={e => setJobTitle(e.target.value)} /></label><label>內容<textarea rows={4} value={jobDetail} onChange={e => setJobDetail(e.target.value)} /></label><button disabled={busy}>新增工作</button></form><p className="hint">系統每日 00:00（Asia/Singapore 預設）建立一筆自動工作記錄。伺服器必須持續運行才能觸發排程；啟動時亦會補上當日缺失記錄。</p></article><article className="panel"><h2>工作歷史 <span className="count">{jobs.length}</span></h2><div className="table-wrap"><table><thead><tr><th>日期</th><th>工作</th><th>狀態</th><th>內容</th></tr></thead><tbody>{jobs.map(j => <tr key={j.id}><td>{j.job_date}</td><td>{j.title}</td><td><span className="status">{j.status}</span></td><td>{j.detail}</td></tr>)}</tbody></table></div></article></section>}
      {tab === 'logins' && <section className="panel"><h2>登入人員及歷史記錄</h2><div className="table-wrap"><table><thead><tr><th>時間</th><th>使用者</th><th>事件</th><th>結果</th><th>說明</th></tr></thead><tbody>{logins.map(l => <tr key={l.id}><td>{l.created_at}</td><td>{l.username}</td><td>{l.event}</td><td>{l.success ? '成功' : '失敗'}</td><td>{l.detail}</td></tr>)}</tbody></table></div></section>}

      {tab === 'users' && user.role === 'admin' && <section className="admin-layout">
        <div className="admin-heading"><div><h2>用戶管理與設備狀態</h2><p className="muted">客戶端每 3 秒回報一次；後台每 3 秒刷新。最後更新：{adminDashboard?.serverTime || '讀取中…'}</p></div><button className="secondary" disabled={busy} onClick={() => refreshAdmin().catch(e => setMessage(e.message))}>立即刷新</button></div>
        <div className="admin-stats"><article className="stat-card"><span>已註冊用戶</span><strong>{adminDashboard?.users.length ?? '—'}</strong></article><article className="stat-card"><span>在線客戶端</span><strong>{adminDashboard?.clients.filter(c => c.online).length ?? '—'}</strong></article><article className="stat-card"><span>已上傳工作</span><strong>{adminDashboard?.deviceWork.length ?? '—'}</strong></article></div>
        <article className="panel"><h2>客戶端即時狀態</h2><p className="hint">「強制登出」會撤銷該客戶端的伺服器工作階段；客戶端最遲在下一次 3 秒心跳時發現並清除本機登入狀態。</p><div className="table-wrap"><table><thead><tr><th>用戶／狀態</th><th>最近回報</th><th>瀏覽器</th><th>操作</th></tr></thead><tbody>{(adminDashboard?.clients || []).map(c => <tr key={c.clientId}><td><strong>{c.username}</strong><div className={c.online ? 'live-pill online' : 'live-pill'}>{c.online ? '在線' : '離線'}</div><small>{c.clientId.slice(0,8)}…</small></td><td>{c.lastSeen}</td><td><small>{c.userAgent || '—'}</small></td><td><button className="danger compact" disabled={busy || !c.online} onClick={() => { if (window.confirm('確定強制登出此客戶端？')) void adminAction('/admin/clients/'+encodeURIComponent(c.clientId)+'/logout',{method:'POST'},'已發出強制登出指令'); }}>強制登出</button></td></tr>)}</tbody></table>{!adminDashboard?.clients.length && <p className="muted">尚未收到客戶端心跳。登入中的客戶端會自動出現在此處。</p>}</div></article>
        <article className="panel"><h2>用戶管理</h2><div className="table-wrap"><table><thead><tr><th>用戶</th><th>角色</th><th>Passkey</th><th>活動工作階段</th><th>最後登入</th><th>註冊時間</th><th>管理</th></tr></thead><tbody>{(adminDashboard?.users || []).map(a => <tr key={a.id}><td><strong>{a.displayName || a.username}</strong><div>{a.username}</div></td><td><select value={a.role} disabled={busy || a.id === user.id} onChange={e => void adminAction('/admin/users/'+a.id+'/role',{method:'POST',body:JSON.stringify({role:e.target.value})},'用戶角色已更新')}><option value="user">一般用戶</option><option value="admin" disabled>管理員（僅限 .env 固定帳號）</option></select></td><td>{a.passkeyCount}</td><td>{a.activeSessions}</td><td>{a.lastLogin || '—'}</td><td>{a.createdAt}</td><td><button className="danger compact" disabled={busy || a.id === user.id} onClick={() => { if(window.confirm('確定刪除此用戶？Passkey、登入工作階段、推播訂閱及其客戶端狀態會一併刪除。')) void adminAction('/admin/users/'+a.id,{method:'DELETE'},'用戶已刪除'); }}>刪除用戶</button></td></tr>)}</tbody></table></div></article>
</section>}
      {tab === 'device-work' && user.role === 'admin' && <section className="panel"><div className="admin-heading"><div><h2>所有設備上傳的工作記錄</h2><p className="muted">只顯示已上傳至伺服器的記錄，刪除後會從伺服器、附件儲存及客戶端列表同步移除。</p></div><span className="count">{adminDashboard?.deviceWork.length || 0} 筆</span></div><div className="table-wrap"><table><thead><tr><th>上傳時間</th><th>設備／用戶</th><th>事件日期</th><th>標題／附件</th><th>內容</th><th>操作</th></tr></thead><tbody>{(adminDashboard?.deviceWork || []).map(w=><tr key={w.id}><td>{w.createdAt}</td><td><strong>{w.username}</strong><div><small>{w.clientId.slice(0,8)}…</small></div></td><td>{w.eventDate || '—'}</td><td>{w.title}<div className="media-list">{(w.media || []).map((m,i)=><button type="button" className="media-open-button" key={m.id || i} onClick={()=>openMediaViewer(m, w.createdAt)}>{m.kind==='video' || m.mimeType?.startsWith('video/') ? '▶ 播放影片' : '檢視圖片'}：{m.originalName || m.name || ('附件 '+(i+1))}</button>)}</div></td><td>{w.content || '—'}</td><td><button className="danger compact" disabled={busy} onClick={()=>{if(window.confirm('確定永久刪除這筆設備工作記錄及所有附件？刪除後客戶端也會同步移除。')) void adminAction('/admin/device-work/'+encodeURIComponent(w.id),{method:'DELETE'},'工作記錄及附件已刪除，客戶端將同步更新');}}>刪除</button></td></tr>)}</tbody></table></div>{!adminDashboard?.deviceWork.length && <p className="muted">尚無設備上傳的工作記錄。</p>}</section>}
      {tab === 'audit' && <section className="panel"><h2>操作稽核歷史</h2><div className="table-wrap"><table><thead><tr><th>時間</th><th>人員</th><th>操作</th><th>類型</th><th>對象 ID</th><th>內容</th></tr></thead><tbody>{audits.map(a => <tr key={a.id}><td>{a.created_at}</td><td>{a.username || 'system'}</td><td>{a.action}</td><td>{a.entity_type}</td><td>{a.entity_id}</td><td>{a.detail}</td></tr>)}</tbody></table></div></section>}
    </main><footer>本機持久化 · SQLite · WebAuthn · BLE ESC/POS</footer>
    {mediaViewer && <div className="media-viewer-backdrop" role="presentation" onClick={closeMediaViewer}>
      <section className="media-viewer-dialog" role="dialog" aria-modal="true" aria-label="附件預覽" onClick={event => event.stopPropagation()}>
        <header className="media-viewer-header"><strong>{mediaViewer.name}</strong><button type="button" className="media-viewer-close" aria-label="關閉預覽" onClick={closeMediaViewer}>✕ 關閉</button></header>
        <div className="media-viewer-content">{mediaViewer.kind === 'video' ? <video src={mediaViewer.src} controls playsInline preload="metadata" onError={() => setMessage('影片無法播放：請確認上傳已完成，且手機瀏覽器支援此影片的編碼格式。')}>此瀏覽器無法播放此影片。</video> : <img src={mediaViewer.src} alt={mediaViewer.name} onError={() => setMessage('圖片載入失敗，請檢查網絡連線或重新上傳附件。')} />}</div>
      </section>
    </div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);