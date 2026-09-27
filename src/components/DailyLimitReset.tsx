import { useState } from 'react';

export function DailyLimitReset() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function reset() {
    if (!window.confirm('Möchtest du die heutigen Beitrags-, Feed- und TTS-Limits zurücksetzen?')) return;
    setBusy(true); setMessage('Tageslimits werden zurückgesetzt …');
    try {
      const response = await fetch(new URL('api/testing/reset-daily-limits', window.location.href), {
        method: 'POST', credentials: 'same-origin',
      });
      const result = await response.json().catch(() => ({})) as { utcDay?: string };
      if (!response.ok) throw new Error(response.status === 401
        ? 'Bitte zuerst bei deiner privaten Radio-App anmelden.'
        : 'Die Tageslimits konnten nicht zurückgesetzt werden.');
      setMessage(`Tageslimits für heute (${result.utcDay ?? 'UTC'}) zurückgesetzt.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Zurücksetzen fehlgeschlagen.');
    } finally { setBusy(false); }
  }

  return <section className="panel settings" aria-labelledby="quota-reset-title">
    <h2 id="quota-reset-title">KI-Limits fürs Testen</h2>
    <p>Setzt für dein angemeldetes Profil die heutigen Beitrags-, TTS-Zeichen- und Feed-Abrufzähler zurück. Das Tageslimit gilt danach wieder vollständig.</p>
    <button className="secondary" type="button" disabled={busy} onClick={() => void reset()}>
      {busy ? 'Wird zurückgesetzt …' : 'Heutige Limits zurücksetzen'}
    </button>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
