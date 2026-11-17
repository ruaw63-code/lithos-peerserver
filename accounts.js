/* ProyectoLithos · cuentas y guardado en la nube (sin dependencias, solo Node >= 18)
   Rutas (todas bajo /api):
     POST /api/register   {u,p,data?}        crea la cuenta (y sube el progreso de este dispositivo si lo mandas)
     POST /api/login      {u,p}              entra; devuelve token + el guardado de la nube
     GET  /api/save       (Bearer token)     descarga el guardado
     PUT  /api/save       {rev,data,force?}  sube el guardado (si otro dispositivo guardó antes, responde 409)
     POST /api/logout     (Bearer token)     cierra la sesión de ESTE dispositivo
     POST /api/password   {old,new}          cambia la contraseña (cierra las demás sesiones)
     POST /api/recover/code    {u,code,new}   recupera con el código de recuperación (te da un código nuevo)
     POST /api/recover/request {u}            envía un código de 6 dígitos al correo de la cuenta (si hay correo configurado)
     POST /api/recover/confirm {u,code,new}   cambia la contraseña con el código recibido por correo
     GET  /api/me                             correo (oculto) de la cuenta · POST /api/email {email} · POST /api/recoverycode {p}
     POST /api/score {mode,score} (Bearer) · GET /api/top?mode=classic|castle|dungeon&u=usuario   clasificación
     POST /api/redeem {code} (Bearer)       canjea un código creado por el administrador
     POST /api/admin/code · GET /api/admin/codes · POST /api/admin/code/delete   (cabecera X-Admin-Key = variable ADMIN_KEY)
     GET  /api/ping
   Correo (opcional): variables BREVO_API_KEY y MAIL_FROM (remitente verificado en Brevo, plan gratis 300/día).
   Almacenamiento:
     · Si defines UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN → se guarda en Upstash Redis (gratis y PERMANENTE).
     · Si no → archivo JSON en DATA_DIR (por defecto ./data). OJO: en Render gratis el disco se BORRA al reiniciar. */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BODY = 1.2 * 1024 * 1024, MAX_SAVE = 900 * 1024, MAX_TOKENS = 8, TOKEN_DAYS = 400;
const USER_RE = /^[a-z0-9_]{3,16}$/;

/* ---------- almacenamiento ---------- */
class FileStore {
  constructor(dir) {
    this.dir = dir; this.file = path.join(dir, 'accounts.json'); this.db = { users: {} }; this.t = null;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (j && j.users) this.db = j; } catch (e) { }
  }
  async get(u) { const r = this.db.users[u]; return r ? JSON.parse(JSON.stringify(r)) : null; }
  async set(u, rec) { this.db.users[u] = rec; this.flush(); }
  flush() {
    clearTimeout(this.t);
    this.t = setTimeout(() => { try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.db)); fs.renameSync(tmp, this.file); } catch (e) { console.error('No se pudo guardar el archivo', e.message); } }, 250);
  }
  async getK(k) { const v = this.db.k && this.db.k[k]; return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
  async setK(k, v) { (this.db.k = this.db.k || {})[k] = v; this.flush(); }
  async delK(k) { if (this.db.k) delete this.db.k[k]; this.flush(); }
  get name() { return 'archivo (' + this.file + ')'; }
}
class UpstashStore {
  constructor(url, token) { this.url = url.replace(/\/$/, ''); this.token = token; }
  async cmd(a) {
    const r = await fetch(this.url, { method: 'POST', headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' }, body: JSON.stringify(a) });
    const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status)); return j.result;
  }
  async get(u) { const v = await this.cmd(['GET', 'lithos:user:' + u]); return v ? JSON.parse(v) : null; }
  async set(u, rec) { await this.cmd(['SET', 'lithos:user:' + u, JSON.stringify(rec)]); }
  async getK(k) { const v = await this.cmd(['GET', 'lithos:k:' + k]); return v ? JSON.parse(v) : null; }
  async setK(k, v) { await this.cmd(['SET', 'lithos:k:' + k, JSON.stringify(v)]); }
  async delK(k) { await this.cmd(['DEL', 'lithos:k:' + k]); }
  get name() { return 'Upstash Redis'; }
}
function makeStore() {
  const U = process.env.UPSTASH_REDIS_REST_URL, T = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (U && T) return new UpstashStore(U, T);
  return new FileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
}
const store = makeStore();
console.log('Cuentas: almacenamiento en ' + store.name);

/* ---------- utilidades ---------- */
const locks = new Map();
function withLock(u, fn) { const prev = locks.get(u) || Promise.resolve(); const next = prev.then(fn, fn); locks.set(u, next.catch(() => { })); return next; }
const CODE_AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () => { let c = ''; const b = crypto.randomBytes(12); for (let i = 0; i < 12; i++) c += CODE_AL[b[i] % 32]; return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8); };
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const maskMail = m => { const [a, d] = String(m).split('@'); return a.slice(0, 2) + '***@' + d; };
const mailOn = () => !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM);
async function sendMail(to, subject, text) {
  if (!mailOn()) return false;
  try { const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ sender: { name: 'ProyectoLithos', email: process.env.MAIL_FROM }, to: [{ email: to }], subject, textContent: text }) }); return r.ok; } catch (e) { return false; }
}
async function setRecovery(rec) { const code = genCode(); rec.rcSalt = crypto.randomBytes(16).toString('hex'); rec.rc = await hashPw(normCode(code), rec.rcSalt); return code; }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function hashPw(pw, salt) { return new Promise((ok, no) => crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? no(e) : ok(k.toString('hex')))); }
const tEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hits = new Map();
function limited(key, max, ms) { const n = Date.now(), a = (hits.get(key) || []).filter(t => n - t < ms); a.push(n); hits.set(key, a); return a.length > max; }
setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.some(t => n - t < 3600e3)) hits.delete(k); }, 600e3).unref();

function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Lithos-User, X-Admin-Key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '86400' });
  res.end(b);
}
function readBody(req) {
  return new Promise((ok, no) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(Object.assign(new Error('big'), { code: 413 })); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { ok(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch (e) { no(Object.assign(new Error('json'), { code: 400 })); } });
    req.on('error', no);
  });
}
const ipOf = req => String((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')).split(',')[0].trim();
const cleanUser = u => String(u || '').trim().toLowerCase();
function validSave(d) { if (!d || typeof d !== 'object' || Array.isArray(d)) return false; try { return JSON.stringify(d).length <= MAX_SAVE; } catch (e) { return false; } }

async function authed(req, body) {
  const h = String(req.headers.authorization || ''), tok = h.startsWith('Bearer ') ? h.slice(7) : String((body && body.tok) || '');
  const u = cleanUser((req.headers['x-lithos-user']) || (body && body.u)); if (!tok || !USER_RE.test(u)) return null;
  const rec = await store.get(u); if (!rec) return null;
  const th = sha(tok), t = (rec.tokens || []).find(x => tEq(x.h, th)); if (!t) return null;
  if (Date.now() - t.used > TOKEN_DAYS * 864e5) return null;
  return { u, rec, t };
}
function newToken(rec) {
  const tok = crypto.randomBytes(32).toString('hex'); rec.tokens = (rec.tokens || []).filter(t => Date.now() - t.used < TOKEN_DAYS * 864e5);
  rec.tokens.push({ h: sha(tok), made: Date.now(), used: Date.now() }); if (rec.tokens.length > MAX_TOKENS) rec.tokens = rec.tokens.slice(-MAX_TOKENS); return tok;
}

/* ---------- rutas ---------- */
async function route(req, res, url) {
  const m = req.method, p = url.pathname.replace(/\/+$/, '');
  if (m === 'OPTIONS') return send(res, 204, {});
  if (p === '/api/ping') return send(res, 200, { ok: 1, t: Date.now(), mail: mailOn() });
  const ip = ipOf(req);

  if (p === '/api/register' && m === 'POST') {
    if (limited('reg|' + ip, 8, 3600e3)) return send(res, 429, { err: 'Demasiados registros desde esta conexión. Intenta más tarde.' });
    const b = await readBody(req), u = cleanUser(b.u), pw = String(b.p || '');
    if (!USER_RE.test(u)) return send(res, 400, { err: 'El usuario debe tener 3 a 16 letras, números o _ (sin espacios).' });
    if (pw.length < 6 || pw.length > 72) return send(res, 400, { err: 'La contraseña debe tener entre 6 y 72 caracteres.' });
    const em = String(b.email || '').trim().toLowerCase(); if (em && !EMAIL_RE.test(em)) return send(res, 400, { err: 'El correo no es válido.' });
    if (b.data !== undefined && b.data !== null && !validSave(b.data)) return send(res, 400, { err: 'El guardado es demasiado grande o inválido.' });
    return withLock(u, async () => {
      if (await store.get(u)) return send(res, 409, { err: 'Ese usuario ya existe. Elige otro o entra con tu contraseña.' });
      const salt = crypto.randomBytes(16).toString('hex'), rec = { u, salt, pw: await hashPw(pw, salt), made: Date.now(), rev: 0, save: null, ts: 0, prev: null, tokens: [] };
      if (b.data) { rec.save = b.data; rec.rev = 1; rec.ts = Date.now(); }
      if (em) rec.email = em; const code = await setRecovery(rec);
      const tok = newToken(rec); await store.set(u, rec); send(res, 200, { u, tok, rev: rec.rev, code });
    });
  }

  if (p === '/api/login' && m === 'POST') {
    const b = await readBody(req), u = cleanUser(b.u), pw = String(b.p || '');
    if (limited('log|' + ip, 20, 600e3) || limited('logu|' + u, 10, 600e3)) return send(res, 429, { err: 'Demasiados intentos. Espera unos minutos.' });
    if (!USER_RE.test(u) || !pw) return send(res, 400, { err: 'Escribe tu usuario y contraseña.' });
    return withLock(u, async () => {
      const rec = await store.get(u), fake = crypto.randomBytes(16).toString('hex');
      const h = await hashPw(pw, rec ? rec.salt : fake);
      if (!rec || !tEq(h, rec.pw)) return send(res, 401, { err: 'Usuario o contraseña incorrectos.' });
      const tok = newToken(rec); await store.set(u, rec);
      send(res, 200, { u, tok, rev: rec.rev, ts: rec.ts, data: rec.save });
    });
  }

  if (p === '/api/save' && (m === 'GET' || m === 'PUT')) {
    const b = m === 'PUT' ? await readBody(req) : {};
    const a0 = await authed(req, b); if (!a0) return send(res, 401, { err: 'Sesión no válida. Vuelve a iniciar sesión.' });
    return withLock(a0.u, async () => {
      const a = await authed(req, b); if (!a) return send(res, 401, { err: 'Sesión no válida. Vuelve a iniciar sesión.' });
      const rec = a.rec; a.t.used = Date.now();
      if (m === 'GET') { await store.set(a.u, rec); return send(res, 200, { rev: rec.rev, ts: rec.ts, data: rec.save }); }
      if (!validSave(b.data)) return send(res, 400, { err: 'El guardado es demasiado grande o inválido.' });
      if (!b.force && (b.rev | 0) !== rec.rev) return send(res, 409, { err: 'Otro dispositivo guardó cambios más nuevos.', rev: rec.rev, ts: rec.ts, data: rec.save });
      rec.prev = rec.save; rec.save = b.data; rec.rev += 1; rec.ts = Date.now();
      await store.set(a.u, rec); send(res, 200, { rev: rec.rev, ts: rec.ts });
    });
  }

  if (p === '/api/logout' && m === 'POST') {
    const b = await readBody(req), a = await authed(req, b); if (!a) return send(res, 200, { ok: 1 });
    return withLock(a.u, async () => { const r = await store.get(a.u); if (r) { const th = sha(String((req.headers.authorization || '').slice(7) || b.tok || '')); r.tokens = (r.tokens || []).filter(t => !tEq(t.h, th)); await store.set(a.u, r); } send(res, 200, { ok: 1 }); });
  }

  if (p === '/api/password' && m === 'POST') {
    const b = await readBody(req), a = await authed(req, b); if (!a) return send(res, 401, { err: 'Sesión no válida.' });
    if (limited('pw|' + a.u, 8, 600e3)) return send(res, 429, { err: 'Demasiados intentos.' });
    const np = String(b.new || ''); if (np.length < 6 || np.length > 72) return send(res, 400, { err: 'La contraseña nueva debe tener entre 6 y 72 caracteres.' });
    return withLock(a.u, async () => {
      const rec = await store.get(a.u); if (!rec || !tEq(await hashPw(String(b.old || ''), rec.salt), rec.pw)) return send(res, 401, { err: 'La contraseña actual no es correcta.' });
      const th = sha(String((req.headers.authorization || '').slice(7) || b.tok || ''));
      rec.salt = crypto.randomBytes(16).toString('hex'); rec.pw = await hashPw(np, rec.salt); rec.tokens = (rec.tokens || []).filter(t => tEq(t.h, th));
      await store.set(a.u, rec); send(res, 200, { ok: 1 });
    });
  }


  /* ---------- clasificación ---------- */
  const MODES = { classic: 5e7, castle: 5e7, dungeon: 1e8 };
  if (p === '/api/score' && m === 'POST') {
    const b = await readBody(req), a = await authed(req, b); if (!a) return send(res, 401, { err: 'Sesión no válida.' });
    const mode = String(b.mode || ''), sc = Math.floor(+b.score);
    if (!(mode in MODES) || !isFinite(sc) || sc < 0 || sc > MODES[mode]) return send(res, 400, { err: 'Puntuación inválida.' });
    if (limited('sc|' + a.u, 40, 60e3)) return send(res, 429, { err: 'Demasiado rápido.' });
    return withLock('lb:' + mode, async () => {
      const lb = (await store.getK('lb:' + mode)) || {}, cur = lb[a.u];
      if (!cur || sc > cur.s) { lb[a.u] = { s: sc, t: Date.now() }; const ks = Object.keys(lb); if (ks.length > 1000) { ks.sort((x, y) => lb[y].s - lb[x].s); ks.slice(1000).forEach(k => delete lb[k]); } await store.setK('lb:' + mode, lb); }
      send(res, 200, { ok: 1, best: lb[a.u] ? lb[a.u].s : sc });
    });
  }
  if (p === '/api/top' && m === 'GET') {
    const mode = String(url.searchParams.get('mode') || ''), me = cleanUser(url.searchParams.get('u'));
    if (!(mode in MODES)) return send(res, 400, { err: 'Modo inválido.' });
    const lb = (await store.getK('lb:' + mode)) || {}, arr = Object.keys(lb).map(u => ({ u, s: lb[u].s, t: lb[u].t })).sort((x, y) => y.s - x.s || x.t - y.t);
    arr.forEach((e, i) => { e.r = i + 1; });
    const mi = me ? arr.find(e => e.u === me) : null;
    return send(res, 200, { list: arr.slice(0, 50), total: arr.length, me: mi ? { r: mi.r, s: mi.s, up: mi.r > 1 ? arr[mi.r - 2].s : 0, up3: mi.r > 3 ? arr[2].s : 0 } : null, t: Date.now() });
  }

  /* ---------- códigos del administrador ---------- */
  const isAdmin = () => { const k = process.env.ADMIN_KEY, h = String(req.headers['x-admin-key'] || ''); return !!k && k.length >= 8 && tEq(sha(h), sha(k)); };
  if (p.startsWith('/api/admin/')) {
    if (limited('adm|' + ip, 40, 600e3)) return send(res, 429, { err: 'Demasiados intentos.' });
    if (!process.env.ADMIN_KEY) return send(res, 503, { err: 'Falta la variable ADMIN_KEY (mín. 8 caracteres) en Render.' });
    if (!isAdmin()) return send(res, 401, { err: 'Clave de administrador incorrecta.' });
    if (p === '/api/admin/code' && m === 'POST') {
      const b = await readBody(req), rw = b.rewards;
      if (!Array.isArray(rw) || !rw.length || rw.length > 40 || JSON.stringify(rw).length > 12000) return send(res, 400, { err: 'Recompensas inválidas (1 a 40).' });
      let code = normCode(b.code); if (code && (code.length < 4 || code.length > 24)) return send(res, 400, { err: 'El código propio debe tener 4 a 24 letras/números.' });
      if (!code) code = normCode(genCode());
      return withLock('codes', async () => {
        if (await store.getK('code:' + code)) return send(res, 409, { err: 'Ese código ya existe.' });
        const rec = { r: rw, uses: Math.max(0, Math.min(1e6, b.uses | 0)), used: [], exp: b.days > 0 ? Date.now() + Math.min(3650, +b.days) * 864e5 : 0, note: String(b.note || '').slice(0, 80), made: Date.now() };
        await store.setK('code:' + code, rec); const ix = (await store.getK('codes')) || []; ix.push(code); await store.setK('codes', ix);
        send(res, 200, { code: code.length === 12 ? code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8) : code });
      });
    }
    if (p === '/api/admin/codes' && m === 'GET') {
      const ix = (await store.getK('codes')) || [], out = [];
      for (const c of ix.slice(-60).reverse()) { const r = await store.getK('code:' + c); if (r) out.push({ code: c, note: r.note, uses: r.uses, used: r.used.length, exp: r.exp, n: r.r.length }); }
      return send(res, 200, { codes: out });
    }
    if (p === '/api/admin/code/delete' && m === 'POST') {
      const b = await readBody(req), c = normCode(b.code);
      return withLock('codes', async () => { await store.delK('code:' + c); const ix = ((await store.getK('codes')) || []).filter(x => x !== c); await store.setK('codes', ix); send(res, 200, { ok: 1 }); });
    }
    return send(res, 404, { err: 'No existe' });
  }
  if (p === '/api/redeem' && m === 'POST') {
    const b = await readBody(req), a = await authed(req, b); if (!a) return send(res, 401, { err: 'Inicia sesión para canjear códigos.' });
    const c = normCode(b.code); if (c.length < 4) return send(res, 400, { err: 'Escribe el código.' });
    if (limited('rd|' + a.u, 12, 600e3) || limited('rdi|' + ip, 30, 600e3)) return send(res, 429, { err: 'Demasiados intentos. Espera unos minutos.' });
    return withLock('code:' + c, async () => {
      const r = await store.getK('code:' + c); if (!r) return send(res, 404, { err: 'Código incorrecto.' });
      if (r.exp && Date.now() > r.exp) return send(res, 410, { err: 'Este código ya venció.' });
      if (r.used.includes(a.u)) return send(res, 409, { err: 'Ya canjeaste este código con tu cuenta.' });
      if (r.uses && r.used.length >= r.uses) return send(res, 410, { err: 'Este código ya se agotó.' });
      r.used.push(a.u); await store.setK('code:' + c, r); send(res, 200, { rewards: r.r, note: r.note });
    });
  }
  if (p === '/api/me' && m === 'GET') {
    const a = await authed(req, {}); if (!a) return send(res, 401, { err: 'Sesión no válida.' });
    return send(res, 200, { email: a.rec.email ? maskMail(a.rec.email) : '', hasCode: !!a.rec.rc, mail: mailOn() });
  }
  if (p === '/api/email' && m === 'POST') {
    const b = await readBody(req), a = await authed(req, b); if (!a) return send(res, 401, { err: 'Sesión no válida.' });
    const em = String(b.email || '').trim().toLowerCase(); if (em && !EMAIL_RE.test(em)) return send(res, 400, { err: 'El correo no es válido.' });
    return withLock(a.u, async () => { const rec = await store.get(a.u); if (!rec) return send(res, 401, { err: 'Sesión no válida.' }); if (em) rec.email = em; else delete rec.email; await store.set(a.u, rec); send(res, 200, { email: em ? maskMail(em) : '' }); });
  }
  if (p === '/api/recoverycode' && m === 'POST') {
    const b = await readBody(req), a = await authed(req, b); if (!a) return send(res, 401, { err: 'Sesión no válida.' });
    if (limited('rcg|' + a.u, 6, 600e3)) return send(res, 429, { err: 'Demasiados intentos.' });
    return withLock(a.u, async () => {
      const rec = await store.get(a.u); if (!rec || !tEq(await hashPw(String(b.p || ''), rec.salt), rec.pw)) return send(res, 401, { err: 'La contraseña no es correcta.' });
      const code = await setRecovery(rec); await store.set(a.u, rec); send(res, 200, { code });
    });
  }
  if (p === '/api/recover/code' && m === 'POST') {
    const b = await readBody(req), u = cleanUser(b.u), np = String(b.new || '');
    if (limited('rcv|' + ip, 10, 3600e3) || limited('rcvu|' + u, 6, 3600e3)) return send(res, 429, { err: 'Demasiados intentos. Espera una hora.' });
    if (!USER_RE.test(u) || !normCode(b.code)) return send(res, 400, { err: 'Escribe tu usuario y tu código de recuperación.' });
    if (np.length < 6 || np.length > 72) return send(res, 400, { err: 'La contraseña nueva debe tener entre 6 y 72 caracteres.' });
    return withLock(u, async () => {
      const rec = await store.get(u), ok = rec && rec.rc && tEq(await hashPw(normCode(b.code), rec.rcSalt), rec.rc);
      if (!ok) return send(res, 401, { err: 'Usuario o código de recuperación incorrectos.' });
      rec.salt = crypto.randomBytes(16).toString('hex'); rec.pw = await hashPw(np, rec.salt); rec.tokens = [];
      const code = await setRecovery(rec), tok = newToken(rec); await store.set(u, rec);
      send(res, 200, { u, tok, rev: rec.rev, ts: rec.ts, data: rec.save, code });
    });
  }
  if (p === '/api/recover/request' && m === 'POST') {
    const b = await readBody(req), u = cleanUser(b.u);
    if (!mailOn()) return send(res, 503, { err: 'La recuperación por correo no está activada en este servidor. Usa tu código de recuperación.' });
    if (limited('rqi|' + ip, 10, 3600e3) || limited('rqu|' + u, 3, 3600e3)) return send(res, 429, { err: 'Ya pediste varios códigos. Espera una hora.' });
    const generic = { ok: 1, msg: 'Si la cuenta tiene un correo registrado, te enviamos un código de 6 dígitos (vale 15 minutos).' };
    if (!USER_RE.test(u)) return send(res, 200, generic);
    return withLock(u, async () => {
      const rec = await store.get(u); if (!rec || !rec.email) return send(res, 200, generic);
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'), salt = crypto.randomBytes(8).toString('hex');
      rec.rs = { h: sha(code + salt), salt, exp: Date.now() + 15 * 60e3, tries: 0 }; await store.set(u, rec);
      await sendMail(rec.email, 'Código para recuperar tu cuenta de ProyectoLithos', 'Tu código de recuperación es: ' + code + '\n\nVale 15 minutos. Si no lo pediste tú, ignora este mensaje.');
      send(res, 200, generic);
    });
  }
  if (p === '/api/recover/confirm' && m === 'POST') {
    const b = await readBody(req), u = cleanUser(b.u), np = String(b.new || ''), code = String(b.code || '').replace(/\D/g, '');
    if (limited('cfi|' + ip, 20, 3600e3)) return send(res, 429, { err: 'Demasiados intentos.' });
    if (!USER_RE.test(u) || code.length !== 6) return send(res, 400, { err: 'Escribe tu usuario y el código de 6 dígitos.' });
    if (np.length < 6 || np.length > 72) return send(res, 400, { err: 'La contraseña nueva debe tener entre 6 y 72 caracteres.' });
    return withLock(u, async () => {
      const rec = await store.get(u), rs = rec && rec.rs;
      if (!rs || Date.now() > rs.exp) return send(res, 401, { err: 'El código no existe o ya venció. Pide uno nuevo.' });
      if (++rs.tries > 5) { delete rec.rs; await store.set(u, rec); return send(res, 429, { err: 'Demasiados intentos. Pide un código nuevo.' }); }
      if (!tEq(sha(code + rs.salt), rs.h)) { await store.set(u, rec); return send(res, 401, { err: 'Código incorrecto.' }); }
      delete rec.rs; rec.salt = crypto.randomBytes(16).toString('hex'); rec.pw = await hashPw(np, rec.salt); rec.tokens = [];
      const tok = newToken(rec); await store.set(u, rec); send(res, 200, { u, tok, rev: rec.rev, ts: rec.ts, data: rec.save, code: null });
    });
  }
  return send(res, 404, { err: 'No existe' });
}

/* devuelve true si la petición era de la API */
function handle(req, res) {
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { return false; }
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') return false;
  route(req, res, url).catch(e => { const c = e && e.code === 413 ? 413 : e && e.code === 400 ? 400 : 500; if (c === 500) console.error(e); try { send(res, c, { err: c === 413 ? 'Guardado demasiado grande' : c === 400 ? 'Petición inválida' : 'Error del servidor' }); } catch (x) { } });
  return true;
}
module.exports = { handle };
