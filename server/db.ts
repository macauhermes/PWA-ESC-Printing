import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import 'dotenv/config';

const filename = process.env.DATABASE_PATH || './data/app.sqlite';
fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
export const db = new Database(filename);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  employee_number TEXT, employee_name TEXT, contact_phone TEXT, contact_email TEXT,
  role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT, login_type TEXT NOT NULL DEFAULT 'passkey', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id), username TEXT NOT NULL,
  event TEXT NOT NULL, success INTEGER NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, username TEXT, action TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  event_date TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, original_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS client_devices (
  client_id TEXT PRIMARY KEY, device_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS client_work (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL,
  title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', event_date TEXT, printer_name TEXT,
  event_code TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_client_work_client_created ON client_work(client_id, created_at DESC);
CREATE TABLE IF NOT EXISTS work_media (
  id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES client_work(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, original_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_work_media_work ON work_media(work_id, created_at);
CREATE TABLE IF NOT EXISTS daily_jobs (
  id TEXT PRIMARY KEY, job_date TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created', detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS printer_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT, device_name TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE TABLE IF NOT EXISTS client_status (
  client_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 0, bluetooth_supported INTEGER NOT NULL DEFAULT 0,
  bluetooth_connected INTEGER NOT NULL DEFAULT 0, printer_connected INTEGER NOT NULL DEFAULT 0,
  printer_name TEXT, printer_id TEXT, user_agent TEXT, app_version TEXT, app_environment TEXT, last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_client_status_last_seen ON client_status(last_seen DESC);
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);
`);

const userColumns = db.pragma('table_info(users)') as { name: string }[];
if (!userColumns.some(c => c.name === 'employee_number')) db.exec('ALTER TABLE users ADD COLUMN employee_number TEXT');
if (!userColumns.some(c => c.name === 'employee_name')) db.exec('ALTER TABLE users ADD COLUMN employee_name TEXT');
if (!userColumns.some(c => c.name === 'contact_phone')) db.exec('ALTER TABLE users ADD COLUMN contact_phone TEXT');
if (!userColumns.some(c => c.name === 'contact_email')) db.exec('ALTER TABLE users ADD COLUMN contact_email TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_number ON users(employee_number) WHERE employee_number IS NOT NULL');
const clientStatusColumns = db.pragma('table_info(client_status)') as { name: string }[];
if (!clientStatusColumns.some(c => c.name === 'app_version')) db.exec('ALTER TABLE client_status ADD COLUMN app_version TEXT');
if (!clientStatusColumns.some(c => c.name === 'app_environment')) db.exec('ALTER TABLE client_status ADD COLUMN app_environment TEXT');

const workColumns = db.pragma('table_info(client_work)') as { name: string }[];
if (!workColumns.some(c => c.name === 'printer_name')) db.exec('ALTER TABLE client_work ADD COLUMN printer_name TEXT');
if (!workColumns.some(c => c.name === 'event_code')) db.exec('ALTER TABLE client_work ADD COLUMN event_code TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_client_work_event_code ON client_work(event_code) WHERE event_code IS NOT NULL');
const sessionColumns = db.pragma('table_info(sessions)') as { name: string }[];
if (!sessionColumns.some(c => c.name === 'client_id')) db.exec('ALTER TABLE sessions ADD COLUMN client_id TEXT');
if (!sessionColumns.some(c => c.name === 'login_type')) db.exec("ALTER TABLE sessions ADD COLUMN login_type TEXT NOT NULL DEFAULT 'passkey'");
const pushColumns = db.pragma('table_info(push_subscriptions)') as { name: string }[];
if (!pushColumns.some(c => c.name === 'client_id')) db.exec('ALTER TABLE push_subscriptions ADD COLUMN client_id TEXT');
const notificationColumns = db.pragma('table_info(notifications)') as { name: string }[];
if (!notificationColumns.some(c => c.name === 'target_client_id')) db.exec('ALTER TABLE notifications ADD COLUMN target_client_id TEXT');
if (!notificationColumns.some(c => c.name === 'created_at')) db.exec("ALTER TABLE notifications ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'");
db.exec('CREATE TABLE IF NOT EXISTS notification_reads (notification_id TEXT NOT NULL, client_id TEXT NOT NULL, read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(notification_id, client_id))');
const jobsTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='daily_jobs'").get() as { sql: string } | undefined;
if (jobsTable?.sql && /job_date\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(jobsTable.sql)) {
  db.exec(`CREATE TABLE daily_jobs_new (
    id TEXT PRIMARY KEY, job_date TEXT NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created', detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO daily_jobs_new(id,job_date,title,status,detail,created_at) SELECT id,job_date,title,status,detail,created_at FROM daily_jobs;
  DROP TABLE daily_jobs;
  ALTER TABLE daily_jobs_new RENAME TO daily_jobs;
  CREATE INDEX IF NOT EXISTS idx_daily_jobs_created ON daily_jobs(created_at DESC);`);
}

