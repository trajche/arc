# Changelog

## 0.7.0

- Downloads show in the sidebar. A tray appears under the tab list while files
  are coming in: a row each with a progress bar, transfer rate and time left,
  and pause, resume, cancel and retry. A download with no size reported gets a
  sliding bar instead of a made-up percentage. Finished downloads stay for a
  minute — click one to open it, reveal it in its folder, or clear them from
  the tray's header — then drop out on their own.
- Closing a tab goes back to the tab you were on before it, instead of the one
  next to it. Tabs of other spaces never win, since going back to one would
  switch space. Arc's own closes — Cmd/Ctrl+W, the sidebar's close button, its
  tab menu, closing a selection, Clear — send you there before the tab goes,
  so nothing flashes in between; closes from elsewhere are corrected right
  after.

## 0.6.7

- Clicking a favorite or a pinned item works when the space has no tabs of its
  own. Firefox reports about:blank for a tab opened with an address until the
  load starts, so the tab Arc had just made looked like the blank one Firefox
  makes for Cmd+T — and with a command bar open, Arc threw it away and went
  back to the bar, leaving the click doing nothing.
- An open that fails is reported instead of swallowed, and marking a tab that
  has already gone no longer fails whatever opened it.

## 0.6.6

- Cmd/Ctrl+T no longer waits for the page the command bar just opened. Enter
  used to wait on Firefox's search service before navigating, and until the bar
  navigated it still counted as the window's command bar, so the next Cmd+T
  came back to it. Three or four tabs in a row now open as fast as you type.
- A command bar Arc had just opened could be missed by the next Cmd+T, which
  then opened a second empty one. Bars are known by tab id now, not only by
  their address, and two presses at once can't both decide to open one.

## 0.6.5

- The sidebar keeps up. A refresh asked Firefox for two session values per tab
  and refreshed on most tab events, so a few hundred tabs meant hundreds of
  round trips before anything was drawn. They're remembered now. Closing a tab
  drops its row at once instead of after that refresh, and pinging other
  extensions for badges no longer holds up the tab list.
- Cmd/Ctrl+T works while the command bar is loading the page you just asked
  for. Firefox reports a tab's new address only once the page commits, so until
  then the tab still looked like the command bar and the shortcut returned to it.
- Searching inside a site (Tab in the command bar) shows its loading row; the
  message saying so went out under a name nothing listened for.

## 0.6.4

- The window drags by its title bar again. Firefox builds a window's drag
  region from what the strip paints, and Arc's strip was fully transparent, so
  there was nothing to grab. It also now spans the sidebar's width (minus the
  nav buttons) instead of a fixed 150px. Needs the setup script re-run, or
  chrome/userChrome.css copied again, and a restart.

## 0.6.3

- Dragging a tab out of the window and dropping it on the desktop opens it in a
  new window, carrying the tab itself rather than reopening its URL. Cancelling
  a drag leaves the tab alone.
- Cmd/Ctrl+W closes faster. Arc asked Firefox three separate questions before
  removing the tab; it now asks one. The sidebar also holds the background page
  awake, so the first press after an idle spell no longer waits for it to start.

## 0.6.2

- Tab on a site in the command bar searches inside it instead of opening it:
  the site becomes a chip and what you type next is searched there, with the
  site's own engine when Firefox knows one. Backspace clears the chip.
- The command bar and the sidebar's address bar keep to the space's container.
  Firefox's history is one list for the whole profile and records no container,
  so Arc notes where it saw each page; pages it never saw stay visible
  everywhere.
- Right-clicking a tab offers "Close N Tabs Above" and "Close N Tabs Below",
  counted in the order the sidebar shows, within that space.
- Cmd+T works while a tab is loading. The command bar Arc had just sent
  somewhere still counted as the command bar, so the shortcut returned to it
  instead of opening a new one.

## 0.6.1

- Tabs in a space you're not looking at unload after 5 minutes instead of 45.
  They're off screen either way, and they were most of a window's memory.
- Cmd/Ctrl+Enter in the sidebar's address bar opens a new tab instead of taking
  over the one you're on.
- A space's container takes the space's name and color, so Firefox's container
  menus read the same as Arc's footer. Containers Arc made for imported spaces
  are picked up on update; containers you made yourself are left alone.

## 0.6.0

- Arc no longer has its own hide/show shortcut. Hiding is Firefox's sidebar
  toggle now — the toolbar button, View → Sidebar, or its shortcut — and the
  extensions row hides with it. Arc's own hide mode was stored per window and
  survived restarts, so a window could come back hidden with no visible way
  out; that state is gone.

- The setup turns on Firefox's Picture-in-Picture on tab switch, so a playing
  video pops out when you leave its tab and returns when you come back, the way
  Arc does. Firefox has this built in; some profiles ship with it off.

- Dragging a tab above the list drops it at the top. The strip with the divider
  and "New Tab · Clear" accepted nothing, so the line stayed on screen while the
  drop was refused.

## 0.5.1

- Tabs nobody has looked at for 45 minutes are unloaded, and load again when
  clicked. A space's tabs stay in memory while the space is hidden, so a window
  was holding every tab of every space at once. Tabs playing audio, tabs in
  private windows and the tab you're on are left alone.

## 0.5.0

- Badge icons other extensions set (like Tab Driver's robot) sit between the
  favicon or sound icon and the title, and look like the sound button instead
  of taking the space's color. A pulsing icon shows a small blinking green dot
  instead of blinking itself. (0.4.9 was meant to carry this and shipped an
  older build by mistake.)

## 0.4.9

- Badge icons other extensions set (like Tab Driver's robot) sit between the
  favicon or sound icon and the title, and look like the sound button instead
  of taking the space's color. A pulsing icon shows a small blinking green dot
  instead of blinking itself.

## 0.4.8

- Other extensions can add items to the sidebar's tab menu, the same way they
  set badges: up to five, optionally limited to certain tabs, with clicks sent
  back to the extension that added them.

## 0.4.7

- Favorites stay four across at the usual sidebar width, and gain a column
  roughly every 64px as the sidebar is dragged wider, instead of the tiles
  growing with it.
- Tab badges other extensions set can be an icon (bot, sparkles), sit at the
  start of the row, or pulse.

## 0.4.6

Run the setup script again for the layout ones: they live in the profile, not
in the add-on.

- Lucide icons throughout. The sound indicator is a speaker glyph in a chip
  next to the favicon, where Arc puts it, instead of an emoji at the end of
  the row.
- The line above the tab list runs the full width when "New Tab · Clear" is
  hidden, instead of stopping short at invisible labels.

- The sidebar can be dragged to any width, for real this time. Three things
  were breaking it: an older copy of the stylesheet left in the profile by a
  manual install, a display override that replaced the splitter's own frame,
  and the marker Arc writes into the window title — a window that had ever
  been hidden with Option+Shift+S lost its resize handle without looking
  hidden. Option+Shift+S was broken by the same mismatch and works again.
- Firefox keeps the width the sidebar is dragged to. It was pinned in
  user.js, which is applied at every start, so it reset on every launch.
- The setup leaves symlinked files alone and says so when it finds an Arc
  stylesheet outside the block it manages.
- Thinner scrollbars in the tab and pinned lists (this one is in the add-on).

## 0.4.5

- Arrow keys in the command bar keep working when the mouse is resting over a
  row: moving the selection re-rendered the list under the cursor, and the
  fresh row's hover dragged the selection straight back.
- The arrows, Enter and Tab listen on the page, so they still work after a
  click moved focus off the search field.

## 0.4.4

- The add-on is called Arcsidebar.

## 0.4.3

- Requires Firefox 155 or newer, and no longer offers itself to Firefox for
  Android, which has no sidebar for it to live in.
- The setup scripts ship from the repository instead of inside the add-on.

## 0.4.2

- The sidebar can be dragged to any width between 180 and 620px, and Firefox
  remembers it. The favorites grid reflows to match.
- Firefox's own sidebar panels (history, bookmarks, synced tabs, AI chat) keep
  their header, share Arcsidebar's width and sit on its background.
- The command bar shows where a tab is headed the moment you press Enter, and
  warms up the connection to the highlighted result while you read the list.
- New tabs paint the space's color on their first frame; the sidebar no longer
  flashes its empty state; a tab's favicon survives navigation.

## 0.4.0

- Arcsidebar takes over Cmd/Ctrl+T and Cmd/Ctrl+W. The command bar opens with
  no flash from Firefox's own new tab, and a space keeps its last command bar
  instead of emptying. The setup clears both reserved keys in customKeys.json.
- Tabs opened from a link show as loading instead of "New Tab".
- "New Tab" sits next to "Clear" above the tab list.
