// Assistente basato su Claude (API Anthropic), chiamato direttamente dal browser
// con la chiave API personale dell'utente, salvata solo su questo dispositivo.

import { formatWhen } from './agent.js';

// SDK ufficiale Anthropic da CDN (con un secondo CDN di riserva)
const SDK_URLS = [
  'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm',
  'https://esm.sh/@anthropic-ai/sdk@0.131.0',
];
const MODEL = 'claude-opus-5-5';
const KEY_STORAGE = 'agenda-vocale:anthropic-key';
// Oltre questo numero di messaggi si riparte da una conversazione nuova,
// invece di tagliare la cronologia (che deve restare solo in aggiunta).
const MAX_HISTORY = 60;

const SYSTEM = `Sei l'assistente personale dell'app "Agenda Vocale". Parli sempre in italiano.
L'utente detta o scrive note e promemoria; tu lo aiuti a ricordare i suoi impegni.

Ad ogni messaggio ricevi la data e l'ora attuali e l'elenco aggiornato delle note (con id).
- Rispondi alle domande sugli impegni basandoti solo su quell'elenco: non inventare impegni.
- Le risposte vengono anche lette ad alta voce: sii breve e naturale, frasi semplici,
  niente markdown, niente tabelle, niente emoji in eccesso. Per elenchi usa righe che iniziano con "• ".
- Esprimi le date in modo colloquiale ("domani alle 10", "venerdì 23 ottobre").
- Se l'utente chiede di ricordare, aggiungere, spostare, completare o cancellare qualcosa,
  usa gli strumenti a disposizione, poi conferma in una frase cosa hai fatto.
- Per cancellare più note, o se non è chiaro a quale nota si riferisce, chiedi conferma prima.
- Puoi dare consigli pratici (organizzare la giornata, priorità, cosa preparare), restando concreto.`;

const DATE_DESC = 'Data e ora locali nel formato "YYYY-MM-DDTHH:MM", oppure solo "YYYY-MM-DD" ' +
  'se non c\'è un orario. null se senza data.';

const TOOLS = [
  {
    name: 'crea_promemoria',
    description: 'Crea una nuova nota/promemoria nell\'agenda dell\'utente.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        titolo: { type: 'string', description: 'Testo breve del promemoria, es. "Chiamare il dentista".' },
        data_ora: { type: ['string', 'null'], description: DATE_DESC },
      },
      required: ['titolo', 'data_ora'],
      additionalProperties: false,
    },
  },
  {
    name: 'modifica_promemoria',
    description: 'Modifica una nota esistente: titolo, data, oppure la segna come fatta/non fatta. ' +
      'Passa null nei campi da lasciare invariati.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id della nota, dall\'elenco ricevuto.' },
        titolo: { type: ['string', 'null'] },
        data_ora: { type: ['string', 'null'], description: `${DATE_DESC} Lascia null per non cambiarla.` },
        rimuovi_data: { type: 'boolean', description: 'true per togliere la data alla nota.' },
        completata: { type: ['boolean', 'null'], description: 'true se fatta, false se da fare, null per non cambiare.' },
      },
      required: ['id', 'titolo', 'data_ora', 'rimuovi_data', 'completata'],
      additionalProperties: false,
    },
  },
  {
    name: 'elimina_promemoria',
    description: 'Elimina definitivamente una nota.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

let sdkPromise;
let client;
let clientKey;
let history = [];

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}

export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* archiviazione non disponibile */ }
  client = null;
  history = [];
}

export const isEnabled = () => Boolean(getApiKey());
export const resetConversation = () => { history = []; };

async function getClient() {
  const key = getApiKey();
  if (client && clientKey === key) return client;
  sdkPromise ??= import(SDK_URLS[0]).catch(() => import(SDK_URLS[1]));
  sdkPromise.catch(() => { sdkPromise = null; });
  const { default: Anthropic } = await sdkPromise;
  client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  clientKey = key;
  return client;
}

// "2026-10-20T10:00" → data locale con orario; "2026-10-20" → giorno intero.
function parseLocalDate(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
  if (!m) return null;
  const date = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  return Number.isNaN(date.getTime()) ? null : { due: date.toISOString(), hasTime: Boolean(m[4]) };
}

function toLocalString(note) {
  const d = new Date(note.due);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return note.hasTime ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

function agendaSnapshot(notes) {
  const now = new Date();
  const lines = notes.map((n) => JSON.stringify({
    id: n.id,
    titolo: n.title,
    testo_dettato: n.text !== n.title ? n.text : undefined,
    quando: n.due ? `${toLocalString(n)} (${formatWhen(n)})` : null,
    completata: n.done,
  }));
  return `[Contesto automatico — ora attuale: ${now.toLocaleString('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })}]\n[Note in agenda (${notes.length}):]\n${lines.join('\n') || '(nessuna nota)'}`;
}

async function runTool(block, actions) {
  const input = block.input ?? {};
  switch (block.name) {
    case 'crea_promemoria': {
      const when = parseLocalDate(input.data_ora);
      const note = await actions.create({
        text: input.titolo, title: input.titolo, due: when?.due ?? null, hasTime: when?.hasTime ?? false,
      });
      return `Creata nota id=${note.id}${note.due ? ` per ${formatWhen(note)}` : ' senza data'}.`;
    }
    case 'modifica_promemoria': {
      const changes = {};
      if (input.titolo) changes.title = input.titolo;
      if (input.rimuovi_data) Object.assign(changes, { due: null, hasTime: false, notified: false });
      else if (input.data_ora) {
        const when = parseLocalDate(input.data_ora);
        if (!when) throw new Error(`Data non valida: ${input.data_ora}`);
        Object.assign(changes, when, { notified: false });
      }
      if (typeof input.completata === 'boolean') changes.done = input.completata;
      const note = await actions.update(input.id, changes);
      if (!note) throw new Error(`Nessuna nota con id ${input.id}`);
      return `Nota aggiornata: "${note.title}", ${note.due ? formatWhen(note) : 'senza data'}, ${note.done ? 'completata' : 'da fare'}.`;
    }
    case 'elimina_promemoria': {
      const ok = await actions.remove(input.id);
      if (!ok) throw new Error(`Nessuna nota con id ${input.id}`);
      return 'Nota eliminata.';
    }
    default:
      throw new Error(`Strumento sconosciuto: ${block.name}`);
  }
}

/**
 * Invia una domanda a Claude. `getNotes()` restituisce le note aggiornate,
 * `actions` = { create(note), update(id, changes), remove(id) }.
 * Restituisce il testo della risposta.
 */
export async function askClaude(question, getNotes, actions) {
  const anthropic = await getClient();
  if (history.length > MAX_HISTORY) history = [];

  history.push({
    role: 'user',
    content: [
      { type: 'text', text: agendaSnapshot(getNotes()) },
      { type: 'text', text: question },
    ],
  });

  for (let step = 0; step < 8; step++) {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      tools: TOOLS,
      messages: history,
    });

    // La risposta completa (blocchi di ragionamento compresi) va rimandata invariata.
    history.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      return 'Mi dispiace, non posso aiutarti con questa richiesta.';
    }
    if (response.stop_reason === 'pause_turn') continue;

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !toolUses.length) {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return text || 'Fatto.';
    }

    const results = [];
    for (const block of toolUses) {
      try {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: await runTool(block, actions) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: String(err.message || err), is_error: true });
      }
    }
    history.push({ role: 'user', content: results });
  }
  return 'Ho eseguito diverse operazioni, controlla la lista delle note.';
}

export const BRIEFING_PROMPT = 'Fammi il riepilogo della mia giornata, come un assistente personale che mi parla ' +
  'al mattino: un saluto, gli impegni di oggi in ordine di orario, eventuali promemoria scaduti da recuperare, ' +
  'un\'anticipazione di domani e uno o due consigli pratici sulle priorità. Al massimo 8 frasi brevi, ' +
  'senza modificare nessuna nota.';

/** Verifica la chiave senza costi (legge solo le informazioni sul modello). */
export async function testKey() {
  const anthropic = await getClient();
  await anthropic.models.retrieve(MODEL);
}

/** Messaggio leggibile per gli errori più comuni. */
export async function describeError(err) {
  const { default: Anthropic } = await (sdkPromise ?? Promise.reject(err)).catch(() => ({ default: null }));
  // Dopo un errore la conversazione potrebbe essere rimasta a metà: si riparte.
  history = [];
  if (Anthropic) {
    if (err instanceof Anthropic.AuthenticationError) return 'La chiave API non è valida. Controllala nelle impostazioni ⚙️.';
    if (err instanceof Anthropic.PermissionDeniedError) return 'La chiave API non ha i permessi necessari.';
    if (err instanceof Anthropic.RateLimitError) return 'Troppe richieste o credito esaurito: riprova tra poco.';
    if (err instanceof Anthropic.APIConnectionError) return 'Non riesco a raggiungere Claude: controlla la connessione.';
    if (err instanceof Anthropic.APIError) return `Errore di Claude (${err.status ?? '?'}): ${err.message}`;
  }
  return 'Non riesco a contattare Claude in questo momento.';
}
