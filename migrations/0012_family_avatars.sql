-- Profile pictures of the family: the image itself is in R2 (avatars/<member key>); the version makes its URL change when it does.
CREATE TABLE IF NOT EXISTS family_avatars (
  owner_id TEXT PRIMARY KEY,
  version TEXT NOT NULL
);
