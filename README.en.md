# 🛡️ Aura Auth

> 🇬🇧 English version. [🇷🇺 Русская версия](README.md)

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Built with](https://img.shields.io/badge/built%20with-Electron-47848f)
![Languages](https://img.shields.io/badge/languages-RU%20%7C%20EN-2ecc71)

**Aura Auth** is a Steam Desktop Authenticator (SDA) for Windows. It replaces the Steam Guard mobile
app and lets you manage your Steam accounts right from your computer: 2FA login, trade and login
confirmations, mass item sending, CS2 Trade-Up contracts, inventory browsing and idle "game
playing" — all in one window, with multi-account support and a separate proxy for each account.



---

## ✨ Features

### 🔐 Accounts & 2FA
- **Account import** via `maFile` (drag-and-drop or file picker).
- **Steam Guard code** with a live countdown — copied to clipboard with one click.
- **Auto-confirm** of 2FA confirmations (trades, email changes, etc.).
- **Steam login approval** — like the mobile app: approve or deny a login from a new device with a
  single button.
- **Rename** an account, **log out** and **remove** it.
- **Per-account proxy** (see below).

### 🤝 Trades & confirmations
- List of **incoming and outgoing** trade offers.
- **Accept / decline** an offer right from the list.
- **Auto-accept** trades without manual confirmation.
- A **trade offer detail** window (items, partner, status) opens separately.
- A **confirmations** feed with an "Accept all" button.

### 📦 Mass item sending
- Pick items from inventory and send them to a **chosen account**.
- **Saved recipients**: SteamID64 or trade link + trade token.
- A hint about error 15 (when the recipient is not a friend and no token is provided).

### 🎮 CS2 Trade-Up contracts
- Browse the **CS2 inventory** and execute **Trade-Up contracts** (10 items of one rarity) via the
  GlobalOffensive Coordinator.
- **EV calculation** for the contract and **history** of executed contracts.
- **View mode without launching the game** (analytics only, crafting disabled).

### 🎒 Inventory
- A separate inventory browser window by game/context, with search, a "tradable only" filter, and
  item selection for mass sending.

### 🕹️ Idle "game playing"
- Connect to Steam as a CM client and **report played games** without launching the game itself
  (like ASF).
- Choose `appID`s (CS2 / Dota 2 / TF2 / Rust presets + custom) and **auto-play on launch**.

### 🌐 Proxy (per-account)
- A **Proxy** field on the account card and on import: `socks5://`, `socks4://`, `http(s)://` or
  just `host:port`. **Username/password** are supported (the `host:port:user:pass` seller format
  works too).
- A **"Test"** button performs a real request through the proxy and shows your external IP (proving
  traffic goes through the proxy).
- DNS is resolved **on the proxy side** (no DNS leak).

### 🎨 Interface & settings
- **Two languages**: Russian and English.
- **Themes**: a set of built-in themes (default "Aura", dark variants).
- **Log** panel (collapsible) for diagnostics.
- **Auto-update** via GitHub Releases.

---

## 📥 Installation

1. Go to the **[Releases](https://github.com/wuwku6e6/Aura-Auth/releases)** section of this repo.
2. Download the installer `Aura Auth-<version>-setup.exe`.
3. Run it and follow the setup (NSIS). You can choose the install folder.
4. Launch **Aura Auth** from the Start menu / desktop shortcut.

> 💡 Updates arrive automatically: in Settings click "Check for updates".

---

## 🚀 Quick start

1. Click **"Add account"** and drop your `maFile` into the window (exported from the official
   Steam Guard / an SDA tool).
2. The account appears in the list; a live **Steam Guard code** sits next to the name (click to
   copy).
3. Enable **Auto-confirm** and/or **Auto-accept** if you want.
4. To use a proxy, click the **"Proxy"** chip under the account name, enter the address and click
   **"Test"**.
5. To "play" games without launching them, open the **"Play games"** block, pick games and click
   **"Play"**.

---

