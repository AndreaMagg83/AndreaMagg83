// Meteo da Open-Meteo (gratuito, senza chiave): posizione, previsioni e testi in italiano.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
const LOCATION_KEY = 'agenda-vocale:meteo-luogo';
const CACHE_KEY = 'agenda-vocale:meteo-cache';
const CACHE_MINUTES = 30;
const timeout = () => (AbortSignal.timeout ? { signal: AbortSignal.timeout(10000) } : {});

// Codici meteo WMO → icona e descrizione
const WMO = {
  0: ['☀️', 'sereno', '🌙'],
  1: ['🌤️', 'poco nuvoloso', '🌙'],
  2: ['⛅', 'parzialmente nuvoloso', '☁️'],
  3: ['☁️', 'nuvoloso'],
  45: ['🌫️', 'nebbia'],
  48: ['🌫️', 'nebbia con brina'],
  51: ['🌦️', 'pioviggine leggera'],
  53: ['🌦️', 'pioviggine'],
  55: ['🌧️', 'pioviggine intensa'],
  56: ['🌧️', 'pioviggine gelata'],
  57: ['🌧️', 'pioviggine gelata intensa'],
  61: ['🌦️', 'pioggia leggera'],
  63: ['🌧️', 'pioggia'],
  65: ['🌧️', 'pioggia forte'],
  66: ['🌧️', 'pioggia gelata'],
  67: ['🌧️', 'pioggia gelata forte'],
  71: ['🌨️', 'neve leggera'],
  73: ['🌨️', 'neve'],
  75: ['❄️', 'neve forte'],
  77: ['🌨️', 'nevischio'],
  80: ['🌦️', 'rovesci leggeri'],
  81: ['🌧️', 'rovesci'],
  82: ['⛈️', 'rovesci violenti'],
  85: ['🌨️', 'rovesci di neve'],
  86: ['❄️', 'forti rovesci di neve'],
  95: ['⛈️', 'temporale'],
  96: ['⛈️', 'temporale con grandine'],
  99: ['⛈️', 'temporale con forte grandine'],
};

export function describe(code, isDay = true) {
  const [icon, label, nightIcon] = WMO[code] ?? ['🌡️', 'condizioni variabili'];
  return { icon: !isDay && nightIcon ? nightIcon : icon, label };
}

const RAINY = (code) => code >= 51 && code <= 99 && !(code >= 71 && code <= 77) && code !== 85 && code !== 86;
const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hourKey = (d) => `${dayKey(d)}T${pad(d.getHours())}:00`;

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeJSON(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* archiviazione non disponibile */ }
}

// ---------- Posizione ----------
export const getLocation = () => readJSON(LOCATION_KEY);

export function setLocation(location) {
  writeJSON(LOCATION_KEY, location);
  writeJSON(CACHE_KEY, null);
}

export async function searchCity(name) {
  const url = `${GEOCODING_URL}?name=${encodeURIComponent(name)}&count=5&language=it&format=json`;
  const res = await fetch(url, timeout());
  if (!res.ok) throw new Error(`Ricerca città non riuscita (${res.status})`);
  const data = await res.json();
  return (data.results ?? []).map((r) => ({
    name: r.name,
    detail: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

/** Usa il GPS del dispositivo; il nome della località è facoltativo. */
export function locateMe() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocalizzazione non disponibile'));
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = +pos.coords.latitude.toFixed(3);
      const lon = +pos.coords.longitude.toFixed(3);
      let name = 'La tua posizione';
      try {
        const res = await fetch(`${REVERSE_URL}?latitude=${lat}&longitude=${lon}&localityLanguage=it`, timeout());
        const data = await res.json();
        name = data.city || data.locality || name;
      } catch { /* va bene anche senza nome */ }
      resolve({ name, detail: '', lat, lon });
    }, (err) => reject(new Error(err.code === 1 ? 'Permesso di posizione negato' : 'Posizione non disponibile')),
    { timeout: 15000, maximumAge: 3600000 });
  });
}

// ---------- Previsioni ----------
function normalize(data, location) {
  const h = data.hourly;
  const d = data.daily;
  return {
    location,
    fetchedAt: Date.now(),
    current: {
      temp: Math.round(data.current.temperature_2m),
      feels: Math.round(data.current.apparent_temperature),
      code: data.current.weather_code,
      isDay: data.current.is_day === 1,
      wind: Math.round(data.current.wind_speed_10m),
    },
    daily: d.time.map((date, i) => ({
      date,
      code: d.weather_code[i],
      max: Math.round(d.temperature_2m_max[i]),
      min: Math.round(d.temperature_2m_min[i]),
      rain: d.precipitation_probability_max[i] ?? 0,
    })),
    hourly: Object.fromEntries(h.time.map((t, i) => [t, {
      temp: Math.round(h.temperature_2m[i]),
      code: h.weather_code[i],
      rain: h.precipitation_probability[i] ?? 0,
    }])),
  };
}

/** Previsioni per la località salvata (in cache per 30 minuti). null se manca la località. */
export async function getForecast({ force = false } = {}) {
  const location = getLocation();
  if (!location) return null;
  const cached = readJSON(CACHE_KEY);
  const fresh = cached && Date.now() - cached.fetchedAt < CACHE_MINUTES * 60000 &&
    cached.location?.lat === location.lat && cached.location?.lon === location.lon;
  if (fresh && !force) return cached;

  const params = new URLSearchParams({
    latitude: location.lat,
    longitude: location.lon,
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m',
    hourly: 'temperature_2m,precipitation_probability,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '7',
  });
  try {
    const res = await fetch(`${FORECAST_URL}?${params}`, timeout());
    if (!res.ok) throw new Error(`Meteo non disponibile (${res.status})`);
    const forecast = normalize(await res.json(), location);
    writeJSON(CACHE_KEY, forecast);
    return forecast;
  } catch (err) {
    // Offline: meglio previsioni un po' vecchie che niente
    if (cached && cached.location?.lat === location.lat) return cached;
    throw err;
  }
}

export const forDay = (forecast, date) => forecast?.daily.find((d) => d.date === dayKey(date)) ?? null;

/** Meteo previsto per una nota: all'ora indicata, oppure per l'intera giornata. */
export function forNote(forecast, note) {
  if (!forecast || !note.due) return null;
  const date = new Date(note.due);
  if (note.hasTime) {
    const h = forecast.hourly[hourKey(date)];
    if (h) return { ...h, ...describe(h.code, date.getHours() >= 7 && date.getHours() < 19) };
  }
  const d = forDay(forecast, date);
  return d ? { temp: d.max, code: d.code, rain: d.rain, ...describe(d.code) } : null;
}

// ---------- Testi ----------
export function dayText(day) {
  const { label } = describe(day.code);
  let text = `${label}, tra ${day.min} e ${day.max} gradi`;
  if (day.rain >= 30) text += `, probabilità di pioggia ${day.rain}%`;
  return text;
}

export function currentText(forecast) {
  const c = forecast.current;
  return `${describe(c.code, c.isDay).label}, ${c.temp} gradi`;
}

/** Consiglio breve sull'ombrello o sul vestirsi, per il giorno indicato. */
export function adviceFor(day) {
  if (!day) return '';
  if (RAINY(day.code) || day.rain >= 50) return 'Meglio portare l\'ombrello.';
  if (day.code >= 71 && day.code <= 86) return 'Attenzione alla neve, vestiti pesante.';
  if (day.max >= 30) return 'Farà caldo: bevi molta acqua.';
  if (day.min <= 3) return 'Farà freddo: copriti bene.';
  return '';
}

/** Riassunto testuale dei prossimi giorni (per Claude). */
export function forecastSummary(forecast) {
  if (!forecast) return null;
  const lines = [`Località: ${forecast.location.name}. Ora: ${currentText(forecast)}.`];
  for (const d of forecast.daily) {
    const label = new Date(`${d.date}T12:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    lines.push(`${label}: ${dayText(d)}.`);
  }
  return lines.join('\n');
}
