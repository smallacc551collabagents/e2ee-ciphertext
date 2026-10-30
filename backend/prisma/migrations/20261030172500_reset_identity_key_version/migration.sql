-- #92 bumped identity_key_version; it is the bundle wire-format version (1). Reset.
UPDATE identity_keys SET identity_key_version = 1 WHERE identity_key_version <> 1;
