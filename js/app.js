import * as db from './db.js';
import { parseWhen } from './dateparser.js';
import { ask, dailyBriefing, formatWhen, toSpeech } from './agent.js';
import { canRecord, canTranscribe, listen, speak } from './voice.js';
import * as claude from './claude.js';

const $ = (sel) => document.querySelector(sel);
const state = { notes: [], filter: 'upcoming', draftAudio: null, session: null };

// ---------- Utilità ----------
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const settings = {
  get(key) { try { return localStorage.getItem(`agenda-vocale:${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`agenda-vocale:${key}`, value); } catch { /* non disponibile */ } },
};

function toLocalInput(date) {
  if (!date) return '';
  const d = new Date(date);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 16);
}

function toast(msg, ms = 4000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

// ---------- Note ----------
async function loadNotes() {
  state.notes = await db.getAllNotes();
  renderNotes();
}

async function createNote({ text, title, due, hasTime, audio = null }) {
  const note = {
    id: uid(),
    text: text.trim(),
    title: (title || text).trim(),
    due,
    hasTime: Boolean(hasTime),
    done: false,
    notified: false,
    hasAudio: Boolean(audio),
    createdAt: new Date().toISOString(),
  };
  if (audio) await db.saveAudio(note.id, audio);
  await db.saveNote(note);
  state.notes.push(note);
  renderNotes();
  return note;
}

async function updateNote(note, changes) {
  Object.assign(note, changes);
  await db.saveNote(note);
  renderNotes();
}

async function removeNote(note) {
  await db.deleteNote(note.id);
  if (note.hasAudio) await db.deleteAudio(note.id);
  state.notes = state.notes.filter((n) => n.id !== note.id);
  renderNotes();
}

function filteredNotes() {
  const today = startOfToday();
  const tomorrow = new Date(today.getTime() + 864e5);
  const byDue = (a, b) => (a.due ? new Date(a.due) : Infinity) - (b.due ? new Date(b.due) : Infinity);
  const list = state.notes.slice();
  switch (state.filter) {
    case 'today': return list.filter((n) => !n.done && n.due && new Date(n.due) >= today && new Date(n.due) < tomorrow).sort(byDue);
    case 'undated': return list.filter((n) => !n.done && !n.due).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case 'done': return list.filter((n) => n.done).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case 'all': return list.sort(byDue);
    default: return list.filter((n) => !n.done && n.due).sort(byDue);
  }
}

function groupLabel(note) {
  if (!note.due) return 'Senza data';
  const d = new Date(note.due);
  const today = startOfToday();
  const days = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 864e5);
  if (days < 0) return 'Scadute';
  if (days === 0) return 'Oggi';
  if (days === 1) return 'Domani';
  if (days < 7) return 'Questa settimana';
  return d.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase());
}

function renderNotes() {
  const list = $('#note-list');
  const notes = filteredNotes();
  if (!notes.length) {
    const empty = {
      upcoming: 'Nessun impegno in programma. Detta una nota per iniziare!',
      today: 'Niente per oggi. 🎉',
      undated: 'Nessuna nota senza data.',
      done: 'Nessuna nota completata.',
      all: 'Non hai ancora nessuna nota.',
    }[state.filter];
    list.innerHTML = `<p class="empty muted">${empty}</p>`;
    return;
  }

  let html = '';
  let lastGroup = null;
  const now = new Date();
  for (const n of notes) {
    const group = state.filter === 'done' ? null : groupLabel(n);
    if (group && group !== lastGroup) {
      html += `<h2 class="group ${group === 'Scadute' ? 'overdue' : ''}">${group}</h2>`;
      lastGroup = group;
    }
    const overdue = !n.done && n.due && new Date(n.due) < (n.hasTime ? now : startOfToday());
    html += `
      <article class="note ${n.done ? 'done' : ''} ${overdue ? 'overdue' : ''}" data-id="${n.id}">
        <input type="checkbox" class="note-done" ${n.done ? 'checked' : ''} aria-label="Segna come fatta">
        <div class="note-body">
          <p class="note-title">${escapeHtml(n.title)}</p>
          <p class="note-when muted small">${n.due ? '🕒 ' + formatWhen(n) : 'Senza data'}</p>
          ${n.text && n.text !== n.title ? `<p class="note-text muted small">“${escapeHtml(n.text)}”</p>` : ''}
        </div>
        <div class="note-actions">
          ${n.hasAudio ? '<button class="icon-btn small play" aria-label="Ascolta">▶️</button>' : ''}
          <button class="icon-btn small edit-date" aria-label="Cambia data">📅</button>
          <button class="icon-btn small delete" aria-label="Elimina">🗑️</button>
        </div>
      </article>`;
  }
  list.innerHTML = html;
}

$('#note-list').addEventListener('click', async (e) => {
  const el = e.target.closest('.note');
  if (!el) return;
  const note = state.notes.find((n) => n.id === el.dataset.id);
  if (!note) return;

  if (e.target.classList.contains('note-done')) {
    await updateNote(note, { done: e.target.checked });
  } else if (e.target.closest('.play')) {
    const blob = await db.getAudio(note.id);
    if (blob) new Audio(URL.createObjectURL(blob)).play();
  } else if (e.target.closest('.delete')) {
    if (confirm(`Eliminare "${note.title}"?`)) await removeNote(note);
  } else if (e.target.closest('.edit-date')) {
    const value = prompt('Nuova data (es. "domani alle 15", "25/10 alle 9") — lascia vuoto per togliere la data:',
      note.due ? formatWhen(note) : '');
    if (value === null) return;
    if (!value.trim()) return updateNote(note, { due: null, hasTime: false, notified: false });
    const { date, hasTime } = parseWhen(value);
    if (!date) return toast('Non ho capito la data, riprova.');
    await updateNote(note, { due: date.toISOString(), hasTime, notified: false });
  }
});

document.querySelectorAll('.filters .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    state.filter = chip.dataset.filter;
    renderNotes();
  });
});

// ---------- Composizione nota vocale ----------
function showDraft(text = '') {
  $('#draft').classList.remove('hidden');
  updateDraft(text);
}

function updateDraft(text) {
  $('#draft-text').value = text;
  const { date, hasTime } = parseWhen(text);
  $('#draft-date').value = date ? toLocalInput(date) : '';
  $('#draft-date').dataset.hasTime = hasTime ? '1' : '';
}

function resetDraft() {
  $('#draft').classList.add('hidden');
  $('#draft-text').value = '';
  $('#draft-date').value = '';
  $('#draft-audio').classList.add('hidden');
  state.draftAudio = null;
}

async function toggleRecording() {
  const btn = $('#rec-btn');
  if (state.session) {
    const audio = await state.session.stop();
    state.session = null;
    btn.classList.remove('recording');
    $('#rec-hint').innerHTML = 'Controlla la nota e salvala.';
    if (audio) {
      state.draftAudio = audio;
      $('#draft-audio').classList.remove('hidden');
    }
    if (!$('#draft-text').value && !audio) resetDraft();
    return;
  }

  if (!canTranscribe && !canRecord) {
    toast('Il tuo browser non supporta il microfono. Usa "Scrivi a mano".');
    return;
  }
  resetDraft();
  showDraft('');
  btn.classList.add('recording');
  $('#rec-hint').textContent = canTranscribe ? 'Ti ascolto… tocca di nuovo per fermare.' : 'Registro l\'audio… (trascrizione non supportata da questo browser)';
  try {
    state.session = await listen({
      keepAudio: $('#keep-audio').checked,
      onText: (text) => updateDraft(text),
    });
  } catch (err) {
    btn.classList.remove('recording');
    toast('Impossibile accedere al microfono.');
    console.error(err);
  }
}

$('#rec-btn').addEventListener('click', toggleRecording);
$('#type-btn').addEventListener('click', () => { resetDraft(); showDraft(''); $('#draft-text').focus(); });
$('#draft-text').addEventListener('input', (e) => {
  // Aggiorna la data riconosciuta mentre si scrive, se l'utente non l'ha toccata a mano
  if (!$('#draft-date').dataset.manual) {
    const { date, hasTime } = parseWhen(e.target.value);
    $('#draft-date').value = date ? toLocalInput(date) : '';
    $('#draft-date').dataset.hasTime = hasTime ? '1' : '';
  }
});
$('#draft-date').addEventListener('change', (e) => {
  e.target.dataset.manual = '1';
  e.target.dataset.hasTime = '1';
});
$('#draft-cancel').addEventListener('click', async () => {
  if (state.session) { await state.session.stop(); state.session = null; $('#rec-btn').classList.remove('recording'); }
  delete $('#draft-date').dataset.manual;
  resetDraft();
  $('#rec-hint').innerHTML = 'Tocca il microfono e detta la tua nota.';
});
$('#draft-save').addEventListener('click', async () => {
  if (state.session) await toggleRecording();
  const text = $('#draft-text').value.trim();
  if (!text && !state.draftAudio) return toast('La nota è vuota.');
  const dateValue = $('#draft-date').value;
  const { rest } = parseWhen(text);
  const note = await createNote({
    text: text || 'Nota vocale',
    title: rest || text || 'Nota vocale',
    due: dateValue ? new Date(dateValue).toISOString() : null,
    hasTime: Boolean(dateValue) && $('#draft-date').dataset.hasTime === '1',
    audio: state.draftAudio,
  });
  delete $('#draft-date').dataset.manual;
  resetDraft();
  $('#rec-hint').innerHTML = 'Tocca il microfono e detta la tua nota.';
  toast(note.due ? `Salvata: ti ricorderò ${formatWhen(note)}.` : 'Nota salvata.');
});

// ---------- Assistente ----------
function addMessage(text, who) {
  const chat = $('#chat');
  const msg = document.createElement('div');
  msg.className = `msg ${who}`;
  msg.textContent = text;
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;
  return msg;
}

// Operazioni sulle note che Claude può eseguire tramite i suoi strumenti
const claudeActions = {
  create: (note) => createNote(note),
  async update(id, changes) {
    const note = state.notes.find((n) => n.id === id);
    if (note) await updateNote(note, changes);
    return note;
  },
  async remove(id) {
    const note = state.notes.find((n) => n.id === id);
    if (note) await removeNote(note);
    return Boolean(note);
  },
};

async function handleQuestion(question) {
  if (!question.trim()) return;
  addMessage(question, 'user');
  let reply;

  if (claude.isEnabled()) {
    const typing = addMessage('Claude sta pensando…', 'bot typing');
    try {
      reply = await claude.askClaude(question, () => state.notes, claudeActions);
      typing.remove();
    } catch (err) {
      console.error(err);
      typing.remove();
      addMessage(`${await claude.describeError(err)} Rispondo con l'assistente base.`, 'bot error');
    }
  }

  if (!reply) {
    const local = ask(question, state.notes);
    if (local.action?.type === 'create') await createNote(local.action.note);
    reply = local.reply;
  }
  addMessage(reply, 'bot');
  if ($('#speak-replies').checked) speak(toSpeech(reply));
}

// ---------- Impostazioni Claude ----------
function updateAgentMode() {
  const on = claude.isEnabled();
  $('#agent-mode').textContent = on ? '✨ Claude attivo' : 'Assistente base';
  $('#agent-mode').classList.toggle('claude', on);
  $('#api-key').value = on ? claude.getApiKey() : '';
}

$('#settings-btn').addEventListener('click', () => {
  const open = $('#settings').classList.toggle('hidden') === false;
  $('#settings-btn').setAttribute('aria-expanded', String(open));
});

$('#key-save').addEventListener('click', async () => {
  const key = $('#api-key').value.trim();
  if (!key) return toast('Inserisci la chiave API.');
  const btn = $('#key-save');
  btn.disabled = true;
  btn.textContent = 'Verifico…';
  claude.setApiKey(key);
  try {
    await claude.testKey();
    toast('✨ Claude collegato!');
    $('#settings').classList.add('hidden');
    addMessage('Ora sono collegato a Claude: chiedimi pure quello che vuoi sulla tua agenda.', 'bot');
  } catch (err) {
    console.error(err);
    claude.setApiKey('');
    toast(await claude.describeError(err), 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salva e prova';
    updateAgentMode();
  }
});

$('#key-remove').addEventListener('click', () => {
  claude.setApiKey('');
  updateAgentMode();
  toast('Claude scollegato: uso l\'assistente base.');
});

$('#new-chat').addEventListener('click', () => {
  claude.resetConversation();
  $('#chat').innerHTML = '';
  addMessage('Nuova conversazione. Come posso aiutarti?', 'bot');
});

$('#ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#ask-input');
  handleQuestion(input.value);
  input.value = '';
});

document.querySelectorAll('[data-ask]').forEach((chip) =>
  chip.addEventListener('click', () => handleQuestion(chip.dataset.ask)));

let askSession = null;
$('#ask-mic').addEventListener('click', async () => {
  const btn = $('#ask-mic');
  if (askSession) { await askSession.stop(); return; }
  if (!canTranscribe) return toast('Il riconoscimento vocale non è supportato da questo browser.');
  let heard = '';
  btn.classList.add('recording');
  $('#ask-input').placeholder = 'Ti ascolto…';
  askSession = await listen({
    onText: (text) => { heard = text; $('#ask-input').value = text; },
    onEnd: () => {
      askSession = null;
      btn.classList.remove('recording');
      $('#ask-input').placeholder = "Chiedi all'assistente…";
      $('#ask-input').value = '';
      handleQuestion(heard);
    },
  });
  // Per le domande basta una frase: fermati alla prima pausa
  setTimeout(() => askSession?.stop(), 8000);
});

// ---------- Riepilogo della giornata ----------
let briefingBusy = false;

// Testo del riepilogo: da Claude se collegato, altrimenti dall'assistente base.
async function generateBriefing() {
  if (claude.isEnabled()) {
    try {
      return await claude.askClaude(claude.BRIEFING_PROMPT, () => state.notes, claudeActions);
    } catch (err) {
      console.error(err);
      return `${await claude.describeError(err)}\n\n${dailyBriefing(state.notes)}`;
    }
  }
  return dailyBriefing(state.notes);
}

async function showBriefing({ speakIt = false } = {}) {
  if (briefingBusy) return;
  briefingBusy = true;
  showView('view-notes');
  const card = $('#briefing');
  const text = $('#briefing-text');
  card.classList.remove('hidden');
  text.classList.add('loading');
  text.textContent = claude.isEnabled() ? 'Claude sta preparando il riepilogo…' : 'Preparo il riepilogo…';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  try {
    const reply = await generateBriefing();
    text.textContent = reply;
    addMessage(`☀️ ${reply}`, 'bot');
    if (speakIt) speak(toSpeech(reply));
  } finally {
    text.classList.remove('loading');
    briefingBusy = false;
  }
}

// Al primo avvio del giorno (dalle 5 in poi) il riepilogo compare da solo.
function maybeAutoBriefing() {
  const today = new Date().toDateString();
  if (settings.get('briefing-auto') === '0' || settings.get('briefing-last') === today) return;
  if (new Date().getHours() < 5) return;
  settings.set('briefing-last', today);
  showBriefing();
}

$('#briefing-btn').addEventListener('click', () => showBriefing({ speakIt: $('#speak-replies').checked }));
$('#briefing-refresh').addEventListener('click', () => showBriefing());
$('#briefing-listen').addEventListener('click', () => {
  const text = $('#briefing-text').textContent;
  if (text && !briefingBusy) speak(toSpeech(text));
});
$('#briefing-close').addEventListener('click', () => {
  $('#briefing').classList.add('hidden');
  if ('speechSynthesis' in window) speechSynthesis.cancel();
});
$('#briefing-auto').checked = settings.get('briefing-auto') !== '0';
$('#briefing-auto').addEventListener('change', (e) => settings.set('briefing-auto', e.target.checked ? '1' : '0'));
$('#briefing-chip').addEventListener('click', async () => {
  if (briefingBusy) return;
  briefingBusy = true;
  addMessage('Riepilogo della giornata', 'user');
  const typing = addMessage(claude.isEnabled() ? 'Claude sta pensando…' : 'Preparo il riepilogo…', 'bot typing');
  try {
    const reply = await generateBriefing();
    typing.remove();
    addMessage(reply, 'bot');
    if ($('#speak-replies').checked) speak(toSpeech(reply));
  } finally {
    briefingBusy = false;
  }
});

// ---------- Promemoria / notifiche ----------
function checkReminders() {
  const now = new Date();
  for (const n of state.notes) {
    if (n.done || n.notified || !n.due) continue;
    const due = new Date(n.due);
    // Le note senza orario vengono ricordate alle 9 del giorno stesso
    const fireAt = n.hasTime ? due : new Date(due.getFullYear(), due.getMonth(), due.getDate(), 9);
    if (fireAt <= now) {
      notify(n);
      updateNote(n, { notified: true });
    }
  }
}

async function notify(note) {
  const body = note.hasTime ? `Alle ${new Date(note.due).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : 'Oggi';
  toast(`⏰ ${note.title}`, 8000);
  if ($('#speak-replies').checked) speak(`Promemoria: ${note.title}`);
  if ('Notification' in window && Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(`⏰ ${note.title}`, { body, icon: 'icons/icon.svg', tag: note.id });
    else new Notification(`⏰ ${note.title}`, { body });
  }
}

$('#notify-btn').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('Le notifiche non sono supportate su questo browser.');
  const perm = await Notification.requestPermission();
  toast(perm === 'granted' ? 'Notifiche attivate! Tieni l\'app aperta per ricevere i promemoria.' : 'Notifiche non autorizzate.');
  updateNotifyButton();
});

function updateNotifyButton() {
  const on = 'Notification' in window && Notification.permission === 'granted';
  $('#notify-btn').classList.toggle('active', on);
  $('#notify-btn').title = on ? 'Notifiche attive' : 'Attiva notifiche';
}

// ---------- Navigazione ----------
function showView(id) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === id));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
}
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));

// ---------- Avvio ----------
function updateTodayLabel() {
  $('#today').textContent = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
}

async function init() {
  updateTodayLabel();
  if (!canTranscribe) $('#rec-hint').innerHTML += '<br><small>⚠️ Dettatura non supportata: usa Chrome, Edge o Safari.</small>';
  updateNotifyButton();
  updateAgentMode();
  await loadNotes();

  const pending = state.notes.filter((n) => !n.done);
  addMessage(`Ciao! Sono il tuo assistente. Hai ${pending.length} not${pending.length === 1 ? 'a' : 'e'} da ricordare. ` +
    'Chiedimi "cosa devo fare oggi?" oppure "prossimi impegni".', 'bot');

  checkReminders();
  setInterval(checkReminders, 30000);
  maybeAutoBriefing();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { updateTodayLabel(); checkReminders(); renderNotes(); maybeAutoBriefing(); }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.warn);
}

init();
