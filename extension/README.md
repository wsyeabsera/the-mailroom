# The Mailroom browser extension

A toolbar companion for the owner: see what is waiting for your approval without opening the Hub.

## Load it

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and choose this `extension` folder.
3. Open the extension's **Settings** (right-click the icon, Options), type your Hub URL (`https://...` or `http://localhost:8787`, no path), and click **Save and connect**. Chrome asks permission for that one address.
4. Sign in on the Hub in a normal tab once. The extension reads with your `mr_session` cookie. It shows "Connected as owner" when it works.

The icon opens a popup. "Open side panel" shows a read-only live view. Approving and declining are not here on purpose: the Hub checks the origin of those requests, so use "Review" to open the Hub.

## Badge

- Orange number: parcels waiting for your approval (no badge when 0).
- Amber `!`: your laptop is not connected (out to lunch).
- Grey `x`: signed out. Grey `?`: the Hub cannot be reached.

A desktop notification appears once for each newly waiting parcel (never on the first check after install). The extension checks every 30 seconds.

## Privacy

It only talks to the Hub URL you set. No analytics, no remote code, no other hosts. The URL is stored in `chrome.storage.sync`; the list of already-notified parcel ids stays in session storage.

Regenerate icons with `node extension/tools/make-icons.mjs`.
