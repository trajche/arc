# Changelog

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
