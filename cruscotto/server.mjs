#!/usr/bin/env node
// Cruscotto delle sessioni Claude Code locali (CLI, VS Code, desktop) per tutti i progetti.
// Node >= 22.5 (node:sqlite), git >= 2.38 e gh nel PATH; unica dipendenza npm l'Agent SDK, per la chat.
//
// Fonti:
//   ~/.claude/sessions/<pid>.json   sessioni registrate (stato busy/idle, cwd, entrypoint)
//   ~/.claude/projects/<slug>/*.jsonl transcript, per l'ultima azione di ogni sessione
//   git worktree list                worktree di ogni repo
//   gh pr/issue list                 piani (PR con checklist di issue), task, issue
//
// Il formato di ~/.claude/sessions è interno a Claude Code e può cambiare:
// tutta la lettura sta in leggiSessioni() e ultimaAttivita().

import http from 'node:http';
import { readFile, readdir, stat, open, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GestoreChat } from './chat.mjs';
import { Collettore, HOST_LOCALE } from './eventi.mjs';

const esegui = promisify(execFile);
const HOME = os.homedir();
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const QUI = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4317);
const HOST = '127.0.0.1';

// ---------------------------------------------------------------- config

const CONFIG_DEFAULT = {
  repos: [],                 // repo da mostrare sempre, oltre a quelli con sessioni vive
  nascondiRepo: [],          // percorsi da non mostrare mai
  prefissiPiano: ['piano/'], // branch di testa che rendono una PR un "piano"
  minTaskPiano: 2,           // oppure: PR aperta con almeno N issue in checklist
  ttlGithubSec: 30,
  limiteIssue: 200,
  limitePr: 300,
  comandoAvvio: {},          // { "/percorso/repo": "claude --worktree issue-{n} \"/task {n}\"" }
  terminale: 'Terminal',     // "Terminal" o "iTerm": dove si apre la sessione lanciata dal cruscotto
};

async function leggiConfig() {
  for (const p of [path.join(QUI, 'config.json'), path.join(HOME, '.config', 'cruscotto-claude', 'config.json')]) {
    try {
      const c = JSON.parse(await readFile(p, 'utf8'));
      return { ...CONFIG_DEFAULT, ...c, _file: p };
    } catch (e) {
      if (e.code !== 'ENOENT') return { ...CONFIG_DEFAULT, _errore: `${p}: ${e.message}` };
    }
  }
  return { ...CONFIG_DEFAULT };
}

const espandi = (p) => (p?.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

// ---------------------------------------------------------------- cache

const cache = new Map();

// Restituisce subito l'ultimo valore e lo rinnova in background (stale-while-revalidate).
// Solo il primo caricamento aspetta.
function memo(chiave, ttlMs, fn) {
  let e = cache.get(chiave);
  if (!e) { e = { t: 0, valore: undefined, errore: null, corsa: null }; cache.set(chiave, e); }
  if (Date.now() - e.t >= ttlMs && !e.corsa) {
    e.corsa = Promise.resolve()
      .then(fn)
      .then((v) => { e.valore = v; e.errore = null; },
            (err) => { e.errore = String(err?.stderr || err?.message || err).trim().slice(0, 400); })
      .finally(() => { e.t = Date.now(); e.corsa = null; });
  }
  if (e.valore === undefined && e.corsa) return e.corsa.then(() => ({ valore: e.valore, errore: e.errore }));
  return Promise.resolve({ valore: e.valore, errore: e.errore });
}

function invalidaGithub() {
  for (const [k, e] of cache) if (k.startsWith('gh:')) e.t = 0;
}

async function cmd(bin, args, cwd, timeout = 20000) {
  const { stdout } = await esegui(bin, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// ---------------------------------------------------------------- processi e sessioni

const orario = (s) => (s || '').match(/(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})/);

async function processi() {
  const { valore } = await memo('ps', 2000, async () => {
    const out = await cmd('ps', ['-axo', 'pid=,lstart=']);
    const m = new Map();
    for (const riga of out.split('\n')) {
      const r = riga.trim().match(/^(\d+)\s+(.*)$/);
      if (r) m.set(Number(r[1]), r[2].trim());
    }
    return m;
  });
  return valore || new Map();
}

// Il pid può essere riusato da un altro processo: confrontiamo minuti, secondi e anno
// dell'avvio (l'ora no, procStart e ps possono essere in fusi diversi).
function stessoAvvio(procStart, lstart) {
  const a = orario(procStart), b = orario(lstart);
  if (!a || !b) return true;
  return a[2] === b[2] && a[3] === b[3] && a[4] === b[4];
}

async function leggiSessioni() {
  const dir = path.join(CLAUDE, 'sessions');
  const file = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  const ps = await processi();
  const vive = [];
  await Promise.all(file.map(async (f) => {
    let d;
    try { d = JSON.parse(await readFile(path.join(dir, f), 'utf8')); } catch { return; }
    const lstart = ps.get(Number(d.pid));
    if (!lstart || !stessoAvvio(d.procStart, lstart)) return;
    vive.push(d);
  }));
  return vive;
}

const ORIGINE = { cli: 'CLI', 'claude-vscode': 'VS Code', 'claude-desktop': 'Desktop', 'sdk-ts': 'SDK', 'sdk-py': 'SDK' };

// ---------------------------------------------------------------- transcript

async function trovaTranscript(cwd, sessionId) {
  const diretto = path.join(CLAUDE, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (await stat(diretto).then(() => true, () => false)) return diretto;
  const { valore: indice } = await memo('indice-transcript', 60000, async () => {
    const m = new Map();
    const base = path.join(CLAUDE, 'projects');
    for (const d of await readdir(base).catch(() => [])) {
      for (const f of await readdir(path.join(base, d)).catch(() => [])) {
        if (f.endsWith('.jsonl')) m.set(f.slice(0, -6), path.join(base, d, f));
      }
    }
    return m;
  });
  return indice?.get(sessionId) || null;
}

const cacheTranscript = new Map();

function testoUtente(content) {
  let t = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '';
  const comando = t.match(/<command-name>([^<]+)<\/command-name>/);
  if (comando) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return `${comando[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  if (/^\s*<(local-command|system-reminder|bash-|task-notification)/.test(t)) return null;
  return t.trim() || null;
}

function descriviTool(c) {
  const i = c.input || {};
  const d = i.description || i.command || i.file_path || i.pattern || i.skill || i.url || i.query || i.prompt || '';
  return { tipo: 'tool', nome: c.name, testo: String(d).replace(/\s+/g, ' ').slice(0, 200) };
}

async function ultimaAttivita(cwd, sessionId, transcript = null) {
  const file = (transcript && await stat(transcript).then(() => transcript, () => null)) || await trovaTranscript(cwd, sessionId);
  if (!file) return null;
  let st;
  try { st = await stat(file); } catch { return null; }
  const chiave = `${file}:${st.size}:${st.mtimeMs}`;
  const c = cacheTranscript.get(file);
  if (c?.chiave === chiave) return c.valore;

  const len = Math.min(st.size, 512 * 1024);
  const fh = await open(file, 'r');
  const buf = Buffer.alloc(len);
  try { await fh.read(buf, 0, len, st.size - len); } finally { await fh.close(); }
  const righe = buf.toString('utf8').split('\n');
  if (len < st.size) righe.shift();

  const v = { azione: null, quandoAzione: null, richiesta: null, quandoRichiesta: null, riepilogo: null, branch: null, modificato: st.mtime.toISOString() };
  for (let i = righe.length - 1; i >= 0; i--) {
    if (!righe[i]) continue;
    let o;
    try { o = JSON.parse(righe[i]); } catch { continue; }
    if (o.isSidechain) continue;
    if (!v.branch && o.gitBranch) v.branch = o.gitBranch;
    if (!v.azione && o.type === 'assistant' && Array.isArray(o.message?.content)) {
      const ultimo = [...o.message.content].reverse().find((x) => x.type === 'text' || x.type === 'tool_use');
      if (ultimo) {
        v.azione = ultimo.type === 'text'
          ? { tipo: 'testo', testo: ultimo.text.replace(/\s+/g, ' ').slice(0, 280) }
          : descriviTool(ultimo);
        v.quandoAzione = o.timestamp;
      }
    }
    if (!v.richiesta && o.type === 'user' && !o.isMeta && !o.toolUseResult) {
      const t = testoUtente(o.message?.content);
      if (t) { v.richiesta = t.replace(/\s+/g, ' ').slice(0, 280); v.quandoRichiesta = o.timestamp; }
    }
    if (!v.riepilogo && o.type === 'system' && o.subtype === 'away_summary' && o.content) {
      v.riepilogo = String(o.content).replace(/\s*\(disable recaps[^)]*\)\s*$/, '').slice(0, 400);
    }
    if (v.azione && v.richiesta && v.riepilogo && v.branch) break;
  }
  // un riepilogo più vecchio dell'ultima richiesta non descrive più la sessione
  cacheTranscript.set(file, { chiave, valore: v });
  return v;
}

// ---------------------------------------------------------------- git

async function infoGit(cwd) {
  const { valore } = await memo(`git:${cwd}`, 15000, async () => {
    try {
      const out = await cmd('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel', '--abbrev-ref', 'HEAD'], undefined, 5000);
      const [common, top, branch] = out.trim().split('\n');
      const radice = path.basename(common) === '.git' ? path.dirname(common) : top;
      return { radice, top, branch: branch === 'HEAD' ? null : branch };
    } catch { return null; }
  });
  return valore;
}

async function remoteGithub(radice) {
  const { valore } = await memo(`remote:${radice}`, 300000, async () => {
    try {
      const url = (await cmd('git', ['-C', radice, 'remote', 'get-url', 'origin'], undefined, 5000)).trim();
      const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
      return m ? `${m[1]}/${m[2]}` : null;
    } catch { return null; }
  });
  return valore;
}

async function worktree(radice) {
  const { valore } = await memo(`wt:${radice}`, 15000, async () => {
    const out = await cmd('git', ['-C', radice, 'worktree', 'list', '--porcelain'], undefined, 5000);
    const lista = [];
    let cur = null;
    for (const r of out.split('\n')) {
      if (r.startsWith('worktree ')) { cur = { percorso: r.slice(9), branch: null, head: null }; lista.push(cur); }
      else if (cur && r.startsWith('HEAD ')) cur.head = r.slice(5);
      else if (cur && r.startsWith('branch ')) cur.branch = r.slice(7).replace('refs/heads/', '');
    }
    return lista;
  });
  return valore || [];
}

// ---------------------------------------------------------------- conflitti di merge

// Il risultato di un merge di prova dipende solo dai due commit: si calcola una volta per coppia.
const provaMerge = new Map();

// Prova il merge di due commit senza toccare worktree e indice (git merge-tree, git >= 2.38).
// Restituisce i file in conflitto ([] = nessun conflitto), null se la prova non si può fare.
function fileInConflitto(cwd, a, b) {
  const chiave = `${a}:${b}`;
  if (!provaMerge.has(chiave)) {
    if (provaMerge.size > 2000) provaMerge.clear();
    provaMerge.set(chiave, esegui('git', ['-C', cwd, 'merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { timeout: 20000 })
      .then(() => [])
      .catch((err) => {
        // uscita 1 = conflitti: prima riga l'albero, poi un file per riga
        if (err.code === 1 && typeof err.stdout === 'string') return [...new Set(err.stdout.split('\n').slice(1).filter(Boolean))];
        provaMerge.delete(chiave);
        return null;
      }));
  }
  return provaMerge.get(chiave);
}

const shaDi = (cwd, ref) => cmd('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], undefined, 5000)
  .then((s) => s.trim(), () => null);

// Merge, rebase o cherry-pick lasciato a metà nel worktree, con i file ancora da risolvere.
async function operazioneInCorso(percorso) {
  const { valore } = await memo(`op:${percorso}`, 5000, async () => {
    const out = await cmd('git', ['-C', percorso, 'rev-parse', '--path-format=absolute',
      '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'CHERRY_PICK_HEAD'], undefined, 5000);
    const [merge, rebaseM, rebaseA, cherry] = out.trim().split('\n');
    const esiste = (p) => stat(p).then(() => true, () => false);
    const operazione = (await esiste(merge)) ? 'merge'
      : (await esiste(rebaseM)) || (await esiste(rebaseA)) ? 'rebase'
      : (await esiste(cherry)) ? 'cherry-pick' : null;
    const nonRisolti = await cmd('git', ['-C', percorso, 'diff', '--name-only', '--diff-filter=U'], undefined, 5000)
      .then((s) => s.split('\n').filter(Boolean), () => []);
    return operazione || nonRisolti.length ? { operazione, file: nonRisolti } : null;
  });
  return valore || null;
}

// Stato dei conflitti di un task:
//   github:  la PR aperta non si può unire (mergeable = CONFLICTING)
//   inCorso: merge/rebase a metà nel worktree, con i file da risolvere
//   conBase: il branch del task, unito ora nel branch del piano, andrebbe in conflitto
//   conTask: altri task del piano con cui andrebbe in conflitto (quando entrambi saranno uniti)
async function conflittiTask(radice, wt, base, prGithub) {
  const c = { github: prGithub?.mergeable === 'CONFLICTING', inCorso: null, conBase: null, base: null };
  if (wt) {
    c.inCorso = await operazioneInCorso(wt.percorso).catch(() => null);
    const baseSha = base ? await shaDi(radice, base) : null;
    if (baseSha && wt.head && baseSha !== wt.head) {
      const file = await fileInConflitto(radice, wt.head, baseSha);
      if (file?.length) { c.conBase = file; c.base = base; }
    }
  }
  return c;
}

const haConflitti = (c) => !!(c && (c.github || c.inCorso || c.conBase?.length || c.conTask?.length));

// ---------------------------------------------------------------- github

async function datiGithub(radice, slug, cfg) {
  return memo(`gh:${radice}`, cfg.ttlGithubSec * 1000, async () => {
    const gh = (args) => cmd('gh', [...args, '-R', slug], radice, 30000).then(JSON.parse);
    const [prAperte, prTutte, issueAperte, issueChiuse] = await Promise.all([
      gh(['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName,baseRefName,isDraft,body,url,updatedAt,reviewDecision,mergeable,mergeStateStatus']),
      gh(['pr', 'list', '--state', 'all', '--limit', String(cfg.limitePr), '--json', 'number,title,headRefName,baseRefName,state,url,mergedAt']),
      gh(['issue', 'list', '--state', 'open', '--limit', String(cfg.limiteIssue), '--json', 'number,title,body,labels,url,updatedAt']),
      gh(['issue', 'list', '--state', 'closed', '--limit', String(cfg.limiteIssue), '--json', 'number,title,url,closedAt']),
    ]);
    return { prAperte, prTutte, issueAperte, issueChiuse, letto: new Date().toISOString() };
  });
}

// ---------------------------------------------------------------- parsing piani

function numeroDa(s) {
  if (!s) return null;
  const m = s.match(/(?:^|[/_-])issue[-_]?(\d+)/i) || s.match(/(?:^|\/)(\d+)(?:[-_]|$)/);
  return m ? Number(m[1]) : null;
}

function dipendenzeDaTesto(t) {
  const out = new Set();
  for (const m of (t || '').matchAll(/\b(?:dopo|dipende da|depends on|after|blocked by|bloccat[oa] da)\b([^)\n]*)/gi)) {
    const pezzo = m[1].split(/in parallelo|parallel/i)[0];
    for (const n of pezzo.matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  }
  return out;
}

function dipendenzeDaBody(body) {
  const out = new Set();
  const righe = (body || '').split('\n');
  let dentro = false;
  for (const r of righe) {
    const titolo = r.match(/^#{1,4}\s+(.*)$/);
    if (titolo) { dentro = /^(dipende da|dipendenze|depends on|dependencies|blocked by)\b/i.test(titolo[1].trim()); continue; }
    const inLinea = r.match(/^\s*(?:\*\*)?(?:dipende da|depends on|blocked by)(?:\*\*)?\s*:\s*(.+)$/i);
    const testo = dentro ? r : inLinea ? inLinea[1] : null;
    if (testo) for (const n of testo.matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  }
  return out;
}

function checklist(body) {
  const out = [];
  for (const r of (body || '').split('\n')) {
    const m = r.match(/^\s*[-*]\s+\[( |x|X)\]\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)\b(.*)$/);
    if (m) out.push({ numero: Number(m[2]), spuntata: m[1] !== ' ', testo: m[3].trim() });
  }
  return out;
}

// ---------------------------------------------------------------- assemblaggio

// stato hook → stato usato dalla pagina e dall'app
const STATO_HOOK = { lavora: 'busy', permesso: 'permesso', ferma: 'idle' };

// Sessioni da due fonti: gli eventi hook (fonte principale, anche da altre macchine) e, per le sessioni
// aperte prima che gli hook esistessero, il registro interno ~/.claude/sessions (disattivabile in config).
async function raccogliSessioni(cfg) {
  const ps = await processi();
  const vivo = (pid) => ps.has(Number(pid));
  const daHook = collettore.sessioniAperte(vivo);
  const registro = cfg.leggiRegistroInterno === false ? [] : await leggiSessioni();
  const perId = new Map(registro.map((r) => [r.sessionId, r]));
  const viste = new Set();
  const out = daHook.map((h) => {
    viste.add(h.session_id);
    const r = perId.get(h.session_id); // stesso processo visto anche nel registro: prendi nome e versione
    return {
      fonte: 'hook', host: h.host, locale: h.locale,
      pid: h.pid ?? r?.pid ?? null, sessionId: h.session_id, name: r?.name || null,
      entrypoint: h.origine || r?.entrypoint, status: STATO_HOOK[h.stato] || h.stato,
      statusUpdatedAt: h.da_quando, startedAt: h.avviata, cwd: h.cwd || r?.cwd || '?', version: r?.version || null,
      transcript: h.transcript, hook: { richiesta: h.richiesta, azione: h.azione, messaggio: h.messaggio, aggiornata: h.aggiornata },
    };
  });
  for (const r of registro) if (!viste.has(r.sessionId)) out.push({ ...r, fonte: 'registro', host: HOST_LOCALE, locale: true });
  return out;
}

function descriviSessione(s, git, att) {
  // con gli hook l'azione in corso è certa; il transcript resta per il riepilogo e l'ultima risposta
  if (s.hook) {
    att = { ...(att || {}) };
    if (s.hook.azione && s.status !== 'idle') { att.azione = { tipo: 'tool', nome: s.hook.azione.nome, testo: s.hook.azione.testo }; att.quandoAzione = s.hook.azione.quando; }
    if (s.hook.richiesta) att.richiesta = s.hook.richiesta;
    if (s.hook.messaggio) att.messaggio = s.hook.messaggio;
  }
  return {
    fonte: s.fonte,
    host: s.host,
    locale: s.locale,
    pid: s.pid,
    sessionId: s.sessionId,
    nome: s.name || null,
    origine: ORIGINE[s.entrypoint] || s.entrypoint || '?',
    stato: s.status || 'sconosciuto',
    daQuando: s.statusUpdatedAt ? new Date(s.statusUpdatedAt).toISOString() : null,
    avviata: s.startedAt ? new Date(s.startedAt).toISOString() : null,
    cwd: s.cwd,
    cartella: path.basename(s.cwd),
    repo: git?.radice || null,
    branch: git?.branch || att?.branch || null,
    issue: numeroDa(path.basename(s.cwd)) ?? numeroDa(git?.branch),
    versione: s.version,
    chatCruscotto: chat.sessionIds().has(s.sessionId),
    attivita: att,
  };
}

async function costruisciStato() {
  const cfg = await leggiConfig();
  const errori = [];
  if (cfg._errore) errori.push(`config: ${cfg._errore}`);
  const nascosti = new Set(cfg.nascondiRepo.map(espandi));

  const grezze = await raccogliSessioni(cfg);
  const sessioni = await Promise.all(grezze.map(async (s) => {
    // git e transcript si leggono solo per le sessioni di questa macchina
    const [git, att] = s.locale
      ? await Promise.all([infoGit(s.cwd), ultimaAttivita(s.cwd, s.sessionId, s.transcript).catch(() => null)])
      : [null, null];
    return descriviSessione(s, git, att);
  }));

  // notifica = l'app avvisa per questa sessione (se il suo progetto è seguito):
  // non se l'hai silenziata, e con "solo task" solo se lavora su un'issue
  const silenziate = new Set(preferenze.silenziate || []);
  for (const s of sessioni) {
    s.silenziata = silenziate.has(s.sessionId);
    s.notifica = !s.silenziata && (!preferenze.soloTask || !!s.issue);
  }

  const radici = new Set(cfg.repos.map(espandi));
  for (const s of sessioni) if (s.repo) radici.add(s.repo);
  for (const n of nascosti) radici.delete(n);

  // Progetti seguiti (scelti dalla pagina): con un filtro si mostrano e si contano solo quelli,
  // così anche le notifiche dell'app ignorano le sessioni degli altri progetti.
  const seguiti = preferenze.seguiti ? new Set(preferenze.seguiti) : null;
  if (seguiti) for (const r of seguiti) if (!nascosti.has(r)) radici.add(r);
  const progetti = [...radici]
    .map((r) => ({ radice: r, nome: path.basename(r), sessioni: sessioni.filter((s) => s.repo === r).length, seguito: !seguiti || seguiti.has(r) }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
  // una sessione senza repo (per esempio in un worktree già cancellato) appartiene al progetto che contiene la sua cartella
  const radiceDaPercorso = (cwd) => progetti.find((p) => cwd === p.radice || String(cwd).startsWith(p.radice + '/'))?.radice;
  const seguita = (s) => !seguiti || (s.repo && !nascosti.has(s.repo) ? seguiti.has(s.repo) : seguiti.has(radiceDaPercorso(s.cwd)));
  if (seguiti) for (const r of [...radici]) if (!seguiti.has(r)) radici.delete(r);

  const repos = await Promise.all([...radici].map(async (radice) => {
    const sessRepo = sessioni.filter((s) => s.repo === radice);
    const [slug, wts] = await Promise.all([remoteGithub(radice), worktree(radice).catch(() => [])]);
    const repo = {
      radice, nome: path.basename(radice), github: slug, githubUrl: slug ? `https://github.com/${slug}` : null,
      piani: [], altreSessioni: [], issueFuoriPiano: [], prFuoriPiano: [], errore: null, letto: null,
      comandoAvvio: comandoPer(cfg, radice),
    };
    let dati = null;
    if (slug) {
      const r = await datiGithub(radice, slug, cfg);
      dati = r.valore; repo.errore = r.errore; repo.letto = dati?.letto || null;
    }

    const issueAperte = new Map((dati?.issueAperte || []).map((i) => [i.number, i]));
    const issueChiuse = new Map((dati?.issueChiuse || []).map((i) => [i.number, i]));
    const prTutte = dati?.prTutte || [];
    const prPerBranch = new Map();
    for (const p of prTutte) if (!prPerBranch.has(p.headRefName)) prPerBranch.set(p.headRefName, p);
    // mergeable / mergeStateStatus ci sono solo nella lista delle PR aperte
    const prAperteN = new Map((dati?.prAperte || []).map((p) => [p.number, p]));
    const infoPr = (pr) => {
      if (!pr) return null;
      const a = prAperteN.get(pr.number);
      return { numero: pr.number, url: pr.url, stato: pr.state, conflitto: a?.mergeable === 'CONFLICTING', statoMerge: a?.mergeStateStatus || null };
    };

    const usate = new Set(); // sessioni già mostrate in un piano
    const issueNeiPiani = new Set();
    const prNeiPiani = new Set();

    const sonoPiani = (dati?.prAperte || []).filter((p) =>
      cfg.prefissiPiano.some((pre) => p.headRefName.startsWith(pre)) || checklist(p.body).length >= cfg.minTaskPiano);

    for (const p of sonoPiani) {
      prNeiPiani.add(p.number);
      const voci = checklist(p.body);
      const prTask = prTutte.filter((x) => x.baseRefName === p.headRefName);
      const prDi = (n) => prTask.filter((x) => numeroDa(x.headRefName) === n || new RegExp(`#${n}\\b`).test(x.title))
        .sort((a, b) => (a.state === 'OPEN' ? -1 : 0) - (b.state === 'OPEN' ? -1 : 0) || b.number - a.number);
      const fatto = (n) => {
        const v = voci.find((x) => x.numero === n);
        return issueChiuse.has(n) || prDi(n).some((x) => x.state === 'MERGED') || !!v?.spuntata;
      };

      const task = voci.map((v) => {
        issueNeiPiani.add(v.numero);
        const issue = issueAperte.get(v.numero) || issueChiuse.get(v.numero);
        const dip = new Set([...dipendenzeDaTesto(v.testo), ...dipendenzeDaBody(issueAperte.get(v.numero)?.body)]);
        dip.delete(v.numero);
        const dipAperte = [...dip].filter((n) => !fatto(n));
        const prs = prDi(v.numero);
        prs.forEach((x) => prNeiPiani.add(x.number));
        const pr = prs[0] || null;
        const sess = sessRepo.filter((s) => s.issue === v.numero);
        sess.forEach((s) => usate.add(s.pid));
        const wt = wts.find((w) => numeroDa(path.basename(w.percorso)) === v.numero || numeroDa(w.branch) === v.numero);

        let stato;
        if (fatto(v.numero)) stato = 'fatto';
        else if (sess.some((s) => s.stato === 'permesso')) stato = 'permesso';
        else if (sess.some((s) => s.stato === 'busy')) stato = 'in_corso';
        else if (pr?.state === 'OPEN') stato = 'pr';
        else if (sess.length) stato = 'aspetta_te';
        else if (dipAperte.length) stato = 'bloccato';
        else stato = 'pronto';

        return {
          numero: v.numero,
          titolo: issue?.title || v.testo.replace(/\s*\([^)]*\)\s*$/, '') || `#${v.numero}`,
          url: issue?.url || (slug ? `https://github.com/${slug}/issues/${v.numero}` : null),
          statoIssue: issueAperte.has(v.numero) ? 'aperta' : issueChiuse.has(v.numero) ? 'chiusa' : 'sconosciuta',
          stato,
          dipendenze: [...dip].sort((a, b) => a - b),
          dipendenzeAperte: dipAperte.sort((a, b) => a - b),
          pr: infoPr(pr),
          sessioni: sess,
          worktree: wt ? { percorso: wt.percorso, branch: wt.branch } : null,
          _wt: wt,
        };
      });

      // conflitti: solo per i task non ancora fatti
      const basePiano = (await esisteRef(radice, `origin/${p.headRefName}`)) ? `origin/${p.headRefName}`
        : (await esisteRef(radice, p.headRefName)) ? p.headRefName : null;
      const baseSha = basePiano ? await shaDi(radice, basePiano) : null;
      const aperti = task.filter((t) => t.stato !== 'fatto');
      await Promise.all(aperti.map(async (t) => {
        t.conflitti = await conflittiTask(radice, t._wt, basePiano, t.pr?.stato === 'OPEN' ? prAperteN.get(t.pr.numero) : null);
      }));
      // coppie di task con lavoro proprio (commit oltre il piano): andranno in conflitto tra loro?
      const conLavoro = aperti.filter((t) => t._wt?.head && t._wt.head !== baseSha);
      for (let i = 0; i < conLavoro.length; i++) {
        for (let j = i + 1; j < conLavoro.length; j++) {
          const [a, b] = [conLavoro[i], conLavoro[j]];
          const file = await fileInConflitto(radice, a._wt.head, b._wt.head);
          if (!file?.length) continue;
          (a.conflitti.conTask ||= []).push({ numero: b.numero, file });
          (b.conflitti.conTask ||= []).push({ numero: a.numero, file });
        }
      }
      for (const t of task) {
        delete t._wt;
        if (!haConflitti(t.conflitti)) t.conflitti = null;
      }

      const conta = {};
      for (const t of task) conta[t.stato] = (conta[t.stato] || 0) + 1;
      // sessioni che lavorano sul branch del piano stesso
      const sessPiano = sessRepo.filter((s) => s.branch === p.headRefName);
      sessPiano.forEach((s) => usate.add(s.pid));
      repo.piani.push({
        numero: p.number, titolo: p.title, url: p.url, branch: p.headRefName, base: p.baseRefName,
        bozza: p.isDraft, aggiornato: p.updatedAt, task, conta, sessioni: sessPiano,
        // il piano stesso verso main
        conflitto: p.mergeable === 'CONFLICTING', statoMerge: p.mergeStateStatus || null,
        taskInConflitto: task.filter((t) => t.conflitti).length,
      });
    }

    for (const s of sessRepo) {
      if (usate.has(s.pid)) continue;
      const pr = s.branch ? prPerBranch.get(s.branch) : null;
      const issue = s.issue ? (issueAperte.get(s.issue) || issueChiuse.get(s.issue)) : null;
      const finita = (s.issue && issueChiuse.has(s.issue)) || pr?.state === 'MERGED' || pr?.state === 'CLOSED';
      const pi = infoPr(pr);
      const inCorso = s.locale && s.cwd ? await operazioneInCorso(s.cwd).catch(() => null) : null;
      const conflitti = pi?.conflitto || inCorso ? { github: !!pi?.conflitto, inCorso } : null;
      repo.altreSessioni.push({
        ...s,
        issueInfo: issue ? { numero: s.issue, titolo: issue.title, url: issue.url, stato: issueAperte.has(s.issue) ? 'aperta' : 'chiusa' } : null,
        pr: pi,
        conflitti,
        daChiudere: !!finita && s.stato !== 'busy',
      });
    }

    // prima chi lavora, poi le più recenti
    repo.altreSessioni.sort((a, b) => (b.stato === 'busy') - (a.stato === 'busy') || String(b.daQuando).localeCompare(String(a.daQuando)));

    const sessPerIssue = new Map();
    for (const s of sessRepo) if (s.issue) sessPerIssue.set(s.issue, [...(sessPerIssue.get(s.issue) || []), s.pid]);
    repo.issueFuoriPiano = [...issueAperte.values()]
      .filter((i) => !issueNeiPiani.has(i.number))
      .map((i) => ({ numero: i.number, titolo: i.title, url: i.url, etichette: i.labels.map((l) => l.name), aggiornata: i.updatedAt, sessioni: sessPerIssue.get(i.number) || [] }));
    repo.prFuoriPiano = (dati?.prAperte || [])
      .filter((p) => !prNeiPiani.has(p.number))
      .map((p) => ({ numero: p.number, titolo: p.title, url: p.url, branch: p.headRefName, base: p.baseRefName, bozza: p.isDraft, revisione: p.reviewDecision,
        conflitto: p.mergeable === 'CONFLICTING', statoMerge: p.mergeStateStatus || null }));
    return repo;
  }));

  repos.sort((a, b) => b.piani.length - a.piani.length
    || sessioni.filter((s) => s.repo === b.radice).length - sessioni.filter((s) => s.repo === a.radice).length
    || a.nome.localeCompare(b.nome));

  const fuoriRepo = sessioni.filter((s) => (!s.repo || nascosti.has(s.repo)) && seguita(s));
  const visibili = sessioni.filter(seguita);
  const daChiudere = repos.reduce((n, r) => n + r.altreSessioni.filter((s) => s.daChiudere).length, 0);
  // elenco piatto dei conflitti, per i contatori e le notifiche dell'app
  const conflitti = [];
  for (const r of repos) {
    for (const p of r.piani) {
      if (p.conflitto) conflitti.push({ chiave: `${r.radice}#piano${p.numero}`, repo: r.nome, tipo: 'piano', numero: p.numero, titolo: p.titolo, url: p.url });
      for (const t of p.task) if (t.conflitti) conflitti.push({ chiave: `${r.radice}#${t.numero}`, repo: r.nome, tipo: 'task', numero: t.numero, titolo: t.titolo, url: t.pr?.url || t.url, dettaglio: t.conflitti });
    }
    for (const s of r.altreSessioni) if (s.conflitti) conflitti.push({ chiave: `${r.radice}@${s.sessionId}`, repo: r.nome, tipo: 'sessione', numero: s.issue, titolo: s.nome || s.cartella, url: s.pr?.url || null, dettaglio: s.conflitti });
    for (const p of r.prFuoriPiano) if (p.conflitto) conflitti.push({ chiave: `${r.radice}#pr${p.numero}`, repo: r.nome, tipo: 'pr', numero: p.numero, titolo: p.titolo, url: p.url });
  }

  return {
    generato: new Date().toISOString(),
    totali: {
      sessioni: visibili.length,
      lavorano: visibili.filter((s) => s.stato === 'busy').length,
      permessi: visibili.filter((s) => s.stato === 'permesso').length,
      ferme: visibili.filter((s) => s.stato !== 'busy' && s.stato !== 'permesso').length,
      daHook: visibili.filter((s) => s.fonte === 'hook').length,
      daChiudere,
      conflitti: conflitti.length,
      perOrigine: visibili.reduce((m, s) => ({ ...m, [s.origine]: (m[s.origine] || 0) + 1 }), {}),
    },
    repos,
    fuoriRepo,
    conflitti,
    progetti,
    seguiti: preferenze.seguiti,
    silenziate: preferenze.silenziate || [],
    soloTask: !!preferenze.soloTask,
    fuoriFiltro: sessioni.length - visibili.length,
    // elenco piatto per l'app della barra dei menu
    sessioni: visibili.map((s) => ({
      sessionId: s.sessionId, fonte: s.fonte, host: s.host,
      pid: s.pid, nome: s.nome, origine: s.origine, stato: s.stato, cartella: s.cartella,
      issue: s.issue, repo: s.repo, branch: s.branch, chatCruscotto: s.chatCruscotto, daQuando: s.daQuando,
      notifica: s.notifica, silenziata: s.silenziata,
    })),
    config: cfg._file || null,
    errori,
  };
}

// ---------------------------------------------------------------- diff di un task

const MAX_PATCH = 1.5 * 1024 * 1024;
const refValido = (r) => typeof r === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(r) && !r.startsWith('-') && !r.includes('..');

function taglia(s) {
  return s.length > MAX_PATCH ? { patch: s.slice(0, MAX_PATCH), troncato: true } : { patch: s, troncato: false };
}

async function esisteRef(cwd, ref) {
  return cmd('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], undefined, 5000).then(() => true, () => false);
}

// Base del confronto: branch del piano (prima origin/, aggiornato dai merge), altrimenti il branch di default.
async function baseDelConfronto(cwd, piano) {
  const candidati = [];
  if (piano) candidati.push(`origin/${piano}`, piano);
  const def = await cmd('git', ['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], undefined, 5000).then((s) => s.trim(), () => null);
  if (def) candidati.push(def);
  candidati.push('origin/main', 'main', 'origin/master', 'master');
  for (const c of candidati) if (await esisteRef(cwd, c)) return c;
  return null;
}

async function diffTask({ repo, numero, piano }) {
  const n = Number(numero);
  if (!Number.isInteger(n) || n <= 0) return [400, { errore: 'numero issue non valido' }];
  if (piano && !refValido(piano)) return [400, { errore: 'branch del piano non valido' }];
  const git = repo && path.isAbsolute(repo) ? await infoGit(repo) : null;
  if (!git || git.radice !== repo) return [400, { errore: 'repo non valido' }];

  const wt = (await worktree(repo)).find((w) => w.percorso !== repo
    && (numeroDa(path.basename(w.percorso)) === n || numeroDa(w.branch) === n));

  if (wt) {
    const g = (args) => cmd('git', ['-C', wt.percorso, ...args], undefined, 20000);
    const base = await baseDelConfronto(wt.percorso, piano);
    const mb = base ? (await g(['merge-base', 'HEAD', base]).catch(() => '')).trim() : '';
    const [log, committate, locali, nuovi] = await Promise.all([
      mb ? g(['log', '--no-color', '--format=%h%x09%an%x09%cI%x09%s', `${mb}..HEAD`]) : '',
      mb ? g(['diff', '--no-color', '--no-ext-diff', mb, 'HEAD']) : '',
      g(['diff', '--no-color', '--no-ext-diff', 'HEAD']),
      g(['ls-files', '--others', '--exclude-standard']),
    ]);
    const vuoto = !log.trim() && !committate && !locali && !nuovi.trim();
    const risultato = {
      fonte: 'worktree',
      percorso: wt.percorso,
      branch: wt.branch,
      base,
      commit: log.trim() ? log.trim().split('\n').map((r) => { const [hash, autore, data, titolo] = r.split('\t'); return { hash, autore, data, titolo }; }) : [],
      sezioni: [
        { chiave: 'committate', titolo: `Commit rispetto a ${base || '?'}`, ...taglia(committate) },
        { chiave: 'locali', titolo: 'Modifiche non ancora committate', ...taglia(locali) },
      ],
      nonTracciati: nuovi.trim() ? nuovi.trim().split('\n') : [],
      letto: new Date().toISOString(),
    };
    // worktree senza differenze = lavoro già unito nel piano: più utile il diff della PR
    if (!vuoto) return [200, risultato];
    const daPr = await diffPr(repo, n, piano);
    return daPr[0] === 200 ? daPr : [200, risultato];
  }
  return diffPr(repo, n, piano);
}

// diff della PR del task su GitHub
async function diffPr(repo, n, piano) {
  const slug = await remoteGithub(repo);
  const cfg = await leggiConfig();
  const dati = slug ? (await datiGithub(repo, slug, cfg)).valore : null;
  const pr = (dati?.prTutte || [])
    .filter((p) => (!piano || p.baseRefName === piano) && (numeroDa(p.headRefName) === n || new RegExp(`#${n}\\b`).test(p.title)))
    .sort((a, b) => b.number - a.number)[0];
  if (!pr) return [404, { errore: `nessun worktree e nessuna PR per #${n}` }];
  const patch = await cmd('gh', ['pr', 'diff', String(pr.number), '-R', slug, '--color', 'never'], repo, 30000);
  return [200, {
    fonte: 'pr', pr: { numero: pr.number, url: pr.url, stato: pr.state }, branch: pr.headRefName, base: pr.baseRefName,
    commit: [], sezioni: [{ chiave: 'pr', titolo: `Diff della PR #${pr.number}`, ...taglia(patch) }], nonTracciati: [],
    letto: new Date().toISOString(),
  }];
}

// ---------------------------------------------------------------- avvio di una sessione

const comandoPer = (cfg, radice) => cfg.comandoAvvio[radice] || cfg.comandoAvvio[path.basename(radice)] || null;
const virgolette = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const avviiRecenti = new Map();

const SCRIPT_TERMINALE = {
  Terminal: ['on run argv', 'tell application "Terminal"', 'activate', 'do script (item 1 of argv)', 'end tell', 'end run'],
  iTerm: ['on run argv', 'tell application "iTerm"', 'activate', 'set w to (create window with default profile)',
    'tell current session of w to write text (item 1 of argv)', 'end tell', 'end run'],
};

// Il comando arriva solo dal config locale: dalla pagina passano un repo e un numero, mai testo libero.
async function avviaSessione({ repo, numero }) {
  const cfg = await leggiConfig();
  const n = Number(numero);
  if (!Number.isInteger(n) || n <= 0 || n > 1e7) return [400, 'numero issue non valido'];
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) return [400, 'repo non valido'];
  const modello = comandoPer(cfg, repo);
  if (!modello) return [400, `nessun comandoAvvio in config per ${path.basename(repo)}`];
  const git = await infoGit(repo);
  if (!git || git.radice !== repo) return [400, 'il percorso non è la radice di un repo git'];

  const chiave = `${repo}#${n}`;
  if (Date.now() - (avviiRecenti.get(chiave) || 0) < 30000) return [409, 'avviata da meno di 30 secondi'];
  for (const s of await leggiSessioni()) {
    if (numeroDa(path.basename(s.cwd)) === n && (await infoGit(s.cwd))?.radice === repo) {
      return [409, `c'è già una sessione viva su #${n} (pid ${s.pid})`];
    }
  }

  const script = SCRIPT_TERMINALE[cfg.terminale] || SCRIPT_TERMINALE.Terminal;
  const riga = `cd ${virgolette(repo)} && ${modello.replaceAll('{n}', String(n))}`;
  await cmd('osascript', [...script.flatMap((l) => ['-e', l]), '--', riga], undefined, 15000);
  avviiRecenti.set(chiave, Date.now());
  return [200, riga];
}

async function corpoJson(req) {
  let s = '';
  for await (const pezzo of req) { s += pezzo; if (s.length > 10000) throw new Error('corpo troppo grande'); }
  return JSON.parse(s || '{}');
}

// ---------------------------------------------------------------- http

const HOST_AMMESSI = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ORIGINI_AMMESSE = new Set([...HOST_AMMESSI].map((h) => `http://${h}`));

// Un sito qualsiasi aperto nel browser può fare POST verso 127.0.0.1: le azioni si accettano solo
// dalla pagina del cruscotto (Origin) e con un header custom, che forza il preflight CORS.
const azioneAmmessa = (req) => req.method === 'POST' && ORIGINI_AMMESSE.has(req.headers.origin)
  && req.headers['x-cruscotto'] === '1' && String(req.headers['content-type']).startsWith('application/json');

const json = (res, codice, corpo) => {
  res.writeHead(codice, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(corpo));
};

const chat = new GestoreChat({
  cartellaDati: path.join(QUI, 'dati', 'chat'),
  verificaRepo: async (repo) => typeof repo === 'string' && path.isAbsolute(repo) && (await infoGit(repo))?.radice === repo,
});
await chat.carica();

const collettore = new Collettore({
  cartellaDati: path.join(QUI, 'dati'),
  fileToken: process.env.CRUSCOTTO_TOKEN_FILE || path.join(HOME, '.config', 'cruscotto-claude', 'token'),
});
await collettore.carica();

// Preferenze della pagina. seguiti = null: tutti i progetti; altrimenti le radici dei repo seguiti.
const FILE_PREFERENZE = path.join(QUI, 'dati', 'preferenze.json');
let preferenze = { seguiti: null, silenziate: [], soloTask: false };
try { preferenze = { ...preferenze, ...JSON.parse(await readFile(FILE_PREFERENZE, 'utf8')) }; } catch {}

// Si aggiornano solo le chiavi presenti: seguiti, silenziate (id di sessione), soloTask.
async function salvaPreferenze(nuove) {
  if (!nuove || typeof nuove !== 'object') throw new Error('preferenze non valide');
  const p = { ...preferenze };
  if ('seguiti' in nuove) {
    const s = nuove.seguiti;
    const valido = s === null || (Array.isArray(s) && s.length <= 100
      && s.every((x) => typeof x === 'string' && x.length < 1000 && path.isAbsolute(x)));
    if (!valido) throw new Error('seguiti: null oppure un elenco di percorsi assoluti');
    p.seguiti = s === null || !s.length ? null : [...new Set(s)];
  }
  if ('silenziate' in nuove) {
    const s = nuove.silenziate;
    if (!Array.isArray(s) || s.length > 500 || !s.every((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(x))) {
      throw new Error('silenziate: elenco di id di sessione');
    }
    p.silenziate = [...new Set(s)].slice(-200);
  }
  if ('soloTask' in nuove) {
    if (typeof nuove.soloTask !== 'boolean') throw new Error('soloTask: true o false');
    p.soloTask = nuove.soloTask;
  }
  preferenze = p;
  await mkdir(path.dirname(FILE_PREFERENZE), { recursive: true });
  await writeFile(FILE_PREFERENZE, JSON.stringify(preferenze, null, 2));
}

// POST /api/eventi dagli hook (hooks/cruscotto.sh). Niente Origin: viene da curl, si autentica col token.
async function riceviEvento(req, res) {
  if (req.method !== 'POST') return json(res, 405, { errore: 'solo POST' });
  if (!collettore.tokenValido(req.headers['x-cruscotto-token'])) return json(res, 401, { errore: 'token non valido' });
  let s = '';
  for await (const pezzo of req) { s += pezzo; if (s.length > 512 * 1024) return json(res, 413, { errore: 'evento troppo grande' }); }
  collettore.registra(JSON.parse(s), {
    host: req.headers['x-cruscotto-host'], pid: req.headers['x-cruscotto-pid'], origine: req.headers['x-cruscotto-origine'],
  });
  res.writeHead(204).end();
}

async function gestisciChat(req, res, url) {
  const parti = url.pathname.split('/').filter(Boolean); // api chat [id] [azione]
  const [, , id, azione] = parti;

  if (id === 'limiti' && req.method === 'GET') return json(res, 200, chat.limiti);
  if (!id) {
    if (req.method === 'GET') return json(res, 200, chat.elenco());
    if (!azioneAmmessa(req)) return json(res, 403, { errore: 'richiesta non ammessa' });
    const { repo } = await corpoJson(req);
    const c = await chat.crea(repo);
    return json(res, 200, { id: c.id });
  }

  const c = chat.get(id);
  if (!c) return json(res, 404, { errore: 'chat non trovata' });

  if (azione === 'eventi' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    const manda = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const stacca = chat.ascolta(c, Number(url.searchParams.get('da') || 0), manda);
    const battito = setInterval(() => res.write(': battito\n\n'), 20000);
    req.on('close', () => { stacca(); clearInterval(battito); });
    return;
  }

  if (!azioneAmmessa(req)) return json(res, 403, { errore: 'richiesta non ammessa' });
  const corpo = await corpoJson(req);
  if (azione === 'messaggio') await chat.invia(c, corpo.testo);
  else if (azione === 'permesso') chat.rispondi(c, corpo.id, corpo);
  else if (azione === 'interrompi') await chat.interrompi(c);
  else if (azione === 'chiudi') await chat.chiudi(c);
  else return json(res, 404, { errore: 'azione sconosciuta' });
  return json(res, 200, { ok: true });
}

for (const segnale of ['SIGINT', 'SIGTERM']) {
  process.on(segnale, async () => { await chat.chiudiTutte().catch(() => {}); process.exit(0); });
}

const server = http.createServer(async (req, res) => {
  // blocca il DNS rebinding: la pagina legge transcript locali
  if (!HOST_AMMESSI.has(req.headers.host)) { res.writeHead(403).end('host non ammesso'); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/eventi') {
      try { await riceviEvento(req, res); } catch (e) { if (!res.headersSent) json(res, 400, { errore: String(e.message || e) }); }
      return;
    }
    if (url.pathname === '/api/chat' || url.pathname.startsWith('/api/chat/')) {
      try { await gestisciChat(req, res, url); } catch (e) { if (!res.headersSent) json(res, 400, { errore: String(e.message || e) }); }
      return;
    }
    if (url.pathname === '/api/preferenze') {
      if (req.method === 'GET') return json(res, 200, preferenze);
      if (!azioneAmmessa(req)) return json(res, 403, { errore: 'richiesta non ammessa' });
      try { await salvaPreferenze(await corpoJson(req)); } catch (e) { return json(res, 400, { errore: String(e.message || e) }); }
      return json(res, 200, preferenze);
    }
    if (url.pathname === '/api/avvia') {
      if (!azioneAmmessa(req)) {
        res.writeHead(403).end('richiesta non ammessa');
        return;
      }
      const [codice, testo] = await avviaSessione(await corpoJson(req));
      console.log(`avvio ${codice}: ${testo}`);
      res.writeHead(codice, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(codice === 200 ? { ok: true, comando: testo } : { errore: testo }));
      return;
    }
    if (url.pathname === '/api/diff') {
      const q = url.searchParams;
      const [codice, corpo] = await diffTask({ repo: q.get('repo'), numero: q.get('numero'), piano: q.get('piano') || null });
      res.writeHead(codice, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(corpo));
      return;
    }
    if (url.pathname === '/api/stato') {
      if (url.searchParams.has('forza')) invalidaGithub();
      const stato = await costruisciStato();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(stato));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(await readFile(path.join(QUI, 'public', 'index.html')));
      return;
    }
    res.writeHead(404).end('non trovato');
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ errore: String(e.message || e) }));
  }
});

server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // porta occupata: se è già un cruscotto, basta dirlo; altrimenti suggerire un'altra porta
  const giaNostro = await fetch(`http://${HOST}:${PORT}/api/stato`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok && r.json()).then((d) => !!d?.totali).catch(() => false);
  if (giaNostro) {
    console.log(`Il cruscotto è già attivo su http://${HOST}:${PORT}`);
    process.exit(0);
  }
  console.error(`La porta ${PORT} è occupata da un altro programma. Prova: PORT=4318 npm start`);
  process.exit(1);
});

server.listen(PORT, HOST, () => console.log(`Cruscotto su http://${HOST}:${PORT}`));
