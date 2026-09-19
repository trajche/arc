<p align="center">
  <img src="docs/logo.png" alt="" width="128" height="128">
</p>

<h1 align="center">Arc for Firefox</h1>

<p align="center">An Arc-style sidebar for Firefox: favorites, spaces, pinned tabs and folders, a command bar for new tabs, and an address bar in the sidebar.</p>

With a small one-time setup it replaces Firefox's tab strip and toolbar, so the sidebar and the page get the whole window.

> Not affiliated with or endorsed by The Browser Company. “Arc” is their browser; this is an independent extension that brings its sidebar ideas to Firefox.

## Features

- **Favorites.** A grid of icons at the top. Each favorite owns one tab: click to switch to it, or reopen it if you closed it. Favorites belong to a container, like Arc's per-profile favorites.
- **Spaces.** Separate sets of tabs with their own name, emoji and color. Switch from the footer, with a two-finger swipe, or `⌃1`–`⌃5` (`Alt+Shift+1`–`5`). A space can use its own Firefox container, so it keeps separate logins.
- **Pinned tabs and folders.** Pin tabs to a space; they stay in the sidebar when closed. Shift- or Command-click to select several, right-click → *New Folder*. The pinned section folds away under the space name.
- **Command bar.** `⌘T` / `Ctrl+T` opens a search box instead of a blank page: addresses, searches, open tabs, history.
- **Address bar in the sidebar.** Shows the site you're on; click to edit or search. `⌥⇧L` / `Alt+Shift+L`.
- **Hide the sidebar.** `⌥⇧S` / `Alt+Shift+S` gives the page the whole window.
- **Split view.** Firefox's split tabs show as one row. Create and separate them with Firefox's own shortcuts (set them in `about:keyboard`).
- **Import from Arc.** Brings over spaces, pinned tabs, folders and favorites. Each Arc profile becomes a Firefox container.

Shortcuts can be changed in `about:addons` → ⚙ → *Manage Extension Shortcuts*.

## Install

Arc for Firefox needs **Firefox 140 or newer**.

1. Download the latest signed `.xpi` from [Releases](https://github.com/trajche/arc/releases) and open it in Firefox.
2. **Give Arc the whole window** (hides Firefox's tab strip and toolbar). Run the setup script for your system. It finds the Firefox profile with Arc and adds Arc's layout, keeping any customizations you already have:
   - **macOS / Linux:** `bash arc-setup.sh` ([`extras/setup/arc-setup.sh.txt`](extras/setup/arc-setup.sh.txt), or download it from the welcome page)
   - **Windows:** `powershell -ExecutionPolicy Bypass -File arc-setup.ps1` ([`extras/setup/arc-setup.ps1`](extras/setup/arc-setup.ps1))

   Then quit Firefox and open it again. Run it again after updating Arc; add `--uninstall` / `-Uninstall` to remove it.
3. Coming from Arc? Right-click the space name → **Import from Arc…**

The welcome page (opened on install, or right-click the space name → *Welcome & Setup*) explains the features and offers the setup script.

### What the setup changes

- `<profile>/chrome/userChrome.css` hides the tab strip, Firefox's sidebar launcher and panel header, and turns the toolbar into a row of extension buttons in the sidebar. Firefox's own address bar appears as a centered overlay with `⌘L` / `Ctrl+L` (needed for `about:` pages, which extensions can't open).
- `<profile>/user.js` enables `userChrome.css`, horizontal tabs and session restore, keeps the window open when the last tab closes, and opens Arc's sidebar at startup.

## Limits

Firefox doesn't allow extensions to do these:

- Draw over the page. Arc's floating command bar becomes a tab here.
- Open `about:` pages, create split views, or read Arc's saved logins and cookies.
- Switch browser profiles. Containers stand in for Arc profiles: separate cookies and logins, but shared history, bookmarks and extensions.

Spaces, pins and favorites are stored locally; Firefox Sync's extension storage is too small for large Arc imports.

## Development

```sh
npm install
npm run setup-dev   # once: creates the "arc-dev" Firefox Developer Edition profile
npm run dev         # start Developer Edition with that profile (macOS)
npm run reload      # reload Arc in place after changing code
npm run lint
```

The dev profile loads Arc unsigned, straight from this folder, and links `extras/userChrome.css` into the profile. Code changes need `npm run reload`; `userChrome.css` changes need a Developer Edition restart. Release Firefox only runs signed add-ons.

- `npm run build:setup` regenerates `extras/setup/` from `extras/userChrome.css` and `extras/user.js`. Run it after changing either.
- `npm run sign` bumps the version and signs an unlisted build with addons.mozilla.org. It reads `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` from `.env` (git-ignored).

| Path | What |
|---|---|
| `background.js` | Tab lifecycle, spaces, context menus, commands |
| `shared/store.js` | Data: spaces, favorites, pinned items, folders, import |
| `sidebar/` | The sidebar: tabs, address bar, spaces footer |
| `palette/`, `newtab/` | Command bar and the new-tab page that opens it |
| `editor/` | Space editor window (emoji data in `emoji.json`) |
| `import/` | Import from Arc (`arc-parse.js` reads Arc's `StorableSidebar.json`) |
| `welcome/` | Welcome and setup page |
| `extras/` | `userChrome.css`, `user.js` and the generated setup scripts |
| `scripts/` | Dev tooling: setup-script generator, dev profile, reload |

## License

[MIT](LICENSE). Emoji data from [unicode-emoji-json](https://github.com/muan/unicode-emoji-json) and [emojilib](https://github.com/muan/emojilib) (MIT, see [`editor/emoji.LICENSE.txt`](editor/emoji.LICENSE.txt)).
