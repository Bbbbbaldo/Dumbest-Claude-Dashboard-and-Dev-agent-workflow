// Chat agentica del cruscotto: una sessione Claude Code (Agent SDK) per chat, nella cartella del repo.
// Carica CLAUDE.md, skill, MCP e hook del progetto come la CLI. Ogni richiesta di permesso
// passa dalla pagina: l'utente consente o nega dal browser.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const esegui = promisify(execFile);
const MAX_EVENTI = 2000;

const ISTRUZIONI = `Sei la chat del "Cruscotto agenti", aperta dall'utente nella radice del repo.
Serve a pianificare e a modificare issue, piani e task (issue GitHub, checklist delle PR dei piani, dipendenze),
seguendo le regole del CLAUDE.md del progetto e le sue skill (per esempio /pianifica).
I task si eseguono in sessioni separate, in worktree, avviate dal cruscotto: qui non implementare codice dei task
salvo richiesta esplicita. Non fare mai merge di PR. L'utente vede le tue risposte in una pagina web:
rispondi in modo compatto, con link alle issue e PR che crei o modifichi.`;

// coda di messaggi utente per lo streaming input dell'SDK
class Coda {
  constructor() { this.voci = []; this.attesa = null; this.chiusa = false; }
  metti(v) { if (this.chiusa) return; if (this.attesa) { this.attesa(v); this.attesa = null; } else this.voci.push(v); }
  chiudi() { this.chiusa = true; if (this.attesa) { this.attesa(null); this.attesa = null; } }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const v = this.voci.length ? this.voci.shift() : this.chiusa ? null : await new Promise((r) => { this.attesa = r; });
      if (v === null) return;
      yield v;
    }
  }
}

function riassumiInput(nome, input = {}) {
  const i = input;
  if (nome === 'Bash') return i.command || '';
  if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(nome)) return i.file_path || i.notebook_path || '';
  if (nome === 'Grep' || nome === 'Glob') return `${i.pattern || ''}${i.path ? ' in ' + i.path : ''}`;
  if (nome === 'Skill') return `${i.skill || ''} ${i.args || ''}`.trim();
  if (nome === 'Agent' || nome === 'Task') return i.description || '';
  if (nome === 'WebFetch') return i.url || '';
  if (nome === 'WebSearch') return i.query || '';
  const s = JSON.stringify(i);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

function testoRisultato(c) {
  const t = typeof c.content === 'string' ? c.content
    : Array.isArray(c.content) ? c.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
  return t.length > 1500 ? t.slice(0, 1500) + '\n…' : t;
}

export class GestoreChat {
  constructor({ cartellaDati, verificaRepo }) {
    this.cartella = cartellaDati;
    this.verificaRepo = verificaRepo; // async (repo) => bool
    this.chat = new Map();
    this.eseguibile = null;
    this.limiti = {}; // ultimo rate_limit_event per finestra (five_hour, seven_day, …)
  }

  async carica() {
    await mkdir(this.cartella, { recursive: true });
    try {
      const indice = JSON.parse(await readFile(path.join(this.cartella, 'indice.json'), 'utf8'));
      for (const c of indice) {
        let eventi = [];
        try { eventi = JSON.parse(await readFile(path.join(this.cartella, `${c.id}.json`), 'utf8')); } catch {}
        this.chat.set(c.id, this.#nuovaStruttura({ ...c, eventi, stato: 'chiusa' }));
      }
    } catch {}
    // il claude installato (stesso login e versione della CLI): prima nel PATH ricevuto, poi dalla shell di login
    for (const dir of (process.env.PATH || '').split(':')) {
      const p = path.join(dir, 'claude');
      try { await access(p, constants.X_OK); this.eseguibile = p; break; } catch {}
    }
    if (!this.eseguibile) {
      try { this.eseguibile = (await esegui('/bin/zsh', ['-lic', 'command -v claude'])).stdout.trim().split('\n').pop() || null; } catch {}
    }
  }

  #nuovaStruttura(dati) {
    return {
      id: dati.id, repo: dati.repo, titolo: dati.titolo || 'Nuova chat', sessionId: dati.sessionId || null,
      creata: dati.creata || new Date().toISOString(), aggiornata: dati.aggiornata || dati.creata || new Date().toISOString(),
      stato: dati.stato || 'pronta', eventi: dati.eventi || [], seq: (dati.eventi || []).reduce((m, e) => Math.max(m, e.seq), 0),
      ascoltatori: new Set(), permessi: new Map(), coda: null, q: null, abort: null, salvataggio: null,
      ultimoTotale: dati.ultimoTotale || null, // token cumulativi all'ultimo turno, per il conto per turno dopo un resume
    };
  }

  elenco() {
    return [...this.chat.values()]
      .sort((a, b) => b.aggiornata.localeCompare(a.aggiornata))
      .map((c) => ({ id: c.id, repo: c.repo, titolo: c.titolo, stato: c.stato, sessionId: c.sessionId, aggiornata: c.aggiornata, permessiInAttesa: c.permessi.size }));
  }

  sessionIds() { return new Set([...this.chat.values()].map((c) => c.sessionId).filter(Boolean)); }

  get(id) { return this.chat.get(id) || null; }

  // ------------------------------------------------------------ eventi

  #emetti(c, evento, { salva = true } = {}) {
    const e = { ...evento, seq: salva ? ++c.seq : c.seq, t: new Date().toISOString() };
    if (salva) {
      c.eventi.push(e);
      if (c.eventi.length > MAX_EVENTI) c.eventi.splice(0, c.eventi.length - MAX_EVENTI);
      c.aggiornata = e.t;
      this.#salvaPresto(c);
    }
    for (const f of c.ascoltatori) f(e);
  }

  #stato(c, stato) {
    if (c.stato === stato) return;
    c.stato = stato;
    this.#emetti(c, { tipo: 'stato', stato });
  }

  ascolta(c, da, f) {
    for (const e of c.eventi) if (e.seq > da) f(e);
    // le richieste ancora aperte: le altre schede di permesso in storia sono solo storia
    f({ tipo: 'stato', stato: c.stato, pendenti: [...c.permessi.keys()], seq: c.seq, replay: true });
    c.ascoltatori.add(f);
    return () => c.ascoltatori.delete(f);
  }

  #salvaPresto(c) {
    clearTimeout(c.salvataggio);
    c.salvataggio = setTimeout(() => this.#salva(c).catch((e) => console.error('salvataggio chat', e)), 500);
  }

  async #salva(c) {
    await writeFile(path.join(this.cartella, `${c.id}.json`), JSON.stringify(c.eventi));
    const indice = [...this.chat.values()].map((x) => ({ id: x.id, repo: x.repo, titolo: x.titolo, sessionId: x.sessionId, creata: x.creata, aggiornata: x.aggiornata, ultimoTotale: x.ultimoTotale }));
    await writeFile(path.join(this.cartella, 'indice.json'), JSON.stringify(indice, null, 1));
  }

  // ------------------------------------------------------------ ciclo di vita

  async crea(repo) {
    if (!(await this.verificaRepo(repo))) throw new Error('repo non valido');
    const c = this.#nuovaStruttura({ id: randomUUID(), repo });
    this.chat.set(c.id, c);
    this.#emetti(c, { tipo: 'sistema', testo: `Chat aperta in ${repo}` });
    return c;
  }

  #avvia(c) {
    c.coda = new Coda();
    c.abort = new AbortController();
    const opzioni = {
      cwd: c.repo,
      abortController: c.abort,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: ISTRUZIONI },
      permissionMode: 'default',
      includePartialMessages: true,
      canUseTool: (nome, input, opz) => this.#chiediPermesso(c, nome, input, opz),
      stderr: (s) => { if (/error/i.test(s)) console.error(`[chat ${c.id.slice(0, 8)}] ${s.trim()}`); },
    };
    if (this.eseguibile) opzioni.pathToClaudeCodeExecutable = this.eseguibile;
    if (c.sessionId) opzioni.resume = c.sessionId;
    c.q = query({ prompt: c.coda, options: opzioni });
    this.#leggi(c).catch(() => {});
  }

  async invia(c, testo) {
    testo = String(testo || '').trim();
    if (!testo) throw new Error('messaggio vuoto');
    if (testo.length > 50000) throw new Error('messaggio troppo lungo');
    if (!c.q) {
      if (c.sessionId) this.#emetti(c, { tipo: 'sistema', testo: 'Riprendo la conversazione precedente.' });
      this.#avvia(c);
    }
    if (c.titolo === 'Nuova chat') c.titolo = testo.replace(/\s+/g, ' ').slice(0, 70);
    this.#emetti(c, { tipo: 'utente', testo });
    this.#stato(c, 'lavora');
    c.coda.metti({ type: 'user', message: { role: 'user', content: testo }, parent_tool_use_id: null, session_id: c.sessionId || '' });
  }

  async interrompi(c) {
    for (const p of c.permessi.values()) p.risolvi({ behavior: 'deny', message: 'Interrotto dall\'utente dal cruscotto.', interrupt: true });
    if (c.q) await c.q.interrupt().catch(() => {});
  }

  async chiudi(c) {
    await this.interrompi(c);
    c.coda?.chiudi();
    c.abort?.abort();
    c.q = null; c.coda = null;
    this.#stato(c, 'chiusa');
  }

  async chiudiTutte() {
    await Promise.all([...this.chat.values()].filter((c) => c.q).map((c) => this.chiudi(c)));
    await Promise.all([...this.chat.values()].map((c) => this.#salva(c).catch(() => {})));
  }

  async #leggi(c) {
    try {
      for await (const m of c.q) this.#gestisci(c, m);
      if (c.stato !== 'chiusa') this.#stato(c, 'chiusa');
    } catch (e) {
      if (c.abort?.signal.aborted) return;
      this.#emetti(c, { tipo: 'errore', testo: String(e?.message || e).slice(0, 2000) });
      this.#stato(c, 'errore');
    } finally {
      c.q = null; c.coda = null;
    }
  }

  #gestisci(c, m) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          const nuova = c.sessionId !== m.session_id;
          c.sessionId = m.session_id;
          // 'none' = login dell'abbonamento claude.ai: total_cost_usd è solo una stima a prezzi API, non una spesa
          c.fonteChiave = m.apiKeySource;
          if (nuova) this.#emetti(c, { tipo: 'sistema', testo: `Sessione ${m.session_id.slice(0, 8)} · ${m.model} · v${m.claude_code_version}` });
        }
        break;
      case 'stream_event': {
        if (m.parent_tool_use_id) break;
        const ev = m.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.#emetti(c, { tipo: 'delta', testo: ev.delta.text }, { salva: false });
        }
        break;
      }
      case 'assistant':
        for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text?.trim()) {
            if (!m.parent_tool_use_id) this.#emetti(c, { tipo: 'testo', testo: b.text });
          } else if (b.type === 'tool_use') {
            this.#emetti(c, { tipo: 'tool', id: b.id, nome: b.name, riassunto: riassumiInput(b.name, b.input), sub: !!m.parent_tool_use_id });
          }
        }
        break;
      case 'user':
        if (Array.isArray(m.message?.content)) {
          for (const b of m.message.content) {
            if (b.type === 'tool_result') {
              this.#emetti(c, { tipo: 'esito', id: b.tool_use_id, errore: !!b.is_error, testo: testoRisultato(b), sub: !!m.parent_tool_use_id });
            }
          }
        }
        break;
      case 'rate_limit_event': {
        // limiti dell'abbonamento claude.ai: valgono per tutto l'account, non per la singola chat
        const info = m.rate_limit_info || {};
        this.limiti[info.rateLimitType || 'sconosciuto'] = { ...info, ricevuto: new Date().toISOString() };
        break;
      }
      case 'result': {
        // modelUsage è cumulativo nella sessione: il turno è la differenza col risultato precedente
        const totale = { input: 0, output: 0, cacheLettura: 0, cacheScrittura: 0, thinking: 0, modelli: {} };
        for (const [modello, u] of Object.entries(m.modelUsage || {})) {
          totale.input += u.inputTokens || 0;
          totale.output += u.outputTokens || 0;
          totale.cacheLettura += u.cacheReadInputTokens || 0;
          totale.cacheScrittura += u.cacheCreationInputTokens || 0;
          totale.thinking += u.thinkingTokens || 0;
          totale.modelli[modello] = { input: u.inputTokens, output: u.outputTokens, cacheLettura: u.cacheReadInputTokens, cacheScrittura: u.cacheCreationInputTokens };
        }
        const prec = c.ultimoTotale || { input: 0, output: 0, cacheLettura: 0, cacheScrittura: 0, thinking: 0 };
        const turno = {};
        for (const k of ['input', 'output', 'cacheLettura', 'cacheScrittura', 'thinking']) turno[k] = Math.max(0, totale[k] - prec[k]);
        c.ultimoTotale = totale;
        this.#emetti(c, {
          tipo: 'fine', errore: m.is_error || m.subtype !== 'success', sottotipo: m.subtype,
          durata: m.duration_ms, costo: m.total_cost_usd, turni: m.num_turns,
          abbonamento: c.fonteChiave === 'none',
          token: { turno, totale },
        });
        this.#stato(c, c.permessi.size ? 'permesso' : 'pronta');
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------ permessi

  #chiediPermesso(c, nome, input, { signal, suggestions, decisionReason, blockedPath, mcpServer }) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const evento = {
        tipo: 'permesso', id, nome, input, riassunto: riassumiInput(nome, input),
        motivo: decisionReason || null, percorso: blockedPath || null,
        mcp: mcpServer ? `${mcpServer.name} (${mcpServer.source})` : null,
        puoiSempre: Array.isArray(suggestions) && suggestions.length > 0,
        domanda: nome === 'AskUserQuestion',
      };
      const risolvi = (r) => {
        if (!c.permessi.has(id)) return;
        c.permessi.delete(id);
        this.#emetti(c, { tipo: 'permesso_risolto', id, decisione: r.behavior === 'allow' ? 'consentito' : 'negato' });
        if (c.stato === 'permesso') this.#stato(c, 'lavora');
        resolve(r);
      };
      c.permessi.set(id, { evento, risolvi, input, suggestions });
      signal?.addEventListener('abort', () => risolvi({ behavior: 'deny', message: 'Richiesta annullata.' }));
      this.#emetti(c, evento);
      this.#stato(c, 'permesso');
    });
  }

  rispondi(c, idPermesso, { decisione, motivo, risposte }) {
    const p = c.permessi.get(idPermesso);
    if (!p) throw new Error('richiesta di permesso non più attiva');
    if (decisione === 'nega') {
      p.risolvi({ behavior: 'deny', message: motivo ? `L'utente ha negato dal cruscotto: ${String(motivo).slice(0, 1000)}` : 'L\'utente ha negato dal cruscotto.' });
    } else if (decisione === 'consenti' || decisione === 'consenti_sempre') {
      const r = { behavior: 'allow', updatedInput: p.input };
      if (p.evento.domanda && risposte && typeof risposte === 'object') {
        r.updatedInput = { ...p.input, answers: Object.fromEntries(Object.entries(risposte).map(([k, v]) => [String(k), String(v).slice(0, 2000)])) };
      }
      if (decisione === 'consenti_sempre' && p.suggestions?.length) r.updatedPermissions = p.suggestions;
      p.risolvi(r);
    } else {
      throw new Error('decisione non valida');
    }
  }
}
