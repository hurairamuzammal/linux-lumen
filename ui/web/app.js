if (typeof CanvasRenderingContext2D !== "undefined" && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) {
    this.rect(x, y, w, h);
  };
}

const Lumen = {
  data: null,
  view: "home",
  q: "",
  selected: null,
  day: null,
  calOverride: null,
  _pendingTheme: null,
  _motion: false,
  _forceMotion: true,
  push(data) {
    if (this.calOverride && data && data.calendar) {
      const same =
        this.calOverride.year === data.calendar.year &&
        this.calOverride.month_n === data.calendar.month_n;
      if (same) this.calOverride = data.calendar;
      else data.calendar = this.calOverride;
    }
    if (this._pendingTheme) {
      if (data.theme === this._pendingTheme) this._pendingTheme = null;
      else data.theme = this._pendingTheme;
    } else {
      try {
        localStorage.setItem("lumen-theme", data.theme || "system");
      } catch (_) {}
    }
    this.data = data;
    applyTheme(data.theme || "system", data.system_dark, data.accent);
    this._motion = this._forceMotion;
    this._forceMotion = false;
    this.render();
  },
  go(view) {
    this.view = view;
    this.selected = null;
    this._forceMotion = true;
    syncNav(view === "app" ? "apps" : view);
    this.render();
  },
  appDetail(detail) {
    this.selected = detail;
    this.view = "app";
    this._forceMotion = true;
    syncNav("apps");
    this.render();
  },
  dayDetail(detail) {
    if (!detail || !detail.ok) {
      openSheet(`
        <div class="cal-head">
          <h2>Day</h2>
          <button class="cal-close" type="button" data-close-sheet>Close</button>
        </div>
        <p class="note">That day is not available.</p>`);
      return;
    }
    this.day = detail;
    openSheet(viewDaySheet(detail));
    requestAnimationFrame(() => {
      const c = document.querySelector("#sheet canvas[data-chart]");
      if (c && detail.hourly && detail.detailed) paintHourly(c, detail.hourly, false);
    });
  },
  calendarData(grid) {
    this.calOverride = grid;
    if (this.data) this.data.calendar = grid;
    this._forceMotion = true;
    if (this.view === "months") this.render();
  },
  render() {
    const stage = document.getElementById("stage");
    if (!this.data || !this.data.ok) {
      stage.classList.remove("is-enter");
      stage.innerHTML = `<div class="empty"><strong>Waiting on the collector</strong>It records in the background. Open Lumen again in a minute.</div>`;
      return;
    }
    const d = this.data;
    if (this.view === "home") stage.innerHTML = viewHome(d, this.q);
    else if (this.view === "activity") stage.innerHTML = viewActivity(d);
    else if (this.view === "apps") stage.innerHTML = viewApps(d, this.q);
    else if (this.view === "battery") stage.innerHTML = viewBattery(d);
    else if (this.view === "months") stage.innerHTML = viewMonths(d);
    else if (this.view === "profile") stage.innerHTML = viewProfile(d);
    else if (this.view === "app") stage.innerHTML = viewApp(this.selected, d);
    stage.classList.toggle("is-enter", !!this._motion);
    paintCanvases(d);
    bindStage();
  },
};

function send(payload) {
  const s = JSON.stringify(payload);
  try {
    window.webkit.messageHandlers.lumen.postMessage(s);
  } catch (_) {}
}

function applyTheme(theme, systemDark, accent) {
  let dark;
  if (theme === "dark") dark = true;
  else if (theme === "light") dark = false;
  else if (typeof systemDark === "boolean") dark = systemDark;
  else dark = !!(window.__lumenDark || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches));
  window.__lumenDark = dark;
  const root = document.documentElement;
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.style.colorScheme = dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", dark ? "dark" : "light");
  applyAccent(accent || (Lumen.data && Lumen.data.accent));
}

function applyAccent(a) {
  if (!a) return;
  const s = document.documentElement.style;
  if (a.window) s.setProperty("--bg", a.window);
  if (a.fg) {
    s.setProperty("--ink", a.fg);
    s.setProperty("--sage-ink", a.fg);
  }
  if (a.accent) {
    s.setProperty("--sage", a.accent);
    s.setProperty("--accent", a.accent);
  }
  if (a.rgb && a.rgb.length === 3) s.setProperty("--accent-rgb", a.rgb.join(", "));
}

function commitTheme(theme) {
  Lumen._pendingTheme = theme;
  try {
    localStorage.setItem("lumen-theme", theme);
  } catch (_) {}
  if (Lumen.data) Lumen.data.theme = theme;
  applyTheme(theme, Lumen.data && Lumen.data.system_dark, Lumen.data && Lumen.data.accent);
  send({ op: "theme", theme });
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  if (m) return `${m}m`;
  return sec ? `${sec}s` : "0m";
}

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtRam(kb) {
  if (!kb) return "—";
  if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb > 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
}

function initial(name) {
  return (name || "?").trim().charAt(0).toUpperCase();
}

function appIconHtml(a) {
  const label = (a && (a.label || a.app)) || "?";
  if (a && a.icon) return `<div class="app-ico"><img src="${a.icon}" alt=""></div>`;
  return `<div class="app-ico">${escapeHtml(initial(label))}</div>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function filterApps(apps, q) {
  if (!q) return apps || [];
  const n = q.toLowerCase();
  return (apps || []).filter((a) => (a.label || a.app).toLowerCase().includes(n));
}

function reportLine(d) {
  const r = d.report;
  if (!r) return "";
  if (r.is_sunday) {
    return `<p class="note"><button type="button" data-open-report>${escapeHtml(r.message)}</button></p>`;
  }
  return "";
}

function viewReportSheet(d) {
  const r = d.report || {};
  const cur = r.current || {};
  const prev = r.previous || {};
  const apps = (cur.apps || [])
    .map(
      (a) => `<button class="row" data-app="${escapeHtml(a.app)}" type="button">
        ${appIconHtml(a)}
        <div class="app-name">${escapeHtml(a.label)}</div>
        <div class="num">${fmtDur(a.sec)}</div>
      </button>`
    )
    .join("");
  return `
    <div class="cal-head">
      <h2>Sunday letter</h2>
      <button class="cal-close" type="button" data-close-sheet>Close</button>
    </div>
    <p class="note">${escapeHtml(r.message || "")}</p>
    <div class="sheet-kpis">
      <div>On screen<strong>${fmtDur(cur.active)}</strong></div>
      <div>Last week<strong>${fmtDur(prev.active)}</strong></div>
      <div>Idle<strong>${fmtDur(cur.idle)}</strong></div>
      <div>Led by<strong>${escapeHtml(cur.top_label || "—")}</strong></div>
    </div>
    <h3>Most used</h3>
    <div class="rows">${apps || `<div class="empty">No app slices this week yet.</div>`}</div>`;
}

function viewDaySheet(d) {
  if (!d || !d.ok) {
    return `<div class="cal-head"><h2>Day</h2><button class="cal-close" type="button" data-close-sheet>Close</button></div><p class="note">Could not open that day.</p>`;
  }
  const t = d.totals || {};
  const apps = (d.apps || [])
    .map(
      (a) => `<button class="row" data-app="${escapeHtml(a.app)}" type="button">
        ${appIconHtml(a)}
        <div class="app-name">${escapeHtml(a.label)}</div>
        <div class="num">${fmtDur(a.sec)}</div>
      </button>`
    )
    .join("");
  const chart = d.detailed
    ? `<div class="chart-wrap"><canvas data-chart="dayhour"></canvas></div>`
    : `<p class="note">${d.recent ? "No slices written for this day yet." : "Full hourly detail is kept for 7 days. This day has totals only."}</p>`;
  return `
    <div class="cal-head">
      <h2>${escapeHtml(d.label)}</h2>
      <button class="cal-close" type="button" data-close-sheet>Close</button>
    </div>
    ${d.empty ? `<p class="note">No session recorded.</p>` : ""}
    <div class="sheet-kpis">
      <div>Active<strong>${fmtDur(t.active)}</strong></div>
      <div>Idle<strong>${fmtDur(t.idle)}</strong></div>
      <div>Lock<strong>${fmtDur(t.lock)}</strong></div>
      <div>Sleep<strong>${fmtDur(t.sleep)}</strong></div>
    </div>
    ${chart}
    <h3>Apps</h3>
    <div class="rows">${apps || `<div class="empty">Nothing recorded.</div>`}</div>`;
}

function viewHome(d, q) {
  const s = d.stats || {};
  const apps = filterApps(d.apps, q).slice(0, 2);
  const rows = apps.length
    ? apps
        .map(
          (a) => `<button class="row" data-app="${escapeHtml(a.app)}" type="button">
        ${appIconHtml(a)}
        <div class="app-name">${escapeHtml(a.label)}</div>
        <div class="num">${fmtDur(a.sec)}</div>
      </button>`
        )
        .join("")
    : `<div class="empty"><strong>No apps yet</strong>Use the machine for a bit.</div>`;
  return `
    <div class="hero">
      <h1>${escapeHtml(d.greet)}, ${escapeHtml(d.display_name)}</h1>
      <div class="fig">${fmtDur(s.active)}</div>
    </div>
    <p class="note">On screen today · idle ${fmtDur(s.idle)} · first wake ${fmtTime(s.first_boot)}</p>
    ${reportLine(d)}
    <div class="chart-hero"><canvas data-chart="hourly"></canvas></div>
    <div class="rows">${rows}</div>`;
}

function viewActivity(d) {
  const week = d.week || [];
  const total = week.reduce((n, w) => n + (w.totals.active || 0), 0);
  const used = week.filter((w) => w.totals.active).length || 1;
  return `
    <div class="hero">
      <h1>This week</h1>
      <div class="fig">${fmtDur(total)}</div>
    </div>
    <p class="note">Average day ${fmtDur(total / used)} · idle ${fmtDur(week.reduce((n, w) => n + (w.totals.idle || 0), 0))}</p>
    ${reportLine(d)}
    <div class="chart-hero"><canvas data-chart="week"></canvas></div>
    <p class="legend"><span><i class="sage"></i>Active</span><span><i class="peach"></i>Idle</span><span><i class="lilac"></i>Lock</span></p>`;
}

function viewApps(d, q) {
  const apps = filterApps(d.apps, q);
  const weekTotals = {};
  for (const w of d.week || []) {
    for (const a of w.apps || []) weekTotals[a.app] = (weekTotals[a.app] || 0) + a.sec;
  }
  const max = Math.max(1, ...apps.map((a) => a.sec));
  const rows = apps
    .map((a) => {
      const wk = weekTotals[a.app] || a.sec;
      return `<button class="row wide" data-app="${escapeHtml(a.app)}" type="button">
        ${appIconHtml(a)}
        <div><div class="app-name">${escapeHtml(a.label)}</div><div class="app-sub">Week ${fmtDur(wk)}</div></div>
        <div class="bar"><i style="width:${Math.max(6, (a.sec / max) * 100)}%"></i></div>
        <div class="num">${fmtDur(a.sec)}</div>
      </button>`;
    })
    .join("");
  return `
    <div class="hero"><h1>Apps</h1></div>
    <label class="search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16.5 16.5 21 21"/></svg>
      <input id="q" type="search" placeholder="Find an app" value="${escapeHtml(q)}" autocomplete="off">
    </label>
    <div class="rows">${rows || `<div class="empty"><strong>Nothing here yet</strong></div>`}</div>`;
}

function viewBattery(d) {
  const today = (d.week || []).find((w) => w.day === d.today) || {};
  const last = (today.battery || []).slice(-1)[0];
  const pct = d.stats.battery == null ? "—" : d.stats.battery + "%";
  return `
    <div class="hero">
      <h1>Battery</h1>
      <div class="fig">${pct}</div>
    </div>
    <p class="note">${escapeHtml((d.stats.battery_status || "").replace("-", " "))}${last ? " · " + fmtTime(last.ts) : ""}</p>
    <div class="chart-hero"><canvas data-chart="battery"></canvas></div>`;
}

function viewMonths(d) {
  const cal = d.calendar || {};
  const weeks = cal.weeks || [];
  const max = Math.max(1, cal.max_active || 1);
  const now = new Date();
  const atEdge =
    cal.year > now.getFullYear() ||
    (cal.year === now.getFullYear() && cal.month_n >= now.getMonth() + 1);
  const cells = weeks
    .flat()
    .map((cell) => {
      if (!cell) return `<span class="cal-cell is-blank" aria-hidden="true"></span>`;
      if (cell.future) {
        return `<button class="cal-cell" disabled type="button" aria-label="${escapeHtml(cell.ymd)}"><span class="d">${cell.d}</span></button>`;
      }
      const t = cell.active / max;
      const bg = cell.active ? `background:rgba(var(--accent-rgb), ${(0.2 + t * 0.55).toFixed(2)})` : "";
      const cls = [
        "cal-cell",
        cell.is_today ? "is-today" : "",
        cell.active ? "has-use" : "",
        cell.recent ? "is-recent" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const tip = cell.active ? `${cell.ymd} · ${fmtDur(cell.active)}` : cell.ymd;
      return `<button class="${cls}" type="button" data-day="${escapeHtml(cell.ymd)}" style="${bg}" title="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">
        <span class="d">${cell.d}</span>
      </button>`;
    })
    .join("");
  const m = cal.totals || {};
  const top = (m.top_apps || []).slice(0, 2);
  const apps = top.length
    ? top
        .map(
          (a) => `<button class="row" data-app="${escapeHtml(a.app)}" type="button">
        ${appIconHtml(a)}
        <div class="app-name">${escapeHtml(a.label)}</div>
        <div class="num">${fmtDur(a.sec)}</div>
      </button>`
        )
        .join("")
    : `<div class="empty"><strong>No apps this month</strong></div>`;
  return `
    <div class="hero">
      <h1>${escapeHtml(cal.label || "Month")}</h1>
      <div class="fig">${fmtDur(m.active)}</div>
    </div>
    <p class="note">Tap a day for its apps and hours. Full detail is kept for 7 days.</p>
    <div class="month-split">
      <div class="cal-mini">
        <div class="cal-head">
          <h2></h2>
          <div class="cal-nav">
            <button type="button" data-cal="-1">←</button>
            <button type="button" data-cal="1"${atEdge ? " disabled" : ""}>→</button>
          </div>
        </div>
        <div class="cal-dow"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
        <div class="cal-grid">${cells}</div>
      </div>
      <div class="rows">${apps}</div>
    </div>`;
}

function viewProfile(d) {
  const c = d.config || {};
  const col = d.collector || {};
  const theme = d.theme || "system";
  return `
    <div class="hero"><h1>Settings</h1></div>
    <p class="note">${escapeHtml((d.profile && d.profile.host) || "")} · ${col.alive ? "recording" : "collector off"}</p>
    <div class="form">
      <div class="field">
        <label for="displayName">Display name</label>
        <input id="displayName" value="${escapeHtml(d.display_name)}" maxlength="40">
      </div>
      <div class="field">
        <label>Appearance</label>
        <div class="seg" id="themeSeg">
          <button type="button" data-theme="light" class="${theme === "light" ? "is-on" : ""}">Light</button>
          <button type="button" data-theme="dark" class="${theme === "dark" ? "is-on" : ""}">Dark</button>
          <button type="button" data-theme="system" class="${theme === "system" ? "is-on" : ""}">System</button>
        </div>
      </div>
      <div class="field">
        <label for="idleSec">Idle after (seconds)</label>
        <input id="idleSec" type="number" min="30" max="3600" value="${c.idle_sec || 180}">
      </div>
      <button class="cta" id="saveProfile" type="button">Save</button>
    </div>
    <p class="note" style="margin-top:28px">PID ${col.pid || "—"} · ${fmtRam(col.rss_kb)} · window titles are not stored.</p>
    <button class="cta" id="openData" type="button">Open data folder</button>`;
}

function viewApp(detail) {
  if (!detail || !detail.ok) {
    return `<div class="empty"><strong>Pick an app</strong></div>`;
  }
  return `
    <button class="back" data-back="apps" type="button">Apps</button>
    <div class="hero">
      <h1>${appIconHtml(detail)} ${escapeHtml(detail.label)}</h1>
      <div class="fig">${fmtDur(detail.week_sec)}</div>
    </div>
    <p class="note">Daily average ${fmtDur(detail.avg_sec)} · ${detail.days_used} of 7 days · peak ${fmtRam(detail.ram_peak)}</p>
    <div class="chart-hero"><canvas data-chart="appweek"></canvas></div>`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fitCanvas(c) {
  const r = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  c.width = Math.round(w * r);
  c.height = Math.round(h * r);
  const ctx = c.getContext("2d");
  ctx.setTransform(r, 0, 0, r, 0, 0);
  return { ctx, w, h };
}

function paintCanvases(d) {
  document.querySelectorAll("#stage canvas[data-chart]").forEach((c) => {
    const kind = c.dataset.chart;
    if (kind === "hourly") paintHourly(c, d.hourly || [], false);
    if (kind === "week") paintWeek(c, d.week || []);
    if (kind === "battery") {
      const today = (d.week || []).find((w) => w.day === d.today);
      paintBattery(c, (today && today.battery) || []);
    }
    if (kind === "appweek" && Lumen.selected) paintAppWeek(c, Lumen.selected.daily || []);
  });
}

function paintHourly(canvas, hourly, spark) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const sage = cssVar("--sage") || "#8fbfb4";
  const dim = cssVar("--dim") || "#7a8490";
  const max = Math.max(1, ...hourly);
  const pad = spark ? 2 : 28;
  ctx.beginPath();
  hourly.forEach((v, i) => {
    const x = pad + (i / Math.max(hourly.length - 1, 1)) * (w - pad * 2);
    const y = h - pad - (v / max) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = sage;
  ctx.lineWidth = spark ? 2 : 2.2;
  ctx.lineJoin = "round";
  ctx.stroke();
  if (!spark) {
    ctx.globalAlpha = 0.28;
    ctx.lineTo(w - pad, h - pad);
    ctx.lineTo(pad, h - pad);
    ctx.closePath();
    ctx.fillStyle = sage;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = dim;
    ctx.font = "12px Outfit, sans-serif";
    ["0", "6", "12", "18"].forEach((lab, i) => {
      const hour = i * 6;
      const x = pad + (hour / 23) * (w - pad * 2);
      ctx.fillText(lab, x, h - 8);
    });
  }
}

function paintWeek(canvas, week) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const sage = cssVar("--sage") || "#8fbfb4";
  const peach = cssVar("--peach") || "#e2b9a4";
  const lilac = cssVar("--lilac") || "#c5b3d6";
  const dim = cssVar("--dim") || "#7a8490";
  const pad = 28;
  const n = week.length || 1;
  const max = Math.max(
    1,
    ...week.map((d) => (d.totals.active || 0) + (d.totals.idle || 0) + (d.totals.lock || 0))
  );
  const gap = 10;
  const bw = (w - pad * 2) / n - gap;
  week.forEach((day, i) => {
    const x = pad + i * ((w - pad * 2) / n);
    const a = day.totals.active || 0;
    const idl = day.totals.idle || 0;
    const l = day.totals.lock || 0;
    const scale = (h - pad * 2) / max;
    let y = h - pad;
    const stack = [
      [a, sage],
      [idl, peach],
      [l, lilac],
    ];
    stack.forEach(([sec, color]) => {
      const bh = sec * scale;
      y -= bh;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, Math.max(sec ? 4 : 0, bh), 6);
      ctx.fill();
    });
    ctx.fillStyle = dim;
    ctx.font = "12px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(day.label || "", x + bw / 2, h - 8);
    ctx.textAlign = "start";
  });
}

function paintBattery(canvas, samples) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!samples.length) return;
  const pad = 28;
  const t0 = samples[0].ts;
  const t1 = samples[samples.length - 1].ts || t0 + 1;
  const sky = cssVar("--sky") || "#b4c4dc";
  const sage = cssVar("--sage") || "#8fbfb4";
  const dim = cssVar("--dim") || "#7a8490";
  ctx.beginPath();
  samples.forEach((s, i) => {
    const x = pad + ((s.ts - t0) / Math.max(t1 - t0, 1)) * (w - pad * 2);
    const y = pad + (1 - s.pct / 100) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = sky;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.globalAlpha = 0.22;
  ctx.lineTo(w - pad, h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.closePath();
  ctx.fillStyle = sky;
  ctx.fill();
  ctx.globalAlpha = 1;
  samples.forEach((s) => {
    if (s.status !== 1) return;
    const x = pad + ((s.ts - t0) / Math.max(t1 - t0, 1)) * (w - pad * 2);
    ctx.fillStyle = sage;
    ctx.globalAlpha = 0.28;
    ctx.fillRect(x, pad, 3, h - pad * 2);
    ctx.globalAlpha = 1;
  });
  ctx.strokeStyle = dim;
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.moveTo(pad, pad + 0.8 * (h - pad * 2));
  ctx.lineTo(w - pad, pad + 0.8 * (h - pad * 2));
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function paintAppWeek(canvas, daily) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const sage = cssVar("--sage") || "#8fbfb4";
  const dim = cssVar("--dim") || "#7a8490";
  const pad = 28;
  const n = daily.length || 1;
  const max = Math.max(1, ...daily.map((d) => d.sec));
  const gap = 10;
  const bw = (w - pad * 2) / n - gap;
  daily.forEach((d, i) => {
    const x = pad + i * ((w - pad * 2) / n);
    const bh = (d.sec / max) * (h - pad * 2);
    ctx.fillStyle = sage;
    ctx.globalAlpha = d.sec ? 0.9 : 0.2;
    ctx.beginPath();
    ctx.roundRect(x, h - pad - bh, bw, Math.max(4, bh), 8);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = dim;
    ctx.font = "12px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(d.label || "", x + bw / 2, h - 8);
    ctx.textAlign = "start";
  });
}

function syncNav(view) {
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("is-on", b.dataset.view === view);
  });
}

function openSheet(html) {
  document.getElementById("sheetCard").innerHTML = html;
  document.getElementById("sheet").hidden = false;
}

function closeSheet() {
  document.getElementById("sheet").hidden = true;
}

function bindStage() {
  const q = document.getElementById("q");
  if (q) {
    q.addEventListener("input", (e) => {
      Lumen.q = e.target.value.trim();
      const n = Lumen.q.toLowerCase();
      document.querySelectorAll("#stage .row[data-app]").forEach((row) => {
        const name = (row.querySelector(".app-name")?.textContent || "").toLowerCase();
        row.hidden = !!(n && !name.includes(n));
      });
    });
  }
  const save = document.getElementById("saveProfile");
  if (save) {
    save.addEventListener("click", () => {
      send({
        op: "config",
        display_name: document.getElementById("displayName").value,
        idle_sec: Number(document.getElementById("idleSec").value),
        theme: document.querySelector("#themeSeg .is-on")?.dataset.theme || "system",
      });
    });
  }
  document.querySelectorAll("#themeSeg button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#themeSeg button").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
      commitTheme(b.dataset.theme);
    });
  });
  const open = document.getElementById("openData");
  if (open) open.addEventListener("click", () => send({ op: "open-data" }));
  const back = document.querySelector("[data-back]");
  if (back) {
    back.addEventListener("click", () => Lumen.go(back.dataset.back));
  }
}

document.getElementById("nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  Lumen.go(btn.dataset.view);
});

document.getElementById("stage").addEventListener("click", (e) => {
  const calBtn = e.target.closest("[data-cal]");
  if (calBtn && !calBtn.disabled) {
    const cal = (Lumen.data && Lumen.data.calendar) || {};
    let y = cal.year;
    let m = cal.month_n + Number(calBtn.dataset.cal);
    if (!y || !m) return;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    if (m > 12) {
      m = 1;
      y += 1;
    }
    send({ op: "calendar", year: y, month: m });
    return;
  }
  const dayBtn = e.target.closest("[data-day]");
  if (dayBtn && !dayBtn.disabled && dayBtn.dataset.day) {
    send({ op: "day", day: dayBtn.dataset.day });
    return;
  }
  const app = e.target.closest("[data-app]");
  if (app && app.dataset.app) {
    send({ op: "app", app: app.dataset.app });
    return;
  }
  if (e.target.closest("[data-open-report]")) {
    openSheet(viewReportSheet(Lumen.data));
  }
});

document.getElementById("sheet").addEventListener("click", (e) => {
  if (e.target.closest("[data-close-sheet]")) {
    closeSheet();
    return;
  }
  const app = e.target.closest("[data-app]");
  if (app) {
    closeSheet();
    send({ op: "app", app: app.dataset.app });
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheet();
});

window.Lumen = Lumen;
window.applyAccent = applyAccent;
send({ op: "refresh" });
if (location.search.includes("preview")) {
  fetch("preview-data.json")
    .then((r) => r.json())
    .then((d) => Lumen.push(d))
    .catch(() => {});
}
