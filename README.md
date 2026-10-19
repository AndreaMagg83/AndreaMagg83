# 🎙️ Agenda Vocale

Agenda personale in cui annoti le cose da ricordare **parlando**, con un **assistente**
che ti dice cosa hai in programma quando glielo chiedi.

È una web app (PWA): si apre dal browser e si può installare sul telefono come un'app.
Tutti i dati restano **sul tuo dispositivo** (IndexedDB), niente server, niente account.

## Cosa fa (versione 0.1)

- **Note vocali**: tocchi il microfono, detti la nota, l'app la trascrive e salva anche l'audio.
- **Date capite al volo**: "Ricordami di chiamare il dentista *domani alle 10*" diventa
  la nota "Chiamare il dentista" fissata per domani alle 10:00. Capisce frasi come
  *oggi, domani, dopodomani, stasera, domattina, lunedì prossimo, il 25 ottobre, 28/10,
  tra 2 ore, alle 9 e mezza di sera*…
- **Lista organizzata**: Scadute / Oggi / Domani / Questa settimana / mesi successivi,
  con filtri (Prossime, Oggi, Senza data, Completate, Tutte).
- **Assistente** (scheda 🤖), a voce o scrivendo:
  - "Cosa devo fare oggi?" · "Cosa ho domani?" · "Questa settimana" · "Giovedì?"
  - "Prossimi impegni" · "Cosa ho scaduto?" · "Note senza data"
  - "Cerca dentista" · "Quando ho la riunione?"
  - "Ricordami di pagare la bolletta dopodomani" → crea il promemoria
  - Le risposte vengono anche lette ad alta voce.
- **Claude come assistente** (opzionale): dalle impostazioni ⚙️ della scheda Assistente
  inserisci una chiave API Anthropic e l'assistente diventa Claude. Capisce richieste libere
  ("sposta il dentista a giovedì", "ho già pagato la bolletta", "come organizzo domani?"),
  può creare, modificare, completare ed eliminare note e dare consigli sulla giornata.
  Senza chiave o senza rete torna automaticamente all'assistente base.
- **Promemoria**: all'ora stabilita compare un avviso (e una notifica, se attivata con 🔔).

## Come provarla

Il microfono funziona solo su `https://` o `localhost`.

```bash
python3 -m http.server 8000
# poi apri http://localhost:8000
```

Per usarla sul telefono, il modo più semplice è pubblicarla con **GitHub Pages**
(Settings → Pages → Deploy from branch) e aprire il link da Chrome/Safari,
poi "Aggiungi a schermata Home".

> La dettatura usa il riconoscimento vocale del browser: funziona su Chrome, Edge e Safari.
> Su Firefox puoi comunque registrare l'audio o scrivere a mano.

## Struttura

| File | Ruolo |
|------|-------|
| `index.html`, `styles.css` | Interfaccia |
| `js/app.js` | Logica dell'app: note, registrazione, promemoria, navigazione |
| `js/agent.js` | Assistente base (a regole, funziona offline) |
| `js/claude.js` | Assistente Claude: chiamate all'API Anthropic e strumenti sulle note |
| `js/dateparser.js` | Riconosce date e orari scritti in italiano |
| `js/voice.js` | Dettatura, registrazione audio, sintesi vocale |
| `js/db.js` | Salvataggio locale (IndexedDB) |
| `sw.js`, `manifest.webmanifest` | Installazione come app e funzionamento offline |

## Collegare Claude

1. Crea una chiave su [console.anthropic.com](https://console.anthropic.com/settings/keys)
   (serve un account con credito; conviene impostare un limite di spesa mensile).
2. Nell'app: scheda **Assistente** → ⚙️ → incolla la chiave → **Salva e prova**.
3. Il badge in alto diventa "✨ Claude attivo".

Dettagli tecnici: modello `claude-opus-5-5` con effort `low` per risposte rapide, SDK ufficiale
`@anthropic-ai/sdk` caricato da CDN, fallback automatico lato server in caso di rifiuto
(`fallbacks: "default"`). La chiave è salvata nel `localStorage` del dispositivo e inviata solo
ad `api.anthropic.com`: va bene per un'app personale, ma **non pubblicare l'app con la tua chiave
dentro** e non usarla su dispositivi condivisi. Per condividere l'app con altri servirà un piccolo
server che custodisca la chiave.

## Limiti attuali e idee per i prossimi passi

- I promemoria scattano solo con l'app aperta (o in background recente): per notifiche
  sempre affidabili servirà un piccolo server con Web Push, oppure un'app nativa.
- Possibili aggiunte: promemoria ricorrenti, categorie/colori, anticipo dell'avviso
  ("avvisami 30 minuti prima"), sincronizzazione tra dispositivi, esportazione su Google Calendar.
