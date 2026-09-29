-- Connecting Spotify: the state lives on the server, so the login can finish in another browser than it
-- started in (the app opens Spotify's login in the system browser, which does not share the app's cookies).
CREATE TABLE IF NOT EXISTS spotify_oauth_states (
  state TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
