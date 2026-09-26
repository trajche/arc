# Changelog

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
