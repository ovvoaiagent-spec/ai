/**
 * Deepgram real-time STT wrapper.
 * Accepts MULAW 8kHz audio chunks from Twilio Media Streams and emits
 * final transcripts via callback. Supports Arabic + English simultaneously.
 */

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const log = require('../services/logger').child('STT');

// How many audio chunks to buffer while the WebSocket is reconnecting.
// Each Twilio chunk is ~160 bytes (20 ms of MULAW 8kHz).  Keeping the last
// 50 chunks (~1 second) covers the typical 300 ms reconnect window without
// wasting memory.
const RECONNECT_BUFFER_MAX = 50;

/**
 * Create a new live-transcription connection.
 * Returns { send(buf), keepAlive(), close() }.
 *
 * keepAlive() — sends a Deepgram KeepAlive JSON message to prevent the
 * server from closing an idle connection (Deepgram closes after ~10 s of
 * silence; call every 8 s during PROCESSING/SPEAKING).
 *
 * Audio buffering — chunks sent while the WebSocket is still in the
 * CONNECTING state (readyState 0) are held in a small ring-buffer and
 * flushed automatically once the connection opens.
 */
function create({ onTranscript, onError, onClose, language = 'multi' } = {}) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY not set');

  const deepgram = createClient(apiKey);

  const conn = deepgram.listen.live({
    encoding:          'mulaw',
    sample_rate:       8000,
    language,
    model:             'nova-2',
    smart_format:      false,   // disabled — corrupts Arabic text formatting
    interim_results:   true,    // required for UtteranceEnd fallback
    endpointing:       600,     // 600ms pause → more complete Arabic utterances
    punctuate:         false,   // disabled — Arabic punctuation adds latency/errors
    utterance_end_ms:  1500,    // fallback: fire UtteranceEnd if no final after 1.5s silence
  });

  // Buffer for audio chunks that arrive before the connection is OPEN.
  const pendingBuffer = [];

  // Track last interim transcript — used by two independent fallback paths
  let lastInterim     = null;
  let lastInterimLang = null;
  let silenceTimer    = null;   // local timer: fires 1.5 s after last interim

  function flushInterim(reason) {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    if (lastInterim) {
      const text = lastInterim;
      const lang = lastInterimLang;
      lastInterim     = null;
      lastInterimLang = null;
      log.info(`Transcript [${lang || '?'}] ${reason}: "${text}"`);
      onTranscript?.(text, lang);
    }
  }

  conn.on(LiveTranscriptionEvents.Open, () => {
    log.info('Deepgram connection opened');
    if (pendingBuffer.length > 0) {
      log.debug(`STT flush: sending ${pendingBuffer.length} buffered chunk(s)`);
      for (const buf of pendingBuffer) {
        try { conn.send(buf); } catch (e) { log.warn(`STT flush send error: ${e.message}`); }
      }
      pendingBuffer.length = 0;
    }
  });

  conn.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data?.channel?.alternatives?.[0];
    if (!alt?.transcript) return;
    const text = alt.transcript.trim();
    if (!text) return;
    const lang = data.channel?.detected_language || null;

    if (data.is_final) {
      // Primary fast path — clear any pending interim and emit immediately
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      lastInterim = null; lastInterimLang = null;
      log.info(`Transcript [${lang || '?'}] final: "${text}"`);
      onTranscript?.(text, lang);
    } else {
      // Interim result — save it and (re)start the local silence timer.
      // If no is_final arrives within 1.5 s of the last interim, we emit anyway.
      lastInterim     = text;
      lastInterimLang = lang;
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => flushInterim('silence-timeout'), 1500);
    }
  });

  // Belt-and-suspenders: also listen for Deepgram's own UtteranceEnd signal
  conn.on(LiveTranscriptionEvents.UtteranceEnd, () => flushInterim('utterance-end'));

  conn.on(LiveTranscriptionEvents.Error, (err) => {
    log.error(`Deepgram error: ${err?.message || String(err)}`);
    onError?.(err);
  });

  conn.on(LiveTranscriptionEvents.Close, () => {
    log.info('Deepgram connection closed');
    onClose?.();
  });

  return {
    send(buf) {
      try {
        const state = conn.getReadyState();
        if (state === 1) {
          conn.send(buf);
        } else if (state === 0) {
          if (pendingBuffer.length >= RECONNECT_BUFFER_MAX) pendingBuffer.shift();
          pendingBuffer.push(buf);
        }
      } catch (e) {
        log.warn(`STT send skipped: ${e.message}`);
      }
    },
    keepAlive() {
      try {
        if (conn.getReadyState() === 1) {
          conn.send(JSON.stringify({ type: 'KeepAlive' }));
          log.debug('STT KeepAlive sent');
        }
      } catch (e) {
        log.warn(`STT keepAlive skipped: ${e.message}`);
      }
    },
    close() {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      lastInterim = null;
      pendingBuffer.length = 0;
      try { conn.finish(); } catch {}
    }
  };
}

module.exports = { create };
