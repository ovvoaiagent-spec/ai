/**
 * Per-call session state machine.
 *
 * States: IDLE → GREETING → LISTENING → PROCESSING → SPEAKING → ENDED
 *
 * Audio flow:
 *   Twilio (MULAW 8kHz) → onAudio() → Deepgram STT → onTranscript()
 *                                                          ↓
 *                                                    Claude LLM (with tools)
 *                                                          ↓
 *                                                  ElevenLabs TTS (ulaw_8000)
 *                                                          ↓
 *                                                  sendAudio() → Twilio
 */

const sttService = require('./sttService');
const llmService = require('./llmService');
const ttsService = require('./ttsService');
const log        = require('../services/logger').child('SESSION');

const STATES = {
  IDLE:       'idle',
  GREETING:   'greeting',
  LISTENING:  'listening',
  PROCESSING: 'processing',
  SPEAKING:   'speaking',
  ENDED:      'ended'
};

class CallSession {
  /**
   * @param {object} opts
   * @param {string}   opts.callSid
   * @param {string}   opts.streamSid
   * @param {string}   opts.caller_id
   * @param {string}   opts.is_returning      'true' | 'false'
   * @param {string}   opts.patient_name
   * @param {string}   opts.last_service
   * @param {string}   opts.last_visit_date
   * @param {function} opts.sendAudio(base64)  — send MULAW chunk to Twilio
   * @param {function} opts.clearAudio()       — send Twilio "clear" (barge-in)
   * @param {function} opts.hangUp()           — end the call via Twilio REST
   */
  constructor(opts) {
    this.callSid    = opts.callSid;
    this.streamSid  = opts.streamSid;
    this.sendAudio  = opts.sendAudio;
    this.clearAudio = opts.clearAudio;
    this.hangUp     = opts.hangUp || (() => {});

    this.context = {
      caller_id:       opts.caller_id       || '',
      is_returning:    opts.is_returning     || 'false',
      patient_name:    opts.patient_name     || '',
      last_service:    opts.last_service     || '',
      last_visit_date: opts.last_visit_date  || '',
      sessionId:       opts.callSid          || `sess-${Date.now()}`,
      language:        'en'
    };

    this.history          = [];
    this.state            = STATES.IDLE;
    this.stt              = null;
    this.abortRef         = { aborted: false };
    this.detectedLanguage = 'en';
    this._keepAliveTimer  = null;

    log.info(`Session created: ${this.callSid} | returning=${this.context.is_returning}`);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Called once when the Twilio Media Stream opens. */
  async start() {
    this._setState(STATES.GREETING);

    // Initialise Deepgram — but only start sending audio after greeting
    this.stt = this._createStt();

    // Send a KeepAlive to Deepgram every 8 s so the connection stays open
    // during long PROCESSING/SPEAKING phases (tool calls + TTS).
    // Deepgram closes idle connections after ~10 s of no audio or traffic.
    this._keepAliveTimer = setInterval(() => {
      this.stt?.keepAlive();
    }, 8000);

    const greeting = this.context.is_returning === 'true'
      ? `Welcome back, ${this.context.patient_name}. Do you prefer Arabic or English today?`
      : 'Thank you for calling Lavora Clinic. Do you prefer Arabic or English?';

    await this._speak(greeting);
    this._setState(STATES.LISTENING);
  }

  /** Called for every audio chunk arriving from Twilio. */
  onAudio(base64Payload) {
    if (this.state !== STATES.LISTENING) return;
    const buf = Buffer.from(base64Payload, 'base64');
    this.stt?.send(buf);
  }

  /** Called when the Twilio Media Stream closes. */
  async stop() {
    if (this.state === STATES.ENDED) return;
    this._setState(STATES.ENDED);
    this.abortRef.aborted = true;
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    this.stt?.close();
    log.info(`Session ended: ${this.callSid}`);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async _onTranscript(text, lang) {
    if (this.state !== STATES.LISTENING) return;  // ignore late transcripts

    // Update language from STT detection (secondary signal)
    if (lang && lang.toLowerCase().startsWith('ar')) {
      this.detectedLanguage = 'ar';
      this.context.language = 'ar';
    }

    // Explicit language-choice detection: caller says "Arabic"/"عربي" or "English"/"إنجليزي"
    // Needed because "Arabic" is an English word — STT returns lang='en', missing the switch.
    if (/arabic|عربي|عرب/i.test(text)) {
      this.detectedLanguage = 'ar';
      this.context.language = 'ar';
    } else if (/english|إنجليزي|انجليزي/i.test(text) && this.detectedLanguage === 'ar') {
      this.detectedLanguage = 'en';
      this.context.language = 'en';
    }

    log.info(`[${this.callSid}] User [${this.detectedLanguage}]: "${text}"`);
    this._setState(STATES.PROCESSING);

    this.history.push({ role: 'user', content: text });

    try {
      const { text: reply, history } = await llmService.chat(this.history, this.context);
      this.history = history;

      // Update language from LLM response (primary signal — more reliable than STT)
      if (reply) {
        if (/[؀-ۿ]/.test(reply)) {
          this.detectedLanguage = 'ar';
        } else if (/[a-zA-Z]/.test(reply)) {
          this.detectedLanguage = 'en';
        }
        this.context.language = this.detectedLanguage;
      }

      log.info(`[${this.callSid}] Agent [${this.detectedLanguage}]: "${reply}"`);
      await this._speak(reply);

      // Detect end-of-call phrase
      if (this._isGoodbye(reply)) {
        await this._endCall();
        return;
      }
    } catch (err) {
      log.error(`[${this.callSid}] LLM error: ${err.message}`);
      await this._speak('I apologise for the technical difficulty. Our team will reach out to you shortly. Goodbye.');
      await this._endCall();
      return;
    }

    if (this.state !== STATES.ENDED) {
      this._setState(STATES.LISTENING);
    }
  }

  async _speak(text) {
    if (!text || this.state === STATES.ENDED) return;
    this._setState(STATES.SPEAKING);

    // Reset abort flag before speaking
    this.abortRef = { aborted: false };

    try {
      await ttsService.synthesize(text, {
        languageCode: this.detectedLanguage,
        abortRef: this.abortRef,
        onChunk: (buf) => {
          if (this.abortRef.aborted || this.state === STATES.ENDED) return;
          this.sendAudio(buf.toString('base64'));
        }
      });
    } catch (err) {
      log.error(`[${this.callSid}] TTS error: ${err.message}`);
      // Reset state so the caller can still speak after a TTS failure
      if (this.state !== STATES.ENDED) this._setState(STATES.LISTENING);
    }
  }

  async _endCall() {
    if (this.state === STATES.ENDED) return;
    // Brief pause so the final audio can finish playing
    await new Promise(r => setTimeout(r, 3000));
    await this.stop();
    try { this.hangUp(); } catch {}
  }

  _isGoodbye(text) {
    const lower = (text || '').toLowerCase();
    return lower.includes('goodbye') ||
      lower.includes('وداع') ||
      lower.includes('مع السلامة') ||
      lower.includes('شكراً على اتصالك بعيادة لافورا');
  }

  _createStt() {
    return sttService.create({
      onTranscript: (text, lang) => this._onTranscript(text, lang),
      onError: (err) => log.error(`STT error [${this.callSid}]: ${err?.message || err}`),
      onClose: () => {
        log.warn(`[${this.callSid}] Deepgram connection closed (state=${this.state})`);
        if (this.state !== STATES.ENDED) {
          log.info(`[${this.callSid}] Restarting STT connection`);
          this.stt = this._createStt();
        }
      }
    });
  }

  _setState(s) {
    if (this.state === STATES.ENDED && s !== STATES.ENDED) return;
    this.state = s;
    log.debug(`[${this.callSid}] → ${s}`);
  }
}

module.exports = CallSession;
