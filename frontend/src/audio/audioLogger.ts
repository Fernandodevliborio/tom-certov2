// ═══════════════════════════════════════════════════════════════════════════
// audioLogger.ts — Logs estruturados do pipeline de áudio
// ═══════════════════════════════════════════════════════════════════════════
//
// Eventos previstos (estáveis — não mudar nomes):
//   audio_frame_received        (sampled 1/100)
//   audio_frame_timeout
//   pitch_detected              (sampled)
//   pitch_timeout
//   rms_level                   (sampled)
//   recorder_started
//   recorder_stopped
//   recorder_restart
//   watchdog_restart
//   hard_reset_detection
//   backend_request_start
//   backend_request_cancelled
//   backend_request_success
//   backend_request_error
//   lock_released
//   app_state_changed
//
// Cada log usa o prefixo [AudioHealth] e um JSON pequeno com contexto.
// ═══════════════════════════════════════════════════════════════════════════

type LogLevel = 'info' | 'warn' | 'error';

const PREFIX = '[AudioHealth]';

function emit(level: LogLevel, event: string, payload?: Record<string, unknown>) {
  const line = payload && Object.keys(payload).length > 0
    ? `${PREFIX} ${event} ${JSON.stringify(payload)}`
    : `${PREFIX} ${event}`;
  // eslint-disable-next-line no-console
  if (level === 'warn') console.warn(line);
  else if (level === 'error') console.error(line);
  else console.log(line);
}

export const audioLog = {
  info: (event: string, payload?: Record<string, unknown>) => emit('info', event, payload),
  warn: (event: string, payload?: Record<string, unknown>) => emit('warn', event, payload),
  error: (event: string, payload?: Record<string, unknown>) => emit('error', event, payload),
};
