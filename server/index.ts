import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import cron from 'node-cron';
import webpush from 'web-push';
import iconvLite from 'iconv-lite';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from '@simplewebauthn/server';
import { db } from './db.js';

const adminUsername = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
const adminPassword = String(process.env.ADMIN_PASSWORD || '');
if (adminUsername) {
  db.prepare("UPDATE users SET role='user' WHERE role='admin' AND username<>?").run(adminUsername);
  db.prepare("UPDATE users SET role='admin' WHERE username=?").run(adminUsername);
} else {
  db.prepare("UPDATE users SET role='user' WHERE role='admin'").run();
}

const app = express();
const port = Number(process.env.PORT || 8787);
const appVersion = String(process.env.APP_VERSION || (JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string }).version || '0.1.1');
const appEnvironment = String(process.env.APP_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'test'));
const origin = process.env.APP_ORIGIN || 'http://localhost:5173';
const rpID = process.env.RP_ID || new URL(origin).hostname;
const rpName = process.env.RP_NAME || 'PWA ESC Printing';
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
fs.mkdirSync(uploadDir, { recursive: true });
app.use(cors({ origin: [origin, 'http://localhost:5173'], credentials: false }));
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(uploadDir));

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

const id = () => crypto.randomUUID();
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function getDeviceCode(clientId: string): string {
  const existing = db.prepare('SELECT device_code FROM client_devices WHERE client_id=?').get(clientId) as { device_code:string } | undefined;
  if (existing) return existing.device_code;
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += base58Alphabet[crypto.randomInt(base58Alphabet.length)];
    try {
      db.prepare('INSERT INTO client_devices(client_id,device_code) VALUES(?,?)').run(clientId, code);
      return code;
    } catch (error) {
      const retry = db.prepare('SELECT device_code FROM client_devices WHERE client_id=?').get(clientId) as {device_code:string}|undefined;
      if (retry) return retry.device_code;
      if (!(error instanceof Error) || !/UNIQUE constraint failed/i.test(error.message)) throw error;
    }
  }
  throw new Error('無法分配設備碼，請稍後重試。');
}
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const audit = (user: any, action: string, type?: string, entityId?: string, detail?: unknown) =>
  db.prepare('INSERT INTO audit_log(user_id,username,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?,?)')
    .run(user?.id || null, user?.username || null, action, type || null, entityId || null, detail ? JSON.stringify(detail) : null);
const publicUser = (u: any) => ({ id: u.id, username: u.username, role: u.role, employeeNumber: u.employee_number || '', employeeName: u.employee_name || '', contactPhone: u.contact_phone || '', contactEmail: u.contact_email || '' });
const auth = (req: any, res: any, next: any) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const session = db.prepare('SELECT s.user_id,s.client_id,s.token_hash,s.login_type,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(token), Date.now()) as any;
  if (!session) return res.status(401).json({ error: 'Session expired; please sign in again' });
  req.user = session; next();
};
const requireAdmin = (req: any, res: any, next: any) => {
  const ua = String(req.headers['user-agent'] || '');
  if (req.user?.role !== 'admin' || req.user?.login_type !== 'admin_password') {
    return res.status(403).json({ error: 'Administrator password login required' });
  }
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua)) {
    return res.status(403).json({ error: 'The administrator console is available on desktop browsers only' });
  }
  next();
};
const requireRegularUser = (req: any, res: any, next: any) => {
  if (req.user?.role === 'admin') return res.status(403).json({ error: '打印功能只供一般用戶使用。' });
  next();
};
const challenge = (kind: string, value: string) => {
  const cid = id();
  db.prepare('INSERT INTO challenges(id,challenge,kind,expires_at) VALUES(?,?,?,?)').run(cid, value, kind, Date.now() + 5 * 60_000);
  return cid;
};
const takeChallenge = (cid: string, kind: string) => {
  const row = db.prepare('SELECT * FROM challenges WHERE id=? AND kind=? AND expires_at>?').get(cid, kind, Date.now()) as any;
  if (row) db.prepare('DELETE FROM challenges WHERE id=?').run(cid);
  return row?.challenge as string | undefined;
};

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'PWA ESC Printing API' }));
app.get('/api/version', (_req, res) => res.set('Cache-Control', 'no-store').json({ version: appVersion, environment: appEnvironment }));
app.get('/api/config', (_req, res) => res.json({ rpName, rpID, origin, vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '' }));

// Public passkey enrollment for ordinary users. The env-configured administrator is password-only.
app.post('/api/auth/register/options', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  if (adminUsername && username === adminUsername) return res.status(403).json({ error: 'This username is reserved for administrator password login' });
  const employeeNumber = String(req.body.employeeNumber ?? '');
  const employeeName = String(req.body.employeeName || '').trim();
  const contactPhone = String(req.body.contactPhone || '').trim();
  const contactEmail = String(req.body.contactEmail || '').trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ error: '帳號必須為 3-40 個字元，只可使用 a-z、0-9、點、底線或連字號。' });
  if (!/^[0-9]+$/.test(employeeNumber)) return res.status(400).json({ error: '員工編號必須填寫，而且只允許 0-9 數字。' });
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return res.status(400).json({ error: '電郵格式不正確。' });
  let user = db.prepare('SELECT * FROM users WHERE username=?').get(username) as any;
  if (user?.role === 'admin') return res.status(403).json({ error: 'Administrator accounts cannot register a passkey' });
  const existing = user ? db.prepare('SELECT credential_id,transports FROM passkeys WHERE user_id=?').all(user.id) as any[] : [];
  if (existing.length > 0) return res.status(409).json({ error: '此帳號已註冊 Passkey，請直接登入。' });
  const existingEmployee = db.prepare('SELECT username FROM users WHERE employee_number=? AND username<>?').get(employeeNumber, username) as any;
  if (existingEmployee) return res.status(409).json({ error: '此員工編號已註冊，請聯絡管理員。' });
  if (user) {
    db.prepare('UPDATE users SET display_name=?,employee_number=?,employee_name=?,contact_phone=?,contact_email=? WHERE id=?')
      .run(username, employeeNumber, employeeName || null, contactPhone || null, contactEmail || null, user.id);
    user = { ...user, display_name: username, employee_number: employeeNumber, employee_name: employeeName || null, contact_phone: contactPhone || null, contact_email: contactEmail || null };
  } else {
    user = { id: id(), username, display_name: username, employee_number: employeeNumber, employee_name: employeeName || null, contact_phone: contactPhone || null, contact_email: contactEmail || null, role: 'user' };
    db.prepare('INSERT INTO users(id,username,display_name,employee_number,employee_name,contact_phone,contact_email,role) VALUES(?,?,?,?,?,?,?,?)')
      .run(user.id, username, username, employeeNumber, employeeName || null, contactPhone || null, contactEmail || null, user.role);
  }
  const options = await awaitRegistrationOptions(user, existing);
  const cid = challenge('register', options.challenge);
  res.json({ ...options, challengeId: cid, userId: user.id });
});
async function awaitRegistrationOptions(user: any, existing: any[]) {
  return generateRegistrationOptions({
    rpName, rpID, userName: user.username, userDisplayName: user.username,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((c: any) => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    preferredAuthenticatorType: 'localDevice'
  });
}
app.post('/api/auth/register/verify', async (req, res) => {
  try {
    const { username, challengeId, response } = req.body;
    const clientId = String(req.body.clientId || '').slice(0, 128) || crypto.randomUUID();
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).toLowerCase()) as any;
    const expectedChallenge = takeChallenge(challengeId, 'register');
    if (!user || !expectedChallenge) return res.status(400).json({ error: 'Registration challenge expired or invalid' });
    const verification = await verifyRegistrationResponse({ response: response as RegistrationResponseJSON, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID });
    if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'Passkey registration was not verified' });
    const info: any = verification.registrationInfo;
    const cred = info.credential || { id: info.credentialID, publicKey: info.credentialPublicKey, counter: info.counter, transports: response.response?.transports };
    db.prepare('INSERT OR REPLACE INTO passkeys(credential_id,user_id,public_key,counter,transports) VALUES(?,?,?,?,?)')
      .run(cred.id, user.id, Buffer.from(cred.publicKey).toString('base64url'), cred.counter || 0, JSON.stringify(cred.transports || response.response?.transports || []));
    const deviceCode = getDeviceCode(clientId);
    db.prepare('INSERT INTO user_devices(user_id,client_id) VALUES(?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET last_seen=CURRENT_TIMESTAMP').run(user.id, clientId);
    audit(publicUser(user), 'auth.passkey_registered', 'user', user.id, { clientId, deviceCode });
    res.json({ verified: true, deviceCode, clientId });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Registration failed' }); }
});
app.post('/api/auth/login/options', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  if (username && adminUsername && username === adminUsername) return res.status(403).json({ error: 'Use administrator password login on a desktop browser' });
  let user: any = null;
  let allowCredentials: any[] | undefined;
  if (username) {
    user = db.prepare('SELECT * FROM users WHERE username=?').get(username) as any;
    if (!user) { db.prepare('INSERT INTO login_events(username,event,success,detail) VALUES(?,?,0,?)').run(username, 'login', 'Unknown username'); return res.status(404).json({ error: 'User not found; register a passkey first' }); }
    const creds = db.prepare('SELECT credential_id,transports FROM passkeys WHERE user_id=?').all(user.id) as any[];
    if (!creds.length) return res.status(400).json({ error: 'No passkey registered for this user' });
    allowCredentials = creds.map((c: any) => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined }));
  }
  // No allowCredentials means WebAuthn can discover the user from a resident/discoverable Passkey.
  const options = await generateAuthenticationOptions({ rpID, ...(allowCredentials ? { allowCredentials } : {}), userVerification: 'preferred' });
  const cid = challenge('login', options.challenge);
  res.json({ ...options, challengeId: cid, ...(username ? { username } : {}) });
});
app.post('/api/auth/login/verify', async (req, res) => {
  const { username, challengeId, response } = req.body;
  const expectedChallenge = takeChallenge(challengeId, 'login');
  let user: any = null;
  let stored: any = null;
  try {
    if (!expectedChallenge || !response?.id) throw new Error('Challenge expired or invalid');
    stored = db.prepare('SELECT * FROM passkeys WHERE credential_id=?').get(response.id) as any;
    if (!stored) throw new Error('Passkey not registered');
    user = db.prepare('SELECT * FROM users WHERE id=?').get(stored.user_id) as any;
    if (!user || (username && user.username !== String(username).toLowerCase())) throw new Error('Passkey does not match this account');
    const credential: WebAuthnCredential = { id: stored.credential_id, publicKey: Buffer.from(stored.public_key, 'base64url'), counter: stored.counter, transports: stored.transports ? JSON.parse(stored.transports) : [] } as any;
    const verification = await verifyAuthenticationResponse({ response: response as AuthenticationResponseJSON, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, credential });
    if (!verification.verified) throw new Error('Passkey verification failed');
    db.prepare('UPDATE passkeys SET counter=? WHERE credential_id=?').run(verification.authenticationInfo.newCounter, stored.credential_id);
    const token = crypto.randomBytes(32).toString('base64url');
    const clientId = String(req.body.clientId || '').slice(0, 128) || crypto.randomUUID();
    const deviceCode = getDeviceCode(clientId);
    db.prepare('INSERT INTO user_devices(user_id,client_id) VALUES(?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET last_seen=CURRENT_TIMESTAMP').run(user.id, clientId);
    db.prepare('INSERT INTO sessions(token_hash,user_id,client_id,expires_at) VALUES(?,?,?,?)').run(hash(token), user.id, clientId, Date.now() + 7 * 24 * 60 * 60_000);
    db.prepare('INSERT INTO login_events(user_id,username,event,success,detail) VALUES(?,?,?,1,?)').run(user.id, user.username, 'login', 'WebAuthn passkey verified');
    audit(publicUser(user), 'auth.login_success', 'user', user.id);
    res.json({ token, user: publicUser(user), deviceCode, clientId });
  } catch (e) {
    db.prepare('INSERT INTO login_events(user_id,username,event,success,detail) VALUES(?,?,?,0,?)').run(user?.id || null, String(username || '(empty)'), 'login', e instanceof Error ? e.message : 'Verification failed');
    res.status(401).json({ error: e instanceof Error ? e.message : 'Login failed' });
  }
});
app.post('/api/auth/logout', auth, (req: any, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
  if (req.user.client_id) db.prepare("UPDATE client_status SET online=0, last_seen=CURRENT_TIMESTAMP WHERE client_id=?").run(req.user.client_id);
  db.prepare('INSERT INTO login_events(user_id,username,event,success,detail) VALUES(?,?,?,1,?)').run(req.user.id, req.user.username, 'logout', 'User signed out');
  audit(req.user, 'auth.logout', 'user', req.user.id); res.json({ ok: true });
});
app.post('/api/admin/login', async (req: any, res) => {
  if (!adminUsername || !adminPassword) return res.status(503).json({ error: 'Set ADMIN_USERNAME and ADMIN_PASSWORD in the server .env file' });
  const ua = String(req.headers['user-agent'] || '');
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua)) {
    return res.status(403).json({ error: 'Administrator login is available on desktop browsers only' });
  }
  const suppliedUsername = String(req.body.username || '').trim().toLowerCase();
  const suppliedPassword = String(req.body.password || '');
  const passwordMatches = crypto.timingSafeEqual(
    crypto.createHash('sha256').update(suppliedPassword).digest(),
    crypto.createHash('sha256').update(adminPassword).digest()
  );
  if (suppliedUsername !== adminUsername || !passwordMatches) {
    db.prepare('INSERT INTO login_events(username,event,success,detail) VALUES(?,?,0,?)').run(suppliedUsername || '(empty)', 'admin_login', 'Invalid administrator credentials');
    return res.status(401).json({ error: 'Invalid administrator username or password' });
  }
  let user = db.prepare('SELECT * FROM users WHERE username=?').get(adminUsername) as any;
  if (!user) {
    user = { id: id(), username: adminUsername, display_name: 'Administrator', role: 'admin' };
    db.prepare('INSERT INTO users(id,username,display_name,role) VALUES(?,?,?,?)').run(user.id, user.username, user.display_name, user.role);
  } else {
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
    user.role = 'admin';
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const clientId = String(req.body.clientId || '').slice(0, 128) || crypto.randomUUID();
  db.prepare('INSERT INTO sessions(token_hash,user_id,client_id,login_type,expires_at) VALUES(?,?,?,?,?)')
    .run(hash(token), user.id, clientId, 'admin_password', Date.now() + 7 * 24 * 60 * 60_000);
  db.prepare('INSERT INTO login_events(user_id,username,event,success,detail) VALUES(?,?,?,1,?)').run(user.id, user.username, 'admin_login', 'Administrator password verified');
  audit(publicUser(user), 'auth.admin_login_success', 'user', user.id);
  res.json({ token, user: publicUser(user) });
});
app.get('/api/me', auth, (req: any, res) => {
  const user = publicUser(req.user);
  // An old Passkey session for the configured admin must not expose admin navigation.
  if (user.role === 'admin' && req.user.login_type !== 'admin_password') user.role = 'user';
  res.json({ user });
});
app.put('/api/me', auth, requireRegularUser, (req: any, res) => {
  const employeeNumber = String(req.body.employeeNumber ?? '').trim();
  const employeeName = String(req.body.employeeName || '').trim().slice(0, 100);
  const contactPhone = String(req.body.contactPhone || '').trim().slice(0, 40);
  const contactEmail = String(req.body.contactEmail || '').trim().slice(0, 254);
  if (!/^[0-9]+$/.test(employeeNumber)) return res.status(400).json({ error: '員工編號必須填寫，而且只允許 0-9 數字。' });
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return res.status(400).json({ error: '電郵格式不正確。' });
  const duplicate = db.prepare('SELECT id FROM users WHERE employee_number=? AND id<>?').get(employeeNumber, req.user.id);
  if (duplicate) return res.status(409).json({ error: '此員工編號已被其他帳戶使用。' });
  db.prepare('UPDATE users SET display_name=username,employee_number=?,employee_name=?,contact_phone=?,contact_email=? WHERE id=?').run(employeeNumber, employeeName || null, contactPhone || null, contactEmail || null, req.user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id) as any;
  audit(updated, 'user.profile_updated', 'user', updated.id, { fields: ['employeeNumber','employeeName','contactPhone','contactEmail'] });
  res.json({ user: publicUser(updated) });
});

app.post('/api/client/heartbeat', auth, (req: any, res) => {
  const clientId = String(req.body.clientId || req.user.client_id || '').slice(0, 128);
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  if (req.user.client_id && req.user.client_id !== clientId) return res.status(403).json({ error: 'Client session mismatch' });
  if (!req.user.client_id) db.prepare('UPDATE sessions SET client_id=? WHERE token_hash=?').run(clientId, req.user.token_hash);
  const body = req.body || {};
  if (req.user.role !== 'admin') db.prepare('INSERT INTO user_devices(user_id,client_id) VALUES(?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET last_seen=CURRENT_TIMESTAMP').run(req.user.id, clientId);
  db.prepare(`INSERT INTO client_status(client_id,user_id,username,online,bluetooth_supported,bluetooth_connected,printer_connected,printer_name,printer_id,user_agent,app_version,app_environment,last_seen)
    VALUES(?,?,?,1,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(client_id) DO UPDATE SET user_id=excluded.user_id,username=excluded.username,online=1,
    bluetooth_supported=excluded.bluetooth_supported,bluetooth_connected=excluded.bluetooth_connected,
    printer_connected=excluded.printer_connected,printer_name=excluded.printer_name,printer_id=excluded.printer_id,
    user_agent=excluded.user_agent,app_version=excluded.app_version,app_environment=excluded.app_environment,last_seen=CURRENT_TIMESTAMP`)
    .run(clientId, req.user.id, req.user.username, body.bluetoothSupported ? 1 : 0, body.bluetoothConnected ? 1 : 0,
      body.printerConnected ? 1 : 0, String(body.printerName || '').slice(0, 200) || null,
      String(body.printerId || '').slice(0, 200) || null, String(body.userAgent || '').slice(0, 500),
      String(body.appVersion || '').slice(0, 32) || null, body.appEnvironment === 'production' ? 'production' : body.appEnvironment === 'test' ? 'test' : null);
  const deviceCode = getDeviceCode(clientId);
  res.json({ ok: true, serverTime: new Date().toISOString(), deviceCode });
});

app.get('/api/logins', auth, requireAdmin, (req: any, res) => {
  const rows = db.prepare('SELECT id,username,event,success,detail,created_at FROM login_events ORDER BY id DESC LIMIT 500').all();
  audit(req.user, 'logins.viewed', 'login_events'); res.json(rows);
});
app.get('/api/audit', auth, requireAdmin, (req: any, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1000').all();
  audit(req.user, 'audit.viewed', 'audit_log'); res.json(rows);
});


// Administrator console APIs. Client heartbeats and dashboard refreshes run every 3 seconds.
app.get('/api/admin/dashboard', auth, requireAdmin, (_req: any, res) => {
  const users = db.prepare(`SELECT u.id,u.username,u.employee_number AS employeeNumber,
    u.employee_name AS employeeName,u.contact_phone AS contactPhone,u.contact_email AS contactEmail,u.role,u.created_at AS createdAt,
    (SELECT COUNT(*) FROM passkeys p WHERE p.user_id=u.id) AS passkeyCount,
    (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at>?) AS activeSessions,
    (SELECT MAX(le.created_at) FROM login_events le WHERE le.user_id=u.id AND le.event='login' AND le.success=1) AS lastLogin
    FROM users u ORDER BY u.created_at DESC`).all(Date.now()) as any[];
  const userDeviceLinks = db.prepare(`SELECT ud.user_id AS userId,cd.client_id AS clientId,cd.device_code AS deviceCode,
    ud.registered_at AS registeredAt,ud.last_seen AS lastSeen FROM user_devices ud JOIN client_devices cd ON cd.client_id=ud.client_id
    ORDER BY ud.registered_at DESC`).all() as any[];
  for (const item of users) item.linkedDevices = userDeviceLinks.filter(link => link.userId === item.id);
  const devices = db.prepare(`SELECT cd.client_id AS clientId,cd.device_code AS deviceCode,cd.created_at AS createdAt,
    CASE WHEN cs.online=1 AND datetime(cs.last_seen)>=datetime('now','-10 seconds') THEN 1 ELSE 0 END AS online,
    cs.last_seen AS lastSeen,cs.user_agent AS userAgent,cs.app_version AS appVersion,cs.app_environment AS appEnvironment,
    (SELECT COUNT(*) FROM user_devices ud WHERE ud.client_id=cd.client_id) AS userCount
    FROM client_devices cd LEFT JOIN client_status cs ON cs.client_id=cd.client_id ORDER BY cd.created_at DESC`).all() as any[];
  for (const device of devices) device.registeredUsers = userDeviceLinks.filter(link => link.clientId === device.clientId).map(link => {
    const item = users.find(candidate => candidate.id === link.userId);
    return item ? { id: item.id, username: item.username, registeredAt: link.registeredAt, lastSeen: link.lastSeen } : null;
  }).filter(Boolean);
  const clients = db.prepare(`SELECT c.client_id AS clientId,c.user_id AS userId,c.username,
    CASE WHEN c.online=1 AND datetime(c.last_seen)>=datetime('now','-10 seconds') THEN 1 ELSE 0 END AS online,
    c.bluetooth_supported AS bluetoothSupported,c.bluetooth_connected AS bluetoothConnected,
    c.printer_connected AS printerConnected,c.printer_name AS printerName,c.printer_id AS printerId,
    c.app_version AS appVersion,c.app_environment AS appEnvironment,
    (SELECT COUNT(*) FROM push_subscriptions ps WHERE ps.client_id=c.client_id) AS pushSubscribed,
    c.user_agent AS userAgent,c.last_seen AS lastSeen FROM client_status c ORDER BY c.last_seen DESC`).all();
  const operations = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
  const jobs = db.prepare('SELECT * FROM daily_jobs ORDER BY created_at DESC LIMIT 200').all();
  const deviceWork = db.prepare(`SELECT w.id,w.client_id AS clientId,w.user_id AS userId,w.username,w.title,w.content,w.event_date AS eventDate,w.created_at AS createdAt,w.printer_name AS printerName,w.event_code AS eventCode
    FROM client_work w ORDER BY w.created_at DESC`).all() as any[];
  const workMedia = db.prepare('SELECT id,work_id AS workId,kind,original_name AS originalName,mime_type AS mimeType,filename,created_at AS createdAt FROM work_media ORDER BY created_at').all() as any[];
  for (const work of deviceWork) work.media = workMedia.filter(m => m.workId === work.id).map(m => ({ ...m, url: '/uploads/' + m.filename }));
  res.json({ users, clients, devices, operations, jobs, deviceWork, appVersion, appEnvironment, serverTime: new Date().toISOString() });
});
app.post('/api/admin/users/:id/role', auth, requireAdmin, (req: any, res) => {
  const role = String(req.body.role || '');
  if (role !== 'user') return res.status(400).json({ error: 'The administrator account is configured only through ADMIN_USERNAME and cannot be assigned to other users' });
  const target = db.prepare('SELECT id,username,role FROM users WHERE id=?').get(req.params.id) as any;
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (adminUsername && target.username === adminUsername) return res.status(400).json({ error: 'The configured administrator account cannot be demoted here' });
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, target.id);
  audit(req.user, 'admin.user_role_changed', 'user', target.id, { username: target.username, role });
  res.json({ ok: true });
});
app.put('/api/admin/users/:id/profile', auth, requireAdmin, (req: any, res) => {
  const target = db.prepare('SELECT id,username,role FROM users WHERE id=?').get(req.params.id) as any;
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin' || (adminUsername && target.username === adminUsername)) return res.status(400).json({ error: 'The configured administrator profile cannot be edited here' });
  const employeeNumber = String(req.body.employeeNumber ?? '').trim();
  const employeeName = String(req.body.employeeName || '').trim().slice(0, 100);
  const contactPhone = String(req.body.contactPhone || '').trim().slice(0, 40);
  const contactEmail = String(req.body.contactEmail || '').trim().slice(0, 254);
  if (!/^[0-9]+$/.test(employeeNumber)) return res.status(400).json({ error: '員工編號必須填寫，而且只允許 0-9 數字。' });
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return res.status(400).json({ error: '電郵格式不正確。' });
  const duplicate = db.prepare('SELECT id FROM users WHERE employee_number=? AND id<>?').get(employeeNumber, target.id);
  if (duplicate) return res.status(409).json({ error: '此員工編號已被其他帳戶使用。' });
  db.prepare('UPDATE users SET display_name=username,employee_number=?,employee_name=?,contact_phone=?,contact_email=? WHERE id=?').run(employeeNumber, employeeName || null, contactPhone || null, contactEmail || null, target.id);
  audit(req.user, 'admin.user_profile_updated', 'user', target.id, { username: target.username, fields: ['employeeNumber','employeeName','contactPhone','contactEmail'] });
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', auth, requireAdmin, (req: any, res) => {
  const target = db.prepare('SELECT id,username,role FROM users WHERE id=?').get(req.params.id) as any;
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (adminUsername && target.username === adminUsername) return res.status(400).json({ error: 'The configured administrator account cannot be deleted here' });
  if (target.role === 'admin' && (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get() as any).n <= 1)
    return res.status(400).json({ error: 'At least one administrator must remain' });
  audit(req.user, 'admin.user_deleted', 'user', target.id, { username: target.username });
  db.prepare('UPDATE login_events SET user_id=NULL WHERE user_id=?').run(target.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
  db.prepare('DELETE FROM users WHERE id=?').run(target.id);
  res.json({ ok: true });
});
app.delete('/api/admin/devices/:clientId', auth, requireAdmin, (req: any, res) => {
  const clientId = String(req.params.clientId || '').slice(0, 128);
  const device = db.prepare('SELECT client_id AS clientId,device_code AS deviceCode FROM client_devices WHERE client_id=?').get(clientId) as any;
  if (!device) return res.status(404).json({ error: '註冊設備不存在。' });
  if (req.user.client_id === clientId) return res.status(400).json({ error: '不能刪除目前管理員登入使用的設備。' });
  const linkedUsers = db.prepare(`SELECT DISTINCT u.id,u.username,u.role FROM users u LEFT JOIN user_devices ud ON ud.user_id=u.id LEFT JOIN sessions s ON s.user_id=u.id AND s.client_id=? LEFT JOIN client_status cs ON cs.user_id=u.id AND cs.client_id=? WHERE ud.client_id=? OR s.client_id=? OR cs.client_id=?`).all(clientId, clientId, clientId, clientId, clientId) as any[];
  if (linkedUsers.some(item => item.role === 'admin' || (adminUsername && item.username === adminUsername))) return res.status(400).json({ error: '此設備關聯管理員帳戶，為避免鎖定管理系統，不能整台刪除。' });
  const media = db.prepare(`SELECT wm.filename FROM work_media wm JOIN client_work cw ON cw.id=wm.work_id WHERE cw.client_id=?`).all(clientId) as { filename:string }[];
  const removeDevice = db.transaction(() => {
    audit(req.user, 'admin.registration_device_deleted', 'client_device', clientId, { deviceCode: device.deviceCode, deletedUsers: linkedUsers.map(item => item.username) });
    db.prepare('DELETE FROM client_work WHERE client_id=?').run(clientId);
    db.prepare('DELETE FROM push_subscriptions WHERE client_id=?').run(clientId);
    db.prepare('DELETE FROM notification_reads WHERE client_id=?').run(clientId);
    db.prepare('DELETE FROM notifications WHERE target_client_id=?').run(clientId);
    db.prepare('DELETE FROM sessions WHERE client_id=?').run(clientId);
    for (const item of linkedUsers) {
      db.prepare('UPDATE login_events SET user_id=NULL WHERE user_id=?').run(item.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(item.id);
      db.prepare('DELETE FROM users WHERE id=?').run(item.id);
    }
    db.prepare('DELETE FROM client_status WHERE client_id=?').run(clientId);
    db.prepare('DELETE FROM client_devices WHERE client_id=?').run(clientId);
  });
  try { removeDevice(); } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : '刪除設備失敗。' }); }
  for (const item of media) { try { fs.unlinkSync(path.join(uploadDir, item.filename)); } catch {} }
  res.json({ ok: true, deletedUsers: linkedUsers.length, deviceCode: device.deviceCode });
});
app.post('/api/admin/clients/:clientId/logout', auth, requireAdmin, (req: any, res) => {
  const clientId = String(req.params.clientId).slice(0,128);
  const client = db.prepare('SELECT user_id,username FROM client_status WHERE client_id=?').get(clientId) as any;
  if (!client) return res.status(404).json({ error: 'Client session not found' });
  db.prepare('DELETE FROM sessions WHERE user_id=? AND client_id=?').run(client.user_id, clientId);
  db.prepare('UPDATE client_status SET online=0,last_seen=CURRENT_TIMESTAMP WHERE client_id=?').run(clientId);
  audit(req.user, 'admin.client_forced_logout', 'client', clientId, { username: client.username });
  res.json({ ok: true });
});
app.delete('/api/admin/device-work/:id', auth, requireAdmin, (req: any, res) => {
  const workId = String(req.params.id || '').slice(0, 128);
  const work = db.prepare('SELECT id,username,title,client_id AS clientId FROM client_work WHERE id=?').get(workId) as any;
  if (!work) return res.status(404).json({ error: '工作記錄不存在' });
  const mediaCount = deleteDeviceWork(workId);
  audit(req.user, 'admin.device_work_deleted', 'client_work', workId, { username:work.username, clientId:work.clientId, title:work.title, mediaCount });
  res.json({ ok:true, id:workId, mediaCount });
});

app.post('/api/admin/notifications', auth, requireAdmin, async (req: any, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const body = String(req.body.body || '').trim().slice(0, 5000);
  const target = String(req.body.targetClientId || '').trim().slice(0, 128) || null;
  if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });
  if (target && !db.prepare('SELECT client_id FROM client_status WHERE client_id=?').get(target)) return res.status(404).json({ error: 'Client not found' });
  const notificationId = id();
  db.prepare('INSERT INTO notifications(id,title,body,target_client_id,created_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)').run(notificationId, title, body, target);
  let pushSent = 0, pushTotal = 0, pushConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  if (pushConfigured) {
    const subs = (target
      ? db.prepare('SELECT id,subscription_json FROM push_subscriptions WHERE client_id=?').all(target)
      : db.prepare('SELECT id,subscription_json FROM push_subscriptions').all()) as { id:string; subscription_json:string }[];
    pushTotal = subs.length;
    const results = await Promise.allSettled(subs.map(async sub => {
      try {
        await webpush.sendNotification(JSON.parse(sub.subscription_json), JSON.stringify({ title, body, url: '/', notificationId }));
        pushSent++;
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
        throw err;
      }
    }));
    const failures = results.filter(r => r.status === 'rejected').length;
    audit(req.user, 'admin.notification_push', 'notification', notificationId, { targetClientId: target, pushSent, pushTotal, failures });
  }
  audit(req.user, 'admin.notification_sent', 'notification', notificationId, { targetClientId: target, pushSent, pushTotal, pushConfigured });
  res.status(201).json({ ok: true, id: notificationId, pushSent, pushTotal, pushConfigured, message: pushConfigured ? `應用程式推播已送出 ${pushSent}/${pushTotal} 個訂閱端點；站內通知亦已保存。` : '站內通知已保存；未設定 VAPID 金鑰，未發送系統推播。' });
});

app.post('/api/admin/operations', auth, requireAdmin, (req: any, res) => {
  const title = String(req.body.title || '').trim(), content = String(req.body.content || '').trim();
  if (!title) return res.status(400).json({ error: 'Operation title is required' });
  const entityId = id();
  db.prepare('INSERT INTO audit_log(user_id,username,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?,?)')
    .run(req.user.id, req.user.username, 'manual.operation', 'manual', entityId, JSON.stringify({ title, content }));
  audit(req.user, 'admin.operation_created', 'audit_log', entityId, { title });
  res.status(201).json({ ok: true, id: entityId });
});
app.delete('/api/admin/operations/:id', auth, requireAdmin, (req: any, res) => {
  const target = db.prepare('SELECT id,action,entity_type,entity_id FROM audit_log WHERE id=?').get(Number(req.params.id)) as any;
  if (!target) return res.status(404).json({ error: 'Operation record not found' });
  db.prepare('DELETE FROM audit_log WHERE id=?').run(target.id);
  audit(req.user, 'admin.operation_deleted', 'audit_log', String(target.id), { action: target.action, entityType: target.entity_type, entityId: target.entity_id });
  res.json({ ok: true });
});
app.post('/api/admin/jobs', auth, requireAdmin, (req: any, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Work title is required' });
  const jobId = id(), jobDate = String(req.body.jobDate || new Date().toISOString().slice(0,10));
  db.prepare('INSERT INTO daily_jobs(id,job_date,title,status,detail) VALUES(?,?,?,?,?)')
    .run(jobId, jobDate, title, String(req.body.status || 'created').slice(0,40), String(req.body.detail || ''));
  audit(req.user, 'admin.work_created', 'daily_job', jobId, { title, jobDate });
  res.status(201).json({ ok: true, id: jobId });
});
app.delete('/api/admin/jobs/:id', auth, requireAdmin, (req: any, res) => {
  const target = db.prepare('SELECT id,title,job_date FROM daily_jobs WHERE id=?').get(req.params.id) as any;
  if (!target) return res.status(404).json({ error: 'Work record not found' });
  db.prepare('DELETE FROM daily_jobs WHERE id=?').run(target.id);
  audit(req.user, 'admin.work_deleted', 'daily_job', target.id, { title: target.title, jobDate: target.job_date });
  res.json({ ok: true });
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).slice(0, 12))
});
const MEDIA_MIME_BY_EXTENSION:Record<string,string> = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.heic':'image/heic','.heif':'image/heif','.bmp':'image/bmp','.tif':'image/tiff','.tiff':'image/tiff','.mp4':'video/mp4','.m4v':'video/x-m4v','.mov':'video/quicktime','.qt':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.3gp':'video/3gpp','.3g2':'video/3gpp2','.mts':'video/mp2t','.m2ts':'video/mp2t','.mpeg':'video/mpeg','.mpg':'video/mpeg','.ogv':'video/ogg' };
function resolveMediaMimeType(originalName:string, suppliedMimeType:string) {
  const type = String(suppliedMimeType || '').toLowerCase().split(';')[0].trim();
  if (/^(image|video)\//.test(type)) return type;
  const ext = path.extname(originalName).toLowerCase();
  return MEDIA_MIME_BY_EXTENSION[ext] || '';
}
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024, files: 20 }, fileFilter: (_req, file, cb) => {
  const resolved = resolveMediaMimeType(file.originalname,file.mimetype);
  if (!resolved) return cb(new Error(`不支援的附件格式：${file.originalname}。請選擇常見圖片或影片格式。`));
  (file as any).mimetype = resolved;
  cb(null,true);
} });
// Keep each upload request comfortably below common 256 KiB reverse-proxy body limits.
const chunkDir = path.join(uploadDir, '.chunks');
fs.mkdirSync(chunkDir, { recursive: true });
const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 170 * 1024, files: 1 } });
type CompletedWorkUpload = { userId:string; filename:string; originalName:string; mimeType:string; size:number; createdAt:number };
const completedWorkUploads = new Map<string, CompletedWorkUpload>();
function cleanupWorkUploads() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(chunkDir)) {
    if (!name.endsWith('.part')) continue;
    const tempPath = path.join(chunkDir,name);
    try { if (fs.statSync(tempPath).mtimeMs < cutoff) fs.unlinkSync(tempPath); } catch {}
  }
  for (const [mediaId, item] of completedWorkUploads) {
    if (item.createdAt < cutoff) {
      try { fs.unlinkSync(path.join(uploadDir, item.filename)); } catch {}
      completedWorkUploads.delete(mediaId);
    }
  }
}
app.post('/api/work/chunk', auth, chunkUpload.single('chunk'), (req: any, res) => {
  cleanupWorkUploads();
  const uploadId = String(req.body.uploadId || '');
  const originalName = String(req.body.filename || 'attachment').split(/[\\/]/).pop()!.slice(0, 255) || 'attachment';
  const mimeType = resolveMediaMimeType(originalName,String(req.body.mimeType || req.file?.mimetype || '')).slice(0,128);
  const index = Number(req.body.index);
  const totalChunks = Number(req.body.totalChunks);
  const totalSize = Number(req.body.totalSize);
  const chunkSize = Number(req.body.chunkSize);
  const maxAttachmentBytes = 500 * 1024 * 1024;
  const expectedChunkSize = 160 * 1024;
  const validationErrors:string[] = [];
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) validationErrors.push('上傳識別碼格式不正確');
  if (!req.file) validationErrors.push('伺服器未收到分段檔案');
  if (!Number.isInteger(index)) validationErrors.push('分段索引不是有效整數');
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 3200) validationErrors.push('分段總數必須介乎 1 至 3200');
  if (Number.isInteger(totalChunks) && Number.isInteger(index) && (index < 0 || index >= totalChunks)) validationErrors.push('分段索引超出分段總數範圍');
  if (!Number.isInteger(totalSize) || totalSize < 1) validationErrors.push('宣告檔案大小不是有效正整數');
  else if (totalSize > maxAttachmentBytes) validationErrors.push('檔案超過 500 MiB 單檔上限');
  if (chunkSize !== expectedChunkSize) validationErrors.push('分段大小設定不一致（預期 160 KiB）');
  if (!/^(image|video)\//i.test(mimeType)) validationErrors.push('附件 MIME type 無效或不受支援');
  if (Number.isInteger(totalSize) && totalSize > 0 && totalSize <= maxAttachmentBytes && chunkSize === expectedChunkSize && Number.isInteger(totalChunks) && totalChunks > 0) {
    const expectedTotalChunks = Math.ceil(totalSize / expectedChunkSize);
    if (totalChunks !== expectedTotalChunks) validationErrors.push('分段總數不符（預期 ' + expectedTotalChunks + ' 段，收到 ' + totalChunks + ' 段）');
    if (req.file && Number.isInteger(index) && index >= 0 && index < totalChunks) {
      const expectedBytes = index === totalChunks - 1 ? totalSize - index * expectedChunkSize : expectedChunkSize;
      if (req.file.size !== expectedBytes) validationErrors.push('第 ' + (index + 1) + ' 段大小不符（預期 ' + expectedBytes + ' bytes，收到 ' + req.file.size + ' bytes）');
    }
  }
  if (validationErrors.length) {
    console.warn('[work/chunk] rejected invalid upload metadata', { reasons:validationErrors, uploadId, index, totalChunks, totalSize, chunkSize, receivedChunkBytes:req.file?.size ?? null, mimeType });
    return res.status(400).json({ error: '附件分段資料無效（' + validationErrors.join('；') + '）。請重新選擇影片或圖片後重試。' });
  }
  const tempPath = path.join(chunkDir, uploadId + '.part');
  try {
    const expectedOffset = index * chunkSize;
    if (index === 0) fs.writeFileSync(tempPath, req.file.buffer);
    else {
      const currentSize = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : -1;
      if (currentSize !== expectedOffset) return res.status(409).json({ error: '附件分段次序不一致，請重新上傳。' });
      fs.appendFileSync(tempPath, req.file.buffer);
    }
    if (index < totalChunks - 1) return res.json({ ok:true, index });
    const actualSize = fs.statSync(tempPath).size;
    if (actualSize !== totalSize) {
      try { fs.unlinkSync(tempPath); } catch {}
      return res.status(400).json({ error: '附件大小校驗失敗，請重新上傳。' });
    }
    const ext = path.extname(originalName).slice(0, 12);
    const filename = crypto.randomUUID() + ext;
    fs.renameSync(tempPath, path.join(uploadDir, filename));
    const mediaId = crypto.randomUUID();
    completedWorkUploads.set(mediaId, { userId:req.user.id, filename, originalName, mimeType, size:actualSize, createdAt:Date.now() });
    res.json({ ok:true, mediaId });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '無法保存附件分段。' });
  }
});

// Mobile clients may keep work locally and upload it only when requested.
app.get('/api/work', auth, (req: any, res) => {
  const clientId = String(req.user.client_id || '').slice(0, 128);
  if (!clientId) return res.status(409).json({ error: '客戶端尚未初始化；請等待裝置心跳完成後再載入工作記錄。' });
  const rows = db.prepare(`SELECT id,client_id AS clientId,user_id AS userId,username,title,content,event_date AS eventDate,created_at AS createdAt,printer_name AS printerName,event_code AS eventCode FROM client_work WHERE client_id=? ORDER BY created_at DESC`).all(clientId) as any[];
  const media = db.prepare('SELECT id,work_id AS workId,kind,original_name AS originalName,mime_type AS mimeType,filename,created_at AS createdAt FROM work_media ORDER BY created_at').all() as any[];
  res.json(rows.map(w => ({ ...w, media: media.filter(m => m.workId === w.id).map(m => ({ ...m, size: (() => { try { return fs.statSync(path.join(uploadDir, m.filename)).size; } catch { return 0; } })(), url: '/uploads/' + m.filename })) })));
});
function deleteDeviceWork(workId: string) {
  const media = db.prepare('SELECT filename FROM work_media WHERE work_id=?').all(workId) as { filename:string }[];
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM work_media WHERE work_id=?').run(workId);
    db.prepare('DELETE FROM client_work WHERE id=?').run(workId);
  });
  remove();
  for (const item of media) try { fs.unlinkSync(path.join(uploadDir, item.filename)); } catch {}
  return media.length;
}

app.delete('/api/work/:id', auth, (req: any, res) => {
  const clientId = String(req.user.client_id || '').slice(0, 128);
  const workId = String(req.params.id || '').slice(0, 128);
  const work = db.prepare('SELECT id,title FROM client_work WHERE id=? AND client_id=?').get(workId, clientId) as any;
  if (!work) return res.status(404).json({ error: '工作記錄不存在或無權刪除' });
  const mediaCount = deleteDeviceWork(workId);
  audit(req.user, 'client.work_deleted', 'client_work', workId, { title: work.title, mediaCount });
  res.json({ ok:true, id:workId });
});

app.post('/api/work', auth, upload.array('media', 20), (req: any, res) => {
  const clientId = String(req.user.client_id || '').slice(0, 128);
  const title = String(req.body.title || '').trim().slice(0, 200);
  const content = String(req.body.content || '').trim().slice(0, 10000);
  const eventDate = String(req.body.eventDate || '').trim().slice(0, 40) || null;
  const eventCode = String(req.body.eventCode || '').trim().slice(0, 64) || null;
  const submittedCreatedAt = String(req.body.createdAt || '').trim();
  const parsedCreatedAt = submittedCreatedAt ? Date.parse(submittedCreatedAt) : NaN;
  const createdAt = Number.isFinite(parsedCreatedAt) ? new Date(parsedCreatedAt).toISOString() : new Date().toISOString();
  const files = (req.files || []) as Express.Multer.File[];
  const uploadedMediaIds = Array.isArray(req.body.uploadedMediaIds) ? req.body.uploadedMediaIds.map(String) : [];
  const chunkedFiles: Array<{ mediaId:string; item:CompletedWorkUpload }> = [];
  for (const mediaId of uploadedMediaIds) {
    const item = completedWorkUploads.get(mediaId);
    if (!item || item.userId !== req.user.id) {
      for (const file of files) try { fs.unlinkSync(file.path); } catch {}
      return res.status(400).json({ error: '附件上傳工作階段已失效，請重新上傳附件。' });
    }
    chunkedFiles.push({ mediaId, item });
  }
  if (chunkedFiles.length + files.length > 20) return res.status(400).json({ error: '每個事件最多可附加 20 個圖片或影片。' });
  if (!clientId) {
    for (const file of files) try { fs.unlinkSync(file.path); } catch {}
    return res.status(409).json({ error: '客戶端尚未初始化；請等待裝置心跳完成後再上傳。' });
  }
  if (!title) {
    for (const file of files) try { fs.unlinkSync(file.path); } catch {}
    return res.status(400).json({ error: '事件標題不可為空' });
  }
  // eventCode is the client-generated idempotency key: if the final response was
  // lost during a disconnect, a retry must not create a second event.
  const existing = eventCode ? db.prepare('SELECT id,client_id AS clientId,title,content,event_date AS eventDate,created_at AS createdAt,printer_name AS printerName,event_code AS eventCode FROM client_work WHERE client_id=? AND event_code=? ORDER BY created_at DESC LIMIT 1').get(clientId,eventCode) as any : null;
  if (existing) {
    for (const file of files) try { fs.unlinkSync(file.path); } catch {}
    for (const { mediaId, item } of chunkedFiles) {
      try { fs.unlinkSync(path.join(uploadDir,item.filename)); } catch {}
      completedWorkUploads.delete(mediaId);
    }
    const mediaCount = Number((db.prepare('SELECT COUNT(*) AS count FROM work_media WHERE work_id=?').get(existing.id) as {count:number}).count || 0);
    return res.status(200).json({ ...existing, mediaCount, alreadyExists:true });
  }
  const workId = id();
  const printerName = (db.prepare('SELECT printer_name FROM client_status WHERE client_id=?').get(clientId) as { printer_name?: string } | undefined)?.printer_name || null;
  const transaction = db.transaction(() => {
    db.prepare('INSERT INTO client_work(id,client_id,user_id,username,title,content,event_date,printer_name,event_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(workId, clientId, req.user.id, req.user.username, title, content, eventDate, printerName, eventCode, createdAt);
    for (const file of files) db.prepare('INSERT INTO work_media(id,work_id,kind,filename,mime_type,original_name) VALUES(?,?,?,?,?,?)')
      .run(id(), workId, file.mimetype.startsWith('image/') ? 'image' : 'video', file.filename, file.mimetype, file.originalname);
    for (const { mediaId, item } of chunkedFiles) db.prepare('INSERT INTO work_media(id,work_id,kind,filename,mime_type,original_name) VALUES(?,?,?,?,?,?)')
      .run(id(), workId, item.mimeType.startsWith('image/') ? 'image' : 'video', item.filename, item.mimeType, item.originalName);
  });
  try { transaction(); } catch (err) { for (const file of files) try { fs.unlinkSync(file.path); } catch {}; throw err; }
  for (const { mediaId } of chunkedFiles) completedWorkUploads.delete(mediaId);
  audit(req.user, 'client.work_uploaded', 'client_work', workId, { clientId, title, printerName, mediaCount: files.length + chunkedFiles.length });
  res.status(201).json({ id: workId, clientId, title, content, eventDate, eventCode, printerName, mediaCount: files.length + chunkedFiles.length, createdAt });
});

app.get('/api/events', auth, (req: any, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY COALESCE(event_date,created_at) DESC').all() as any[];
  const media = db.prepare('SELECT * FROM media ORDER BY created_at').all() as any[];
  audit(req.user, 'events.listed', 'event');
  res.json(events.map(e => ({ ...e, media: media.filter(m => m.event_id === e.id).map(m => ({ ...m, url: '/uploads/' + m.filename })) })));
});
app.post('/api/events', auth, upload.array('media', 20), (req: any, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Event title is required' });
  const eid = id();
  db.prepare('INSERT INTO events(id,title,content,event_date,created_by) VALUES(?,?,?,?,?)').run(eid, title, String(req.body.content || ''), req.body.eventDate || null, req.user.id);
  for (const file of (req.files || []) as Express.Multer.File[]) db.prepare('INSERT INTO media(id,event_id,kind,filename,mime_type,original_name) VALUES(?,?,?,?,?,?)').run(id(), eid, file.mimetype.startsWith('image/') ? 'image' : 'video', file.filename, file.mimetype, file.originalname);
  audit(req.user, 'event.created', 'event', eid, { title, mediaCount: (req.files || []).length });
  res.status(201).json({ id: eid, title });
});
app.delete('/api/events/:id', auth, (req: any, res) => {
  const found = db.prepare('SELECT id FROM events WHERE id=?').get(req.params.id);
  if (!found) return res.status(404).json({ error: 'Event not found' });
  db.prepare('DELETE FROM events WHERE id=?').run(req.params.id);
  audit(req.user, 'event.deleted', 'event', req.params.id); res.json({ ok: true });
});
app.post('/api/records/clear', auth, requireAdmin, (req: any, res) => {
  const requested = Array.isArray(req.body.categories) ? req.body.categories.map(String) : [];
  const allowed = new Set(['events', 'jobs', 'work', 'logins', 'printer_preferences', 'push_subscriptions']);
  const invalid = requested.filter((c: string) => !allowed.has(c));
  if (invalid.length) return res.status(400).json({ error: `Unsupported record categories: ${invalid.join(', ')}` });
  const counts: Record<string, number> = {};
  const removeMediaFiles = () => {
    const rows = db.prepare('SELECT filename FROM media').all() as { filename: string }[];
    for (const row of rows) {
      const target = path.resolve(uploadDir, row.filename);
      if (target.startsWith(uploadDir + path.sep) && fs.existsSync(target)) {
        try { fs.unlinkSync(target); } catch (e) { console.error('Unable to delete media file', target, e); }
      }
    }
  };
  const run = db.transaction(() => {
    for (const category of requested) {
      if (category === 'events') {
        removeMediaFiles();
        const mediaCount = (db.prepare('SELECT COUNT(*) AS n FROM media').get() as any).n;
        const eventCount = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n;
        db.prepare('DELETE FROM media').run(); db.prepare('DELETE FROM events').run();
        counts.events = eventCount; counts.media = mediaCount;
      } else if (category === 'jobs') {
        counts.jobs = (db.prepare('SELECT COUNT(*) AS n FROM daily_jobs').get() as any).n; db.prepare('DELETE FROM daily_jobs').run();
      } else if (category === 'work') {
        counts.work = (db.prepare('SELECT COUNT(*) AS n FROM client_work').get() as any).n;
        const workFiles = db.prepare('SELECT filename FROM work_media').all() as { filename:string }[];
        for (const row of workFiles) { const target = path.resolve(uploadDir, row.filename); if (target.startsWith(uploadDir + path.sep) && fs.existsSync(target)) try { fs.unlinkSync(target); } catch {} }
        db.prepare('DELETE FROM work_media').run();
        db.prepare('DELETE FROM client_work').run();
      } else if (category === 'logins') {
        counts.logins = (db.prepare('SELECT COUNT(*) AS n FROM login_events').get() as any).n;
        db.prepare('DELETE FROM login_events').run();
      } else if (category === 'printer_preferences') {
        counts.printer_preferences = (db.prepare('SELECT COUNT(*) AS n FROM printer_preferences').get() as any).n;
        db.prepare('DELETE FROM printer_preferences').run();
      } else if (category === 'push_subscriptions') {
        counts.push_subscriptions = (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as any).n;
        db.prepare('DELETE FROM push_subscriptions').run();
      }
    }
    audit(req.user, 'records.cleared', 'persistent_records', undefined, { categories: requested, deletedCounts: counts });
  });
  try { run(); res.json({ ok: true, deletedCounts: counts, auditRetained: true }); }
  catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Unable to clear records' }); }
});

app.get('/api/jobs', auth, (req: any, res) => { audit(req.user, 'jobs.listed', 'daily_jobs'); res.json(db.prepare('SELECT * FROM daily_jobs ORDER BY job_date DESC LIMIT 500').all()); });
app.post('/api/jobs', auth, (req: any, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Job title is required' });
  const jid = id();
  db.prepare('INSERT INTO daily_jobs(id,job_date,title,status,detail) VALUES(?,?,?,?,?)').run(jid, String(req.body.jobDate || new Date().toISOString().slice(0,10)), title, 'created', String(req.body.detail || ''));
  audit(req.user, 'job.created', 'daily_job', jid, { title }); res.status(201).json({ id: jid, title });
});
function createDailyJob() {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const exists = db.prepare("SELECT id FROM daily_jobs WHERE job_date=? AND title='每日自動工作記錄'").get(date);
  if (!exists) {
    const jid = id();
    db.prepare('INSERT INTO daily_jobs(id,job_date,title,status,detail) VALUES(?,?,?,?,?)').run(jid, date, '每日自動工作記錄', 'created', '系統於每日 00:00 自動建立');
    audit(null, 'job.daily_created', 'daily_job', jid, { date });
  }
}
createDailyJob();
cron.schedule('0 0 * * *', createDailyJob, { timezone: process.env.TZ || 'Asia/Singapore' });

app.post('/api/printer-preference', auth, requireRegularUser, (req: any, res) => {
  const { deviceId, deviceName } = req.body;
  db.prepare('INSERT INTO printer_preferences(user_id,device_id,device_name,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET device_id=excluded.device_id,device_name=excluded.device_name,updated_at=CURRENT_TIMESTAMP')
    .run(req.user.id, deviceId || null, deviceName || null);
  audit(req.user, 'printer.preference_saved', 'printer', deviceId, { deviceName }); res.json({ ok: true });
});
app.get('/api/printer-preference', auth, requireRegularUser, (req: any, res) => res.json(db.prepare('SELECT device_id AS deviceId,device_name AS deviceName,updated_at AS updatedAt FROM printer_preferences WHERE user_id=?').get(req.user.id) || null));
app.post('/api/printer-action', auth, requireRegularUser, (req: any, res) => {
  const action = String(req.body.action || 'unknown');
  if (!['connected', 'disconnected', 'connection_failed'].includes(action)) return res.status(400).json({ error: 'Invalid printer action' });
  audit(req.user, 'printer.' + action, 'printer', String(req.body.deviceId || ''), { deviceName: String(req.body.deviceName || ''), detail: String(req.body.detail || '') });
  res.json({ ok: true });
});

app.post('/api/push/subscribe', auth, (req: any, res) => {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return res.status(503).json({ error: 'Web Push VAPID keys are not configured' });
  const clientId = String(req.user.client_id || '').slice(0, 128);
  if (!clientId) return res.status(409).json({ error: '裝置尚未初始化；請稍後再啟用推播。' });
  const subscription = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ error: 'Invalid Web Push subscription payload' });
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE client_id=? AND json_extract(subscription_json,\'$.endpoint\')=?').get(clientId, subscription.endpoint) as { id:string } | undefined;
  const sid = existing?.id || id();
  if (existing) db.prepare('UPDATE push_subscriptions SET user_id=?,subscription_json=? WHERE id=?').run(req.user.id, JSON.stringify(subscription), sid);
  else db.prepare('INSERT INTO push_subscriptions(id,user_id,client_id,subscription_json) VALUES(?,?,?,?)').run(sid, req.user.id, clientId, JSON.stringify(subscription));
  audit(req.user, 'push.subscribed', 'push_subscription', sid, { clientId }); res.json({ ok: true, clientId });
});
app.post('/api/push/test', auth, async (req: any, res) => {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return res.status(503).json({ error: 'Web Push VAPID keys are not configured' });
  const subs = db.prepare('SELECT subscription_json FROM push_subscriptions WHERE user_id=?').all(req.user.id) as any[];
  const result = await Promise.allSettled(subs.map(s => webpush.sendNotification(JSON.parse(s.subscription_json), JSON.stringify({ title: 'PWA ESC Printing', body: '推播測試通知' }))));
  audit(req.user, 'push.test_sent', 'push_subscription', undefined, { count: subs.length });
  res.json({ sent: result.filter(r => r.status === 'fulfilled').length, total: subs.length });
});

app.get('/api/notifications', auth, (req: any, res) => {
  const clientId = String(req.user.client_id || '').slice(0, 128);
  if (!clientId) return res.status(409).json({ error: 'Client session not initialized' });
  const rows = db.prepare(`SELECT n.id,n.title,n.body,n.target_client_id AS targetClientId,n.created_at AS createdAt,
    CASE WHEN r.notification_id IS NULL THEN 0 ELSE 1 END AS isRead,r.read_at AS readAt
    FROM notifications n LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.client_id=?
    WHERE n.target_client_id IS NULL OR n.target_client_id=?
    ORDER BY n.created_at DESC LIMIT 500`).all(clientId, clientId);
  res.json(rows);
});
app.post('/api/notifications/:id/read', auth, (req: any, res) => {
  const clientId = String(req.user.client_id || '').slice(0, 128);
  const row = db.prepare('SELECT id FROM notifications WHERE id=? AND (target_client_id IS NULL OR target_client_id=?)').get(req.params.id, clientId);
  if (!row) return res.status(404).json({ error: 'Notification not found' });
  db.prepare('INSERT OR IGNORE INTO notification_reads(notification_id,client_id) VALUES(?,?)').run(req.params.id, clientId);
  res.json({ ok: true });
});

const requireIconv = () => iconvLite;

app.post('/api/receipt/encode', auth, requireRegularUser, (req: any, res) => {
  const iconv = requireIconv();
  const text = String(req.body.text || '');
  // Big5 is the requested encoding. Printer ESC/POS code-page number is firmware-specific;
  // clients can override the returned index after checking the printer manual.
  const bytes = iconv.encode(text, 'big5');
  audit(req.user, 'receipt.encoded', 'receipt', undefined, { encoding: 'Big5', byteLength: bytes.length });
  res.json({ base64: bytes.toString('base64'), encoding: 'Big5', codePageIndex: Number.isInteger(req.body.codePageIndex) ? req.body.codePageIndex : 0 });
});
app.post('/api/receipt/print-log', auth, requireRegularUser, (req: any, res) => {
  audit(req.user, 'receipt.print_requested', 'receipt', undefined, { printerName: String(req.body.printerName || ''), receiptType: 'test', status: String(req.body.status || 'submitted') });
  res.json({ ok: true });
});

if (fs.existsSync(path.resolve('dist'))) {
  app.use(express.static(path.resolve('dist')));
  app.get(/^(?!\/api(?:\/|$)|\/uploads(?:\/|$)).*/, (_req, res) => res.sendFile(path.resolve('dist/index.html')));
}
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('Unhandled request error:', err);
  if (res.headersSent) return;
  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? '附件超過伺服器允許的 500 MiB 上限。' : `附件上傳限制：${err.message}` });
  }
  if (err instanceof Error && err.message.startsWith('不支援的附件格式：')) return res.status(415).json({ error: err.message });
  res.status(500).json({ error: '伺服器發生內部錯誤，請查看伺服器日誌。' });
});

app.listen(port, () => console.log(`PWA ESC Printing API listening on :${port}`));
