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

const app = express();
const port = Number(process.env.PORT || 8787);
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
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const audit = (user: any, action: string, type?: string, entityId?: string, detail?: unknown) =>
  db.prepare('INSERT INTO audit_log(user_id,username,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?,?)')
    .run(user?.id || null, user?.username || null, action, type || null, entityId || null, detail ? JSON.stringify(detail) : null);
const publicUser = (u: any) => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role });
const auth = (req: any, res: any, next: any) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const session = db.prepare('SELECT s.user_id,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(token), Date.now()) as any;
  if (!session) return res.status(401).json({ error: 'Session expired; please sign in again' });
  req.user = session; next();
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
app.get('/api/config', (_req, res) => res.json({ rpName, rpID, origin, vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '' }));

// Passkey enrollment. In production, disable open enrollment or add an invitation/admin workflow.
app.post('/api/auth/register/options', async (req, res) => {
  if (process.env.ALLOW_SELF_REGISTRATION === 'false') return res.status(403).json({ error: 'Self registration is disabled' });
  const username = String(req.body.username || '').trim().toLowerCase();
  const displayName = String(req.body.displayName || username).trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-40 characters: a-z, 0-9, dot, underscore or hyphen' });
  let user = db.prepare('SELECT * FROM users WHERE username=?').get(username) as any;
  if (!user) { user = { id: id(), username, display_name: displayName, role: 'user' }; db.prepare('INSERT INTO users(id,username,display_name) VALUES(?,?,?)').run(user.id, username, displayName); }
  const existing = db.prepare('SELECT credential_id,transports FROM passkeys WHERE user_id=?').all(user.id) as any[];
  if (existing.length > 0) return res.status(409).json({ error: 'This username already has a passkey. Ask an administrator to add another authenticator.' });
  const options = await awaitRegistrationOptions(user, existing);
  const cid = challenge('register', options.challenge);
  res.json({ ...options, challengeId: cid, userId: user.id });
});
async function awaitRegistrationOptions(user: any, existing: any[]) {
  return generateRegistrationOptions({
    rpName, rpID, userName: user.username, userDisplayName: user.display_name,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((c: any) => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
  });
}
app.post('/api/auth/register/verify', async (req, res) => {
  try {
    const { username, challengeId, response } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).toLowerCase()) as any;
    const expectedChallenge = takeChallenge(challengeId, 'register');
    if (!user || !expectedChallenge) return res.status(400).json({ error: 'Registration challenge expired or invalid' });
    const verification = await verifyRegistrationResponse({ response: response as RegistrationResponseJSON, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID });
    if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'Passkey registration was not verified' });
    const info: any = verification.registrationInfo;
    const cred = info.credential || { id: info.credentialID, publicKey: info.credentialPublicKey, counter: info.counter, transports: response.response?.transports };
    db.prepare('INSERT OR REPLACE INTO passkeys(credential_id,user_id,public_key,counter,transports) VALUES(?,?,?,?,?)')
      .run(cred.id, user.id, Buffer.from(cred.publicKey).toString('base64url'), cred.counter || 0, JSON.stringify(cred.transports || response.response?.transports || []));
    audit(publicUser(user), 'auth.passkey_registered', 'user', user.id);
    res.json({ verified: true });
  } catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Registration failed' }); }
});
app.post('/api/auth/login/options', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username) as any;
  if (!user) { db.prepare('INSERT INTO login_events(username,event,success,detail) VALUES(?,?,0,?)').run(username || '(empty)', 'login', 'Unknown username'); return res.status(404).json({ error: 'User not found; register a passkey first' }); }
  const creds = db.prepare('SELECT credential_id,transports FROM passkeys WHERE user_id=?').all(user.id) as any[];
  if (!creds.length) return res.status(400).json({ error: 'No passkey registered for this user' });
  const options = await generateAuthenticationOptions({ rpID, allowCredentials: creds.map((c: any) => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined })), userVerification: 'preferred' });
  const cid = challenge('login', options.challenge);
  res.json({ ...options, challengeId: cid, username });
});
app.post('/api/auth/login/verify', async (req, res) => {
  const { username, challengeId, response } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').toLowerCase()) as any;
  const expectedChallenge = takeChallenge(challengeId, 'login');
  try {
    if (!user || !expectedChallenge) throw new Error('Challenge expired or user not found');
    const stored = db.prepare('SELECT * FROM passkeys WHERE user_id=? AND credential_id=?').get(user.id, response.id) as any;
    if (!stored) throw new Error('Passkey not registered');
    const credential: WebAuthnCredential = { id: stored.credential_id, publicKey: Buffer.from(stored.public_key, 'base64url'), counter: stored.counter, transports: stored.transports ? JSON.parse(stored.transports) : [] } as any;
    const verification = await verifyAuthenticationResponse({ response: response as AuthenticationResponseJSON, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, credential });
    if (!verification.verified) throw new Error('Passkey verification failed');
    db.prepare('UPDATE passkeys SET counter=? WHERE credential_id=?').run(verification.authenticationInfo.newCounter, stored.credential_id);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token), user.id, Date.now() + 7 * 24 * 60 * 60_000);
    db.prepare('INSERT INTO login_events(user_id,username,event,success,detail) VALUES(?,?,?,1,?)').run(user.id, user.username, 'login', 'WebAuthn passkey verified');
    audit(publicUser(user), 'auth.login_success', 'user', user.id);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    db.prepare('INSERT INTO login_events(user_id,username,event,success,detail) VALUES(?,?,?,0,?)').run(user?.id || null, String(username || '(empty)'), 'login', e instanceof Error ? e.message : 'Verification failed');
    res.status(401).json({ error: e instanceof Error ? e.message : 'Login failed' });
  }
});
app.post('/api/auth/logout', auth, (req: any, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
  db.prepare('INSERT INTO login_events(user_id,username,event,success,detail) VALUES(?,?,?,1,?)').run(req.user.id, req.user.username, 'logout', 'User signed out');
  audit(req.user, 'auth.logout', 'user', req.user.id); res.json({ ok: true });
});
app.get('/api/me', auth, (req: any, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/logins', auth, (req: any, res) => {
  const rows = db.prepare('SELECT id,username,event,success,detail,created_at FROM login_events ORDER BY id DESC LIMIT 500').all();
  audit(req.user, 'logins.viewed', 'login_events'); res.json(rows);
});
app.get('/api/audit', auth, (req: any, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1000').all();
  audit(req.user, 'audit.viewed', 'audit_log'); res.json(rows);
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).slice(0, 12))
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024, files: 20 }, fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) });
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
  const exists = db.prepare('SELECT id FROM daily_jobs WHERE job_date=?').get(date);
  if (!exists) {
    const jid = id();
    db.prepare('INSERT INTO daily_jobs(id,job_date,title,status,detail) VALUES(?,?,?,?,?)').run(jid, date, '每日自動工作記錄', 'created', '系統於每日 00:00 自動建立');
    audit(null, 'job.daily_created', 'daily_job', jid, { date });
  }
}
createDailyJob();
cron.schedule('0 0 * * *', createDailyJob, { timezone: process.env.TZ || 'Asia/Singapore' });

app.post('/api/printer-preference', auth, (req: any, res) => {
  const { deviceId, deviceName } = req.body;
  db.prepare('INSERT INTO printer_preferences(user_id,device_id,device_name,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET device_id=excluded.device_id,device_name=excluded.device_name,updated_at=CURRENT_TIMESTAMP')
    .run(req.user.id, deviceId || null, deviceName || null);
  audit(req.user, 'printer.preference_saved', 'printer', deviceId, { deviceName }); res.json({ ok: true });
});
app.get('/api/printer-preference', auth, (req: any, res) => res.json(db.prepare('SELECT device_id AS deviceId,device_name AS deviceName,updated_at AS updatedAt FROM printer_preferences WHERE user_id=?').get(req.user.id) || null));
app.post('/api/printer-action', auth, (req: any, res) => {
  const action = String(req.body.action || 'unknown');
  if (!['connected', 'disconnected', 'connection_failed'].includes(action)) return res.status(400).json({ error: 'Invalid printer action' });
  audit(req.user, 'printer.' + action, 'printer', String(req.body.deviceId || ''), { deviceName: String(req.body.deviceName || ''), detail: String(req.body.detail || '') });
  res.json({ ok: true });
});

app.post('/api/push/subscribe', auth, (req: any, res) => {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return res.status(503).json({ error: 'Web Push VAPID keys are not configured' });
  const sid = id();
  db.prepare('INSERT INTO push_subscriptions(id,user_id,subscription_json) VALUES(?,?,?)').run(sid, req.user.id, JSON.stringify(req.body));
  audit(req.user, 'push.subscribed', 'push_subscription', sid); res.json({ ok: true });
});
app.post('/api/push/test', auth, async (req: any, res) => {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return res.status(503).json({ error: 'Web Push VAPID keys are not configured' });
  const subs = db.prepare('SELECT subscription_json FROM push_subscriptions WHERE user_id=?').all(req.user.id) as any[];
  const result = await Promise.allSettled(subs.map(s => webpush.sendNotification(JSON.parse(s.subscription_json), JSON.stringify({ title: 'PWA ESC Printing', body: '推播測試通知' }))));
  audit(req.user, 'push.test_sent', 'push_subscription', undefined, { count: subs.length });
  res.json({ sent: result.filter(r => r.status === 'fulfilled').length, total: subs.length });
});

const requireIconv = () => iconvLite;

app.post('/api/receipt/encode', auth, (req: any, res) => {
  const iconv = requireIconv();
  const text = String(req.body.text || '');
  // Big5 is the requested encoding. Printer ESC/POS code-page number is firmware-specific;
  // clients can override the returned index after checking the printer manual.
  const bytes = iconv.encode(text, 'big5');
  audit(req.user, 'receipt.encoded', 'receipt', undefined, { encoding: 'Big5', byteLength: bytes.length });
  res.json({ base64: bytes.toString('base64'), encoding: 'Big5', codePageIndex: Number.isInteger(req.body.codePageIndex) ? req.body.codePageIndex : 0 });
});
app.post('/api/receipt/print-log', auth, (req: any, res) => {
  audit(req.user, 'receipt.print_requested', 'receipt', undefined, { printerName: String(req.body.printerName || ''), receiptType: 'test', status: String(req.body.status || 'submitted') });
  res.json({ ok: true });
});

if (fs.existsSync(path.resolve('dist'))) {
  app.use(express.static(path.resolve('dist')));
  app.get(/^(?!\/api(?:\/|$)|\/uploads(?:\/|$)).*/, (_req, res) => res.sendFile(path.resolve('dist/index.html')));
}
app.listen(port, () => console.log(`PWA ESC Printing API listening on :${port}`));
