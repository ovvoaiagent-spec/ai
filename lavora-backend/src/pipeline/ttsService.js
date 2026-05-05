/**
 * ElevenLabs streaming TTS — outputs MULAW 8kHz (ulaw_8000) directly.
 * No audio conversion required; output is immediately playable by Twilio.
 */

const https = require('https');
const log   = require('../services/logger').child('TTS');

const DEFAULT_VOICE   = 'MoRbPlz3injOLU6hNLMY';  // Lavora clinic voice
const MODEL_EN        = 'eleven_turbo_v2_5';        // fastest — English
const MODEL_MULTI     = 'eleven_multilingual_v2';   // multilingual — Arabic etc.

/**
 * Synthesize text to MULAW 8kHz audio.
 * Calls onChunk(Buffer) for each audio chunk as it arrives.
 * Returns a Promise that resolves when the stream ends.
 *
 * Pass abortRef = { aborted: false } to support mid-stream cancellation.
 * Set abortRef.aborted = true from the caller to stop delivering chunks.
 */
function synthesize(text, { onChunk, onDone, onError, abortRef, languageCode } = {}) {
  return new Promise((resolve, reject) => {
    const apiKey  = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;

    if (!apiKey) {
      const err = new Error('ELEVENLABS_API_KEY not set');
      onError?.(err);
      return reject(err);
    }

    if (!text || !text.trim()) {
      onDone?.();
      return resolve();
    }

    // Use multilingual model for Arabic (auto-detects from text — no language_code needed)
    // Use turbo model for English/default (lower latency)
    const model = (languageCode === 'ar') ? MODEL_MULTI : MODEL_EN;
    const bodyObj = {
      text,
      model_id: model,
      voice_settings: {
        stability:        0.5,
        similarity_boost: 0.75,
        speed:            1.0
      }
    };
    const body = JSON.stringify(bodyObj);

    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000&optimize_streaming_latency=4`,
      method: 'POST',
      headers: {
        'xi-api-key':     apiKey,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          const err = new Error(`TTS HTTP ${res.statusCode}: ${raw.slice(0, 200)}`);
          log.error(err.message);
          onError?.(err);
          reject(err);
        });
        return;
      }

      res.on('data', (chunk) => {
        if (abortRef?.aborted) return;
        onChunk?.(chunk);
      });

      res.on('end', () => {
        log.debug(`TTS stream complete (${text.length} chars)`);
        onDone?.();
        resolve();
      });

      res.on('error', (err) => {
        log.error(`TTS stream error: ${err.message}`);
        onError?.(err);
        reject(err);
      });
    });

    req.on('error', (err) => {
      log.error(`TTS request error: ${err.message}`);
      onError?.(err);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

module.exports = { synthesize };
