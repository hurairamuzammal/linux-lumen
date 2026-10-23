#!/usr/bin/env python3
"""Lumen — GTK window that hosts the wellbeing UI. Runs only when opened."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("WebKit", "6.0")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk, WebKit  # noqa: E402

# Allow running from the source tree or from an install prefix.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import lumen_store as store  # noqa: E402


def web_root() -> Path:
    env = os.environ.get("LUMEN_WEB")
    if env:
        return Path(env)
    cand = _HERE / "web" / "index.html"
    if cand.is_file():
        return _HERE / "web"
    return Path("/usr/local/share/lumen/web")


def apply_theme(name: str) -> None:
    mgr = Adw.StyleManager.get_default()
    table = {
        "light": Adw.ColorScheme.FORCE_LIGHT,
        "dark": Adw.ColorScheme.FORCE_DARK,
        "system": Adw.ColorScheme.DEFAULT,
    }
    mgr.set_color_scheme(table.get(name, Adw.ColorScheme.DEFAULT))


def _rgba(hex_color: str) -> Gdk.RGBA:
    c = Gdk.RGBA()
    c.parse(hex_color)
    return c


_THEME_BOOT = """
(function () {
  var dark = __DARK__;
  try {
    var t = localStorage.getItem("lumen-theme");
    if (t === "dark") dark = true;
    else if (t === "light") dark = false;
  } catch (e) {}
  window.__lumenDark = !!dark;
  var orig = window.matchMedia.bind(window);
  window.matchMedia = function (q) {
    q = String(q || "");
    if (q.indexOf("prefers-color-scheme") !== -1) {
      var isDark = !!window.__lumenDark;
      var matches = q.indexOf("dark") !== -1 ? isDark : !isDark;
      return {
        matches: matches,
        media: q,
        onchange: null,
        addListener: function () {},
        removeListener: function () {},
        addEventListener: function () {},
        removeEventListener: function () {},
        dispatchEvent: function () { return false; }
      };
    }
    return orig(q);
  };
})();
"""


def _theme_is_dark(theme: str) -> bool:
    return theme == "dark" or (theme == "system" and store.system_prefers_dark())


def theme_boot_script(theme: str) -> WebKit.UserScript:
    src = _THEME_BOOT.replace("__DARK__", "true" if _theme_is_dark(theme) else "false")
    return WebKit.UserScript.new(
        src,
        WebKit.UserContentInjectedFrames.TOP_FRAME,
        WebKit.UserScriptInjectionTime.START,
        None,
        None,
    )


class LumenApp(Adw.Application):
    def __init__(self) -> None:
        super().__init__(
            application_id="org.lumen.Wellbeing",
            flags=Gio.ApplicationFlags.FLAGS_NONE,
        )
        self.win: Adw.ApplicationWindow | None = None
        self.view: WebKit.WebView | None = None
        self._ready = False
        self._css = Gtk.CssProvider()
        self._pause_btn: Gtk.Button | None = None
        self._menu_btn: Gtk.MenuButton | None = None
        self._iface: Gio.Settings | None = None

    def do_activate(self) -> None:  # noqa: N802
        if self.win:
            self.win.present()
            return
        theme = store.load_ui_conf().get("theme") or "system"
        apply_theme(theme)
        self.win = Adw.ApplicationWindow(application=self)
        self.win.set_title("Lumen")
        self.win.set_default_size(1200, 800)
        self.win.set_icon_name("org.lumen.Wellbeing")
        self.win.add_css_class("lumen-win")
        self.win.set_decorated(True)
        self.win.set_resizable(True)

        manager = WebKit.UserContentManager()
        try:
            manager.register_script_message_handler("lumen")
        except TypeError:
            manager.register_script_message_handler("lumen", None)
        manager.connect("script-message-received::lumen", self._on_js)
        manager.connect("script-message-received", self._on_js)
        manager.add_script(theme_boot_script(theme))

        settings = WebKit.Settings()
        settings.set_enable_javascript(True)
        settings.set_allow_file_access_from_file_urls(True)
        settings.set_allow_universal_access_from_file_urls(False)
        settings.set_enable_write_console_messages_to_stdout(False)
        try:
            settings.set_enable_developer_extras(False)
        except Exception:
            pass

        self.view = WebKit.WebView(user_content_manager=manager)
        self.view.set_settings(settings)
        self.view.connect("load-changed", self._on_load)
        self.view.connect("decide-policy", self._on_decide_policy)
        self.view.set_vexpand(True)
        self.view.set_hexpand(True)
        self._paint_webview_bg(theme)

        header = Adw.HeaderBar()
        header.add_css_class("flat")
        header.set_show_start_title_buttons(False)
        header.set_show_end_title_buttons(True)
        header.set_decoration_layout(":minimize,maximize,close")
        title = Gtk.Label(label="Lumen")
        title.add_css_class("title")
        header.set_title_widget(title)
        header.pack_end(self._make_menu())

        toolbar = Adw.ToolbarView()
        toolbar.add_top_bar(header)
        toolbar.set_content(self.view)
        self.win.set_content(toolbar)

        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            self._css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )
        self._apply_shell_css(theme)
        try:
            self._iface = Gio.Settings.new("org.gnome.desktop.interface")
            self._iface.connect("changed", self._on_iface_changed)
        except Exception:
            self._iface = None

        html = web_root() / "index.html"
        self.view.load_uri(html.resolve().as_uri())
        self.win.present()
        GLib.timeout_add_seconds(60, self._poll)

    def _make_menu(self) -> Gtk.MenuButton:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        box.set_margin_top(8)
        box.set_margin_bottom(8)
        box.set_margin_start(8)
        box.set_margin_end(8)

        def row(label: str, fn) -> Gtk.Button:
            b = Gtk.Button(label=label)
            b.set_halign(Gtk.Align.FILL)
            b.add_css_class("flat")
            b.add_css_class("lumen-menu-item")
            b.connect("clicked", lambda *_: (self._popdown(), fn()))
            box.append(b)
            return b

        self._pause_btn = row("Pause tracking", self._toggle_pause)
        row("Light", lambda: self._set_theme("light"))
        row("Dark", lambda: self._set_theme("dark"))
        row("System", lambda: self._set_theme("system"))
        row("Settings", lambda: self._eval('window.Lumen && window.Lumen.go("profile")'))
        row("Open data folder", lambda: self._handle({"op": "open-data"}))

        pop = Gtk.Popover()
        pop.set_child(box)
        btn = Gtk.MenuButton(icon_name="open-menu-symbolic")
        btn.set_tooltip_text("Menu")
        btn.set_popover(pop)
        self._menu_btn = btn
        return btn

    def _popdown(self) -> None:
        if self._menu_btn:
            pop = self._menu_btn.get_popover()
            if pop:
                pop.popdown()

    def _toggle_pause(self) -> None:
        conf = store.load_collector_conf()
        paused = not bool(conf.get("paused"))
        store.set_tracking_paused(paused)
        self.push_state()

    def _set_theme(self, theme: str) -> None:
        conf = store.load_ui_conf()
        conf["theme"] = theme
        store.save_ui_conf(conf)
        apply_theme(theme)
        self._paint_webview_bg(theme)
        self._apply_shell_css(theme)
        self.push_state()

    def _on_iface_changed(self, _settings, key: str) -> None:
        if key not in ("gtk-theme", "color-scheme"):
            return
        theme = store.load_ui_conf().get("theme") or "system"
        self._paint_webview_bg(theme)
        self._apply_shell_css(theme)
        self.push_state()

    def _apply_shell_css(self, theme: str) -> None:
        dark = _theme_is_dark(theme)
        colors = store.system_colors(dark)
        bg = colors.get("window") or ("#2c281d" if dark else "#f6f5ea")
        ink = colors.get("fg") or ("#fce8ad" if dark else "#565014")
        css = f"""
        window.lumen-win {{ background: {bg}; }}
        .lumen-win headerbar {{
            background: {bg};
            color: {ink};
            box-shadow: none;
            border: none;
            min-height: 42px;
        }}
        .lumen-win headerbar:backdrop {{
            background: {bg};
            box-shadow: none;
        }}
        .lumen-win .lumen-menu-item {{
            padding: 8px 12px;
            min-width: 180px;
        }}
        """
        self._css.load_from_data(css.encode("utf-8"))

    def _paint_webview_bg(self, theme: str) -> None:
        if not self.view:
            return
        dark = _theme_is_dark(theme)
        colors = store.system_colors(dark)
        bg = colors.get("window") or ("#14181d" if dark else "#eef1f4")
        self.view.set_background_color(_rgba(bg))
        if not self._ready:
            return
        flag = "true" if dark else "false"
        accent = json.dumps(colors)
        self._eval(
            f"window.__lumenDark={flag};"
            "if(document.documentElement){"
            f"document.documentElement.setAttribute('data-theme','{'dark' if dark else 'light'}');"
            f"document.documentElement.style.colorScheme='{'dark' if dark else 'light'}';"
            "}"
            f"window.Lumen && window.applyAccent && window.applyAccent({accent});"
        )

    def _on_load(self, _view, event) -> None:
        if event == WebKit.LoadEvent.FINISHED:
            self._ready = True
            self.push_state()

    def _on_decide_policy(self, _view, decision, decision_type) -> bool:
        try:
            if decision_type in (
                WebKit.PolicyDecisionType.NAVIGATION_ACTION,
                WebKit.PolicyDecisionType.NEW_WINDOW_ACTION,
            ):
                action = decision.get_navigation_action()
                req = action.get_request() if action else None
                uri = (req.get_uri() if req else "") or ""
                allowed = (web_root() / "index.html").resolve().as_uri()
                if uri and not uri.startswith(allowed):
                    decision.ignore()
                    return True
        except Exception:
            pass
        return False

    def _js_payload(self, *args) -> str:
        for arg in args:
            if arg is None or arg in (self,):
                continue
            if isinstance(arg, str):
                return arg
            for meth in ("to_json", "to_string", "to_string_as_bytes"):
                fn = getattr(arg, meth, None)
                if not fn:
                    continue
                try:
                    if meth == "to_json":
                        return fn(0)
                    val = fn()
                    if isinstance(val, bytes):
                        return val.decode("utf-8", "replace")
                    return str(val)
                except Exception:
                    continue
            js = getattr(arg, "get_js_value", None)
            if js:
                try:
                    return self._js_payload(js())
                except Exception:
                    pass
        return ""

    def _on_js(self, *args) -> None:
        raw = self._js_payload(*args).strip()
        if not raw:
            return
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            try:
                msg = json.loads(raw.encode("utf-8").decode("unicode_escape"))
            except json.JSONDecodeError:
                return
        if not isinstance(msg, dict):
            return
        self._handle(msg)

    def _handle(self, msg: dict) -> None:
        op = msg.get("op")
        if op in (None, "refresh", "home"):
            self.push_state()
            return
        if op == "theme":
            theme = str(msg.get("theme") or "system")
            if theme not in ("light", "dark", "system"):
                theme = "system"
            conf = store.load_ui_conf()
            conf["theme"] = theme
            store.save_ui_conf(conf)
            apply_theme(theme)
            self._paint_webview_bg(theme)
            self._apply_shell_css(theme)
            self.push_state()
            return
        if op == "pause":
            store.set_tracking_paused(bool(msg.get("paused")))
            self.push_state()
            return
        if op == "config":
            patch = {}
            if "idle_sec" in msg:
                try:
                    patch["idle_sec"] = max(30, min(3600, int(msg["idle_sec"])))
                except (TypeError, ValueError):
                    pass
            if "poll_sec" in msg:
                try:
                    patch["poll_sec"] = max(3, min(60, int(msg["poll_sec"])))
                except (TypeError, ValueError):
                    pass
            if patch:
                store.save_collector_conf(patch)
            if "display_name" in msg:
                conf = store.load_ui_conf()
                conf["display_name"] = str(msg["display_name"]).strip()[:40]
                store.save_ui_conf(conf)
            if "theme" in msg:
                theme = str(msg["theme"])
                if theme not in ("light", "dark", "system"):
                    theme = "system"
                conf = store.load_ui_conf()
                conf["theme"] = theme
                store.save_ui_conf(conf)
                apply_theme(theme)
                self._paint_webview_bg(theme)
                self._apply_shell_css(theme)
            self.push_state()
            return
        if op == "app":
            detail = store.app_detail(str(msg.get("app") or ""))
            self._eval(f"window.Lumen && window.Lumen.appDetail({json.dumps(detail)})")
            return
        if op == "day":
            detail = store.day_detail(str(msg.get("day") or ""))
            self._eval(f"window.Lumen && window.Lumen.dayDetail({json.dumps(detail)})")
            return
        if op == "calendar":
            try:
                year = int(msg.get("year") or 0)
                month = int(msg.get("month") or 0)
            except (TypeError, ValueError):
                year = month = 0
            if year < 2000 or month < 1 or month > 12:
                today = __import__("datetime").date.today()
                year, month = today.year, today.month
            grid = store.month_grid(year, month)
            self._eval(f"window.Lumen && window.Lumen.calendarData({json.dumps(grid)})")
            return
        if op == "open-data":
            path = store.data_dir()
            path.mkdir(parents=True, exist_ok=True)
            Gio.AppInfo.launch_default_for_uri(path.as_uri(), None)
            return

    def push_state(self, quiet: bool = False) -> None:
        if not self._ready or not self.view:
            return
        try:
            payload = store.build_state()
        except Exception as exc:
            payload = {"ok": False, "error": str(exc)}
        flag = "true" if quiet else "false"
        self._eval(f"window.Lumen && window.Lumen.push({json.dumps(payload)}, {flag})")
        if self._pause_btn:
            paused = bool((payload.get("config") or {}).get("paused")) if isinstance(payload, dict) else False
            self._pause_btn.set_label("Resume tracking" if paused else "Pause tracking")

    def _eval(self, script: str) -> None:
        if not self.view:
            return
        try:
            self.view.evaluate_javascript(script, -1, None, None, None, None)
        except TypeError:
            try:
                self.view.evaluate_javascript(script, -1, None, None, None, None, None)
            except TypeError:
                self.view.run_javascript(script, None, None, None)

    def _poll(self) -> bool:
        if self.win and self.win.is_visible():
            self.push_state(quiet=True)
        return True


def main() -> int:
    Adw.init()
    app = LumenApp()
    return app.run(sys.argv)


if __name__ == "__main__":
    sys.exit(main())
