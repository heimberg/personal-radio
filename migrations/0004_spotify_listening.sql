-- The owner's Spotify listening profile: a refresh token (scope user-top-read) and the cached top artists.
CREATE TABLE IF NOT EXISTS spotify_listening (
  owner_id TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  artists_json TEXT,
  fetched_at TEXT,
  connected_at TEXT NOT NULL
);
