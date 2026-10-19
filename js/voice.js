// Voce: dettatura (riconoscimento vocale), registrazione audio e lettura ad alta voce.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canTranscribe = Boolean(Recognition);
export const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

/**
 * Avvia una sessione di ascolto. Chiama onText(testoCompleto, èDefinitivo)
 * mentre l'utente parla. Restituisce { stop() } che risolve con l'eventuale
 * registrazione audio (Blob) se keepAudio è true.
 */
export async function listen({ onText, onEnd, onError, keepAudio = false }) {
  let finalText = '';
  let recognition = null;
  let recorder = null;
  let stream = null;
  const chunks = [];

  if (keepAudio && canRecord) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start();
    } catch (err) {
      console.warn('Registrazione audio non disponibile', err);
    }
  }

  if (canTranscribe) {
    recognition = new Recognition();
    recognition.lang = 'it-IT';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      onText?.((finalText + interim).trim(), !interim);
    };
    recognition.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      console.warn('Riconoscimento vocale:', e.error);
      onError?.(e.error);
    };
    recognition.onend = () => onEnd?.();
    recognition.start();
  }

  return {
    stop() {
      recognition?.stop();
      return new Promise((resolve) => {
        if (!recorder || recorder.state === 'inactive') {
          stream?.getTracks().forEach((t) => t.stop());
          resolve(null);
          return;
        }
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType }) : null);
        };
        recorder.stop();
      });
    },
  };
}

export function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'it-IT';
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith('it'));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}
