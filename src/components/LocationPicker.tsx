import { useState } from 'react';
import type { StationLocation } from '../domain/station.ts';
import { api, readJson } from '../station-client.ts';

interface Place { name: string; region: string; country: string; latitude: number; longitude: number }
interface Props { value?: StationLocation; onChange(location: StationLocation | undefined): void }

/** Finds the listener's place by name (Open-Meteo geocoding through the Worker) for `{ort}` and `{wetter}`. */
export function LocationPicker({ value, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [problem, setProblem] = useState('');

  async function search() {
    setProblem('');
    try {
      const response = await fetch(api(`api/places?name=${encodeURIComponent(query.trim())}`), { credentials: 'same-origin' });
      const result = await readJson<{ places?: Place[] }>(response);
      if (!response.ok) throw new Error();
      setPlaces(result.places ?? []);
    } catch { setProblem('Die Ortssuche ist gerade nicht erreichbar.'); }
  }

  return <div className="location">
    <p className="muted">{value ? <>Ort: <strong>{value.name}</strong> ({value.latitude.toFixed(2)}, {value.longitude.toFixed(2)}) <button type="button" className="button ghost small" onClick={() => onChange(undefined)}>Entfernen</button></> : 'Noch kein Ort – ohne Ort gibt es kein Wetter.'}</p>
    <form className="inline" onSubmit={event => { event.preventDefault(); if (query.trim().length >= 2) void search(); }}>
      <label className="sr-only" htmlFor="place">Ort suchen</label>
      <input id="place" value={query} maxLength={80} placeholder="Ort suchen, z. B. Bern" onChange={event => setQuery(event.target.value)} />
      <button className="button" type="submit" disabled={query.trim().length < 2}>Suchen</button>
    </form>
    {problem && <p className="problem" role="alert">{problem}</p>}
    {places && (places.length === 0 ? <p className="muted">Kein Ort gefunden.</p> : <div className="chips">{places.map(place =>
      <button type="button" key={`${place.latitude},${place.longitude}`} onClick={() => {
        onChange({ name: place.name, latitude: Math.round(place.latitude * 10_000) / 10_000, longitude: Math.round(place.longitude * 10_000) / 10_000 });
        setPlaces(null); setQuery('');
      }}>{[place.name, place.region, place.country].filter(Boolean).join(', ')}</button>)}</div>)}
  </div>;
}
