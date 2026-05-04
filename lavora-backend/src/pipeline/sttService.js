/**
 * Deepgram real-time STT wrapper.
 * Accepts MULAW 8kHz audio chunks from Twilio Media Streams and emits
 * final transcripts via callback. Supports Arabic + English simultaneously.
 */

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const log = require('../services/logger').child('STT');

/**
 * Create a new live-transcription connection.
 * Returns { send(buf), close() }.
 */
function create({ onTranscript, onError, onClose } = {}) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY not set');

  const deepgram = createClient(apiKey);

  const conn = deepgram.listen.live({
    encoding:          'mulaw',
    sample_rate:       8000,
    language:          'multi',        // Arabic + English auto-detect
    model:             'nova-2-general',
    smart_format:      true,
    interim_results:   false,
    endpointing:       300,            // 300 ms silence = utterance end
    utterance_end_ms:  1000,
    vad_events:        true,
    punctuate:         true,
  });

  conn.on(LiveTranscriptionEvents.Open, () => {
    log.debug('Deepgram connection opened');
  });

  conn.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data?.channel?.alternatives?.[0];
    if (!alt?.transcript || !data.is_final) return;
    const text = alt.transcript.trim();
    if (!text) return;
    const lang = data.channel?.detected_language || null;
    log.debug(`Transcript [${lang || '?'}]: "${text}"`);
    onTranscript?.(text, lang);
  });

  conn.on(LiveTranscriptionEvents.Error, (err) => {
    log.error(`Deepgram error: ${err?.message || String(err)}`);
    onError?.(err);
  });

  conn.on(LiveTranscriptionEvents.Close, () => {
    log.debug('Deepgram connection closed');
    onClose?.();
  });

  return {
    send(buf) {
      try {
        if (conn.getReadyState() === 1) conn.send(buf);
      } catch (e) {
        log.warn(`STT send skipped: ${e.message}`);
      }
    },
    close() {
      try { conn.finish(); } catch {}
    }
  };
}

module.exports = { create };
