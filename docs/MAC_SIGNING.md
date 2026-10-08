# Mac signing

LIVE Link has no Apple Developer ID yet, so Gatekeeper still asks each host to click **Open Anyway** once. What the
signature does decide is the **Keychain**: the app keeps its sign-in token in the Keychain item
"LIVE Link Safe Storage", and macOS lets a new version read it without asking only when the new version is signed
with the same certificate (its *designated requirement* names that certificate).

* Ad-hoc signing (`-`, up to 1.0.4) changes with every build, so every update asked again.
* Since 1.0.5 the build signs with **one stable self-signed certificate**, kept as two repo secrets:
  * `MAC_CERT_P12`: the certificate and its key, a base64 `.p12` (3DES/SHA-1, the format `security import` reads)
  * `MAC_CERT_PASSWORD`: its password
* Public fingerprint (SHA-1): `4A:68:BD:21:40:51:70:93:67:6F:11:3C:BB:3A:60:83:CB:45:B8:2A`, valid 20 years.
* The private files live outside this repo (owner's machine, folder `live link-signing`). They are never committed.
* Without the secrets, `mac.yml` signs with a throwaway certificate and adds a build warning: the app works, but
  Mac hosts see a Keychain prompt after that update.
* `mac.yml` checks the designated requirement names a certificate (a build note shows it).

If a host clicks **Deny** on the Keychain prompt anyway, the app does not lose its pairing: it shows
"Allow Keychain access, then Retry" (phase `locked`) and keeps the saved token until access is allowed.
