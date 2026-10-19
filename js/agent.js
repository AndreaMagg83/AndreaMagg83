// Assistente locale: capisce richieste in italiano sulle note e risponde.
// Funziona senza rete; in futuro si potrà collegare a un modello linguistico
// mantenendo la stessa interfaccia ask(text, notes) → { reply, action? }.

import { normalize, parseRange, parseWhen } from './dateparser.js';
import * as meteo from './weather.js';

const STOP_WORDS = new Set(('il lo la i gli le un uno una di a da in con su per tra fra e o ' +
  'che cosa quando dove come ho devo dovevo avevo mi ti si del della dei delle al alla ai alle ' +
  'nel nella mio mia miei mie c ce e\' cerca trova trovami note nota appunti appunto ricordo ' +
  'qualcosa riguardo parlava parla sul sulla quale quali').split(' '));

export function formatWhen(note) {
  if (!note.due) return 'senza data';
  const d = new Date(note.due);
  const today = new Date();
  const diffDays = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) -
    new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5);
  const dayLabel = diffDays === 0 ? 'oggi'
    : diffDays === 1 ? 'domani'
    : diffDays === -1 ? 'ieri'
    : d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  if (!note.hasTime) return dayLabel;
  return `${dayLabel} alle ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
}

function listNotes(notes, intro) {
  const lines = notes.map((n) => `• ${n.title} — ${formatWhen(n)}`);
  return `${intro}\n${lines.join('\n')}`;
}

// Versione da leggere ad alta voce, senza simboli.
export function toSpeech(text) {
  return text.replace(/•/g, '').replace(/—/g, ',').replace(/\n+/g, '. ');
}

export function ask(text, notes, now = new Date(), forecast = null) {
  const t = normalize(text).trim();
  const pending = notes
    .filter((n) => !n.done)
    .sort((a, b) => (a.due ? new Date(a.due) : Infinity) - (b.due ? new Date(b.due) : Infinity));

  if (!t) return { reply: 'Non ho sentito nulla, puoi ripetere?' };

  // Saluti e aiuto
  if (/^(ciao|buongiorno|buonasera|salve|hey)\b/.test(t) && t.split(' ').length <= 3) {
    const todayCount = pending.filter((n) => n.due && sameDay(new Date(n.due), now)).length;
    return {
      reply: `Ciao! Oggi hai ${todayCount ? `${todayCount} promemoria` : 'la giornata libera'}. ` +
        'Chiedimi ad esempio "cosa devo fare domani?" oppure dimmi "ricordami di…".',
    };
  }
  if (/\b(aiuto|cosa sai fare|come funzion)/.test(t)) {
    return {
      reply: 'Posso:\n• dirti cosa hai in programma ("cosa ho oggi?", "questa settimana", "lunedì")\n' +
        '• elencare i prossimi impegni ("prossimi impegni")\n' +
        '• cercare tra le note ("cerca dentista")\n' +
        '• aggiungere un promemoria ("ricordami di chiamare Luca domani alle 18")\n' +
        '• dirti cosa hai in arretrato ("cosa ho scaduto?")',
    };
  }

  // Creazione di una nuova nota
  if (/^(ricordami|ricorda|aggiungi|annota|segna|appunta|crea)\b/.test(t)) {
    const body = text.replace(/^\s*(aggiungi|crea)\s+(una\s+)?(nota|promemoria)?\s*(di|che|:)?\s*/i, '');
    const { date, hasTime, rest } = parseWhen(body, now);
    const title = rest || body;
    const when = date ? formatWhen({ due: date.toISOString(), hasTime }) : null;
    return {
      reply: when ? `Fatto! Ti ricorderò "${title}" ${when}.` : `Ho annotato "${title}" (senza data).`,
      action: { type: 'create', note: { text: body, title, due: date ? date.toISOString() : null, hasTime } },
    };
  }

  // Meteo
  if (/\b(meteo|che tempo|tempo fa|piov\w*|pioggia|ombrello|temperatur\w*|gradi|caldo|freddo|nev[ei]\w*|sole|soleggiato)\b/.test(t)) {
    return { reply: weatherReply(text, forecast, now) };
  }

  // Note scadute / arretrate
  if (/\b(scadut|arretrat|dimenticat|saltat|non ho fatto)/.test(t)) {
    const overdue = pending.filter((n) => n.due && new Date(n.due) < (n.hasTime ? now : startOfToday(now)));
    if (!overdue.length) return { reply: 'Nessun promemoria scaduto, sei in pari! 👏' };
    return { reply: listNotes(overdue, `Hai ${overdue.length} promemoria scadut${overdue.length === 1 ? 'o' : 'i'}:`) };
  }

  // Note senza data
  if (/\bsenza\s+data\b/.test(t)) {
    const undated = pending.filter((n) => !n.due);
    if (!undated.length) return { reply: 'Non hai note senza data.' };
    return { reply: listNotes(undated, 'Ecco le note senza data:') };
  }

  // Ricerca per parole chiave
  const search = /^(cerca|trova|trovami)\b/.test(t) || /\b(quando\s+(ho|devo|c'e)|dove\s+ho)\b/.test(t);
  if (search) {
    const words = t.replace(/[?!.,']/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    if (words.length) {
      const found = notes.filter((n) => {
        const hay = normalize(`${n.title} ${n.text}`);
        return words.some((w) => hay.includes(w.slice(0, Math.max(4, w.length - 2))));
      });
      if (!found.length) return { reply: `Non ho trovato note su "${words.join(' ')}".` };
      return { reply: listNotes(found, `Ho trovato ${found.length} not${found.length === 1 ? 'a' : 'e'}:`) };
    }
  }

  // Periodo specifico: oggi, domani, settimana, giorno preciso…
  const range = parseRange(text, now);
  if (range) {
    const inRange = pending.filter((n) => n.due && new Date(n.due) >= range.from && new Date(n.due) < range.to);
    if (!inRange.length) return { reply: `Non hai nulla in programma ${range.label}. 🎉` };
    return {
      reply: listNotes(inRange, `${capitalize(range.label)} hai ${inRange.length} promemoria:`),
    };
  }

  // Prossimi impegni (risposta predefinita per domande generiche)
  if (/\b(prossim|futur|programma|impegni|agenda|cosa\s+(devo|ho)|ricordami\s+cosa|riepilogo)/.test(t)) {
    const upcoming = pending.filter((n) => n.due && new Date(n.due) >= startOfToday(now)).slice(0, 5);
    if (!upcoming.length) return { reply: 'Non hai impegni futuri in agenda.' };
    return { reply: listNotes(upcoming, 'Ecco i tuoi prossimi impegni:') };
  }

  return {
    reply: 'Non ho capito bene. Prova con "cosa ho domani?", "prossimi impegni", ' +
      '"cerca dentista" o "ricordami di…".',
  };
}

function weatherReply(text, forecast, now) {
  if (!forecast) return 'Non ho ancora le previsioni: imposta la tua città nella scheda meteo in alto nelle Note.';
  const range = parseRange(text, now);
  const day = range ? new Date(range.from) : now;
  const forecastDay = meteo.forDay(forecast, day);
  if (!forecastDay) return 'Ho le previsioni solo per i prossimi 7 giorni.';
  const isToday = meteo.dayKey(day) === meteo.dayKey(now);
  const label = isToday ? 'Oggi' : capitalize(range.label);
  let reply = `${label} a ${forecast.location.name}: ${meteo.dayText(forecastDay)}.`;
  if (isToday) reply += ` Adesso ${meteo.currentText(forecast)}.`;
  let advice = meteo.adviceFor(forecastDay);
  if (!advice && /\b(piov\w*|pioggia|ombrello)\b/.test(normalize(text))) advice = 'Non dovrebbe piovere, niente ombrello.';
  return advice ? `${reply} ${advice}` : reply;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function startOfToday(now) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Riepilogo della giornata senza Claude: saluto, impegni di oggi, arretrati e anteprima di domani.
export function dailyBriefing(notes, now = new Date(), forecast = null) {
  const today = startOfToday(now);
  const tomorrow = new Date(today.getTime() + 864e5);
  const dayAfter = new Date(today.getTime() + 2 * 864e5);
  const pending = notes
    .filter((n) => !n.done)
    .sort((a, b) => (a.due ? new Date(a.due) : Infinity) - (b.due ? new Date(b.due) : Infinity));
  const due = (n) => new Date(n.due);
  const todays = pending.filter((n) => n.due && due(n) >= today && due(n) < tomorrow);
  const overdue = pending.filter((n) => n.due && due(n) < today);
  const tomorrows = pending.filter((n) => n.due && due(n) >= tomorrow && due(n) < dayAfter);
  const undated = pending.filter((n) => !n.due);

  const h = now.getHours();
  const greeting = h < 12 ? 'Buongiorno!' : h < 18 ? 'Buon pomeriggio!' : 'Buonasera!';
  const dateLabel = now.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  const parts = [`${greeting} Oggi è ${dateLabel}.`];
  const todayWeather = meteo.forDay(forecast, now);
  if (todayWeather) {
    parts.push(`Meteo a ${forecast.location.name}: ${meteo.dayText(todayWeather)}. ${meteo.adviceFor(todayWeather)}`.trim());
  }

  if (todays.length) {
    parts.push(listNotes(todays, `Oggi hai ${todays.length} promemoria:`));
  } else {
    parts.push('Oggi non hai impegni in agenda.');
  }
  if (overdue.length) {
    parts.push(`Hai anche ${overdue.length} promemoria scadut${overdue.length === 1 ? 'o' : 'i'} da recuperare, ` +
      `a partire da "${overdue[0].title}".`);
  }
  if (tomorrows.length) {
    parts.push(`Domani ${tomorrows.length === 1 ? 'hai' : 'inizi con'} "${tomorrows[0].title}" ${formatWhen(tomorrows[0]).replace(/^domani\s*/, '')}`.trim() + '.');
  }
  if (undated.length) {
    parts.push(`${undated.length === 1 ? "C'è 1 nota" : `Ci sono ${undated.length} note`} senza data, se trovi un momento libero.`);
  }
  return parts.join('\n');
}
