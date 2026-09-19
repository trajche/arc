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
// Fallback when there is no session to restore: ArcFox panel open, launcher hidden.
user_pref("sidebar.backupState", "{\"command\":\"arc_sidebar-sidebar-action\",\"panelOpen\":true,\"panelWidth\":260,\"launcherVisible\":false,\"launcherExpanded\":false}");
