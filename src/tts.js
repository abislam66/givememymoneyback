// ElevenLabs text-to-speech. Returns an audio/mpeg Buffer, or null when no key is set or on failure
// (the browser then falls back to speechSynthesis).

const TIMEOUT_MS = 15000;
const MAX_CHARS = 2500; // keep free-plan credit use small

// The three voices people can pick. Voice IDs aren't secret; the API key stays on the server.
const VOICES = { clear: 'gPPH6SLdL8XSX6GNJ40G', calm: 'KMjDragTYnXfFE5NOvAo', direct: 'CwhRBWXzGAHq8TQ4Fs17' };
const DEFAULT_VOICE = 'clear';

function hasTTS() { return Boolean((process.env.ELEVENLABS_API_KEY || '').trim()); }

async function speak(text, { voice: pick, lang = 'en' } = {}) {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return null;
  const voice = VOICES[pick] || VOICES[DEFAULT_VOICE];
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!clean) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: clean, model_id: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5', ...(lang !== 'en' ? { language_code: lang } : {}) }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[tts] HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.warn(`[tts] ${e.name === 'AbortError' ? 'timed out after 15s' : e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { speak, hasTTS, VOICES, DEFAULT_VOICE };
