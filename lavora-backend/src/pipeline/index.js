/**
 * Custom voice pipeline — WebSocket server for Twilio Media Streams.
 *
 * Twilio sends MULAW 8kHz audio over a WebSocket (one message per 20ms chunk).
 * We run that audio through Deepgram STT → Claude LLM → ElevenLabs TTS (ulaw_8000)
 * and stream the synthesised audio back to Twilio in real time.
 *
 * Attach to an existing Express http.Server via pipeline.attach(server).
 */

const WebSocket   = require('ws');
const url         = require('url');
const https       = require('https');
const CallSession = require('./callSession');
const log         = require('../services/logger').child('PIPELINE');

const WS_PATH = '/media-stream';

/**
 * Hang up a Twilio call via REST API.
 * Fire-and-forget — failure is logged but not propagated.
 */
function twilioHangUp(callSid) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken || !callSid) return;

  const body = 'Status=completed';
  const req = https.request({
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
    method: 'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Authorization':  'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
    }
  }, (res) => {
    if (res.statusCode !== 200) {
      log.warn(`Twilio hangup returned ${res.statusCode} for ${callSid}`);
    }
  });
  req.on('error', (e) => log.warn(`Twilio hangup error: ${e.message}`));
  req.write(body);
  req.end();
}

/**
 * Attach the Media Stream WebSocket server to an existing http.Server.
 */
function attach(server) {
  const wss = new WebSocket.Server({ noServer: true });

  // Only upgrade requests to /media-stream
  server.on('upgrade', (req, socket, head) => {
    const pathname = url.parse(req.url).pathname;
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    log.info('Media stream WebSocket connected');
    let session = null;

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // ── Stream started ──────────────────────────────────────────────────
      if (msg.event === 'start') {
        const startData        = msg.start || {};
        const streamSid        = startData.streamSid  || msg.streamSid || '';
        const callSid          = startData.callSid    || '';
        const params           = startData.customParameters || {};

        log.info(`Stream start: ${streamSid} | call: ${callSid}`);

        session = new CallSession({
          callSid,
          streamSid,
          caller_id:       params.caller_id       || '',
          is_returning:    params.is_returning     || 'false',
          patient_name:    params.patient_name     || '',
          last_service:    params.last_service     || '',
          last_visit_date: params.last_visit_date  || '',

          sendAudio: (base64) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                event:     'media',
                streamSid,
                media:     { payload: base64 }
              }));
            }
          },

          clearAudio: () => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ event: 'clear', streamSid }));
            }
          },

          hangUp: () => twilioHangUp(callSid)
        });

        session.start().catch(err => log.error(`Session start error: ${err.message}`));
      }

      // ── Inbound audio ───────────────────────────────────────────────────
      else if (msg.event === 'media' && session) {
        session.onAudio(msg.media?.payload);
      }

      // ── Stream stopped ──────────────────────────────────────────────────
      else if (msg.event === 'stop' && session) {
        log.info('Stream stop received');
        await session.stop();
        session = null;
      }
    });

    ws.on('close', () => {
      log.info('Media stream WebSocket closed');
      session?.stop();
      session = null;
    });

    ws.on('error', (err) => {
      log.error(`Media stream WS error: ${err.message}`);
    });
  });

  log.info(`Voice pipeline attached at ws://<host>${WS_PATH}`);
}

module.exports = { attach };
