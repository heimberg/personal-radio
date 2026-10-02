// Ortsgeschichten: the app reports where the listener is (only while it is open and the feature is on);
// the Worker names the place with OpenStreetMap's reverse geocoding. Only the place name goes to the AI.
type Fetch = typeof fetch;

export interface PlaceName { name: string; label: string }

/** The village or town at a coordinate, with its canton or region: «Melchnau» / «Melchnau, Bern». Null when there is none. */
export async function reverseGeocode(latitude: number, longitude: number, fetcher: Fetch = fetch): Promise<PlaceName | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=de&lat=${latitude.toFixed(4)}&lon=${longitude.toFixed(4)}`;
  const response = await fetcher(url, { headers: { 'User-Agent': 'personal-radio (private listening app)', Accept: 'application/json' } });
  if (!response.ok) return null;
  const address = ((await response.json()) as { address?: Record<string, string> }).address ?? {};
  const name = address.village ?? address.town ?? address.city ?? address.hamlet ?? address.municipality ?? address.suburb;
  if (!name) return null;
  const region = address.state ?? address.county;
  return { name: name.slice(0, 80), label: (region && region !== name ? `${name}, ${region}` : name).slice(0, 120) };
}

/** A coordinate the app may send: on Earth, as numbers. */
export const validCoordinate = (latitude: unknown, longitude: unknown): latitude is number =>
  typeof latitude === 'number' && typeof longitude === 'number' && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
