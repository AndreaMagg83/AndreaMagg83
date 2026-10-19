// Riconoscimento di date e orari scritti in italiano naturale
// ("domani alle 10", "lunedì prossimo", "il 25 ottobre alle 15:30", "tra 2 ore"...).

const WEEKDAYS = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio',
  'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const NUM_WORDS = {
  un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8,
  nove: 9, dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15,
  venti: 20, trenta: 30, quaranta: 40, cinquanta: 50, primo: 1,
};
const NUM = `(\\d{1,2}|${Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|')})`;
const WD = `(${WEEKDAYS.join('|')})`;
const MO = `(${MONTHS.join('|')})`;
const DAY_PART = '(?:\\s+(?:di|del|della|nel|nella)\\s+(mattina|mattino|pomeriggio|sera|notte))';
const PART_HOURS = { mattina: 9, mattino: 9, pomeriggio: 15, sera: 20, notte: 22 };

// Minuscolo e senza accenti; la lunghezza resta invariata così gli indici
// trovati sul testo normalizzato valgono anche su quello originale.
export function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const toNum = (s) => (/^\d+$/.test(s) ? parseInt(s, 10) : NUM_WORDS[s]);
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function adjustHour(h, part) {
  if (part === 'pomeriggio' || part === 'sera') return h < 12 ? h + 12 : h;
  if (part === 'notte') return h >= 8 && h < 12 ? h + 12 : h;
  if (part) return h;
  // Senza indicazioni, "alle 3" significa quasi sempre le 15.
  return h >= 1 && h <= 7 ? h + 12 : h;
}

/**
 * Cerca un'indicazione temporale nel testo.
 * Restituisce { date, hasTime, rest } dove `rest` è il testo ripulito
 * dalle espressioni temporali, oppure { date: null } se non trova nulla.
 */
export function parseWhen(text, now = new Date()) {
  const t = normalize(text);
  const spans = [];
  let day = null;
  let time = null;
  let partOfDay = null;

  const find = (re) => {
    const m = re.exec(t);
    if (m) spans.push([m.index, m.index + m[0].length]);
    return m;
  };

  // Durata relativa: "tra 10 minuti", "fra due ore", "tra 3 giorni"
  let m = find(new RegExp(`\\b(?:tra|fra)\\s+(?:un'|un\\s+)?${NUM}?\\s*(minut[oi]|or[ae]|giorn[oi]|settiman[ae]|mes[ei])\\b`));
  if (m) {
    const n = m[1] ? toNum(m[1]) : 1;
    const unit = m[2];
    if (unit.startsWith('minut') || unit.startsWith('or')) {
      const ms = n * (unit.startsWith('minut') ? 60e3 : 3600e3);
      return { date: new Date(now.getTime() + ms), hasTime: true, rest: cleanup(text, spans) };
    }
    if (unit.startsWith('giorn')) day = addDays(now, n);
    else if (unit.startsWith('settiman')) day = addDays(now, 7 * n);
    else day = new Date(now.getFullYear(), now.getMonth() + n, now.getDate());
  }

  // Parole chiave relative
  if (!day && (m = find(/\b(dopodomani|domattina|domani|oggi|stamattina|stamani|stasera|stanotte|stanot)\b/))) {
    const w = m[1];
    if (w === 'dopodomani') day = addDays(now, 2);
    else if (w === 'domani' || w === 'domattina') day = addDays(now, 1);
    else day = startOfDay(now);
    if (w === 'domattina' || w === 'stamattina' || w === 'stamani') partOfDay = 'mattina';
    if (w === 'stasera') partOfDay = 'sera';
    if (w.startsWith('stanot')) partOfDay = 'notte';
  }

  // Data numerica: 25/10, 25-10-2026, 25.10.26
  if (!day && (m = find(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/))) {
    const d = +m[1], mo = +m[2] - 1;
    let y = m[3] ? +m[3] : now.getFullYear();
    if (y < 100) y += 2000;
    day = new Date(y, mo, d);
    if (!m[3] && day < startOfDay(now)) day = new Date(y + 1, mo, d);
  }

  // Data testuale: "il 25 ottobre", "primo novembre 2026"
  if (!day && (m = find(new RegExp(`\\b(?:il\\s+|l'|per\\s+il\\s+)?${NUM}\\s+${MO}(?:\\s+(\\d{4}))?\\b`)))) {
    const d = toNum(m[1]), mo = MONTHS.indexOf(m[2]);
    const y = m[3] ? +m[3] : now.getFullYear();
    day = new Date(y, mo, d);
    if (!m[3] && day < startOfDay(now)) day = new Date(y + 1, mo, d);
  }

  // Giorno della settimana: "lunedì", "lunedì prossimo", "il prossimo venerdì"
  if (!day && (m = find(new RegExp(`\\b(?:(?:il|la)\\s+)?(?:prossim[oa]\\s+)?${WD}(?:\\s+prossim[oa])?\\b`)))) {
    const target = WEEKDAYS.indexOf(m[1]);
    let diff = (target - now.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    day = addDays(now, diff);
  }

  // "la settimana prossima" → lunedì successivo
  if (!day && find(/\b(?:la\s+)?(?:settimana\s+prossima|prossima\s+settimana)\b/)) {
    const diff = ((1 - now.getDay() + 7) % 7) || 7;
    day = addDays(now, diff);
  }

  // Orario: "alle 10", "alle 10:30", "alle 9 e mezza di sera", "all'una", "ore 15"
  m = find(new RegExp(`\\b(?:alle\\s+(?:ore\\s+)?|all'|verso\\s+le\\s+|ore\\s+)${NUM}(?:[:.](\\d{2})|\\s+e\\s+(mezza|mezzo|un\\s+quarto|tre\\s+quarti|\\d{1,2}))?${DAY_PART}?`));
  if (m) {
    let h = toNum(m[1]);
    let min = 0;
    if (m[2]) min = +m[2];
    else if (m[3]) {
      const x = m[3];
      min = x.startsWith('mezz') ? 30 : x.includes('tre') ? 45 : x.includes('quarto') ? 15 : +x;
    }
    h = adjustHour(h, m[4] || partOfDay);
    if (h <= 23 && min <= 59) time = { h, m: min };
  } else if ((m = find(/\b(?:a\s+)?(mezzogiorno|mezzanotte)\b/))) {
    time = { h: m[1] === 'mezzogiorno' ? 12 : 23, m: m[1] === 'mezzogiorno' ? 0 : 59 };
  } else if ((m = find(/\b(?:di|in|nel|nella|la|il)\s+(mattina|mattinata|pomeriggio|serata|sera)\b/))) {
    partOfDay = m[1].startsWith('mattin') ? 'mattina' : m[1].startsWith('ser') ? 'sera' : 'pomeriggio';
  }

  if (!time && partOfDay) time = { h: PART_HOURS[partOfDay], m: 0 };
  if (!day && !time) return { date: null, hasTime: false, rest: cleanup(text, []) };

  if (!day) {
    // Solo orario: oggi, oppure domani se l'ora è già passata
    day = startOfDay(now);
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.h, time.m);
    if (candidate <= now) day = addDays(day, 1);
  }

  const date = time
    ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.h, time.m)
    : startOfDay(day);
  return { date, hasTime: Boolean(time), rest: cleanup(text, spans) };
}

// Toglie dal testo le espressioni temporali e le formule tipo "ricordami di".
function cleanup(text, spans) {
  let out = text;
  [...spans].sort((a, b) => b[0] - a[0]).forEach(([s, e]) => {
    out = out.slice(0, s) + ' ' + out.slice(e);
  });
  out = out
    .replace(/^\s*(ricordami|ricorda(?:ti)?|promemoria|annota|segna|appunta)\s*(?:di|che|:)?\s*/i, '')
    .replace(/\s+(il|la|per|di|a|alle|entro)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Interpreta un periodo richiesto all'assistente ("oggi", "questa settimana",
 * "lunedì", "prossimi giorni"...). Restituisce { from, to, label } o null.
 */
export function parseRange(text, now = new Date()) {
  const t = normalize(text);
  const today = startOfDay(now);
  if (/\b(questa|sta)\s+settimana\b/.test(t)) {
    const toSunday = (7 - now.getDay()) % 7;
    return { from: now, to: addDays(today, toSunday + 1), label: 'questa settimana' };
  }
  if (/\b(settimana\s+prossima|prossima\s+settimana)\b/.test(t)) {
    const monday = addDays(today, ((1 - now.getDay() + 7) % 7) || 7);
    return { from: monday, to: addDays(monday, 7), label: 'la prossima settimana' };
  }
  if (/\bquesto\s+mese\b/.test(t)) {
    return { from: now, to: new Date(now.getFullYear(), now.getMonth() + 1, 1), label: 'questo mese' };
  }
  if (/\b(prossimo\s+mese|mese\s+prossimo)\b/.test(t)) {
    return {
      from: new Date(now.getFullYear(), now.getMonth() + 1, 1),
      to: new Date(now.getFullYear(), now.getMonth() + 2, 1),
      label: 'il prossimo mese',
    };
  }
  if (/\bweekend|fine\s+settimana\b/.test(t)) {
    const sat = addDays(today, (6 - now.getDay() + 7) % 7);
    return { from: sat, to: addDays(sat, 2), label: 'nel weekend' };
  }
  const m = /\bprossimi\s+(\d+|due|tre|quattro|cinque|sei|sette|dieci|quindici)?\s*giorni\b/.exec(t);
  if (m) {
    const n = m[1] ? toNum(m[1]) : 7;
    return { from: now, to: addDays(today, n + 1), label: `nei prossimi ${n} giorni` };
  }
  const { date } = parseWhen(text, now);
  if (date) {
    const d = startOfDay(date);
    const label = d.getTime() === today.getTime() ? 'oggi'
      : d.getTime() === addDays(today, 1).getTime() ? 'domani'
      : d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    return { from: d, to: addDays(d, 1), label };
  }
  return null;
}
