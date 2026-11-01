# RP Tavern

RP Tavern is a responsive role-play chat site for AI characters. GitHub Pages serves the public interface; a Node.js bridge on the owner's PC sends generation requests to the locally configured AI service. The interface includes a character hall, profile and character editor, saved chats, message editing and deletion, alternate replies, and swipe-to-regenerate on phones.

## Start the local services on Windows

1. Start the local AI service and connect its API and model. The default address is `http://127.0.0.1:8000`.
2. In PowerShell, start the bridge from the project folder:

   ```powershell
   cd "C:\Users\мишко\AppData\Local\Cline\tavern-site"
   node server.js
   ```

   On first launch, the server creates `config.local.json` and prints the access keys in this window. Keep this file private. To issue more keys, add strings to its `accessCodes` list and restart Node.js. Removing a key from that list revokes it and signs out its holders.

   To add more keys later, edit only the `accessCodes` field in `config.local.json`, for example:

   ```json
   "accessCodes": ["RPT-your-first-key", "RPT-your-second-key"]
   ```

   Keep the other settings in the file. Never put real keys in the public repository.

   A one-use tester key goes in `oneTimeAccessCodes`. It disappears from that list after a successful login; the tester's session remains valid until it expires.
3. In a second PowerShell window, start Cloudflare Tunnel:

   ```powershell
   cloudflared tunnel --url http://127.0.0.1:3000
   ```

   Keep both windows open. Copy the `https://…trycloudflare.com` URL from the Tunnel window.
4. Open [RP Tavern](https://mihuilpon-pixel.github.io/rp-tavern/), confirm you are 18+, enter the Tunnel URL and access code.

The admin page is at `/admin.html`. Its separate code is printed by Node.js and stored privately as `adminCode` in `config.local.json`. The panel lists sessions connected since the current server start and can revoke any one of them. Restarting Node.js ends all listed sessions; users can sign in again, and their browser chat histories remain local.

If the Quick Tunnel address changes, enter the new address in the site's settings. For a shareable link, append `?server=https://YOUR-TUNNEL.trycloudflare.com` to the site URL.

## Publish the website

The repository's GitHub Pages source should be set to branch `main`, folder `/ (root)`. The static site files are at the repository root. Never commit `config.local.json` or API credentials.

## Data and privacy

Characters and chat history are stored in IndexedDB in each visitor's browser; they do not automatically sync between devices. Generation requests go through the local Node.js bridge to the configured AI service and model. The server does not save chat text.
