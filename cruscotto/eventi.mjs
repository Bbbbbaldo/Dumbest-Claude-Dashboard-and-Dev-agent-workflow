// Collettore degli eventi hook di Claude Code (hooks/cruscotto.sh → POST /api/eventi).
// Ogni sessione, su qualunque macchina, manda i suoi eventi: lo stato si ricava da quelli,
// senza leggere i file interni di Claude Code.

import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const GIORNI_EVENTI = 14;
const HOST_LOCALE = os.hostname().split('.')[0];

// stato derivato dall'ultimo evento significativo
const STATO_DA_EVENTO = {
  SessionStart: 'ferma',
  UserPromptSubmit: 'lavora',
  PreToolUse: 'lavora',
  PostToolUse: 'lavora',
  SubagentStop: 'lavora',
  Stop: 'ferma',
  SessionEnd: 'chiusa',
};

function riassumi(nome, i = {}) {
  if (nome === 'Bash') return i.description || i.command || '';
  if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(nome)) return i.file_path || i.notebook_path || '';
  if (nome === 'Grep' || nome === 'Glob') return i.pattern || '';
  if (nome === 'Skill') return `${i.skill || ''} ${i.args || ''}`.trim();
  if (nome === 'Agent' || nome === 'Task') return i.description || '';
  return i.description || i.url || i.query || '';
}

export class Collettore {
  constructor({ cartellaDati, fileToken }) {
    this.cartella = cartellaDati;
    this.fileToken = fileToken;
    this.token = null;
    this.db = null;
  }

  async carica() {
    await mkdir(this.cartella, { recursive: true });
    await mkdir(path.dirname(this.fileToken), { recursive: true });
    try {
      this.token = (await readFile(this.fileToken, 'utf8')).trim();
    } catch {
      this.token = randomBytes(24).toString('hex');
      await writeFile(this.fileToken, this.token + '\n', { mode: 0o600 });
    }
    await chmod(this.fileToken, 0o600).catch(() => {});

    this.db = new DatabaseSync(path.join(this.cartella, 'eventi.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS eventi (
        id INTEGER PRIMARY KEY, ricevuto TEXT NOT NULL, host TEXT, session_id TEXT, evento TEXT, dati TEXT
      );
      CREATE INDEX IF NOT EXISTS eventi_sessione ON eventi(session_id, id);
      CREATE TABLE IF NOT EXISTS sessioni (
        session_id TEXT PRIMARY KEY, host TEXT, pid INTEGER, origine TEXT, cwd TEXT, transcript TEXT,
        stato TEXT, da_quando TEXT, avviata TEXT, aggiornata TEXT, finita TEXT,
        richiesta TEXT, azione TEXT, messaggio TEXT
      );
    `);
    const limite = new Date(Date.now() - GIORNI_EVENTI * 86400000).toISOString();
    this.db.prepare('DELETE FROM eventi WHERE ricevuto < ?').run(limite);
    this.db.prepare("DELETE FROM sessioni WHERE stato = 'chiusa' AND aggiornata < ?").run(limite);
  }

  tokenValido(t) {
    if (typeof t !== 'string' || !this.token) return false;
    const a = Buffer.from(t), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  registra(e, { host, pid, origine }) {
    const sid = typeof e.session_id === 'string' ? e.session_id.slice(0, 100) : null;
    const evento = typeof e.hook_event_name === 'string' ? e.hook_event_name.slice(0, 50) : null;
    if (!sid || !evento) throw new Error('evento senza session_id o hook_event_name');
    const ora = new Date().toISOString();
    host = String(host || '?').slice(0, 100);

    this.db.prepare('INSERT INTO eventi (ricevuto, host, session_id, evento, dati) VALUES (?, ?, ?, ?, ?)')
      .run(ora, host, sid, evento, JSON.stringify(e).slice(0, 20000));

    const prima = this.db.prepare('SELECT * FROM sessioni WHERE session_id = ?').get(sid);
    const s = prima ? { ...prima } : { session_id: sid, avviata: ora, stato: null };
    s.host = host;
    if (pid) s.pid = Number(pid) || s.pid;
    if (origine) s.origine = String(origine).slice(0, 40);
    if (typeof e.cwd === 'string') s.cwd = e.cwd;
    if (typeof e.transcript_path === 'string') s.transcript = e.transcript_path;
    s.aggiornata = ora;

    let stato = STATO_DA_EVENTO[evento];
    if (evento === 'Notification') {
      const tipo = e.notification_type || '';
      if (tipo === 'permission_prompt' || /permission/i.test(e.message || '')) stato = 'permesso';
      else if (tipo === 'idle_prompt') stato = 'ferma';
      s.messaggio = String(e.message || '').slice(0, 500);
    }
    if (evento === 'SessionStart') { s.avviata = ora; s.finita = null; }
    if (evento === 'UserPromptSubmit') { s.richiesta = String(e.prompt || '').replace(/\s+/g, ' ').slice(0, 400); s.messaggio = null; }
    if (evento === 'PreToolUse') {
      s.azione = JSON.stringify({ nome: e.tool_name, testo: String(riassumi(e.tool_name, e.tool_input)).replace(/\s+/g, ' ').slice(0, 200), quando: ora });
      s.messaggio = null;
    }
    if (evento === 'SessionEnd') s.finita = ora;
    if (stato && stato !== s.stato) { s.stato = stato; s.da_quando = ora; }
    if (!s.stato) { s.stato = 'ferma'; s.da_quando = ora; }

    this.db.prepare(`INSERT OR REPLACE INTO sessioni
      (session_id, host, pid, origine, cwd, transcript, stato, da_quando, avviata, aggiornata, finita, richiesta, azione, messaggio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.session_id, s.host, s.pid ?? null, s.origine ?? null, s.cwd ?? null, s.transcript ?? null, s.stato,
        s.da_quando, s.avviata, s.aggiornata, s.finita ?? null, s.richiesta ?? null, s.azione ?? null, s.messaggio ?? null);
  }

  // Sessioni non chiuse. Su questa macchina una sessione il cui processo non esiste più conta come chiusa
  // (crash o kill: SessionEnd non arriva).
  sessioniAperte(vivo) {
    const righe = this.db.prepare("SELECT * FROM sessioni WHERE stato != 'chiusa' ORDER BY aggiornata DESC").all();
    const out = [];
    for (const r of righe) {
      if (r.host === HOST_LOCALE && r.pid && !vivo(r.pid)) {
        this.db.prepare("UPDATE sessioni SET stato = 'chiusa', finita = ? WHERE session_id = ?").run(new Date().toISOString(), r.session_id);
        continue;
      }
      out.push({ ...r, azione: r.azione ? JSON.parse(r.azione) : null, locale: r.host === HOST_LOCALE });
    }
    return out;
  }

  ultimiEventi(sessionId, n = 50) {
    return this.db.prepare('SELECT ricevuto, evento, dati FROM eventi WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, n);
  }
}

export { HOST_LOCALE };
