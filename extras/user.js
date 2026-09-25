// ArcFox: copy into your Firefox profile folder (next to prefs.js).
// Firefox applies these on every start.

// Load chrome/userChrome.css.
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
// Horizontal tabs (their strip is hidden; ArcFox lists the tabs).
user_pref("sidebar.verticalTabs", false);
// Closing the last tab keeps the window (with a new tab), like Arc.
user_pref("browser.tabs.closeWindowWithLastTab", false);
// Reopen windows and tabs, including the open ArcFox sidebar.
user_pref("browser.startup.page", 3);
// Arc's panel state (open, and how wide) lives in sidebar.backupState, which
// Firefox writes itself. The setup seeds it once in prefs.js instead of here:
// a user_pref would be re-applied at every start, throwing away a width the
// sidebar had been dragged to.
