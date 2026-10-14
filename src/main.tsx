import React, { useEffect, useMemo, useRef, useState } from 'react';
import packageJson from '../package.json';
import { createRoot } from 'react-dom/client';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import './style.css';

const APP_VERSION = packageJson.version;
const LOCAL_DB_NAME = 'esc-printing-local';
const LOCAL_DB_SCHEMA_VERSION = 2;
const BUILD_ENVIRONMENT = import.meta.env.VITE_APP_ENV || (import.meta.env.PROD ? 'production' : 'test');
const environmentLabel = (value: string) => value === 'production' ? '正式環境' : '測試環境';
type User = { id: string; username: string; role: string };
type EventItem = { id: string; title: string; content: string; event_date?: string; created_at: string; media: { id: string; kind: string; original_name: string; url: string }[] };
type Job = { id: string; job_date: string; title: string; status: string; detail: string; created_at: string };
type Printer = { id: string; name: string; device: BluetoothDevice; characteristic?: BluetoothRemoteGATTCharacteristic };
type AdminClient = { clientId:string; userId:string; username:string; online:number; bluetoothSupported:number; bluetoothConnected:number; printerConnected:number; printerName?:string; printerId?:string; pushSubscribed?:number; userAgent?:string; appVersion?:string|null; appEnvironment?:string|null; lastSeen:string };
type AdminLinkedDevice = { clientId:string; deviceCode:string; registeredAt:string; lastSeen:string };
type AdminUser = { id:string; username:string; employeeNumber?:string; employeeName?:string; contactPhone?:string; contactEmail?:string; role:string; createdAt:string; passkeyCount:number; activeSessions:number; lastLogin?:string; linkedDevices?:AdminLinkedDevice[] };
type AdminDeviceUser = { id:string; username:string; registeredAt:string; lastSeen:string };
type AdminDevice = { clientId:string; deviceCode:string; createdAt:string; online:number; lastSeen?:string; userAgent?:string; appVersion?:string|null; appEnvironment?:string|null; userCount:number; registeredUsers:AdminDeviceUser[] };
type ProfileForm = { employeeNumber:string; employeeName:string; contactPhone:string; contactEmail:string };
type AdminOperation = { id:number; username?:string; action:string; entity_type?:string; entity_id?:string; detail?:string; created_at:string };
type WorkMedia = { id?:string; kind:string; originalName:string; mimeType:string; url?:string; name?:string; size?:number; blob?:Blob };
type DeviceWork = { id:string; clientId:string; userId:string; username:string; title:string; content:string; eventDate?:string|null; createdAt:string; printerName?:string|null; eventCode?:string|null; media?:WorkMedia[] };
type LocalDraft = { id:string; title:string; content:string; eventDate:string; createdAt:string; eventCode:string; uploadDispatchSeq?:number; syncStatus?:'draft'|'queued'|'uploading'|'failed'|'cancelled'; media:WorkMedia[] };
type MediaViewer = { src:string; kind:'image'|'video'; name:string; revokeOnClose:boolean; recordCreatedAt?:string };
type UploadProgress = { loaded:number; total:number; percent:number|null; bytesPerSecond:number };
type AttachmentUploadStatus = 'pending'|'uploading'|'uploaded'|'failed';
type WorkUploadMedia = { blob:Blob; name:string; mimeType:string; key:string };
const WORK_UPLOAD_CHUNK_BYTES = 160 * 1024;
const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024;
function mediaMimeType(name:string, supplied:string) {
  const type = String(supplied || '').toLowerCase().split(';')[0].trim();
  if (/^(image|video)\//.test(type)) return type;
  const ext = '.' + (name.toLowerCase().split('.').pop() || '');
  const byExtension:Record<string,string> = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.heic':'image/heic','.heif':'image/heif','.bmp':'image/bmp','.tif':'image/tiff','.tiff':'image/tiff','.mp4':'video/mp4','.m4v':'video/x-m4v','.mov':'video/quicktime','.qt':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.3gp':'video/3gpp','.3g2':'video/3gpp2','.mts':'video/mp2t','.m2ts':'video/mp2t','.mpeg':'video/mpeg','.mpg':'video/mpeg','.ogv':'video/ogg' };
  return byExtension[ext] || '';
}
const formAttachmentKey = (file:File,index:number) => 'form:'+index+':'+file.name;
const draftAttachmentKey = (draftId:string,index:number,file:WorkMedia) => 'draft:'+draftId+':'+index+':'+(file.name || file.originalName || 'attachment');
type LocalStorageInfo = { quotaBytes:number; usageBytes:number; measured:boolean };
const DEFAULT_STORAGE_LIMIT_BYTES = 5 * 1024 ** 3;
type AdminDashboard = { users:AdminUser[]; clients:AdminClient[]; devices:AdminDevice[]; operations:AdminOperation[]; jobs:Job[]; deviceWork:DeviceWork[]; appVersion:string; appEnvironment:string; serverTime:string };
type NotificationItem = { id:string; title:string; body:string; targetClientId?:string|null; createdAt:string; isRead:number; readAt?:string };
type AdminSentNotification = { id:string; title:string; body:string; targetClientId?:string|null; targetUsername?:string|null; deviceCode?:string|null; createdAt:string; pushSent:number|null; pushTotal:number|null; pushConfigured:number|null };

const api = async (path: string, token: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch('/api' + path, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
};
function uploadFormDataWithProgress(path: string, token: string, data: FormData, onProgress: (progress: UploadProgress) => void, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api' + path);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.timeout = 60000;
    xhr.ontimeout = () => reject(new Error('附件上傳逾時（60 秒）。請檢查遠端伺服器／代理限制後重試。'));
    xhr.upload.onprogress = event => {
      const snapshot = { loaded: event.loaded, total: event.lengthComputable ? event.total : 0, percent: event.lengthComputable && event.total > 0 ? Math.min(100, Math.round(event.loaded / event.total * 100)) : null, bytesPerSecond: 0 };
      window.requestAnimationFrame(() => onProgress(snapshot));
    };
    xhr.onerror = () => reject(new Error('網絡連線中斷，請檢查網絡後重試。'));
    xhr.onabort = () => reject(new Error('上傳已取消。'));
    if (signal) {
      if (signal.aborted) { reject(new Error('上傳已取消。')); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once:true });
    }
    xhr.onload = () => {
      let body: any = {};
      try { body = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status < 200 || xhr.status >= 300) reject(new Error(body.error || `HTTP ${xhr.status}`));
      else resolve(body);
    };
    xhr.send(data);
  });
}
type WorkUploadFields = { title:string; content:string; eventDate:string; eventCode:string; createdAt:string };
async function uploadWorkInChunks(token:string, fields:WorkUploadFields, media:WorkUploadMedia[], onProgress:(progress:UploadProgress)=>void, onStatus:(key:string,status:AttachmentUploadStatus)=>void, onFileProgress:(key:string,percent:number)=>void, signal?:AbortSignal) {
  const totalBytes = media.reduce((sum,file)=>sum+file.blob.size,0);
  const uploadedMediaIds:string[] = [];
  let completedBytes = 0;
  for (const file of media) {
    if (signal?.aborted) throw new Error('上傳已取消。');
    if (file.blob.size < 1) throw new Error(`附件「${file.name}」是空檔案，請重新選擇。`);
    const mimeType = mediaMimeType(file.name,file.mimeType);
    if (!mimeType) throw new Error(`無法識別附件「${file.name}」的圖片／影片格式；請使用 JPG、PNG、HEIC、MP4、MOV、M4V、WEBM、MKV 或 AVI 等常見格式。`);
    onStatus(file.key,'uploading');
    onFileProgress(file.key,0);
    const totalChunks = Math.ceil(file.blob.size/WORK_UPLOAD_CHUNK_BYTES);
    const uploadId = crypto.randomUUID();
    let mediaId = '';
    try {
      for (let index=0; index<totalChunks; index++) {
        const start = index*WORK_UPLOAD_CHUNK_BYTES;
        const chunk = file.blob.slice(start,Math.min(file.blob.size,start+WORK_UPLOAD_CHUNK_BYTES));
        const data = new FormData();
        data.append('uploadId',uploadId); data.append('filename',file.name || 'attachment'); data.append('mimeType',mimeType);
        data.append('totalSize',String(file.blob.size)); data.append('chunkSize',String(WORK_UPLOAD_CHUNK_BYTES)); data.append('index',String(index)); data.append('totalChunks',String(totalChunks));
        data.append('chunk',chunk,'chunk.bin');
        if (signal?.aborted) throw new Error('上傳已取消。');
        const result = await uploadFormDataWithProgress('/work/chunk',token,data,progress => {
          const loaded = Math.min(chunk.size,progress.loaded);
          const overallLoaded = Math.min(totalBytes,completedBytes+start+loaded);
          onProgress({ loaded:overallLoaded,total:totalBytes,percent:totalBytes>0?Math.min(99,Math.round(overallLoaded/totalBytes*100)):null,bytesPerSecond:0 });
          onFileProgress(file.key,Math.min(99,Math.round((start+loaded)/file.blob.size*100)));
        },signal);
        if (index===totalChunks-1) mediaId = String(result.mediaId || '');
        const overallLoaded = Math.min(totalBytes,completedBytes+start+chunk.size);
        onProgress({ loaded:overallLoaded,total:totalBytes,percent:totalBytes>0?Math.min(99,Math.round(overallLoaded/totalBytes*100)):null,bytesPerSecond:0 });
      }
      if (!mediaId) throw new Error(`附件「${file.name}」已傳送但伺服器未確認完成，請重試。`);
      uploadedMediaIds.push(mediaId); completedBytes += file.blob.size; onFileProgress(file.key,100); onStatus(file.key,'uploaded');
    } catch (error) { onStatus(file.key,'failed'); throw error; }
  }
  onProgress({ loaded:completedBytes,total:totalBytes,percent:99,bytesPerSecond:0 });
  if (signal?.aborted) throw new Error('上傳已取消。');
  await api('/work',token,{method:'POST',body:JSON.stringify({...fields,uploadedMediaIds}),signal});
  onProgress({ loaded:totalBytes,total:totalBytes,percent:100,bytesPerSecond:0 });
}
const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
const formatUsedStorage = (bytes: number) => bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(2)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const formatStorageGB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
function formatTimestampUTC8(value: string | undefined | null) {
  if (!value) return '—';
  const raw = String(value).trim();
  // SQLite CURRENT_TIMESTAMP values have no zone suffix and are stored in UTC.
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : (raw.includes('T') ? raw + 'Z' : raw.replace(' ', 'T') + 'Z');
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return raw;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value || '00';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')} +08:00`;
}
const b64url = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
const b64 = (s: string) => Uint8Array.from(atob(b64url(s)), c => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
const id = () => crypto.randomUUID();
type SavedPrinter = { id: string; name: string; savedAt: string };
type LocalDatabaseInfo = { exists: boolean; version: number };
let localDatabaseResetInProgress = false;
function inspectLocalDatabaseVersion(): Promise<LocalDatabaseInfo> {
  const factory = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string; version?: number }>> };
  if (typeof factory.databases !== 'function') {
    return Promise.reject(new Error('此瀏覽器不支援安全檢查本機資料庫版本。請更新至較新的 Safari／Chrome 後重試；為避免資料遺失，系統不會自動清除資料庫。'));
  }
  return factory.databases().then(databases => {
    const existing = databases.find(database => database.name === LOCAL_DB_NAME);
    return existing
      ? { exists: true, version: Number(existing.version || 0) }
      : { exists: false, version: 0 };
  });
}
function deleteLocalDatabase(onBlocked?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('清除本機資料庫失敗。'));
    request.onblocked = () => onBlocked?.();
  });
}
function printerStore(): Promise<IDBDatabase> {
  if (localDatabaseResetInProgress) return Promise.reject(new Error('本機資料庫正在重建；請等待系統更新完成。'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_SCHEMA_VERSION);
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

// A dispatch sequence records when the user put an event into the upload queue.
// It is intentionally independent of the event code; resuming a cancelled event
// assigns a fresh sequence so it joins the back of the current queue.
async function nextUploadDispatchSequence(): Promise<number> {
  const db = await printerStore();
  const value = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction('preferences', 'readwrite');
    const store = tx.objectStore('preferences');
    const request = store.get('upload-dispatch-sequence');
    let next = 1;
    request.onsuccess = () => { next = Number(request.result?.value || 0) + 1; store.put({ id:'upload-dispatch-sequence', value:next }); };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(next);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return value;
}
function localDateTimeInputValue(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
}
function localDateInputValue(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
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
  const [token, setToken] = useState(() => { if (typeof window !== 'undefined' && window.matchMedia('(max-width: 800px)').matches) { localStorage.removeItem('esc-token'); return ''; } return localStorage.getItem('esc-token') || ''; });
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 800px)').matches ? (localStorage.getItem('esc-last-username') || '') : '');
  function updateUsername(value: string) { setUsername(value); if (typeof window !== 'undefined' && window.matchMedia('(max-width: 800px)').matches) { if (value.trim()) localStorage.setItem('esc-last-username', value); else localStorage.removeItem('esc-last-username'); } }
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [employeeName, setEmployeeName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [showStorageTooltip, setShowStorageTooltip] = useState(false);
  const [adminMode, setAdminMode] = useState(false);
  const [adminUsernameInput, setAdminUsernameInput] = useState('');
  const [adminPasswordInput, setAdminPasswordInput] = useState('');
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 801px)').matches);
  const [tab, setTab] = useState('print');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [forceUpdating, setForceUpdating] = useState(false);
  const forceUpdatingRef = useRef(false);
  const [forceUpdateComplete, setForceUpdateComplete] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('forceUpdate'));
  useEffect(() => {
    if (!forceUpdateComplete) return;
    const timer = window.setTimeout(() => {
      setForceUpdateComplete(false);
      const url = new URL(window.location.href);
      url.searchParams.delete('forceUpdate');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }, 5 * 60 * 1000);
    return () => window.clearTimeout(timer);
  }, [forceUpdateComplete]);
  const [workSubmitting, setWorkSubmitting] = useState(false);
  const uploadingLocalWorkIds = useRef(new Set<string>());
  const [printer, setPrinter] = useState<Printer | null>(null);
  const [savedPrinter, setSavedPrinter] = useState<any>(null);
  const [codePageIndex, setCodePageIndex] = useState('0');
  const [printNote, setPrintNote] = useState('');
  const [showReceiptPreview, setShowReceiptPreview] = useState(false);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [localDrafts, setLocalDrafts] = useState<LocalDraft[]>([]);
  const localDraftsRef = useRef<LocalDraft[]>([]);
  localDraftsRef.current = localDrafts;
  const uploadControllers = useRef(new Map<string,AbortController>());
  const forceDeletingUploadIds = useRef(new Set<string>());
  const [localStorageInfo, setLocalStorageInfo] = useState<LocalStorageInfo>({ quotaBytes: DEFAULT_STORAGE_LIMIT_BYTES, usageBytes: 0, measured: false });
  const [workMedia, setWorkMedia] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [attachmentUploadStatuses, setAttachmentUploadStatuses] = useState<Record<string,AttachmentUploadStatus>>({});
  const [attachmentUploadPercents, setAttachmentUploadPercents] = useState<Record<string,number>>({});
  const [deviceCode, setDeviceCode] = useState(() => localStorage.getItem('esc-device-code') || '');
  const [remoteOnline, setRemoteOnline] = useState(false);
  const remoteOnlineRef = useRef(false);
  remoteOnlineRef.current = remoteOnline;
  const [serverVersion, setServerVersion] = useState('');
  const [serverEnvironment, setServerEnvironment] = useState('');
  const [updateRequired, setUpdateRequired] = useState(false);
  const updateRequiredRef = useRef(false);
  updateRequiredRef.current = updateRequired;
  const [versionCheckComplete, setVersionCheckComplete] = useState(false);
  const versionCheckCompleteRef = useRef(false);
  versionCheckCompleteRef.current = versionCheckComplete;
  const [versionCheckError, setVersionCheckError] = useState('');
  const versionCheckErrorRef = useRef('');
  versionCheckErrorRef.current = versionCheckError;
  const [schemaUpdateRequired, setSchemaUpdateRequired] = useState(false);
  const [localDbVersion, setLocalDbVersion] = useState(0);
  const [serverDbSchemaVersion, setServerDbSchemaVersion] = useState(LOCAL_DB_SCHEMA_VERSION);
  const [updateSummary, setUpdateSummary] = useState('本次更新包含系統版本及本機資料庫相容性檢查。');
  const [updateRisks, setUpdateRisks] = useState('確認後會永久清除本機 IndexedDB 中的暫存事件、上傳隊列、附件、打印機偏好及本機流水號。尚未上傳的事件與附件無法復原；已上傳至後台的記錄不受影響。');
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [uploadedWork, setUploadedWork] = useState<DeviceWork[]>([]);
  const [mediaViewer, setMediaViewer] = useState<MediaViewer | null>(null);
  const [workTitle, setWorkTitle] = useState('');
  const [workContent, setWorkContent] = useState('');
  const [workDate, setWorkDate] = useState(() => localDateTimeInputValue());
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
  const [selectedAdminUserId, setSelectedAdminUserId] = useState('');
  const [selectedAdminDeviceId, setSelectedAdminDeviceId] = useState('');
  const [profile, setProfile] = useState<ProfileForm>({ employeeNumber:'', employeeName:'', contactPhone:'', contactEmail:'' });
  const [adminWorkTitle, setAdminWorkTitle] = useState('');
  const [adminWorkDate, setAdminWorkDate] = useState(localDateInputValue());
  const [adminWorkDetail, setAdminWorkDetail] = useState('');
  const [adminOpTitle, setAdminOpTitle] = useState('');
  const [adminOpContent, setAdminOpContent] = useState('');
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationTitle, setNotificationTitle] = useState('');
  const [notificationBody, setNotificationBody] = useState('');
  const [notificationTarget, setNotificationTarget] = useState('');
  const [adminSentNotifications, setAdminSentNotifications] = useState<AdminSentNotification[]>([]);
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

  useEffect(() => { if (token) api('/me', token).then((x) => { setUser(x.user); if (x.user.role === 'admin') setTab('registered-devices'); }).catch(() => { localStorage.removeItem('esc-token'); setToken(''); setUser(null); setTab('print'); }); }, [token]);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 801px)');
    const update = () => { setIsDesktop(query.matches); if (!query.matches) setAdminMode(false); };
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    let active = true;
    let checking = false;
    const check = async () => {
      if (checking || forceUpdatingRef.current) return;
      checking = true;
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (!response.ok) throw new Error('API unavailable');
        const versionResponse = await fetch('/api/version', { cache: 'no-store' });
        if (!versionResponse.ok) throw new Error('Version endpoint unavailable');
        const versionInfo: { version: string; environment: string; localDbSchemaVersion?: number; updateSummary?: string; updateRisks?: string } = await versionResponse.json();
        let databaseInfo: LocalDatabaseInfo;
        try {
          databaseInfo = await inspectLocalDatabaseVersion();
        } catch (error) {
          if (active) {
            setRemoteOnline(true);
            setServerVersion(versionInfo.version);
            setServerEnvironment(versionInfo.environment);
            setVersionCheckComplete(true);
            setVersionCheckError(error instanceof Error ? error.message : '無法安全檢查本機資料庫版本。');
            setUpdateRequired(true);
          }
          return;
        }
        const targetSchemaVersion = Math.max(1, Number(versionInfo.localDbSchemaVersion) || LOCAL_DB_SCHEMA_VERSION);
        const schemaMismatch = databaseInfo.exists && databaseInfo.version !== targetSchemaVersion;
        const versionMismatch = versionInfo.version !== APP_VERSION || versionInfo.environment !== BUILD_ENVIRONMENT;
        if (active) {
          setRemoteOnline(true);
          setServerVersion(versionInfo.version);
          setServerEnvironment(versionInfo.environment);
          setLocalDbVersion(databaseInfo.version);
          setServerDbSchemaVersion(targetSchemaVersion);
          setUpdateSummary(String(versionInfo.updateSummary || '本次更新包含系統版本及本機資料庫相容性檢查。'));
          setUpdateRisks(String(versionInfo.updateRisks || '確認後會永久清除本機 IndexedDB 中的暫存事件、上傳隊列、附件、打印機偏好及本機流水號。尚未上傳的事件與附件無法復原；已上傳至後台的記錄不受影響。'));
          setSchemaUpdateRequired(schemaMismatch);
          setUpdateRequired(versionMismatch || schemaMismatch);
          setVersionCheckError('');
          setVersionCheckComplete(true);
        }
      } catch {
        if (active) {
          setRemoteOnline(false);
          // Allow offline local work when the server cannot be reached. Once online,
          // the next check will compare the server's schema version before enabling uploads.
          setVersionCheckComplete(true);
        }
      } finally {
        checking = false;
      }
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
    if (!versionCheckComplete || updateRequired || versionCheckError) return;
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
  }, [token, user, versionCheckComplete, updateRequired, versionCheckError]);
  useEffect(() => { if (!versionCheckComplete || updateRequired || versionCheckError) return; loadLocalDrafts().then(async drafts => { let normalized = drafts.map(draft => draft.syncStatus === 'uploading' ? { ...draft, syncStatus:'queued' as const } : draft); const missing = normalized.filter(draft => draft.syncStatus === 'queued' && !(Number(draft.uploadDispatchSeq) > 0)).sort((a,b) => a.createdAt.localeCompare(b.createdAt)); for (const draft of missing) { draft.uploadDispatchSeq = await nextUploadDispatchSequence(); } localDraftsRef.current = normalized; setLocalDrafts(normalized); void Promise.all(normalized.filter((draft,index) => draft !== drafts[index] || missing.includes(draft)).map(draft => saveLocalDraft(draft).catch(() => {}))); }).catch(() => setMessage('讀取手機暫存失敗，請檢查瀏覽器儲存空間。')); }, [versionCheckComplete, updateRequired, versionCheckError]);
  useEffect(() => {
    let active = true;
    const refreshStorageInfo = async () => {
      const fallbackUsage = mediaBytes(localDrafts);
      try {
        const estimate = await navigator.storage?.estimate();
        if (estimate && Number(estimate.quota) > 0) {
          // Report the app's locally saved event attachments so this value changes immediately after saving a draft.
          if (active) setLocalStorageInfo({ quotaBytes: Number(estimate.quota), usageBytes: fallbackUsage, measured: true });
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
          clientId, userAgent: navigator.userAgent, appVersion: APP_VERSION, appEnvironment: BUILD_ENVIRONMENT, bluetoothSupported: 'bluetooth' in navigator,
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
    if (!token || !user || user.role !== 'admin' || !['registered-devices', 'device-users', 'user-detail', 'device-detail', 'device-work', 'notifications'].includes(tab)) return;
    let alive = true;
    const refresh = async () => {
      try {
        const data = await api('/admin/dashboard', token);
        const sentNotifications = tab === 'notifications' ? await api('/admin/notifications', token) : null;
        if (alive) { setAdminDashboard(data); if (sentNotifications) setAdminSentNotifications(sentNotifications as AdminSentNotification[]); }
      } catch (err) { if (alive) setMessage(err instanceof Error ? err.message : '管理後台讀取失敗'); }
    };
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [token, user, tab]);

  useEffect(() => {
    if (!token || !user || user.role === 'admin' || tab !== 'profile') return;
    let alive = true;
    api('/me', token).then(result => {
      if (!alive) return;
      const p = result.user || {};
      setProfile({ employeeNumber:p.employeeNumber || '', employeeName:p.employeeName || '', contactPhone:p.contactPhone || '', contactEmail:p.contactEmail || '' });
    }).catch(err => { if (alive) setMessage(err instanceof Error ? err.message : '無法載入個人資料'); });
    return () => { alive = false; };
  }, [token, user, tab]);

  async function refreshAdmin() { setAdminDashboard(await api('/admin/dashboard', token)); }
  async function saveProfile(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const result = await api('/me', token, { method:'PUT', body:JSON.stringify(profile) });
      setProfile({ employeeNumber:result.user.employeeNumber || '', employeeName:result.user.employeeName || '', contactPhone:result.user.contactPhone || '', contactEmail:result.user.contactEmail || '' });
      setMessage('個人資料已更新；登入用戶名保持不變。');
    } catch (err) { setMessage(err instanceof Error ? err.message : '更新個人資料失敗'); }
    finally { setBusy(false); }
  }
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
      await refreshAdmin();
      setAdminSentNotifications(await api('/admin/notifications', token));
      setMessage(result.message || '通知已發送。');
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
  async function markAllNotificationsRead() {
    const unread = notifications.filter(n => !n.isRead);
    if (!unread.length) return;
    setBusy(true);
    setMessage('');
    try {
      await Promise.all(unread.map(n => api('/notifications/' + encodeURIComponent(n.id) + '/read', token, { method:'POST' })));
      const readAt = new Date().toISOString();
      setNotifications(rows => rows.map(n => ({ ...n, isRead: 1, readAt: n.readAt || readAt })));
      setMessage('全部通知已標記為已讀。');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '全部標記已讀失敗，請重試。');
    } finally {
      setBusy(false);
    }
  }

  async function createAdminWork(e: React.FormEvent) {
    e.preventDefault();
    await adminAction('/admin/jobs', { method:'POST', body:JSON.stringify({ title:adminWorkTitle, jobDate:adminWorkDate, detail:adminWorkDetail }) }, '工作記錄已新增');
    setAdminWorkTitle(''); setAdminWorkDetail('');
  }

  async function login() {
    const mobilePasskeyLogin = typeof window !== 'undefined' && window.matchMedia('(max-width: 800px)').matches && !isRegisterMode;
    setBusy(true); setMessage('');
    try {
      const options = await fetch('/api/auth/login/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mobilePasskeyLogin ? {} : { username }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      const { challengeId, username: loginName, ...publicKey } = options;
      const response = await startAuthentication({ optionsJSON: publicKey });
      const result = await fetch('/api/auth/login/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(loginName ? { username: loginName } : {}), challengeId, response, clientId }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      if (result.deviceCode) { localStorage.setItem('esc-device-code', result.deviceCode); setDeviceCode(result.deviceCode); }
      localStorage.setItem('esc-token', result.token); setToken(result.token); setUser(result.user); setMessage('登入成功');
    } catch (e) {
      const errorName = e instanceof Error ? e.name : '';
      const errorMessage = e instanceof Error ? e.message : '登入失敗';
      if (mobilePasskeyLogin && (errorName === 'NotAllowedError' || /passkey not registered|no credentials|credential/i.test(errorMessage))) {
        setIsRegisterMode(true);
        setMessage('此裝置未能找到可用的 Passkey，請建立新用戶或確認帳號資料。');
      } else setMessage(errorMessage);
    } finally { setBusy(false); }
  }
  async function adminLogin() {
    setBusy(true); setMessage('');
    try {
      const result = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: adminUsernameInput, password: adminPasswordInput, clientId })
      }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      localStorage.setItem('esc-token', result.token);
      setToken(result.token); setUser(result.user); setTab('registered-devices'); setMessage('管理員登入成功');
      setAdminPasswordInput('');
    } catch (e) { setMessage(e instanceof Error ? e.message : '管理員登入失敗'); }
    finally { setBusy(false); }
  }
  async function register() {
    if (!/^[0-9]+$/.test(employeeNumber)) { setMessage('員工編號必須填寫，而且只允許輸入 0-9 數字。'); return; }
    setBusy(true); setMessage('');
    try {
      const options = await fetch('/api/auth/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, employeeNumber, employeeName: employeeName.trim(), contactPhone: contactPhone.trim(), contactEmail: contactEmail.trim() }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      const { challengeId, userId, ...publicKey } = options;
      const response = await startRegistration({ optionsJSON: publicKey });
      const result = await fetch('/api/auth/register/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, challengeId, response, clientId }) }).then(async r => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; });
      if (result.deviceCode) { localStorage.setItem('esc-device-code', result.deviceCode); setDeviceCode(result.deviceCode); }
      setMessage(result.verified ? `Passkey 註冊成功，設備碼：${result.deviceCode || '待同步'}。現在可以登入。` : '註冊未完成');
      if (result.verified) setIsRegisterMode(false);
    } catch (e) { setMessage(e instanceof Error ? e.message : '註冊失敗'); }
    finally { setBusy(false); }
  }
  async function logout() {
    try { if (token) await api('/auth/logout', token, { method: 'POST' }); } catch {}
    setForceUpdating(false); setForceUpdateComplete(false);
    const url = new URL(window.location.href);
    url.searchParams.delete('forceUpdate');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
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
  async function draftFromForm(eventCode: string, syncStatus: LocalDraft['syncStatus'] = 'draft', createdAt = new Date().toISOString()): Promise<LocalDraft> {
    // Snapshot picked files into fresh, byte-backed Blobs before IndexedDB persistence.
    // Some Chromium-based mobile browsers can fail with "Failed to write blobs (InvalidBlob)"
    // when IndexedDB receives the original lazy File handle from the device file picker.
    const media = await Promise.all(workMedia.map(async file => {
      const mimeType = file.type || mediaMimeType(file.name, '') || 'application/octet-stream';
      const blob = await new Response(file.stream(), { headers: { 'Content-Type': mimeType } }).blob();
      return { name:file.name, originalName:file.name, kind:(file.type || mediaMimeType(file.name, '')).startsWith('video/') ? 'video' : 'image', mimeType, size:file.size, blob };
    }));
    return {
      id: crypto.randomUUID(), title: workTitle.trim(), content: workContent.trim(), eventDate: workDate,
      createdAt, eventCode, syncStatus, media
    };
  }
  function clearWorkForm() {
    setWorkTitle(''); setWorkContent(''); setWorkDate(localDateTimeInputValue()); setWorkMedia([]);
    setAttachmentUploadStatuses(old => { const next = { ...old }; Object.keys(next).filter(key => key.startsWith('form:')).forEach(key => delete next[key]); return next; });
    setAttachmentUploadPercents(old => { const next = { ...old }; Object.keys(next).filter(key => key.startsWith('form:')).forEach(key => delete next[key]); return next; });
  }
  function isConnectivityFailure(error: unknown) {
    const text = error instanceof Error ? error.message : String(error || '');
    return /網絡連線中斷|Failed to fetch|NetworkError|Load failed|HTTP 5\d\d|HTTP 408|HTTP 429|連線逾時|附件上傳逾時/i.test(text);
  }
  async function uploadCurrentWork() {
    const oversized = workMedia.filter(file => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized.length) { setMessage(`單一附件上限為 500 MiB，以下檔案超出限制：${oversized.map(file=>file.name).join('、')}`); return; }
    const title = workTitle.trim(); if (!title) { setMessage('請輸入事件標題'); return; }
    setWorkSubmitting(true);
    try {
      const draft = { ...await draftFromForm(await createEventCode(), 'queued'), uploadDispatchSeq: await nextUploadDispatchSequence() };
      await saveLocalDraft(draft);
      localDraftsRef.current = [draft, ...localDraftsRef.current];
      setLocalDrafts(old => [draft, ...old]);
      clearWorkForm();
      setMessage(remoteOnline
        ? `事件 ${draft.eventCode} 已加入上傳隊列，將按派發序號順序上傳；你可以繼續建立新事件。`
        : `事件 ${draft.eventCode} 已加入上傳隊列，正在立即嘗試上傳；若網絡中斷會保留並自動重試。`);
      // Always kick the queue immediately. If another event is uploading,
      // the scheduler leaves this item queued; completion starts the next one.
      window.setTimeout(() => startNextQueuedUpload(), 0);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '無法將事件保存至本機上傳隊列；表單內容仍保留，請檢查儲存空間後重試。');
    } finally { setWorkSubmitting(false); }
  }

  async function saveLocalWork(e: React.FormEvent) {
    e.preventDefault();
    const oversized = workMedia.filter(file => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized.length) { setMessage(`單一附件上限為 500 MiB，以下檔案超出限制：${oversized.map(file=>file.name).join('、')}`); return; }
    const title = workTitle.trim(); if (!title) { setMessage('請輸入事件標題'); return; }
    setWorkSubmitting(true);
    try {
      const draft = await draftFromForm(await createEventCode());
      await saveLocalDraft(draft); setLocalDrafts(old => [draft, ...old]); clearWorkForm();
      setMessage(`事件已暫存在手機。事件編號：${draft.eventCode}`);
    } catch (err) { setMessage(err instanceof Error ? err.message : '手機暫存失敗；可能是裝置儲存空間不足。請減少影片大小後再試。'); }
    finally { setWorkSubmitting(false); }
  }

  function removeSelectedAttachment(index: number) {
    if (workSubmitting) return;
    const removed = workMedia[index];
    const remaining = workMedia.filter((_, itemIndex) => itemIndex !== index);
    setWorkMedia(remaining);
    setAttachmentUploadStatuses(old => {
      const next = { ...old };
      Object.keys(next).filter(key => key.startsWith('form:')).forEach(key => delete next[key]);
      remaining.forEach((file, itemIndex) => { next[formAttachmentKey(file, itemIndex)] = 'pending'; });
      return next;
    });
    setAttachmentUploadPercents(old => {
      const next = { ...old };
      Object.keys(next).filter(key => key.startsWith('form:')).forEach(key => delete next[key]);
      return next;
    });
    setMessage(`已移除附件：${removed?.name || '附件'}`);
  }

  function uploadDispatchSequence(draft: LocalDraft) {
    return Number(draft.uploadDispatchSeq) > 0 ? Number(draft.uploadDispatchSeq) : Number.MAX_SAFE_INTEGER;
  }
  function startNextQueuedUpload() {
    // Claim the queue item and install its AbortController synchronously, before any
    // async work starts. This closes the race where cancel was clicked while the
    // scheduler was still awaiting event-code creation and the upload kept running.
    if (!versionCheckCompleteRef.current || updateRequiredRef.current || versionCheckErrorRef.current || !remoteOnlineRef.current || !token || !user || uploadingLocalWorkIds.current.size > 0) return;
    const next = localDraftsRef.current
      .filter(draft => draft.syncStatus === 'queued' && remainingMs(draft.createdAt, Date.now()) > 0)
      .sort((a,b) => uploadDispatchSequence(a) - uploadDispatchSequence(b) || a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return;
    const controller = new AbortController();
    uploadingLocalWorkIds.current.add(next.id);
    uploadControllers.current.set(next.id, controller);
    void uploadLocalWork(next, controller);
  }
  function clearDraftAttachmentUploadUi(draft: LocalDraft) {
    const keys = draft.media.map((media, index) => draftAttachmentKey(draft.id, index, media));
    setAttachmentUploadStatuses(old => {
      const next = { ...old };
      keys.forEach(key => { delete next[key]; });
      return next;
    });
    setAttachmentUploadPercents(old => {
      const next = { ...old };
      keys.forEach(key => { delete next[key]; });
      return next;
    });
    setUploadProgress(null);
  }

  async function cancelLocalWork(draft: LocalDraft) {
    clearDraftAttachmentUploadUi(draft);
    if (draft.syncStatus === 'uploading' || uploadControllers.current.has(draft.id) || uploadingLocalWorkIds.current.has(draft.id)) {
      uploadControllers.current.get(draft.id)?.abort();
      setMessage(`已要求取消事件 ${draft.eventCode} 的上傳；原始事件及附件會保留在隊列。`);
      return;
    }
    const cancelled = { ...draft, syncStatus:'cancelled' as const };
    // Remove it from the scheduler's synchronous source of truth before awaiting
    // IndexedDB, so a finishing upload cannot pick it up during the write.
    localDraftsRef.current = localDraftsRef.current.map(item => item.id === draft.id ? cancelled : item);
    setLocalDrafts(old => old.map(item => item.id === draft.id ? cancelled : item));
    try {
      await saveLocalDraft(cancelled);
      setMessage(`事件 ${draft.eventCode} 已取消排程；可選擇繼續上傳或轉為暫存。`);
    } catch (err) {
      localDraftsRef.current = localDraftsRef.current.map(item => item.id === draft.id ? draft : item);
      setLocalDrafts(old => old.map(item => item.id === draft.id ? draft : item));
      setMessage(err instanceof Error ? err.message : '保存取消狀態失敗，請重試。');
    }
  }
  async function continueLocalWork(draft: LocalDraft) {
    try {
      const queued = { ...draft, uploadDispatchSeq: await nextUploadDispatchSequence(), syncStatus:'queued' as const };
      await saveLocalDraft(queued);
      localDraftsRef.current = localDraftsRef.current.map(item => item.id === draft.id ? queued : item);
      setLocalDrafts(old => old.map(item => item.id === draft.id ? queued : item));
      setMessage(`事件 ${draft.eventCode} 已重新加入上傳隊列（派發序號 ${queued.uploadDispatchSeq}），將按新的派發序號排程。`);
      window.setTimeout(() => startNextQueuedUpload(), 0);
    } catch (err) { setMessage(err instanceof Error ? err.message : '無法恢復上傳排程；本機事件仍保留。'); }
  }
  async function uploadLocalWork(draft: LocalDraft, controller: AbortController) {
    let finalStatus: LocalDraft['syncStatus'] = 'uploading';
    try {
      if (draft.syncStatus !== 'queued' || !token || !user) return;
      const smallestQueued = localDraftsRef.current
        .filter(item => item.syncStatus === 'queued' && remainingMs(item.createdAt, Date.now()) > 0)
        .sort((a,b) => uploadDispatchSequence(a) - uploadDispatchSequence(b) || a.createdAt.localeCompare(b.createdAt))[0];
      if (smallestQueued && smallestQueued.id !== draft.id) return;
      if (remainingMs(draft.createdAt, Date.now()) <= 0) {
        await deleteLocalDraft(draft.id).catch(() => {});
        setLocalDrafts(old => old.filter(item => item.id !== draft.id));
        setMessage('此事件已超過 24 小時，已從客戶端移除。');
        finalStatus = undefined;
        return;
      }
      if (!draft.eventCode) {
        draft = { ...draft, eventCode: await createEventCode() };
        if (controller.signal.aborted) throw new Error('上傳已取消。');
        await saveLocalDraft(draft);
        localDraftsRef.current = localDraftsRef.current.map(item => item.id === draft.id ? draft : item);
        setLocalDrafts(old => old.map(item => item.id === draft.id ? draft : item));
      }
      if (controller.signal.aborted) throw new Error('上傳已取消。');
      const uploading = { ...draft, syncStatus:'uploading' as const };
      localDraftsRef.current = localDraftsRef.current.map(item => item.id === draft.id ? uploading : item);
      setLocalDrafts(old => old.map(item => item.id === draft.id ? uploading : item));
      await saveLocalDraft(uploading);
      const queuedMedia:WorkUploadMedia[] = draft.media.map((file,index)=>({file,index})).filter(item=>item.file.blob).map(({file,index})=>({blob:file.blob as Blob,name:file.name || file.originalName || 'attachment',mimeType:mediaMimeType(file.name || file.originalName || 'attachment',file.mimeType || file.blob?.type || ''),key:draftAttachmentKey(draft.id,index,file)}));
      setAttachmentUploadStatuses(old=>({...old,...Object.fromEntries(queuedMedia.map(file=>[file.key,'pending' as AttachmentUploadStatus]))}));
      setUploadProgress({ loaded:0, total:queuedMedia.reduce((sum,file)=>sum+file.blob.size,0), percent:0, bytesPerSecond:0 });
      await uploadWorkInChunks(token,{title:draft.title,content:draft.content,eventDate:draft.eventDate,eventCode:draft.eventCode,createdAt:draft.createdAt},queuedMedia,setUploadProgress,(key,status)=>setAttachmentUploadStatuses(old=>({...old,[key]:status})),(key,percent)=>setAttachmentUploadPercents(old=>({...old,[key]:percent})),controller.signal);
      await deleteLocalDraft(draft.id);
      localDraftsRef.current = localDraftsRef.current.filter(item => item.id !== draft.id);
      setLocalDrafts(old => old.filter(item => item.id !== draft.id));
      finalStatus = undefined;
      setUploadedWork(await api('/work', token)); setMessage(`事件 ${draft.eventCode} 及 ${draft.media.length} 個附件已上傳。`);
    } catch (err) {
      if (forceDeletingUploadIds.current.has(draft.id)) {
        finalStatus = undefined;
        return;
      }
      const status = controller.signal.aborted ? 'cancelled' as const : isConnectivityFailure(err) ? 'queued' as const : 'failed' as const;
      finalStatus = status;
      const retained = { ...draft, syncStatus:status };
      await saveLocalDraft(retained).catch(() => {});
      localDraftsRef.current = localDraftsRef.current.map(item => item.id === draft.id ? retained : item);
      setLocalDrafts(old => old.map(item => item.id === draft.id ? retained : item));
      if (status === 'cancelled') {
        clearDraftAttachmentUploadUi(draft);
        setMessage(`事件 ${draft.eventCode || '（待補編號）'} 已取消上傳；可選擇「繼續上傳」或「轉為暫存」。`);
      }
      else setMessage(status === 'queued' ? `事件 ${draft.eventCode} 上傳中斷，已保留在上傳隊列，稍後自動重試。` : (err instanceof Error ? err.message : '上傳失敗；本機事件仍保留，可手動繼續上傳。'));
    } finally {
      uploadingLocalWorkIds.current.delete(draft.id);
      uploadControllers.current.delete(draft.id);
      forceDeletingUploadIds.current.delete(draft.id);
      window.setTimeout(() => setUploadProgress(null), 1200);
      if (finalStatus === 'cancelled') clearDraftAttachmentUploadUi(draft);
      if (finalStatus !== 'queued') window.setTimeout(() => startNextQueuedUpload(), 0);
    }
  }
  async function enqueueLocalDraftForUpload(draft: LocalDraft) {
    if (draft.syncStatus && draft.syncStatus !== 'draft') {
      setMessage('此事件已在上傳隊列中，請在隊列區操作。');
      return;
    }
    if (!draft.title.trim()) {
      setMessage('此暫存事件沒有標題，請先編輯或重新建立事件。');
      return;
    }
    try {
      const queued: LocalDraft = { ...draft, uploadDispatchSeq: await nextUploadDispatchSequence(), syncStatus:'queued' };
      await saveLocalDraft(queued);
      localDraftsRef.current = localDraftsRef.current.map(item => item.id === draft.id ? queued : item);
      setLocalDrafts(old => old.map(item => item.id === draft.id ? queued : item));
      setMessage(`事件 ${draft.eventCode || '（待補編號）'} 已加入上傳隊列（派發序號 ${queued.uploadDispatchSeq}），將依加入隊列順序上傳。`);
      window.setTimeout(() => startNextQueuedUpload(), 0);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '無法將手機暫存事件加入上傳隊列；原暫存仍保留。');
    }
  }

  async function deleteLocalWork(draftId: string) {
    const draft = localDraftsRef.current.find(item => item.id === draftId);
    if (!draft) return;
    if (uploadingLocalWorkIds.current.has(draftId) || uploadControllers.current.has(draftId) || draft.syncStatus === 'uploading') {
      setMessage('事件正在上傳，請先取消上傳，完成後再轉為暫存或刪除。');
      return;
    }
    if (!window.confirm(`確定刪除手機暫存事件「${draft.title}」及其 ${draft.media.length} 個本機附件？此操作無法復原。`)) return;
    try {
      await deleteLocalDraft(draftId);
      setLocalDrafts(old => old.filter(item => item.id !== draftId));
      setMessage(`已刪除手機暫存事件：${draft.title}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '刪除手機暫存失敗；事件及附件仍保留。');
    }
  }

  async function convertQueueItemToDraft(draft: LocalDraft) {
    if (uploadingLocalWorkIds.current.has(draft.id) || uploadControllers.current.has(draft.id)) {
      setMessage('事件仍在上傳中，請先取消上傳，待取消完成後再轉為暫存。'); return;
    }
    const localDraft: LocalDraft = { ...draft, syncStatus:'draft' };
    try {
      await saveLocalDraft(localDraft);
      clearDraftAttachmentUploadUi(draft);
      setLocalDrafts(old => old.map(item => item.id === draft.id ? localDraft : item));
      setMessage(`事件 ${draft.eventCode} 已移至「手機暫存事件」，不會再自動排程上傳。`);
    } catch (err) { setMessage(err instanceof Error ? err.message : '轉為手機暫存失敗；事件仍保留在上傳隊列。'); }
  }

  async function forceCleanupLocalRecords() {
    const removable = localDraftsRef.current.filter(draft =>
      (!draft.syncStatus || draft.syncStatus === 'draft') &&
      !uploadingLocalWorkIds.current.has(draft.id) &&
      !uploadControllers.current.has(draft.id)
    );
    if (!removable.length) {
      setMessage('沒有可強制清理的手機暫存記錄；已取消上傳、排程中、上傳中及失敗記錄均會保留。');
      return;
    }
    if (!window.confirm(`強制清理 ${removable.length} 筆手機暫存事件及其本機附件？此操作無法復原；已取消上傳記錄、排程中、上傳中、失敗及後台已上傳事件均不會被清除。`)) return;
    try {
      for (const draft of removable) await deleteLocalDraft(draft.id);
      const removedIds = new Set(removable.map(draft => draft.id));
      localDraftsRef.current = localDraftsRef.current.filter(draft => !removedIds.has(draft.id));
      setLocalDrafts(old => old.filter(draft => !removedIds.has(draft.id)));
      setMessage(`已強制清理 ${removable.length} 筆手機暫存記錄及其附件；已取消上傳記錄已保留。`);
    } catch (err) {
      const remaining = await loadLocalDrafts().catch(() => localDraftsRef.current);
      localDraftsRef.current = remaining;
      setLocalDrafts(remaining);
      setMessage(err instanceof Error ? err.message : '強制清理未能完全完成；已重新讀取本機記錄，請再次檢查。');
    }
  }

  async function forceClearUploadCases() {
    const targets = localDraftsRef.current.filter(draft => ['queued','uploading','failed','cancelled'].includes(draft.syncStatus || ''));
    if (!targets.length) {
      setMessage('目前沒有可強制清除的上傳個案；手機暫存及已上傳的後台事件不受影響。');
      return;
    }
    const active = targets.filter(draft => uploadingLocalWorkIds.current.has(draft.id) || uploadControllers.current.has(draft.id) || draft.syncStatus === 'uploading');
    if (!window.confirm(`強制清除 ${targets.length} 筆上傳個案？將先中止 ${active.length} 筆正在上傳的工作，再刪除所有 queued／uploading／failed／cancelled 本機隊列記錄及其附件。此操作無法復原；不會刪除手機暫存（draft）或已成功上傳至後台的事件。`)) return;
    const targetIds = new Set(targets.map(draft => draft.id));
    const activeIds = new Set(active.map(draft => draft.id));
    activeIds.forEach(id => forceDeletingUploadIds.current.add(id));
    // Remove from the scheduler's source of truth before aborting to prevent a queued
    // item from being picked up while IndexedDB deletions are in progress.
    localDraftsRef.current = localDraftsRef.current.filter(draft => !targetIds.has(draft.id));
    targets.forEach(draft => uploadControllers.current.get(draft.id)?.abort());
    try {
      for (const draft of targets) await deleteLocalDraft(draft.id);
      setLocalDrafts(old => old.filter(draft => !targetIds.has(draft.id)));
      for (const draft of targets) {
        if (!activeIds.has(draft.id)) forceDeletingUploadIds.current.delete(draft.id);
      }
      setMessage(`已強制中止並清除 ${targets.length} 筆上傳個案及其本機附件；手機暫存與後台已上傳事件保留。`);
    } catch (err) {
      const remaining = await loadLocalDrafts().catch(() => localDraftsRef.current);
      localDraftsRef.current = remaining;
      setLocalDrafts(remaining);
      for (const draft of targets) forceDeletingUploadIds.current.delete(draft.id);
      setMessage(err instanceof Error ? `強制清除未能完全完成：${err.message}。已重新載入仍存在的本機記錄。` : '強制清除未能完全完成；已重新載入仍存在的本機記錄。');
    }
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
    if (!versionCheckComplete || updateRequired || versionCheckError || !localDrafts.length) return;
    const expired = localDrafts.filter(draft => remainingMs(draft.createdAt, clockNow) <= 0);
    if (!expired.length) return;
    setLocalDrafts(current => current.filter(draft => remainingMs(draft.createdAt, clockNow) > 0));
    void Promise.all(expired.map(draft => deleteLocalDraft(draft.id).catch(() => {})));
  }, [clockNow, localDrafts, versionCheckComplete, updateRequired, versionCheckError]);
  useEffect(() => {
    if (!versionCheckComplete || updateRequired || versionCheckError || !remoteOnline || !token || !user) return;
    // Periodic queue pump is deliberately independent of the health badge. The
    // actual upload request handles offline/HTTP failures and keeps the draft.
    const timer = window.setInterval(() => startNextQueuedUpload(), 15000);
    window.setTimeout(() => startNextQueuedUpload(), 0);
    return () => window.clearInterval(timer);
  }, [token, user, versionCheckComplete, updateRequired, versionCheckError, remoteOnline]);
  const tabs = useMemo(() => {
    const base: [string,string][] = user?.role === 'admin'
      ? [['notifications', '通知'], ['registered-devices', '註冊設備'], ['device-users', '用戶列表'], ['device-work', '事件記錄'], ['logins', '登入記錄'], ['audit', '操作稽核'], ['clear-records', '清除持久化記錄']]
      : [['print', '打印'], ['events', '事件管理'], ['notifications', '通知'], ['profile', '個人資料']];
    return base;
  }, [user?.role, notifications]);
  const displayedVersion = serverVersion || APP_VERSION;
  const displayedEnvironment = environmentLabel(serverEnvironment || BUILD_ENVIRONMENT);
  const forceRefresh = async () => {
    if (forceUpdatingRef.current) return;
    forceUpdatingRef.current = true;
    setForceUpdating(true);
    setMessage('');
    try {
      if (schemaUpdateRequired) {
        localDatabaseResetInProgress = true;
        uploadControllers.current.forEach(controller => controller.abort());
        const deadline = Date.now() + 10000;
        while (uploadControllers.current.size > 0 && Date.now() < deadline) {
          await new Promise(resolve => window.setTimeout(resolve, 100));
        }
        if (uploadControllers.current.size > 0) throw new Error('仍有上傳程序未停止。為避免資料損壞，尚未清除本機資料；請稍後再確認更新。');
        await deleteLocalDatabase(() => setMessage('正在等待其他分頁關閉本機資料庫連線；請關閉其他已開啟的系統分頁。'));
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(registration => registration.unregister()));
      }
      if ('caches' in window) {
        const cacheNames = await window.caches.keys();
        await Promise.all(cacheNames.map(cacheName => window.caches.delete(cacheName)));
      }
      // The marker lets the freshly loaded login screen show completion without a spinner.
      window.location.replace(`${window.location.pathname}?forceUpdate=${Date.now()}`);
    } catch (error) {
      forceUpdatingRef.current = false;
      setForceUpdating(false);
      setMessage(`強制更新失敗：${error instanceof Error ? error.message : '請重試。'}`);
    }
  };
  if (!versionCheckComplete) return <main className="auth-shell"><section className="panel auth-panel update-required" role="status"><div className="brand">事件管理系統</div><h1>正在檢查系統更新</h1><p>正在確認系統版本及本機資料庫相容性，請稍候。</p></section></main>;
  if (versionCheckError) return <main className="auth-shell"><section className="panel auth-panel update-required" role="alert"><div className="brand">事件管理系統</div><h1>無法安全檢查本機資料庫</h1><p>{versionCheckError}</p><p>為避免資料結構不相容或意外遺失，本系統暫停使用。請依照上方提示更新瀏覽器或關閉其他已開啟的系統分頁後重新載入。</p><button className="full" onClick={() => window.location.reload()}>重新檢查</button></section></main>;
  if (schemaUpdateRequired) return <main className="schema-update-shell" role="dialog" aria-modal="true" aria-labelledby="schema-update-title"><section className="schema-update-modal"><div className="schema-update-eyebrow">必要的資料庫結構更新</div><div className="brand">事件管理系統</div><h1 id="schema-update-title">確認更新並重建本機資料庫</h1><p>偵測到新版本需要不同的 IndexedDB 結構。為避免舊資料與新結構衝突，必須先清除本機資料庫，再更新系統並重新建立所需資料表。</p><div className="schema-version-row"><span>目前執行系統版本</span><strong>v{APP_VERSION}</strong><span>伺服器目標版本</span><strong>v{serverVersion || '—'}</strong></div><div className="schema-version-row"><span>目前本機資料庫版本</span><strong>{localDbVersion}</strong><span>新版本要求</span><strong>{serverDbSchemaVersion}</strong></div><section className="schema-update-detail"><h2>本次更新內容</h2><p>{updateSummary}</p></section><section className="schema-update-warning"><h2>風險及會清除的資料</h2><p>{updateRisks}</p><ul><li>尚未上傳的本機暫存事件、上傳隊列及其附件會永久刪除。</li><li>本機保存的打印機偏好與事件流水號亦會清除；更新後會重新建立空白資料庫。</li><li>已上傳到後台的工作記錄與附件不受影響；本操作不會刪除伺服器資料。</li></ul></section><p className="schema-update-final-warning">此操作無法復原。在你按下確認前，系統不會清除 IndexedDB 或程式快取，也不會重新載入；確認後會先停止本機上傳，再清除整個本機資料庫、清理 Service Worker／Cache Storage，最後重新載入新版本並按新結構重新建立資料庫。</p><button className="full schema-update-confirm" disabled={forceUpdating} onClick={() => void forceRefresh()}>{forceUpdating ? <><span className="loading-spinner" aria-hidden="true" />正在清除本機資料並更新…</> : '確認更新並清除本機資料'}</button>{message && <p className="notice">{message}</p>}</section></main>;
  if (updateRequired) return <main className="auth-shell"><section className="panel auth-panel update-required" role="alert"><div className="brand">事件管理系統</div><h1>需要更新系統</h1><p>伺服器已更新至 v{serverVersion}，目前裝置仍在使用 v{APP_VERSION}。為確保功能及資料相容，請先更新再繼續使用。</p><p className="version-label">環境：{displayedEnvironment}</p><button className="full" disabled={forceUpdating} onClick={() => void forceRefresh()}>{forceUpdating ? '正在清理程式快取並重新載入…' : '立即強制更新並重新載入'}</button>{message && <p className="notice">{message}</p>}</section></main>;
  if (!user) return <><div className={`remote-status ${remoteOnline ? 'online' : 'offline'}`} role="status"><span className="remote-light" />{remoteOnline ? '遠端已連線' : '遠端未連線'} </div><main className="auth-shell"><section className="panel auth-panel"><div className="brand">事件管理系統</div><small className="version-label">v{displayedVersion} · {displayedEnvironment}</small>
    {isDesktop && <div className="actions"><button className={adminMode ? 'secondary' : ''} onClick={() => { setAdminMode(false); setMessage(''); }}>一般用戶</button><button className={adminMode ? '' : 'secondary'} onClick={() => { setAdminMode(true); setMessage(''); }}>管理員登入</button></div>}
    {adminMode && isDesktop ? <><p className="muted">管理員請使用伺服器 .env 設定的固定帳號及密碼登入。</p><label>管理員帳號<input value={adminUsernameInput} onChange={e => setAdminUsernameInput(e.target.value)} autoComplete="username" /></label><label>管理員密碼<input type="password" value={adminPasswordInput} onChange={e => setAdminPasswordInput(e.target.value)} autoComplete="current-password" onKeyDown={e => { if (e.key === 'Enter' && adminUsernameInput && adminPasswordInput && !busy) void adminLogin(); }} /></label><button className="full" disabled={busy || !adminUsernameInput || !adminPasswordInput} onClick={() => void adminLogin()}>{busy ? '登入中…' : '管理員登入'}</button></> : <><p className="muted">一般用戶使用 Passkey 安全登入。</p>{(isDesktop || isRegisterMode) && <label>帳號<input value={username} onChange={e => updateUsername(e.target.value)} autoComplete="username" placeholder="例如：operator01" /></label>}{isRegisterMode && <div className="registration-fields"><label>員工編號（必填，只限 0-9）<input required inputMode="numeric" pattern="[0-9]+" value={employeeNumber} onChange={e => setEmployeeNumber(e.target.value.replace(/[^0-9]/g, ''))} placeholder="例如：0123" /></label><label>名稱（選填）<input value={employeeName} onChange={e => setEmployeeName(e.target.value)} placeholder="員工姓名" /></label><label>聯絡電話（選填）<input type="tel" inputMode="tel" value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="聯絡電話" /></label><label>電郵（選填）<input type="email" autoComplete="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="name@example.com" /></label></div>}<div className="actions">{!isRegisterMode && <button disabled={busy || (isDesktop && !username)} onClick={login}>{busy ? '處理中…' : 'Passkey 登入'}</button>}{isRegisterMode ? <><button disabled={busy || !username || !employeeNumber || !/^[0-9]+$/.test(employeeNumber) } onClick={register}>{busy ? '註冊中…' : '確認註冊 Passkey'}</button><button className="secondary" disabled={busy} onClick={() => { setIsRegisterMode(false); setMessage(''); }}>取消</button></> : <button className="secondary" disabled={busy} onClick={() => { setIsRegisterMode(true); setMessage(''); }}>新用戶註冊</button>}</div><p className="hint">首次使用請先註冊。管理員帳號僅能透過桌面版的固定帳密登入。</p></>}
    {!isDesktop && <button type="button" className="secondary full mobile-force-update" disabled={busy || forceUpdating || forceUpdateComplete} onClick={() => void forceRefresh()}>{forceUpdating ? <><span className="loading-spinner" aria-hidden="true" />正在清除快取並重新載入…</> : forceUpdateComplete ? '✓ PWA 更新完成' : '清理程式緩存'}</button>}{message && <p className="notice">{message}</p>}</section></main></>;

  return <div className="app-shell"><header className="topbar"><div className="mobile-brand-block"><div className="mobile-header-first-row"><div className="brand">事件管理系統</div><button className="secondary compact mobile-logout" onClick={logout}>登出</button>{user.role !== 'admin' && <span className={`remote-status inline header-remote-status ${remoteOnline ? 'online' : 'offline'}`} role="status" aria-label={remoteOnline ? '遠端已連線' : '遠端未連線'} title={remoteOnline ? '遠端已連線' : '遠端未連線'}><span className="remote-light" /></span>}</div>{user.role === 'admin' && <small className="desktop-system-version">v{displayedVersion}</small>}<div className="mobile-header-meta-row"><div className="mobile-header-system"><span className="meta-version">v{displayedVersion}</span><span className="meta-environment">{displayedEnvironment}</span>{user.role !== 'admin' && <span className="device-code-meta">設備編號 {deviceCode || '同步中'}</span>}</div><div className="mobile-header-user"><span className="mobile-username">{user.username}</span><span className="mobile-header-storage"><button type="button" className="storage-label storage-label-trigger" aria-expanded={showStorageTooltip} onClick={() => setShowStorageTooltip(value => !value)}>空間</button><button type="button" className={`storage-meter ${localStorageInfo.usageBytes / Math.max(1, localStorageInfo.quotaBytes) >= 0.9 ? 'critical' : localStorageInfo.usageBytes / Math.max(1, localStorageInfo.quotaBytes) >= 0.5 ? 'warning' : ''}`} aria-label={`設備使用空間 ${formatUsedStorage(localStorageInfo.usageBytes)} / ${formatStorageGB(localStorageInfo.quotaBytes)}`} aria-expanded={showStorageTooltip} onClick={() => setShowStorageTooltip(value => !value)}><span className="storage-meter-fill" style={{ width: `${Math.max(0, Math.min(100, localStorageInfo.usageBytes / Math.max(1, localStorageInfo.quotaBytes) * 100))}%` }} /></button></span></div></div></div><div className="account"><span>{user.username}</span><button className="secondary compact" onClick={logout}>登出</button>{user.role !== 'admin' && <span className={`remote-status inline account-remote-status ${remoteOnline ? 'online' : 'offline'}`} role="status"><span className="remote-light" />{remoteOnline ? '遠端連線' : '遠端離線'}</span>}</div></header>
    {showStorageTooltip && <div className="storage-popup-overlay" role="presentation" onClick={() => setShowStorageTooltip(false)}><section className="storage-popup storage-capacity" role="dialog" aria-modal="true" aria-label="本機暫存容量估算" onClick={event => event.stopPropagation()}>
      <div className="storage-capacity-heading"><strong>本機暫存容量（估算）</strong><button type="button" className="storage-popup-close" aria-label="關閉容量資訊" onClick={() => setShowStorageTooltip(false)}>×</button></div>
      <div className="storage-capacity-heading"><strong>已使用 {formatUsedStorage(localStorageInfo.usageBytes)}</strong><strong>上限 {formatStorageGB(localStorageInfo.quotaBytes)}</strong></div>
      <p>剩餘估算 {Math.max(0, localStorageInfo.quotaBytes - localStorageInfo.usageBytes) / 1024 ** 3 < 0.01 ? (Math.max(0, localStorageInfo.quotaBytes - localStorageInfo.usageBytes) / 1024 ** 2).toFixed(0) + ' MB' : (Math.max(0, localStorageInfo.quotaBytes - localStorageInfo.usageBytes) / 1024 ** 3).toFixed(2) + ' GB'}</p>
      <progress max="100" value={Math.min(100, localStorageInfo.usageBytes / Math.max(1, localStorageInfo.quotaBytes) * 100)} />
      <small>{localStorageInfo.measured ? '已使用量按本機暫存事件附件大小估算；配額上限取自瀏覽器回報的此 PWA 網站儲存配額，並非整部手機的總磁碟容量。' : '此瀏覽器無法提供可靠配額；暫以 5 GB 作為本機暫存上限，已使用量按本機事件附件估算。'}</small>
      {localStorageInfo.usageBytes / Math.max(1, localStorageInfo.quotaBytes) >= 0.8 && <p className="storage-warning">儲存空間已使用 {Math.round(localStorageInfo.usageBytes / Math.max(1, localStorageInfo.quotaBytes) * 100)}%，建議先同步事件或刪除不需要的本機暫存附件。</p>}
    </section></div>}
    {uploadProgress && <div className="upload-progress global-upload-progress" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" /><strong>正在上傳附件，請稍候…</strong></div>}<nav className="tabs">{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'tab active' : 'tab'} onClick={() => { setTab(key); setMessage(''); }}>{label}{key === 'notifications' && notifications.filter(n => !n.isRead).length > 0 && <span className="notification-unread-bubble" aria-label={`${notifications.filter(n => !n.isRead).length} 則未讀`}>{notifications.filter(n => !n.isRead).length > 99 ? '99+' : notifications.filter(n => !n.isRead).length}</span>}</button>)}</nav>
    <main className="content">
      {message && <div className="notice" role="status">{message}<button className="notice-close" onClick={() => setMessage('')}>×</button></div>}
            {tab === 'print' && user.role !== 'admin' && <section className="grid two">
        <article className="panel"><h2>打印</h2><p className="muted">可重複按「選取打印機」重新開啟裝置選擇器，切換到其他支援 BLE GATT 的打印機。需要 HTTPS；iPhone／iPad 的 Safari 不支援 Web Bluetooth。</p>
          <div className="printer-card"><div className="printer-icon">▤</div><div><strong>{printer?.name || savedPrinter?.device_name || '尚未選取打印機'}</strong><p className="muted">{printer?.characteristic ? '已連接 · 可打印' : printer ? '已選取 · 尚未連接' : '請選取打印機'}</p></div></div>
          <div className="actions"><button disabled={busy} onClick={() => void scanPrinter()}>選取打印機</button><button className="secondary" disabled={busy || !printer} onClick={() => void connectPrinter()}>{printer?.characteristic ? '重新連接' : '連接打印機'}</button></div>
          <label>測試收據備註（會打印在收據上，最多 500 字）<textarea rows={3} maxLength={500} value={printNote} onChange={e => setPrintNote(e.target.value)} placeholder="例如：櫃檯 A／紙卷更換後測試／設備編號 PR-01" /></label>
          <label>ESC/POS 字碼表索引（依打印機手冊）<input type="number" min="0" max="255" value={codePageIndex} onChange={e => setCodePageIndex(e.target.value)} /></label>
          <p className="hint">測試收據使用模擬商品與付款金額，不代表真實交易。文字以 Big5 編碼；不同打印機的 Big5 code page 編號可能不同。</p>
          <div className="actions"><button className="secondary" type="button" onClick={() => setShowReceiptPreview(true)}>預覽</button><button disabled={busy || !printer?.characteristic} onClick={() => void printTest()}>{busy ? '打印中…' : '打印測試'}</button></div></article>
      </section>}
      {showReceiptPreview && <div className="storage-popup-overlay" role="presentation" onClick={() => setShowReceiptPreview(false)}><section className="storage-popup receipt-preview-popup" role="dialog" aria-modal="true" aria-label="測試付款收據預覽" onClick={event => event.stopPropagation()}>
        <div className="storage-capacity-heading"><strong>測試付款收據預覽</strong><button type="button" className="storage-popup-close" aria-label="關閉預覽" onClick={() => setShowReceiptPreview(false)}>×</button></div>
        <div className="receipt-preview">
          <div className="receipt-title">示範商店 · 付款收據</div><p>地址：澳門示範路 88 號</p><p>電話：+853 2888 1234</p><hr/>
          <p>單號：TEST-20261011-001</p><p>日期：{new Date().toLocaleString('zh-TW')}</p><p>收銀員：測試帳戶</p><hr/>
          <div className="receipt-columns"><span>商品／項目</span><span>數量／金額</span></div><div className="receipt-columns"><span>咖啡飲品（測試）× 1</span><span>$28.00</span></div>
          <div className="receipt-columns"><span>午餐套餐（測試）× 2</span><span>$96.00</span></div><div className="receipt-columns"><span>會員折扣</span><span>-$6.00</span></div><hr/>
          <div className="receipt-columns"><span>小計</span><span>$118.00</span></div><div className="receipt-columns"><span>稅項（示範）</span><span>$0.00</span></div>
          <div className="receipt-columns total"><span>應付總額</span><span>$118.00</span></div><div className="receipt-columns"><span>現金付款</span><span>$120.00</span></div><div className="receipt-columns"><span>找零</span><span>$2.00</span></div>
          <p>付款方式：現金（模擬）</p><p>交易參考：DEMO-NOT-A-REAL-PAYMENT</p><p>狀態：打印測試，非真實交易</p><hr/>
          <p>備註：{printNote.trim() || '（未填寫）'}</p><p className="receipt-footer">感謝惠顧，歡迎再次光臨</p>
        </div>
      </section></div>}
      {tab === 'notifications' && user.role === 'admin' && <><section className="panel"><h2>發送通知</h2><p className="muted">通知集中於此頁管理。通知會保存到客戶端站內通知中心；如已設定 VAPID，亦會向指定已訂閱設備或所有已訂閱設備發送 Web Push。管理員不顯示自己的通知收件匣。</p><form onSubmit={sendAdminNotification}><label>接收對象<select value={notificationTarget} onChange={e=>setNotificationTarget(e.target.value)}><option value="">廣播所有已訂閱設備</option>{(adminDashboard?.clients || []).filter(c => Number(c.pushSubscribed || 0) > 0).map(c=><option key={c.clientId} value={c.clientId}>{c.username} · {c.clientId.slice(0,8)}… {c.online ? '（在線）' : '（離線）'} · 已訂閱推播</option>)}</select></label><label>通知標題<input required maxLength={200} value={notificationTitle} onChange={e=>setNotificationTitle(e.target.value)} placeholder="例如：系統維護通知" /></label><label>通知內容<textarea required maxLength={5000} rows={4} value={notificationBody} onChange={e=>setNotificationBody(e.target.value)} placeholder="輸入要通知客戶端的訊息" /></label><button disabled={busy || !notificationTitle.trim() || !notificationBody.trim()}>{notificationTarget ? '推播指定設備' : '廣播所有已訂閱設備'}</button></form></section><section className="panel admin-sent-notifications"><div className="admin-heading"><div><h2>已發送通知記錄</h2><p className="muted">共 {adminSentNotifications.length} 則；每 3 秒自動更新，按發送時間由新至舊排列。</p></div><button type="button" className="secondary compact" disabled={busy} onClick={() => api('/admin/notifications', token).then(rows => setAdminSentNotifications(rows)).catch(err => setMessage(err instanceof Error ? err.message : '通知記錄讀取失敗'))}>立即刷新</button></div>{adminSentNotifications.length === 0 ? <p className="muted">目前沒有已發送的通知記錄。</p> : adminSentNotifications.map(n => <article className="notification-card" key={n.id}><div className="notification-header"><div className="notification-title"><strong>{n.title}</strong><small>發送時間：{formatTimestampUTC8(n.createdAt)}</small></div><div className="notification-read"><span className="status">已保存</span></div></div><p className="notification-body">{n.body}</p><div className="notification-footer"><span className="muted">{n.targetClientId ? '指定設備：' + (n.targetUsername || '未知用戶') + (n.deviceCode ? ' · 設備編號 ' + n.deviceCode : '') : '接收對象：廣播所有設備'}</span><span className="muted">{n.pushConfigured ? 'Web Push：' + (n.pushSent ?? 0) + '/' + (n.pushTotal ?? 0) + ' 成功' : 'Web Push：未設定 VAPID／僅保存站內通知'}</span></div></article>)}</section></>}
            {tab === 'notifications' && user.role !== 'admin' && <section className="panel"><div className="admin-heading"><div><h2>通知</h2><p className="muted">通知保存在伺服器 SQLite，每 3 秒自動更新；重新登入後仍可查看。啟用 Web App 推播後，即使 App 在背景也可接收系統通知（視瀏覽器及作業系統支援而定）。</p></div></div><div className="actions notification-subscription-actions"><button disabled={busy} onClick={() => void subscribePush()}>訂閱推播訊息</button><button type="button" className="secondary compact" disabled={busy || !notifications.some(n => !n.isRead)} onClick={() => void markAllNotificationsRead()}>全部標記已讀</button></div><p className="hint">iPhone／iPad：請先將網站加入主畫面並從主畫面開啟；Android：請使用最新版 Chrome 或支援 Web Push 的瀏覽器。兩者均須使用 HTTPS 並允許通知。</p>{notifications.length === 0 ? <p className="muted">目前沒有通知。</p> : notifications.map(n => <article className="notification-card" key={n.id}><div className="notification-header"><div className="notification-title"><strong>{n.title}</strong><small>{formatTimestampUTC8(n.createdAt)}</small></div><div className="notification-read">{n.isRead ? <span className="status">已讀</span> : <button className="secondary compact" onClick={() => void markNotificationRead(n.id)}>標記已讀</button>}</div></div><p className="notification-body">{n.body}</p><div className="notification-footer"><span className="muted">{n.targetClientId ? '指定給此客戶端' : '全體廣播'}</span></div></article>)}</section>}{tab === 'profile' && user.role !== 'admin' && <section className="grid two"><article className="panel"><h2>個人資料</h2><p className="muted">可更新員工資料及聯絡方式；帳戶識別只使用登入用戶名，且不可在此修改。</p><form onSubmit={saveProfile}><label>登入用戶名<input value={user.username} readOnly disabled /></label><label>員工編號（必填，只限 0-9）<input required inputMode="numeric" pattern="[0-9]+" value={profile.employeeNumber} onChange={e=>setProfile(p=>({...p,employeeNumber:e.target.value.replace(/[^0-9]/g,'')}))} /></label><label>員工姓名<input maxLength={100} value={profile.employeeName} onChange={e=>setProfile(p=>({...p,employeeName:e.target.value}))} /></label><label>聯絡電話<input type="tel" maxLength={40} value={profile.contactPhone} onChange={e=>setProfile(p=>({...p,contactPhone:e.target.value}))} /></label><label>電郵<input type="email" maxLength={254} value={profile.contactEmail} onChange={e=>setProfile(p=>({...p,contactEmail:e.target.value}))} /></label><button disabled={busy || !/^[0-9]+$/.test(profile.employeeNumber)}>{busy ? '保存中…' : '保存個人資料'}</button></form></article><article className="panel"><h2>帳戶與設備</h2><p>登入用戶名：<strong>{user.username}</strong></p><p className="hint">用戶名是 Passkey 登入帳戶的固定識別，不允許從個人資料頁修改。如需更正登入用戶名，請聯絡管理員處理。</p></article></section>}{tab === 'events' && user.role !== 'admin' && <section className="grid two">
        <article className="panel"><h2>建立事件</h2><p className="muted">新事件預設只儲存在這部手機的瀏覽器，不會自動上傳。需要時可手動上傳系統，或使用目前已連接的熱敏打印機列印固定測試收據。</p>
          <form onSubmit={saveLocalWork}><label>事件標題<input required maxLength={200} value={workTitle} onChange={e=>setWorkTitle(e.target.value)} placeholder="例如：設備檢查、付款異常、客戶跟進" /></label><label>事件內容／工作備註<textarea rows={5} maxLength={10000} value={workContent} onChange={e=>setWorkContent(e.target.value)} placeholder="記錄事件經過、處理方式及備註" /></label><label className="event-date-field">事件日期與時間<input className="event-datetime-input" type="datetime-local" value={workDate} onChange={e=>setWorkDate(e.target.value)} /></label><label>圖片／影片附件（可多選）<input type="file" accept="image/*,video/*,.heic,.heif,.mov,.mp4,.m4v,.3gp,.3g2,.webm,.mkv,.avi,.mts,.m2ts" multiple onChange={e=>{
            const selectedFiles=Array.from(e.target.files || []);
            const oversized=selectedFiles.filter(file=>file.size>MAX_ATTACHMENT_BYTES);
            const validFiles=selectedFiles.filter(file=>file.size<=MAX_ATTACHMENT_BYTES);
            const fileIdentity=(file:File)=>[file.name,file.size,file.lastModified,file.type].join('::');
            const knownFiles=new Set(workMedia.map(fileIdentity));
            const additions:File[]=[];
            let duplicateCount=0;
            let limitCount=0;
            for(const file of validFiles){
              const identity=fileIdentity(file);
              if(knownFiles.has(identity)){duplicateCount++;continue;}
              if(workMedia.length+additions.length>=20){limitCount++;continue;}
              knownFiles.add(identity);
              additions.push(file);
            }
            const mergedFiles=[...workMedia,...additions];
            setWorkMedia(mergedFiles);
            e.target.value='';
            setAttachmentUploadStatuses(old=>{
              const next={...old};
              additions.forEach(file=>{
                const index=mergedFiles.indexOf(file);
                next[formAttachmentKey(file,index)]='pending';
              });
              return next;
            });
            const issues:string[]=[];
            if(oversized.length) issues.push('超過 500 MiB 上限：'+oversized.map(file=>file.name+'（'+(file.size/1024/1024).toFixed(1)+' MiB）').join('、'));
            if(duplicateCount) issues.push('已略過 '+duplicateCount+' 個重複附件。');
            if(limitCount) issues.push('每個事件最多 20 個附件；已保留先前選取及新增的前 20 個合規附件。');
            setMessage(issues.length ? '附件選取結果：'+issues.join('；') : (additions.length ? '已追加 '+additions.length+' 個新附件。' : '沒有新增附件；已保留先前選取的文件。'));
          }} /></label><p className="muted">已選取 {workMedia.length} 個附件；每個事件最多 20 個圖片／影片，單一檔案上限 500 MiB（約 524 MB）。</p>
          {workMedia.map((file,i)=>{const key=formAttachmentKey(file,i);const status=attachmentUploadStatuses[key] || 'pending';const percent=attachmentUploadPercents[key] ?? 0;return <div className="attachment-progress-item" key={key}><div className="attachment-row"><span className="attachment-name">{file.type.startsWith('video/') || /\.(mov|mp4|m4v|3gp|3g2|webm|mkv|avi|mts|m2ts)$/i.test(file.name)?'影片':'圖片'}：{file.name}（{(file.size/1024/1024).toFixed(1)} MB）</span><button type="button" className="attachment-remove-button" disabled={workSubmitting} aria-label={`移除附件 ${file.name}`} onClick={()=>removeSelectedAttachment(i)}>移除</button><span className={`attachment-status status-${status}`}>{status==='uploading'?<><span className="loading-spinner small-spinner" />上傳中 {percent}%</>:status==='uploaded'?'已上傳 100%':status==='failed'?'上傳失敗':'待上傳'}</span></div>{(status==='uploading'||status==='uploaded'||status==='failed')&&<div className="attachment-progress-track"><span className={`attachment-progress-fill status-${status}`} style={{width:`${status==='uploaded'?100:percent}%`}} /></div>}</div>})}<div className="actions"><button type="submit" disabled={workSubmitting || !workTitle.trim()}>暫存於手機</button><button type="button" disabled={workSubmitting || !workTitle.trim()} onClick={()=>void uploadCurrentWork()}>上傳至後台</button></div></form>
          <p className="hint">手機暫存只保存在目前瀏覽器／裝置；清除網站資料或更換裝置可能導致暫存遺失。暫存內容不會出現在後台，直到按下「上傳系統」。</p>
        </article>
        <article className="panel"><div className="admin-heading"><div><h2>手機暫存事件</h2><p className="muted">尚未上傳：{localDrafts.filter(draft => (!draft.syncStatus || draft.syncStatus === 'draft') && remainingMs(draft.createdAt, clockNow) > 0).length} 項</p></div><div className="actions">{localDrafts.some(draft => (!draft.syncStatus || draft.syncStatus === 'draft') && remainingMs(draft.createdAt, clockNow) > 0) && <button type="button" className="danger compact" onClick={()=>void forceCleanupLocalRecords()}>清除全部暫存記錄</button>}</div></div>
          {!localDrafts.some(draft => (!draft.syncStatus || draft.syncStatus === 'draft') && remainingMs(draft.createdAt, clockNow) > 0) ? <p className="muted">尚無 24 小時內的已暫存事件。</p> : localDrafts.filter(draft => (!draft.syncStatus || draft.syncStatus === 'draft') && remainingMs(draft.createdAt, clockNow) > 0).map(draft=><div className="work-event-card" key={draft.id}><div className="list-heading"><strong>{draft.title}</strong><small>{draft.eventDate || draft.createdAt}</small></div><p className="event-code">事件編號：{draft.eventCode || '上傳時補發'}</p><p className="muted">{draft.content || '（沒有備註）'}</p><p className="muted">附件：{draft.media.length} 個 · 尚未上傳</p>{draft.media.length > 0 && <div className="media-list">{draft.media.map((m,i)=>{const key=draftAttachmentKey(draft.id,i,m);const status=attachmentUploadStatuses[key] || 'pending';const percent=attachmentUploadPercents[key] ?? 0;const showUploadUi=draft.syncStatus !== 'cancelled';return <div className="attachment-progress-item" key={m.id || key}><div className="attachment-row"><button type="button" className="media-open-button attachment-open" onClick={()=>openMediaViewer(m, draft.createdAt)}>{m.kind === 'video' || m.mimeType?.startsWith('video/') ? '▶ 影片' : '檢視圖片'}：{m.originalName || m.name || ('附件 '+(i+1))}</button>{showUploadUi && <span className={`attachment-status status-${status}`}>{status==='uploading'?<><span className="loading-spinner small-spinner" />上傳中 {percent}%</>:status==='uploaded'?'已上傳 100%':status==='failed'?'上傳失敗':'待上傳'}</span>}</div>{showUploadUi && (status==='uploading'||status==='uploaded'||status==='failed')&&<div className="attachment-progress-track"><span className={`attachment-progress-fill status-${status}`} style={{width:`${status==='uploaded'?100:percent}%`}} /></div>}</div>})}</div>}<div className="actions"><button disabled={busy} onClick={()=>void enqueueLocalDraftForUpload(draft)}>上傳至後台</button><button className="danger compact" disabled={busy} onClick={()=>void deleteLocalWork(draft.id)}>刪除暫存</button></div><div className="expiry-countdown"><span className="expiry-label">本地保存期間：{countdownLabel(draft.createdAt, clockNow).label}</span><div className="expiry-track" aria-label="本地保存剩餘時間"><span style={{width:`${countdownLabel(draft.createdAt, clockNow).percent}%`}} /></div></div></div>)}
        </article>
        <article className="panel"><div className="admin-heading"><div><h2>上傳隊列</h2><p className="muted">中斷或等待重試：{localDrafts.filter(draft => ['queued','uploading','failed','cancelled'].includes(draft.syncStatus || '') && remainingMs(draft.createdAt, clockNow) > 0).length} 項</p></div>{localDrafts.some(draft => ['queued','uploading','failed','cancelled'].includes(draft.syncStatus || '') && remainingMs(draft.createdAt, clockNow) > 0) && <div className="actions"><button type="button" className="danger compact" onClick={()=>void forceClearUploadCases()}>強制清理上傳記錄</button></div>}</div>
          {!localDrafts.some(draft => ['queued','uploading','failed','cancelled'].includes(draft.syncStatus || '') && remainingMs(draft.createdAt, clockNow) > 0) ? <p className="muted">目前沒有排程中的事件。</p> : localDrafts.filter(draft => ['queued','uploading','failed','cancelled'].includes(draft.syncStatus || '') && remainingMs(draft.createdAt, clockNow) > 0).map(draft=><div className="work-event-card" key={draft.id}><div className="list-heading"><strong>{draft.title}</strong><small>{draft.eventDate || draft.createdAt}</small></div><p className="event-code">事件編號：{draft.eventCode || '上傳時補發'}</p><p className="muted">{draft.content || '（沒有備註）'}</p><p className="muted">附件：{draft.media.length} 個 · {draft.syncStatus === 'queued' ? `已排程 · 派發序號 ${draft.uploadDispatchSeq ?? '—'}，按加入隊列順序等待上傳` : draft.syncStatus === 'uploading' ? `正在上傳 · 派發序號 ${draft.uploadDispatchSeq ?? '—'}；可取消本次上傳` : draft.syncStatus === 'cancelled' ? '已取消上傳' : '上次上傳失敗，等待手動重新排程'}</p>{draft.media.length > 0 && <div className="media-list">{draft.media.map((m,i)=>{const key=draftAttachmentKey(draft.id,i,m);const status=attachmentUploadStatuses[key] || 'pending';const percent=attachmentUploadPercents[key] ?? 0;return <div className="attachment-progress-item" key={m.id || key}><div className="attachment-row"><button type="button" className="media-open-button attachment-open" onClick={()=>openMediaViewer(m, draft.createdAt)}>{m.kind === 'video' || m.mimeType?.startsWith('video/') ? '▶ 影片' : '檢視圖片'}：{m.originalName || m.name || ('附件 '+(i+1))}</button><span className={`attachment-status status-${status}`}>{status==='uploading'?<><span className="loading-spinner small-spinner" />上傳中 {percent}%</>:status==='uploaded'?'已上傳 100%':status==='failed'?'上傳失敗':'待上傳'}</span></div>{(status==='uploading'||status==='uploaded'||status==='failed')&&<div className="attachment-progress-track"><span className={`attachment-progress-fill status-${status}`} style={{width:`${status==='uploaded'?100:percent}%`}} /></div>}</div>})}</div>}<div className="actions queue-actions">
              {draft.syncStatus === 'queued' || draft.syncStatus === 'uploading'
                ? <button className="secondary compact" onClick={()=>void cancelLocalWork(draft)}>取消上傳</button>
                : draft.syncStatus === 'cancelled' || draft.syncStatus === 'failed'
                  ? <>
                      <button className="secondary compact" onClick={()=>void continueLocalWork(draft)}>繼續上傳</button>
                      <button className="secondary compact" onClick={()=>void convertQueueItemToDraft(draft)}>轉為暫存</button>
                    </>
                  : null}
            </div><div className="expiry-countdown"><span className="expiry-label">本地保存期間：{countdownLabel(draft.createdAt, clockNow).label}</span><div className="expiry-track" aria-label="本地保存剩餘時間"><span style={{width:`${countdownLabel(draft.createdAt, clockNow).percent}%`}} /></div></div></div>)}
        </article>
        <article className="panel"><h2>已上傳事件</h2><p className="muted">只顯示目前登入客戶端已上傳至系統的工作記錄。點擊附件會在頁面內開啟預覽，不會離開目前畫面。</p>{!uploadedWork.some(item => remainingMs(item.createdAt, clockNow) > 0) ? <p className="muted">尚無 24 小時內的已上傳事件。</p> : uploadedWork.filter(item => remainingMs(item.createdAt, clockNow) > 0).map(item=><div className="work-event-card" key={item.id}><div className="list-heading"><strong>{item.title}</strong><small>{item.eventDate || item.createdAt}</small></div>{item.eventCode && <p className="event-code">事件編號：{item.eventCode}</p>}<p className="muted">{item.content || '（沒有備註）'}</p><div className="media-list">{(item.media || []).map((m,i)=><div className="attachment-row" key={m.id || i}><button type="button" className="media-open-button attachment-open" onClick={()=>openMediaViewer(m, item.createdAt)}>{m.kind==='video' || m.mimeType?.startsWith('video/') ? '▶ 影片' : '檢視圖片'}：{m.originalName || m.name || ('附件 '+(i+1))}</button><span className="attachment-file-size">({((m.size || 0)/1024/1024).toFixed(1)}MB)</span></div>)}</div><div className="expiry-countdown"><span className="expiry-label">查看期限：{countdownLabel(item.createdAt, clockNow).label}</span><div className="expiry-track" aria-label="查看剩餘時間"><span style={{width:`${countdownLabel(item.createdAt, clockNow).percent}%`}} /></div></div></div>)}</article>
      </section>}
      {tab === 'clear-records' && <section className="grid two"><article className="panel"><h2>清除持久化記錄</h2><p className="muted">勾選需要刪除的資料類別。這是永久刪除操作，請先確認備份。</p>{[['events','事件及其圖片／影片附件'],['jobs','每日及手動工作記錄'],['logins','登入／登出歷史記錄'],['printer_preferences','伺服器保存的打印機偏好'],['push_subscriptions','推播訂閱資料']] .map(([key,label]) => <label className="check-row" key={key}><input type="checkbox" checked={clearSelections.includes(key)} onChange={e => setClearSelections(old => e.target.checked ? [...old,key] : old.filter(x => x !== key))} />{label}</label>)}<label className="check-row"><input type="checkbox" checked={clearLocalPrinter} onChange={e => setClearLocalPrinter(e.target.checked)} />本機瀏覽器 IndexedDB 打印機偏好</label><div className="warning-note">為保留可追溯性，操作稽核記錄不會被此頁清除；系統會追加一筆「清除記錄」操作。使用者帳戶、Passkey 與目前登入工作階段不會被刪除。</div><button className="danger" disabled={busy || (!clearSelections.length && !clearLocalPrinter)} onClick={clearPersistentRecords}>{busy ? '清除中…' : '永久清除所選記錄'}</button></article><article className="panel"><h2>資料保存位置</h2><p>伺服器資料庫：<code>./data/app.sqlite</code></p><p>事件媒體檔案：<code>./uploads/</code></p><p>本機打印機偏好：瀏覽器 IndexedDB（資料庫 <code>esc-printing-local</code>）。</p><p className="hint">清除事件會同時刪除事件資料、附件資料庫索引及對應媒體檔案。清除伺服器資料只影響此應用程式資料，不會清除瀏覽器的網站權限或作業系統藍牙配對。</p></article></section>}
      {tab === 'jobs' && <section className="grid two"><article className="panel"><h2>建立工作記錄</h2><form onSubmit={saveJob}><label>標題<input required value={jobTitle} onChange={e => setJobTitle(e.target.value)} /></label><label>內容<textarea rows={4} value={jobDetail} onChange={e => setJobDetail(e.target.value)} /></label><button disabled={busy}>新增工作</button></form><p className="hint">系統每日 00:00（Asia/Singapore 預設）建立一筆自動工作記錄。伺服器必須持續運行才能觸發排程；啟動時亦會補上當日缺失記錄。</p></article><article className="panel"><h2>工作歷史 <span className="count">{jobs.length}</span></h2><div className="table-wrap"><table><thead><tr><th>日期</th><th>工作</th><th>狀態</th><th>內容</th></tr></thead><tbody>{jobs.map(j => <tr key={j.id}><td>{j.job_date}</td><td>{j.title}</td><td><span className="status">{j.status}</span></td><td>{j.detail}</td></tr>)}</tbody></table></div></article></section>}
      {tab === 'logins' && <section className="panel"><h2>登入人員及歷史記錄</h2><div className="table-wrap"><table><thead><tr><th>時間</th><th>使用者</th><th>事件</th><th>結果</th><th>說明</th></tr></thead><tbody>{logins.map(l => <tr key={l.id}><td>{formatTimestampUTC8(l.created_at)}</td><td>{l.username}</td><td>{l.event}</td><td>{l.success ? '成功' : '失敗'}</td><td>{l.detail}</td></tr>)}</tbody></table></div></section>}

      {tab === 'registered-devices' && user.role === 'admin' && <section className="admin-layout">
        <div className="admin-heading"><div><h2>註冊設備</h2><p className="muted">整合設備註冊資料與客戶端即時狀態；客戶端每 3 秒回報，後台每 3 秒刷新。最後更新：{adminDashboard?.serverTime || '讀取中…'}</p></div><button className="secondary" disabled={busy} onClick={() => refreshAdmin().catch(e => setMessage(e.message))}>立即刷新</button></div>
        <div className="admin-stats">
          <article className="stat-card"><span>已註冊用戶</span><strong>{adminDashboard?.users.filter(a => a.role !== 'admin').length ?? '—'}</strong></article>
          <article className="stat-card"><span>在線客戶端</span><strong>{adminDashboard?.clients.filter(c => c.online).length ?? '—'}</strong></article>
          <article className="stat-card"><span>已上傳工作</span><strong>{adminDashboard?.deviceWork.length ?? '—'}</strong></article>
        </div>
        <article className="panel"><div className="admin-heading"><div><h3>已註冊設備及其用戶</h3><p className="muted">設備列表已包含在線狀態、版本、瀏覽器、藍牙／打印機狀態及關聯用戶。管理員目前使用的設備不會列入。</p></div><span className="count">{adminDashboard?.devices.length || 0} 部設備</span></div>
          <div className="table-wrap"><table><thead><tr><th>設備／設備碼</th><th>客戶端狀態</th><th>打印機 / 訂閱</th><th>建立時間</th><th>關聯註冊用戶</th><th>操作</th></tr></thead><tbody>{(adminDashboard?.devices || []).map(d=><tr key={d.clientId}>
            <td><button type="button" className="text-link" onClick={() => { setSelectedAdminDeviceId(d.clientId); setTab('device-detail'); setMessage(''); }}><strong>{d.deviceCode}</strong></button><small>{d.clientId}</small><small>{d.appVersion ? `v${d.appVersion}` : '版本未知'} · {d.appEnvironment === 'production' ? '正式環境' : d.appEnvironment === 'test' ? '測試環境' : '環境未知'}</small>{d.appVersion && (d.appVersion !== (adminDashboard?.appVersion || APP_VERSION) || d.appEnvironment !== (adminDashboard?.appEnvironment || BUILD_ENVIRONMENT)) && <small className="muted">需要更新</small>}</td>
            <td><span className={`live-pill ${d.online ? 'online' : 'offline'}`}>{d.online ? '在線' : '離線'}</span><small>{d.currentUsername ? '目前用戶：' + d.currentUsername : '目前沒有登入用戶'}</small><small>最近回報：{d.lastSeen ? formatTimestampUTC8(d.lastSeen) : '從未回報'}</small><small>{d.userAgent || '瀏覽器資訊未知'}</small></td>
            <td><small>{d.online && d.printerConnected && d.printerName ? d.printerName : '未連接'}</small><small>{Number(d.pushSubscribed || 0) > 0 ? '已訂閱推播' : '未訂閱推播'}</small></td>
            <td>{formatTimestampUTC8(d.createdAt)}</td>
            <td>{d.registeredUsers.length ? <div>{d.registeredUsers.map(u=><div key={u.id} className="registered-device-user"><button type="button" className="text-link" onClick={() => { setSelectedAdminUserId(u.id); setTab('user-detail'); setMessage(''); }}><strong>{u.username}</strong></button><small>關聯時間：{formatTimestampUTC8(u.registeredAt)}</small><small>最近關聯：{formatTimestampUTC8(u.lastSeen)}</small></div>)}</div> : <small>尚未關聯帳戶</small>}</td>
            <td><button className="danger compact" disabled={busy || d.clientId===clientId} onClick={()=>{const names=d.registeredUsers.map(u=>u.username);const detail=names.length ? '\n關聯用戶：'+names.join('、') : '\n此設備目前沒有關聯用戶';if(window.confirm('確定永久刪除整部註冊設備？'+detail+'\n\n此操作會刪除設備及所有關聯的一般用戶帳戶、Passkey、工作階段、該設備上傳的工作記錄及附件。登入歷史與操作稽核會保留。此操作無法復原。')) void adminAction('/admin/devices/'+encodeURIComponent(d.clientId),{method:'DELETE'},'註冊設備及其關聯用戶已刪除');}}>刪除整部設備</button></td>
          </tr>)}</tbody></table>{!adminDashboard?.devices.length && <p className="muted">尚無已註冊設備。</p>}</div>
        </article>
      </section>}
      {tab === 'device-users' && user.role === 'admin' && <section className="panel">
        <div className="admin-heading"><div><h2>所有已註冊用戶</h2><p className="muted">列出所有已註冊的一般用戶。點擊用戶名稱可查看完整資料、編輯帳戶資料及查看關聯設備；登入用戶名不可修改。</p></div><span className="count">{(adminDashboard?.users || []).filter(a => a.role !== 'admin').length} 個用戶</span></div>
        <div className="table-wrap"><table><thead><tr><th>用戶</th><th>員工編號</th><th>建立時間</th><th>Passkey／工作階段</th><th>最後登入</th><th>關聯設備</th><th>操作</th></tr></thead><tbody>{(adminDashboard?.users || []).filter(a => a.role !== 'admin').map(a => <tr key={a.id}>
          <td><button type="button" className="text-link" onClick={() => { setSelectedAdminUserId(a.id); setTab('user-detail'); setMessage(''); }}><strong>{a.username}</strong></button></td>
          <td>{a.employeeNumber || '—'}</td><td>{formatTimestampUTC8(a.createdAt)}</td><td>{a.passkeyCount}／{a.activeSessions}</td><td>{formatTimestampUTC8(a.lastLogin)}</td>
          <td>{(a.linkedDevices || []).length ? a.linkedDevices!.map(d => <div key={d.clientId}><button type="button" className="text-link" onClick={() => { setSelectedAdminDeviceId(d.clientId); setTab('device-detail'); setMessage(''); }}><strong>{d.deviceCode}</strong></button></div>) : <small>尚無關聯設備</small>}</td>
          <td><button type="button" className="secondary compact" onClick={() => { setSelectedAdminUserId(a.id); setTab('user-detail'); setMessage(''); }}>用戶詳情</button> <button type="button" className="danger compact" disabled={busy || a.role === 'admin' || Number(a.activeSessions) === 0} onClick={() => { if (window.confirm('確定強制登出用戶「' + a.username + '」的所有工作階段？')) void adminAction('/admin/users/' + encodeURIComponent(a.id) + '/logout', { method:'POST' }, '已強制登出用戶的所有工作階段'); }}>強制登出</button></td>
        </tr>)}</tbody></table>{!(adminDashboard?.users || []).some(a => a.role !== 'admin') && <p className="muted">尚無已註冊用戶。</p>}</div>
      </section>}
      {tab === 'device-detail' && user.role === 'admin' && (() => {
        const d = (adminDashboard?.devices || []).find(item => item.clientId === selectedAdminDeviceId);
        if (!d) return <section className="panel"><button type="button" className="secondary compact" onClick={() => setTab('registered-devices')}>← 返回註冊設備列表</button><h2>找不到註冊設備</h2><p className="muted">設備可能已刪除，請返回列表重新選擇。</p></section>;
        return <section className="admin-layout">
          <div className="admin-heading"><div><button type="button" className="secondary compact" onClick={() => setTab('registered-devices')}>← 返回註冊設備列表</button><h2>註冊設備詳情：{d.deviceCode}</h2><p className="muted">設備識別碼：{d.clientId}</p></div><span className="count">{d.registeredUsers.length} 個關聯用戶</span></div>
          <article className="panel"><h3>設備資料</h3><div className="grid two"><div><p>設備碼：<strong>{d.deviceCode}</strong></p><p>建立時間：{formatTimestampUTC8(d.createdAt)}</p><p>在線狀態：<span className={d.online ? 'live-pill online' : 'live-pill offline'}>{d.online ? '在線' : '離線'}</span></p><p>最近活動：{d.lastSeen ? formatTimestampUTC8(d.lastSeen) : '從未回報'}</p></div><div><p>目前版本：{d.appVersion ? 'v' + d.appVersion : '版本未知'}</p><p>環境：{d.appEnvironment === 'production' ? '正式環境' : d.appEnvironment === 'test' ? '測試環境' : '環境未知'}</p><p>瀏覽器：{d.userAgent || '未知'}</p><p>關聯用戶數：{d.registeredUsers.length}</p></div></div></article>
          <article className="panel"><h3>此設備相關用戶</h3><p className="muted">點擊用戶名稱查看用戶詳情及其所有關聯設備。</p>
            {d.registeredUsers.length ? <div className="table-wrap"><table><thead><tr><th>用戶</th><th>登入用戶名</th><th>首次關聯</th><th>最近關聯</th><th>操作</th></tr></thead><tbody>{d.registeredUsers.map(u => <tr key={u.id}><td><button type="button" className="text-link" onClick={() => { setSelectedAdminUserId(u.id); setTab('user-detail'); setMessage(''); }}><strong>{u.username}</strong></button></td><td>{u.username}</td><td>{formatTimestampUTC8(u.registeredAt)}</td><td>{formatTimestampUTC8(u.lastSeen)}</td><td><button type="button" className="secondary compact" onClick={() => { setSelectedAdminUserId(u.id); setTab('user-detail'); setMessage(''); }}>用戶詳情</button> <button type="button" className="danger compact" disabled={busy || !d.online || d.currentUserId !== u.id} onClick={() => { if (window.confirm('確定強制登出用戶「' + u.username + '」在此設備上的工作階段？')) void adminAction('/admin/clients/' + encodeURIComponent(d.clientId) + '/logout', { method:'POST' }, '已發出此設備的強制登出指令'); }}>強制登出</button></td></tr>)}</tbody></table></div> : <p className="muted">此設備尚無關聯用戶。</p>}
          </article>
          <article className="panel"><h3>危險操作</h3><p className="warning-note">刪除設備會一併刪除所有關聯的一般用戶帳戶、Passkey、工作階段、此設備上傳的工作記錄及附件。登入歷史與操作稽核會保留。</p><button type="button" className="danger" disabled={busy || d.clientId === clientId} onClick={() => { const names = d.registeredUsers.map(u => u.username); const detail = names.length ? '\n關聯用戶：' + names.join('、') : '\n此設備目前沒有關聯用戶'; if (window.confirm('確定永久刪除整部註冊設備？' + detail + '\n\n此操作無法復原。')) { void adminAction('/admin/devices/' + encodeURIComponent(d.clientId), { method:'DELETE' }, '註冊設備及其關聯用戶已刪除').then(() => { setSelectedAdminDeviceId(''); setTab('registered-devices'); }); } }}>刪除整部設備及其用戶</button></article>
        </section>;
      })()}
      {tab === 'user-detail' && user.role === 'admin' && (() => {
        const a = (adminDashboard?.users || []).find(item => item.id === selectedAdminUserId);
        if (!a) return <section className="panel"><button type="button" className="secondary compact" onClick={() => setTab('device-users')}>← 返回設備用戶列表</button><h2>找不到用戶</h2><p className="muted">用戶可能已刪除，請返回列表重新選擇。</p></section>;
        return <section className="admin-layout">
          <div className="admin-heading"><div><button type="button" className="secondary compact" onClick={() => setTab('device-users')}>← 返回用戶列表</button><h2>用戶詳情：{a.username}</h2><p className="muted">登入用戶名為固定識別，不可修改。</p></div><span className="count">{(a.linkedDevices || []).length} 部關聯設備</span></div>
          <section className="grid two">
            <article className="panel"><h3>帳戶資料</h3><p>登入用戶名：<strong>{a.username}</strong></p><p>員工編號：{a.employeeNumber || '—'}</p><p>員工姓名：{a.employeeName || '—'}</p><p>聯絡電話：{a.contactPhone || '—'}</p><p>電郵：{a.contactEmail || '—'}</p><p>建立時間：{formatTimestampUTC8(a.createdAt)}</p><p>Passkey 數量：{a.passkeyCount}</p><p>有效工作階段：{a.activeSessions}</p><p>最後登入：{formatTimestampUTC8(a.lastLogin)}</p></article>
            <article className="panel"><h3>編輯用戶資料</h3><p className="muted">可修改此用戶的個人資料；不會更改登入用戶名。</p><form onSubmit={e => { e.preventDefault(); const d = new FormData(e.currentTarget); void adminAction('/admin/users/' + a.id + '/profile', { method:'PUT', body:JSON.stringify({ employeeNumber:String(d.get('employeeNumber') || ''), employeeName:String(d.get('employeeName') || ''), contactPhone:String(d.get('contactPhone') || ''), contactEmail:String(d.get('contactEmail') || '') }) }, '用戶個人資料已更新'); }}>
              <label>登入用戶名<input value={a.username} disabled readOnly /></label><label>員工編號<input name="employeeNumber" required inputMode="numeric" pattern="[0-9]+" defaultValue={a.employeeNumber || ''} /></label><label>員工姓名<input name="employeeName" maxLength={100} defaultValue={a.employeeName || ''} /></label><label>聯絡電話<input name="contactPhone" maxLength={40} defaultValue={a.contactPhone || ''} /></label><label>電郵<input name="contactEmail" type="email" maxLength={254} defaultValue={a.contactEmail || ''} /></label><button disabled={busy || a.role === 'admin'}>保存用戶資料</button>
            </form></article>
          </section>
          <article className="panel"><h3>相關連結設備</h3><p className="muted">點擊設備名稱可查看設備詳情及該設備上的其他關聯用戶。</p>
            {(a.linkedDevices || []).length ? <div className="table-wrap"><table><thead><tr><th>設備</th><th>設備識別碼</th><th>首次關聯</th><th>最近關聯</th><th>操作</th></tr></thead><tbody>{a.linkedDevices!.map(d => { const device = (adminDashboard?.devices || []).find(item => item.clientId === d.clientId); return <tr key={d.clientId}><td><button type="button" className="text-link" onClick={() => { setSelectedAdminDeviceId(d.clientId); setTab('device-detail'); setMessage(''); }}><strong>{d.deviceCode}</strong></button></td><td><small>{d.clientId}</small></td><td>{formatTimestampUTC8(d.registeredAt)}</td><td>{formatTimestampUTC8(d.lastSeen)}</td><td><button type="button" className="secondary compact" onClick={() => { setSelectedAdminDeviceId(d.clientId); setTab('device-detail'); setMessage(''); }}>設備詳情</button>{device && <div><small>{device.online ? '在線' : '離線'} · {device.appVersion ? 'v' + device.appVersion : '版本未知'}</small></div>}</td></tr>; })}</tbody></table></div> : <p className="muted">此用戶目前沒有已登記的關聯設備。</p>}
          </article>
          <article className="panel"><h3>危險操作</h3><p className="warning-note">強制刪除會撤銷其工作階段並刪除 Passkey、推播訂閱及帳戶關聯；登入歷史與操作稽核會保留。此操作無法復原。</p><button type="button" className="danger" disabled={busy || a.id === user.id || a.role === 'admin'} onClick={() => { if (window.confirm('確定強制刪除用戶「' + a.username + '」？此操作無法復原。')) { void adminAction('/admin/users/' + a.id, { method:'DELETE' }, '用戶已刪除').then(() => { setSelectedAdminUserId(''); setTab('device-users'); }); } }}>強制刪除用戶</button></article>
        </section>;
      })()}
      {tab === 'device-work' && user.role === 'admin' && <section className="panel"><div className="admin-heading"><div><h2>所有設備的上傳記錄</h2><p className="muted">只顯示已上傳至伺服器的記錄，刪除後會從伺服器、附件儲存及客戶端列表同步移除。</p></div><span className="count">{adminDashboard?.deviceWork.length || 0} 筆</span></div><div className="table-wrap"><table><thead><tr><th>上傳時間</th><th>設備／用戶</th><th>事件日期</th><th>標題／附件</th><th>內容</th><th>操作</th></tr></thead><tbody>{(adminDashboard?.deviceWork || []).map(w=><tr key={w.id}><td>{formatTimestampUTC8(w.createdAt)}</td><td><strong>{w.username}</strong><div><small>{w.clientId.slice(0,8)}…</small></div></td><td>{w.eventDate || '—'}</td><td>{w.title}<div className="media-list">{(w.media || []).map((m,i)=><button type="button" className="media-open-button" key={m.id || i} onClick={()=>openMediaViewer(m, w.createdAt)}>{m.kind==='video' || m.mimeType?.startsWith('video/') ? '▶ 播放影片' : '檢視圖片'}：{m.originalName || m.name || ('附件 '+(i+1))}</button>)}</div></td><td>{w.content || '—'}</td><td><button className="danger compact" disabled={busy} onClick={()=>{if(window.confirm('確定永久刪除這筆設備工作記錄及所有附件？刪除後客戶端也會同步移除。')) void adminAction('/admin/device-work/'+encodeURIComponent(w.id),{method:'DELETE'},'工作記錄及附件已刪除，客戶端將同步更新');}}>刪除</button></td></tr>)}</tbody></table></div>{!adminDashboard?.deviceWork.length && <p className="muted">尚無設備上傳的工作記錄。</p>}</section>}
      {tab === 'audit' && <section className="panel"><h2>操作稽核歷史</h2><div className="table-wrap"><table><thead><tr><th>時間</th><th>人員</th><th>操作</th><th>類型</th><th>對象 ID</th><th>內容</th></tr></thead><tbody>{audits.map(a => <tr key={a.id}><td>{formatTimestampUTC8(a.created_at)}</td><td>{a.username || 'system'}</td><td>{a.action}</td><td>{a.entity_type}</td><td>{a.entity_id}</td><td>{a.detail}</td></tr>)}</tbody></table></div></section>}
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