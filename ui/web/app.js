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
  selectedWeekDay: null,
  selectedCalDay: null,
  calDayData: {},
  _openingFullDay: false,
  calOverride: null,
  _pendingTheme: null,
  _motion: false,
  _forceMotion: true,
  _renderedView: "",
  _chartKey: "",
  push(data, quiet) {
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
    } else if (!quiet) {
      try {
        localStorage.setItem("lumen-theme", data.theme || "system");
      } catch (_) {}
    }
    const prev = this.data;
    this.data = data;
    if (data && data.week && data.week.length) {
      if (!this.selectedWeekDay || !data.week.some((w) => w.day === this.selectedWeekDay)) {
        const todayMatch = data.week.find((w) => w.day === data.today);
        this.selectedWeekDay = (todayMatch && todayMatch.day) || data.week[data.week.length - 1].day;
      }
    }
    const themeChanged =
      !prev ||
      prev.theme !== data.theme ||
      prev.system_dark !== data.system_dark;
    if (!quiet && themeChanged) applyTheme(data.theme || "system", data.system_dark, data.accent);
    const canPatch = !!(
      quiet &&
      prev &&
      prev.ok &&
      data &&
      data.ok &&
      this._renderedView === this.view
    );
    this._motion = !quiet && this._forceMotion;
    this._forceMotion = false;
    if (canPatch) this.patch(data);
    else this.render();
  },
  patch(d) {
    document.querySelectorAll("[data-live]").forEach((el) => {
      const next = liveText(d, el.dataset.live);
      if (next != null && el.textContent !== next) el.textContent = next;
    });
    patchAppRows(d);
    patchCalCells(d);
    syncPauseBar(d);
    const key = chartFingerprint(d);
    if (key !== this._chartKey) {
      this._chartKey = key;
      paintCanvases(d);
    }
  },
  go(view) {
    hideCalTip();
    this.view = view;
    this.selected = null;
    if (view !== "day") this.day = null;
    this._forceMotion = true;
    syncNav(view === "app" ? "apps" : view === "day" ? "months" : view);
    this.render();
  },
  appDetail(detail) {
    this.selected = detail;
    this.view = "app";
    this._forceMotion = true;
    syncNav("apps");
    this.render();
  },
  _fromView: "months",
  dayDetail(detail) {
    if (!detail) return;
    this.calDayData = this.calDayData || {};
    if (detail.day) this.calDayData[detail.day] = detail;
    if (this._openingFullDay || (this.view !== "activity" && this.view !== "months")) {
      this._openingFullDay = false;
      const here = this.view;
      this._fromView = here === "day" || here === "app" ? this._fromView || "months" : here;
      this.day = hydrateDay(detail);
      this.view = "day";
      this._forceMotion = true;
      const tab = this._fromView === "activity" ? "activity" : this._fromView === "home" ? "home" : "months";
      syncNav(tab);
      this.render();
    } else {
      this.render();
    }
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
    else if (this.view === "day") stage.innerHTML = viewDay(this.day, this._fromView);
    else if (this.view === "profile") stage.innerHTML = viewProfile(d);
    else if (this.view === "app") stage.innerHTML = viewApp(this.selected, d);
    stage.classList.toggle("is-enter", !!this._motion);
    this._chartKey = chartFingerprint(d);
    paintCanvases(d);
    bindStage();
    syncPauseBar(d);
    this._renderedView = this.view;
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

function fmtDur(sec, precise) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (precise) {
    if (h) return m ? (s ? `${h}h ${m}m ${s}s` : `${h}h ${m}m`) : `${h}h`;
    if (m) return s ? `${m}m ${s}s` : `${m}m`;
    return sec ? `${sec}s` : "0m";
  }
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

function appIconHtml(a, isSmall = false) {
  const label = (a && (a.label || a.app)) || "?";
  const icon = String((a && a.icon) || (Lumen.data && Lumen.data.icons && Lumen.data.icons[a && a.app]) || "");
  const cls = isSmall ? "app-ico is-sm" : "app-ico";
  const isImg = icon && (icon.startsWith("data:image/") || icon.startsWith("/") || icon.startsWith("file://"));
  if (isImg) return `<div class="${cls}"><img src="${escapeHtml(icon)}" alt="" loading="lazy"></div>`;
  return `<div class="${cls}">${escapeHtml(initial(label))}</div>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function fuzzyScore(query, text) {
  if (!query) return { match: true, score: 0, indices: [] };
  if (!text) return { match: false, score: 0, indices: [] };
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();

  if (q === t) {
    return {
      match: true,
      score: 1200,
      indices: Array.from({ length: text.length }, (_, i) => i),
    };
  }

  // Exact substring match
  const subIdx = t.indexOf(q);
  if (subIdx !== -1) {
    const indices = [];
    for (let i = 0; i < q.length; i++) indices.push(subIdx + i);
    const isWordStart = subIdx === 0 || /[\s_\-./]/.test(text[subIdx - 1]);
    const score = 600 + (isWordStart ? 250 : 0) - (text.length - q.length) * 2;
    return { match: true, score, indices };
  }

  // Subsequence matching
  let qIdx = 0;
  let tIdx = 0;
  let score = 0;
  const indices = [];
  let consecutive = 0;
  let prevIdx = -2;

  while (qIdx < q.length && tIdx < t.length) {
    if (q[qIdx] === t[tIdx]) {
      indices.push(tIdx);
      let charScore = 15;
      if (tIdx === 0) charScore += 40;
      else if (/[\s_\-./]/.test(text[tIdx - 1])) charScore += 35;
      else if (text[tIdx] >= "A" && text[tIdx] <= "Z" && text[tIdx - 1] >= "a" && text[tIdx - 1] <= "z") charScore += 25;

      if (tIdx === prevIdx + 1) {
        consecutive++;
        charScore += consecutive * 15;
      } else {
        consecutive = 0;
      }
      score += charScore;
      prevIdx = tIdx;
      qIdx++;
    }
    tIdx++;
  }

  if (qIdx === q.length) {
    score -= (indices[0] || 0) * 3;
    score -= (text.length - q.length);
    return { match: true, score, indices };
  }

  // Typo tolerance fallback for queries >= 3 chars
  if (q.length >= 3) {
    const words = text.split(/[\s_\-./]+/);
    for (const w of words) {
      if (Math.abs(w.length - q.length) <= 2) {
        const d = levenshteinDistance(q, w.slice(0, q.length + 1).toLowerCase());
        if (d <= 1) {
          const wStart = t.indexOf(w.toLowerCase());
          const matchIndices = wStart !== -1 ? [wStart] : [];
          return { match: true, score: 70 - d * 25, indices: matchIndices };
        }
      }
    }
    if (Math.abs(t.length - q.length) <= 3) {
      const d = levenshteinDistance(q, t.slice(0, q.length + 1));
      if (d <= 1) {
        return { match: true, score: 50 - d * 20, indices: [] };
      }
    }
  }

  return { match: false, score: -1, indices: [] };
}

function highlightFuzzyMatches(text, indices) {
  if (!indices || !indices.length) return escapeHtml(text);
  const set = new Set(indices);
  let html = "";
  for (let i = 0; i < text.length; i++) {
    const char = escapeHtml(text[i]);
    if (set.has(i)) {
      html += `<mark class="search-match">${char}</mark>`;
    } else {
      html += char;
    }
  }
  return html;
}

function fuzzySearchApps(apps, q) {
  if (!q) {
    return (apps || []).map((a) => ({ app: a, score: a.sec || 0, indices: [] }));
  }
  const results = [];
  for (const a of apps || []) {
    const labelScore = fuzzyScore(q, a.label || "");
    const appScore = fuzzyScore(q, a.app || "");
    if (labelScore.match || appScore.match) {
      const best = labelScore.score >= appScore.score ? labelScore : appScore;
      results.push({
        app: a,
        score: best.score,
        indices: labelScore.match ? labelScore.indices : [],
      });
    }
  }
  results.sort((x, y) => y.score - x.score || (y.app.sec || 0) - (x.app.sec || 0));
  return results;
}

function filterApps(apps, q) {
  const scored = fuzzySearchApps(apps, q);
  return scored.map((s) => s.app);
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

function viewDay(d, from) {
  const backView = from === "activity" ? "activity" : from === "home" ? "home" : "months";
  const backLabel = backView === "activity" ? "Week" : backView === "home" ? "Today" : "Month";
  if (!d || !d.ok) {
    const why = d && d.reason === "future" ? "That day is still ahead." : "That day is not available.";
    return `
      <button class="back" data-back="${backView}" type="button">${backLabel}</button>
      <div class="empty"><strong>No day to show</strong>${escapeHtml(why)}</div>`;
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
    ? `<div class="chart-hero"><canvas data-chart="dayhour"></canvas></div>`
    : `<p class="note">${d.recent ? "No hourly slices for this day yet." : "Hourly detail is kept for 7 days. Totals are still here."}</p>`;
  const strip = (d.week_days || [])
    .map((c) => {
      if (c.future) {
        return `<button class="strip-day" disabled type="button">${escapeHtml(c.label)}<span class="n">${c.d}</span></button>`;
      }
      const on = c.is_sel || c.ymd === d.day ? " is-on" : "";
      return `<button class="strip-day${on}" type="button" data-day="${escapeHtml(c.ymd)}" data-active="${c.active || 0}" data-idle="${c.idle || 0}" data-lock="${c.lock || 0}">${escapeHtml(c.label)}<span class="n">${fmtDur(c.active)}</span></button>`;
    })
    .join("");
  const prev = d.prev_day
    ? `<button type="button" data-day="${escapeHtml(d.prev_day)}" aria-label="Previous day">←</button>`
    : `<button type="button" disabled aria-label="Previous day">←</button>`;
  const next = d.next_day
    ? `<button type="button" data-day="${escapeHtml(d.next_day)}" aria-label="Next day">→</button>`
    : `<button type="button" disabled aria-label="Next day">→</button>`;
  return `
    <button class="back" data-back="${backView}" type="button">${backLabel}</button>
    <p class="kicker">Total weekly usage</p>
    <div class="hero">
      <h1>${escapeHtml(d.week_label || "This week")}</h1>
      <div class="fig">${fmtDur(d.week_active)}</div>
    </div>
    <p class="note">Idle ${fmtDur(d.week_idle)}</p>
    <div class="week-strip">${strip}</div>
    <div class="day-nav">
      ${prev}
      <h2 class="day-name">${escapeHtml(d.label)}</h2>
      ${next}
    </div>
    ${d.empty ? `<p class="note">No session recorded this day.</p>` : ""}
    <div class="sheet-kpis">
      <div>Usage<strong>${fmtDur(t.active)}</strong></div>
      <div>Idle<strong>${fmtDur(t.idle)}</strong></div>
      <div>Lock<strong>${fmtDur(t.lock)}</strong></div>
    </div>
    ${chart}
    <h3>Apps</h3>
    <div class="rows">${apps || `<div class="empty">Nothing recorded.</div>`}</div>`;
}

function viewHome(d, q) {
  const s = d.stats || {};
  const rows = homeRowsHtml(d, q);
  return `
    <div class="hero">
      <h1>${escapeHtml(d.greet)}, ${escapeHtml(d.display_name)}</h1>
      <div class="fig" data-live="active">${fmtDur(s.active, true)}</div>
    </div>
    <p class="note">On screen today · idle <span data-live="idle">${fmtDur(s.idle, true)}</span> · <span data-live="now">${escapeHtml(liveLine(d))}</span></p>
    ${reportLine(d)}
    <div class="chart-hero"><canvas data-chart="hourly"></canvas></div>
    <div class="rows">${rows}</div>`;
}

function homeRowsHtml(d, q) {
  const apps = filterApps(d.apps, q);
  const nowApp = (d.current && d.current.app) || "";
  if (!apps.length) return `<div class="empty"><strong>No apps yet</strong>Use the machine for a bit.</div>`;
  return apps
    .map(
      (a) => `<button class="row" data-app="${escapeHtml(a.app)}" type="button">
        ${appIconHtml(a)}
        <div><div class="app-name">${escapeHtml(a.label)}</div>${nowApp === a.app ? `<div class="app-sub">Now</div>` : ""}</div>
        <div class="num">${fmtDur(a.sec, true)}</div>
      </button>`
    )
    .join("");
}

function liveLine(d) {
  if (trackingPaused(d)) return "Paused";
  const cur = d.current || {};
  const st = cur.state || "";
  if (st === "idle") return "Idle now";
  if (st === "lock") return "Locked";
  if (st === "sleep") return "Asleep";
  const hit = (d.apps || []).find((a) => a.app === cur.app);
  const name = (hit && hit.label) || cur.app;
  if (!name || name === "Desktop") return "Desktop now";
  return `${name} now`;
}

function dayProgressCircleSvg(active, maxTotal) {
  const cap = Math.max(1, maxTotal || 8 * 3600);
  const ratio = Math.max(0, Math.min(1, (active || 0) / cap));

  // Single bold, large circular progress ring (viewBox 120 120, radius 49, stroke-width 11)
  const r = 49;
  const c = 2 * Math.PI * r; // ~307.88
  const off = (c * (1 - ratio)).toFixed(1);

  return `<svg class="sc-rings-svg" viewBox="0 0 120 120" aria-hidden="true">
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--line)" stroke-width="11" opacity="0.45" />
    ${ratio > 0 ? `<circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--sage, #8fbfb4)" stroke-width="11" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off}" transform="rotate(-90 60 60)" />` : ""}
  </svg>`;
}

function renderDaySquareCard({
  day,
  label,
  dateLabel,
  isToday,
  isSelected,
  active,
  idle,
  lock,
  maxTotal,
  apps = [],
  selectAttr = "",
}) {
  const ringsSvg = dayProgressCircleSvg(active, maxTotal);
  const actDur = fmtDur(active);
  const idlDur = fmtDur(idle);
  const lckDur = fmtDur(lock);
  const topApps = (apps || []).slice(0, 3);

  const centerDurHtml = `<span class="sc-rc-dur${active ? "" : " is-empty"}">${active ? actDur : "—"}</span>`;

  const topAppsHtml = topApps.length
    ? `<div class="sc-ho-apps">
        <div class="sc-ho-apps-title">Top apps</div>
        ${topApps
          .map(
            (a) => `<div class="sc-ho-app-row">
              ${appIconHtml(a, true)}
              <span class="sc-ho-app-name">${escapeHtml(a.label || a.app)}</span>
              <span class="sc-ho-app-sec">${fmtDur(a.sec)}</span>
            </div>`
          )
          .join("")}
      </div>`
    : "";

  return `
    <div class="day-square-card${isSelected ? " is-selected" : ""}" ${selectAttr} role="button" tabindex="0" aria-label="${escapeHtml(label + " " + dateLabel + ": " + actDur + " active")}">
      <div class="sc-face">
        <div class="sc-top">
          <div class="sc-day-wrap">
            <span class="sc-day">${escapeHtml(label)}</span>
            ${isToday ? `<span class="wd-today-tag">Today</span>` : ""}
          </div>
          <span class="sc-date">${escapeHtml(dateLabel)}</span>
        </div>

        <div class="sc-rings-wrap">
          ${ringsSvg}
          <div class="sc-rings-center">
            ${centerDurHtml}
          </div>
        </div>

        <div class="sc-bottom">
          <span class="sc-summary">${active ? `${actDur} active` : "No activity"}</span>
        </div>
      </div>

      <div class="sc-hover-overlay">
        <div class="sc-ho-head">
          <div>
            <div class="sc-ho-day">${escapeHtml(label)}</div>
            <div class="sc-ho-date">${escapeHtml(dateLabel)}</div>
          </div>
          <span class="sc-ho-badge">${actDur}</span>
        </div>

        <div class="sc-ho-kpis">
          <div class="sc-ho-kpi"><span class="ik-dot sage"></span>Active <strong>${actDur}</strong></div>
          <div class="sc-ho-kpi"><span class="ik-dot peach"></span>Idle <strong>${idlDur}</strong></div>
          <div class="sc-ho-kpi"><span class="ik-dot lilac"></span>Lock <strong>${lckDur}</strong></div>
        </div>

        ${topAppsHtml}

        <div class="sc-ho-footer">Click to inspect day →</div>
      </div>
    </div>`;
}

function viewActivity(d) {
  const week = d.week || [];
  const total = week.reduce((n, w) => n + (w.totals.active || 0), 0);
  const idle = week.reduce((n, w) => n + (w.totals.idle || 0), 0);
  const lock = week.reduce((n, w) => n + (w.totals.lock || 0), 0);
  const used = week.filter((w) => w.totals.active).length || 1;

  if (!Lumen.selectedWeekDay || !week.some((w) => w.day === Lumen.selectedWeekDay)) {
    const todayMatch = week.find((w) => w.day === d.today);
    Lumen.selectedWeekDay = (todayMatch && todayMatch.day) || (week[week.length - 1] && week[week.length - 1].day) || d.today;
  }
  const selDay = week.find((w) => w.day === Lumen.selectedWeekDay) || week[week.length - 1] || { totals: {}, apps: [] };
  const selTotals = selDay.totals || {};
  const selTotalSec = (selTotals.active || 0) + (selTotals.idle || 0) + (selTotals.lock || 0) || 1;
  const actPct = Math.round(((selTotals.active || 0) / selTotalSec) * 100);
  const idlPct = Math.round(((selTotals.idle || 0) / selTotalSec) * 100);
  const lckPct = Math.max(0, 100 - actPct - idlPct);

  const selDayApps = selDay.apps || [];
  const maxAppSec = Math.max(1, ...selDayApps.map((a) => a.sec || 0));

  const inspectorAppsHtml = selDayApps.length
    ? selDayApps.map((a) => {
        const pct = Math.max(4, Math.round(((a.sec || 0) / maxAppSec) * 100));
        return `
          <button class="inspector-app-row" data-app="${escapeHtml(a.app)}" type="button">
            ${appIconHtml(a, true)}
            <div class="ia-info">
              <div class="ia-top">
                <span class="ia-name">${escapeHtml(a.label || a.app)}</span>
                <span class="ia-num">${fmtDur(a.sec)}</span>
              </div>
              <div class="bar"><i style="width:${pct}%"></i></div>
            </div>
          </button>`;
      }).join("")
    : `<div class="inspector-empty">No screen activity recorded on this day.</div>`;

  const maxDayVal = Math.max(
    8 * 3600,
    ...week.map((w) => Math.max(w.totals.active || 0, w.totals.idle || 0, w.totals.lock || 0))
  );

  const dayCardsHtml = week.map((w) => {
    const t = w.totals || {};
    const isSel = w.day === Lumen.selectedWeekDay;
    const isToday = w.day === d.today;

    return renderDaySquareCard({
      day: w.day,
      label: w.label || "",
      dateLabel: w.date_label || w.day || "",
      isToday,
      isSelected: isSel,
      active: t.active || 0,
      idle: t.idle || 0,
      lock: t.lock || 0,
      maxTotal: maxDayVal,
      apps: w.apps || [],
      selectAttr: `data-select-week-day="${escapeHtml(w.day)}"`,
    });
  }).join("");

  return `
    <div class="hero">
      <h1>This week</h1>
      <div class="fig" data-live="week-active">${fmtDur(total)}</div>
    </div>
    <p class="note">Average day ${fmtDur(total / used)} · idle <span data-live="week-idle">${fmtDur(idle)}</span> · lock <span>${fmtDur(lock)}</span></p>
    ${reportLine(d)}
    <div class="chart-hero">
      <canvas data-chart="week"></canvas>
      <div class="week-hits" style="grid-template-columns:repeat(${Math.max(week.length, 1)},1fr)">${week
        .map((w) => {
          const t = w.totals || {};
          const isSel = w.day === Lumen.selectedWeekDay ? " is-selected-bar" : "";
          return `<button class="week-hit${isSel}" type="button" data-select-week-day="${escapeHtml(w.day)}" data-active="${t.active || 0}" data-idle="${t.idle || 0}" data-lock="${t.lock || 0}" aria-label="${escapeHtml(fmtCalDay(w.day))}"></button>`;
        })
        .join("")}</div>
    </div>
    <p class="legend"><span><i class="sage"></i>Usage</span><span><i class="peach"></i>Idle</span><span><i class="lilac"></i>Lock</span></p>

    <h3 class="section-title">Daily Activity</h3>
    <div class="square-cards-grid week-grid">${dayCardsHtml}</div>

    <div class="week-inspector card">
      <div class="inspector-head">
        <div>
          <div class="inspector-title-row">
            <h2>${escapeHtml(selDay.date_label || selDay.label || selDay.day)}</h2>
            ${selDay.day === d.today ? `<span class="wd-today-tag">Today</span>` : ""}
            <span class="inspector-active-pill">${fmtDur(selTotals.active || 0)}</span>
          </div>
          <div class="inspector-sub">Selected day detailed breakdown and top applications:</div>
        </div>
        <button class="btn-day-timeline" data-day-timeline="${escapeHtml(selDay.day)}" type="button">
          Full day timeline →
        </button>
      </div>
      
      <div class="inspector-kpis">
        <div class="ik-item"><span class="ik-dot sage"></span>Usage <strong>${fmtDur(selTotals.active || 0)}</strong></div>
        <div class="ik-item"><span class="ik-dot peach"></span>Idle <strong>${fmtDur(selTotals.idle || 0)}</strong></div>
        <div class="ik-item"><span class="ik-dot lilac"></span>Lock <strong>${fmtDur(selTotals.lock || 0)}</strong></div>
      </div>

      <div class="day-seg-bar is-lg">
        <span class="seg-act" style="width:${actPct}%"></span>
        <span class="seg-idl" style="width:${idlPct}%"></span>
        <span class="seg-lck" style="width:${lckPct}%"></span>
      </div>

      <h3 class="inspector-sec-title">Top Apps on ${escapeHtml(selDay.date_label || selDay.label)}</h3>
      <div class="inspector-apps-grid">${inspectorAppsHtml}</div>
    </div>`;
}

function viewApps(d, q) {
  const scored = fuzzySearchApps(d.apps || [], q);
  const weekTotals = {};
  for (const w of d.week || []) {
    for (const a of w.apps || []) weekTotals[a.app] = (weekTotals[a.app] || 0) + a.sec;
  }
  const max = Math.max(1, ...(d.apps || []).map((a) => a.sec));
  const rows = scored
    .map(({ app: a, indices }) => {
      const wk = weekTotals[a.app] || a.sec;
      const highlightedName = highlightFuzzyMatches(a.label || a.app, indices);
      return `<button class="row wide" data-app="${escapeHtml(a.app)}" type="button">
        ${appIconHtml(a)}
        <div><div class="app-name">${highlightedName}</div><div class="app-sub">Week ${fmtDur(wk)}</div></div>
        <div class="bar"><i style="width:${Math.max(6, (a.sec / max) * 100)}%"></i></div>
        <div class="num">${fmtDur(a.sec)}</div>
      </button>`;
    })
    .join("");

  const emptyState = q
    ? `<div class="empty search-empty">
        <strong>No apps found</strong>
        <p>No applications match &ldquo;${escapeHtml(q)}&rdquo;</p>
        <button class="btn-clear-search" type="button" data-clear-search>Clear search</button>
      </div>`
    : `<div class="empty"><strong>Nothing here yet</strong></div>`;

  return `
    <div class="hero"><h1>Apps</h1></div>
    <div class="search-wrap">
      <label class="search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16.5 16.5 21 21"/></svg>
        <input id="q" type="search" placeholder="Search apps (fuzzy)..." value="${escapeHtml(q)}" autocomplete="off">
        ${q ? `<button class="search-clear" type="button" data-clear-search aria-label="Clear search">×</button>` : ""}
      </label>
      ${q ? `<span class="search-count">${scored.length} ${scored.length === 1 ? 'app' : 'apps'} found</span>` : ""}
    </div>
    <div class="rows">${rows || emptyState}</div>`;
}

function viewBattery(d) {
  const b = d.battery || {};
  const pct = b.pct == null && d.stats.battery == null ? "—" : `${b.pct != null ? b.pct : d.stats.battery}%`;
  const samples = ((d.week || []).find((w) => w.day === d.today) || {}).battery || [];
  const kpis = [
    ["Time left", battEta(b)],
    ["Power", b.watts == null ? "—" : `${b.watts} W`],
    ["Today high", b.today_high == null ? "—" : `${b.today_high}%`],
    ["Today low", b.today_low == null ? "—" : `${b.today_low}%`],
    ["Health", b.health_pct == null ? "—" : `${b.health_pct}%`],
    ["Cycles", b.cycles == null ? "—" : String(b.cycles)],
    ["Capacity", battWh(b)],
    ["Voltage", b.voltage_v == null ? "—" : `${b.voltage_v} V`],
  ]
    .map(
      ([lab, val], i) =>
        `<div>${escapeHtml(lab)}<strong data-live="${["batt-eta", "batt-watts", "batt-high", "batt-low", "batt-health", "batt-cycles", "batt-wh", "batt-volt"][i]}">${escapeHtml(val)}</strong></div>`
    )
    .join("");
  const meta = [b.maker, b.model, b.tech, b.name].filter(Boolean).join(" · ");
  const delta =
    b.today_delta == null ? "" : ` · today ${b.today_delta > 0 ? "+" : ""}${b.today_delta} pt`;
  return `
    <div class="hero">
      <h1>Battery</h1>
      <div class="fig" data-live="batt">${pct}</div>
    </div>
    <p class="note" data-live="batt-status">${escapeHtml(battStatusLine(d))}${escapeHtml(delta)}</p>
    <div class="sheet-kpis batt-kpis">${kpis}</div>
    ${meta ? `<p class="note">${escapeHtml(meta)}</p>` : ""}
    <div class="chart-hero"><canvas data-chart="battery"></canvas></div>
    <p class="note">${samples.length ? "Charge through today. Green marks charging." : "No charge samples yet today."}</p>`;
}

function battStatusLine(d) {
  const b = d.battery || {};
  const bits = [b.status_label || (d.stats.battery_status || "").replace(/-/g, " ")];
  if (b.ac && b.status !== "discharging") bits.push("AC");
  if (b.level) bits.push(b.level);
  return bits.filter(Boolean).join(" · ") || "Battery";
}

function battEta(b) {
  if (!b || b.eta_sec == null) return "—";
  const t = fmtDur(b.eta_sec);
  if (b.eta_kind === "full") return `${t} to full`;
  if (b.eta_kind === "empty") return `${t} left`;
  return t;
}

function battWh(b) {
  if (!b) return "—";
  if (b.energy_wh != null && b.full_wh != null) return `${b.energy_wh} / ${b.full_wh} Wh`;
  if (b.full_wh != null) return `${b.full_wh} Wh`;
  if (b.energy_wh != null) return `${b.energy_wh} Wh`;
  return "—";
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function shiftYm(year, month, delta) {
  const dt = new Date(year, month - 1 + delta, 1);
  return { year: dt.getFullYear(), month: dt.getMonth() + 1 };
}

function monthLong(year, month) {
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long" });
}

function calYearMonth(cal) {
  let year = Number(cal && cal.year) || Number(String((cal && cal.month) || "").slice(0, 4));
  let month = Number(cal && cal.month_n) || Number(String((cal && cal.month) || "").slice(5, 7));
  if (!year || !month) {
    const today = (Lumen.data && Lumen.data.today) || "";
    if (today && today.length >= 7) {
      year = Number(today.slice(0, 4));
      month = Number(today.slice(5, 7));
    } else {
      const now = new Date();
      year = now.getFullYear();
      month = now.getMonth() + 1;
    }
  }
  return { year, month };
}

function knownMonthKeys(d) {
  const keys = new Set();
  for (const m of (d && d.months) || []) if (m.month) keys.add(m.month);
  for (const w of (d && d.week) || []) if (w.day) keys.add(w.day.slice(0, 7));
  if (d && d.today) keys.add(d.today.slice(0, 7));
  const cal = (d && d.calendar) || {};
  if (cal.month) keys.add(cal.month);
  return [...keys].sort();
}

function buildClientMonthGrid(year, month) {
  const d = Lumen.data || {};
  const key = monthKey(year, month);
  const rec = ((d.months || []).find((m) => m.month === key) || {});
  const dayActive = { ...(rec.day_active || {}) };
  const dayIdle = { ...(rec.day_idle || {}) };
  const dayLock = { ...(rec.day_lock || {}) };
  for (const w of d.week || []) {
    if (!w.day || !w.day.startsWith(key)) continue;
    const dd = w.day.slice(8, 10);
    const t = w.totals || {};
    dayActive[dd] = t.active || 0;
    dayIdle[dd] = t.idle || 0;
    dayLock[dd] = t.lock || 0;
  }
  const today = d.today || "";
  const first = new Date(year, month - 1, 1);
  const start = (first.getDay() + 6) % 7;
  const last = new Date(year, month, 0).getDate();
  const weeks = [];
  let row = [];
  for (let i = 0; i < start; i++) row.push(null);
  let totA = 0;
  let totI = 0;
  let totL = 0;
  let n = 0;
  for (let day = 1; day <= last; day++) {
    const dd = String(day).padStart(2, "0");
    const ymd = `${key}-${dd}`;
    const active = Number(dayActive[dd] || 0);
    const idle = Number(dayIdle[dd] || 0);
    const lock = Number(dayLock[dd] || 0);
    totA += active;
    totI += idle;
    totL += lock;
    if (active || idle || lock) n += 1;
    row.push({
      d: day,
      ymd,
      active,
      idle,
      lock,
      is_today: ymd === today,
      future: !!(today && ymd > today),
      recent: false,
      has_data: !!(active || idle || lock),
    });
    if (row.length === 7) {
      weeks.push(row);
      row = [];
    }
  }
  while (row.length && row.length < 7) row.push(null);
  if (row.length) weeks.push(row);
  const keys = knownMonthKeys(d);
  const todayKey = today.slice(0, 7);
  return {
    month: key,
    label: `${monthLong(year, month)} ${year}`,
    year,
    month_n: month,
    weeks,
    totals: {
      active: totA || rec.active || 0,
      idle: totI || rec.idle || 0,
      lock: totL || rec.lock || 0,
      days_n: n || rec.days_n || 0,
      avg_active: n ? Math.floor(totA / n) : rec.avg_active || 0,
      top_apps: rec.top_apps || [],
    },
    max_active: Math.max(1, rec.max_active || 0, ...Object.values(dayActive).map(Number)),
    has_prev: keys.length ? key > keys[0] : true,
    has_next: todayKey ? key < todayKey : false,
  };
}

function viewMonths(d) {
  let cal = Lumen.calOverride || d.calendar || {};
  const parsed = calYearMonth(cal);
  const year = parsed.year;
  const month = parsed.month;
  if (!cal.weeks || !cal.weeks.length || cal.year !== year || cal.month_n !== month) {
    cal = buildClientMonthGrid(year, month);
  }
  const weeks = cal.weeks || [];
  const max = Math.max(1, cal.max_active || 1);
  const todayKey = (d.today || "").slice(0, 7);
  const oldest = shiftYm(Number(todayKey.slice(0, 4)) || year, Number(todayKey.slice(5, 7)) || month, -12);
  const atStart = !year || monthKey(year, month) <= monthKey(oldest.year, oldest.month);
  const atEdge = todayKey ? monthKey(year, month) >= todayKey : true;
  const prev = shiftYm(year || 2026, month || 1, -1);
  const next = shiftYm(year || 2026, month || 1, 1);

  const flatCells = weeks.flat().filter(Boolean);
  if (!Lumen.selectedCalDay || !flatCells.some((c) => c.ymd === Lumen.selectedCalDay)) {
    const todayCell = flatCells.find((c) => c.is_today);
    const latestActiveCell = [...flatCells].reverse().find((c) => c.has_data && !c.future);
    Lumen.selectedCalDay = (todayCell && todayCell.ymd) || (latestActiveCell && latestActiveCell.ymd) || (flatCells[0] && flatCells[0].ymd) || d.today;
  }
  if (Lumen.selectedCalDay && (!Lumen.calDayData || !Lumen.calDayData[Lumen.selectedCalDay])) {
    send({ op: "day", day: Lumen.selectedCalDay });
  }

  const cells = weeks
    .flat()
    .map((cell) => {
      if (!cell) return `<span class="cal-cell is-blank" aria-hidden="true"></span>`;
      if (cell.future) {
        return `<button class="cal-cell" disabled type="button" aria-label="${escapeHtml(cell.ymd)}"><span class="d">${cell.d}</span></button>`;
      }
      const t = cell.active / max;
      let heatCls = "";
      if (cell.active > 0) {
        if (t > 0.66) heatCls = " heat-4";
        else if (t > 0.4) heatCls = " heat-3";
        else if (t > 0.15) heatCls = " heat-2";
        else heatCls = " heat-1";
      }
      const isSel = cell.ymd === Lumen.selectedCalDay ? " is-selected" : "";
      const cls = [
        "cal-cell",
        cell.is_today ? "is-today" : "",
        cell.active ? "has-use" : "",
        cell.recent ? "is-recent" : "",
        heatCls,
        isSel,
      ]
        .filter(Boolean)
        .join(" ");

      const usage = fmtDur(cell.active);
      const idle = fmtDur(cell.idle);
      const lock = fmtDur(cell.lock);
      const label = `${cell.ymd}. Usage ${usage}. Idle ${idle}. Lock ${lock}`;
      return `<button class="${cls}" type="button" data-select-cal-day="${escapeHtml(cell.ymd)}" data-active="${cell.active || 0}" data-idle="${cell.idle || 0}" data-lock="${cell.lock || 0}" aria-label="${escapeHtml(label)}">
        <span class="d">${cell.d}</span>
        ${cell.active ? `<span class="cal-dot"></span>` : ""}
      </button>`;
    })
    .join("");

  const m = cal.totals || {};
  const monthIcons = {};
  for (const block of d.months || []) {
    for (const a of block.top_apps || []) if (a.app && a.icon) monthIcons[a.app] = a.icon;
  }
  for (const a of d.apps || []) if (a.app && a.icon) monthIcons[a.app] = a.icon;

  const selCell = flatCells.find((c) => c.ymd === Lumen.selectedCalDay) || {};
  const weekMatch = (d.week || []).find((w) => w.day === Lumen.selectedCalDay);
  const cachedDetail = (Lumen.calDayData && Lumen.calDayData[Lumen.selectedCalDay]) || null;

  const selTotals = cachedDetail ? cachedDetail.totals : (weekMatch ? weekMatch.totals : {
    active: selCell.active || 0,
    idle: selCell.idle || 0,
    lock: selCell.lock || 0,
  });

  const selApps = cachedDetail ? (cachedDetail.apps || []) : (weekMatch ? (weekMatch.apps || []) : (selCell.apps || []));
  const selDayTotalSec = (selTotals.active || 0) + (selTotals.idle || 0) + (selTotals.lock || 0) || 1;
  const aPct = Math.round(((selTotals.active || 0) / selDayTotalSec) * 100);
  const iPct = Math.round(((selTotals.idle || 0) / selDayTotalSec) * 100);
  const lPct = Math.max(0, 100 - aPct - iPct);

  const selAppsMax = Math.max(1, ...selApps.map((a) => a.sec || 0));
  const isOlderDay = !weekMatch && Lumen.selectedCalDay !== d.today;
  const inspectorSub = isOlderDay
    ? (selTotals.active
        ? "Older than 7 days · Summary totals retained (Usage, Idle, Lock)."
        : "Older than 7 days · Summarized in monthly total and average above.")
    : "Selected day from calendar. Click any date to inspect.";

  const selAppsHtml = selApps.length
    ? selApps.map((a) => {
        const pct = Math.max(4, Math.round(((a.sec || 0) / selAppsMax) * 100));
        return `
          <button class="inspector-app-row" data-app="${escapeHtml(a.app)}" type="button">
            ${appIconHtml(a, true)}
            <div class="ia-info">
              <div class="ia-top">
                <span class="ia-name">${escapeHtml(a.label || a.app)}</span>
                <span class="ia-num">${fmtDur(a.sec)}</span>
              </div>
              <div class="bar"><i style="width:${pct}%"></i></div>
            </div>
          </button>`;
      }).join("")
    : `<div class="inspector-empty">${selTotals.active ? `Recorded usage: <strong>${fmtDur(selTotals.active)}</strong>.` : "No recorded activity for this date."}${isOlderDay ? `<div class="inspector-empty-sub">Older than 7 days is summarized in monthly totals (Total: <strong>${fmtDur(m.active || 0)}</strong>, Daily avg: <strong>${fmtDur(m.avg_active || 0)}</strong> across ${m.days_n || 0} active days).</div>` : ""}</div>`;

  const top = (m.top_apps || []).slice(0, 6);
  const maxMonthApp = Math.max(1, ...top.map((a) => a.sec || 0));
  const monthAppsHtml = top.length
    ? top
        .map((a) => {
          const row = { ...a, icon: a.icon || monthIcons[a.app] || "" };
          const pct = Math.max(4, Math.round(((a.sec || 0) / maxMonthApp) * 100));
          return `<button class="row wide" data-app="${escapeHtml(row.app)}" type="button">
            ${appIconHtml(row)}
            <div><div class="app-name">${escapeHtml(row.label)}</div></div>
            <div class="bar"><i style="width:${pct}%"></i></div>
            <div class="num">${fmtDur(row.sec)}</div>
          </button>`;
        })
        .join("")
    : `<div class="empty"><strong>No apps this month</strong></div>`;

  const activeDaysList = weeks
    .flat()
    .filter((c) => c && c.has_data && !c.future)
    .map((c) => {
      const isSel = c.ymd === Lumen.selectedCalDay;
      const wMatch = (d.week || []).find((w) => w.day === c.ymd);
      const cached = (Lumen.calDayData && Lumen.calDayData[c.ymd]) || null;
      const dayApps = (cached && cached.apps) || (wMatch && wMatch.apps) || (c.apps || []);
      const dayDate = new Date(c.ymd + "T12:00:00");
      const dayName = dayDate.toLocaleDateString(undefined, { weekday: "short" });
      const dayDateStr = `${c.ymd.slice(8, 10)} ${monthLong(year, month).slice(0, 3)}`;

      return renderDaySquareCard({
        day: c.ymd,
        label: dayName,
        dateLabel: dayDateStr,
        isToday: c.is_today,
        isSelected: isSel,
        active: c.active || 0,
        idle: c.idle || 0,
        lock: c.lock || 0,
        maxTotal: max,
        apps: dayApps,
        selectAttr: `data-select-cal-day="${escapeHtml(c.ymd)}"`,
      });
    })
    .join("");

  return `
    <div class="month-nav">
      <button class="month-shift" type="button" data-cal="-1"${atStart ? " disabled" : ""} aria-label="Previous month">${escapeHtml(monthLong(prev.year, prev.month))}</button>
      <div class="month-id">
        <h1>${escapeHtml(year ? monthLong(year, month) : cal.label || "Month")}</h1>
        <p class="month-year">${year || ""}</p>
      </div>
      <button class="month-shift is-next" type="button" data-cal="1"${atEdge ? " disabled" : ""} aria-label="Next month">${escapeHtml(monthLong(next.year, next.month))}</button>
    </div>

    <div class="month-layout">
      <div class="month-col-left">
        <div class="card month-kpi-card">
          <div class="mk-total-label">Total Screen Time · ${escapeHtml(monthLong(year, month))}</div>
          <div class="mk-total-val">${fmtDur(m.active || 0)}</div>
          <div class="mk-grid">
            <div><span class="mk-sub">Daily avg</span><strong>${fmtDur(m.avg_active || 0)}</strong></div>
            <div><span class="mk-sub">Total idle</span><strong>${fmtDur(m.idle || 0)}</strong></div>
            <div><span class="mk-sub">Active days</span><strong>${m.days_n || 0} / ${new Date(year, month, 0).getDate()}</strong></div>
          </div>
        </div>

        <div class="card cal-card">
          <div class="cal-board">
            <div class="cal-dow"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
            <div class="cal-grid">${cells}</div>
          </div>
        </div>

        <div class="card month-apps-card">
          <h3 class="card-title">Top Apps this Month</h3>
          <div class="rows">${monthAppsHtml}</div>
        </div>
      </div>

      <div class="month-col-right">
        <div class="card cal-day-inspector">
          <div class="inspector-head">
            <div>
              <div class="inspector-title-row">
                <h2>${escapeHtml(fmtCalDay(Lumen.selectedCalDay))}</h2>
                ${Lumen.selectedCalDay === d.today ? `<span class="wd-today-tag">Today</span>` : ""}
                <span class="inspector-active-pill">${fmtDur(selTotals.active || 0)}</span>
              </div>
              <div class="inspector-sub">${escapeHtml(inspectorSub)}</div>
            </div>
            ${isOlderDay
              ? `<span class="inspector-retention-pill">7-day summary</span>`
              : `<button class="btn-day-timeline" data-day-timeline="${escapeHtml(Lumen.selectedCalDay)}" type="button">
                  Full day timeline →
                </button>`}
          </div>

          <div class="inspector-kpis">
            <div class="ik-item"><span class="ik-dot sage"></span>Usage <strong>${fmtDur(selTotals.active || 0)}</strong></div>
            <div class="ik-item"><span class="ik-dot peach"></span>Idle <strong>${fmtDur(selTotals.idle || 0)}</strong></div>
            <div class="ik-item"><span class="ik-dot lilac"></span>Lock <strong>${fmtDur(selTotals.lock || 0)}</strong></div>
          </div>

          <div class="day-seg-bar is-lg">
            <span class="seg-act" style="width:${aPct}%"></span>
            <span class="seg-idl" style="width:${iPct}%"></span>
            <span class="seg-lck" style="width:${lPct}%"></span>
          </div>

          <h3 class="inspector-sec-title">Apps used on ${escapeHtml(fmtCalDay(Lumen.selectedCalDay))}</h3>
          <div class="inspector-apps-grid">${selAppsHtml}</div>
        </div>

        <div class="month-days-section">
          <div class="month-section-head">
            <h3 class="section-title">Active Days in ${escapeHtml(monthLong(year, month))}</h3>
            <span class="section-sub">Days older than 7 days are summarized in monthly totals &amp; average above.</span>
          </div>
          <div class="square-cards-grid month-grid">${activeDaysList || `<div class="empty">No recorded activity this month.</div>`}</div>
        </div>
      </div>
    </div>`;
}

function viewProfile(d) {
  const c = d.config || {};
  const col = d.collector || {};
  const theme = d.theme || "system";
  return `
    <div class="hero"><h1>Settings</h1></div>
    <p class="note">${escapeHtml((d.profile && d.profile.host) || "")} · <span data-live="collector">${trackingPaused(d) ? "paused" : col.alive ? "recording" : "collector off"}</span></p>
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

function trackingPaused(d) {
  return !!(d && ((d.config && d.config.paused) || (d.collector && d.collector.paused)));
}

function syncPauseBar(d) {
  const bar = document.getElementById("pauseBar");
  if (!bar) return;
  const on = trackingPaused(d);
  bar.hidden = !on;
}

function liveText(d, key) {
  const s = d.stats || {};
  const b = d.battery || {};
  const week = d.week || [];
  if (key === "active") return fmtDur(s.active, true);
  if (key === "idle") return fmtDur(s.idle, true);
  if (key === "lock") return fmtDur(s.lock, true);
  if (key === "now") return liveLine(d);
  if (key === "week-active") return fmtDur(week.reduce((n, w) => n + ((w.totals && w.totals.active) || 0), 0));
  if (key === "week-idle") return fmtDur(week.reduce((n, w) => n + ((w.totals && w.totals.idle) || 0), 0));
  if (key === "batt") return b.pct == null && s.battery == null ? "—" : `${b.pct != null ? b.pct : s.battery}%`;
  if (key === "batt-status") {
    const delta = b.today_delta == null ? "" : ` · today ${b.today_delta > 0 ? "+" : ""}${b.today_delta} pt`;
    return battStatusLine(d) + delta;
  }
  if (key === "batt-watts") return b.watts == null ? "—" : `${b.watts} W`;
  if (key === "batt-eta") return battEta(b);
  if (key === "batt-high") return b.today_high == null ? "—" : `${b.today_high}%`;
  if (key === "batt-low") return b.today_low == null ? "—" : `${b.today_low}%`;
  if (key === "batt-health") return b.health_pct == null ? "—" : `${b.health_pct}%`;
  if (key === "batt-cycles") return b.cycles == null ? "—" : String(b.cycles);
  if (key === "batt-wh") return battWh(b);
  if (key === "batt-volt") return b.voltage_v == null ? "—" : `${b.voltage_v} V`;
  if (key === "collector") return trackingPaused(d) ? "paused" : d.collector && d.collector.alive ? "recording" : "collector off";
  return null;
}

function patchAppRows(d) {
  if (Lumen.view !== "home") return;
  const box = document.querySelector("#stage .rows");
  if (!box) return;
  const apps = filterApps(d.apps || [], Lumen.q);
  const ids = apps.map((a) => a.app).join("\0");
  const rows = [...box.querySelectorAll(".row[data-app]")];
  const have = rows.map((r) => r.dataset.app).join("\0");
  if (ids !== have) {
    box.innerHTML = homeRowsHtml(d, Lumen.q);
    return;
  }
  const nowApp = (d.current && d.current.app) || "";
  const map = Object.fromEntries(apps.map((a) => [a.app, a]));
  rows.forEach((row) => {
    const a = map[row.dataset.app];
    if (!a) return;
    const num = row.querySelector(".num");
    const next = fmtDur(a.sec, true);
    if (num && num.textContent !== next) num.textContent = next;
    const name = row.querySelector(".app-name");
    let sub = row.querySelector(".app-sub");
    const want = nowApp === a.app;
    if (want && !sub && name && name.parentElement) {
      sub = document.createElement("div");
      sub.className = "app-sub";
      sub.textContent = "Now";
      name.after(sub);
    } else if (!want && sub) sub.remove();
  });
}

function patchCalCells(d) {
  if (Lumen.view !== "months") return;
  const by = {};
  for (const row of (d.calendar && d.calendar.weeks) || []) {
    for (const c of row || []) {
      if (c && c.ymd) by[c.ymd] = c;
    }
  }
  const max = Math.max(1, (d.calendar && d.calendar.max_active) || 1);
  document.querySelectorAll("#stage [data-day]").forEach((el) => {
    const c = by[el.dataset.day];
    if (!c) return;
    el.dataset.active = String(c.active || 0);
    el.dataset.idle = String(c.idle || 0);
    el.dataset.lock = String(c.lock || 0);
    const mark = el.querySelector(".n");
    if (mark) mark.textContent = c.active ? fmtDur(c.active) : "";
    const t = (c.active || 0) / max;
    el.style.background = c.active ? `rgba(var(--accent-rgb), ${(0.2 + t * 0.55).toFixed(2)})` : "";
    el.classList.toggle("has-use", !!c.active);
    el.setAttribute(
      "aria-label",
      `${c.ymd}. Usage ${fmtDur(c.active)}. Idle ${fmtDur(c.idle)}. Lock ${fmtDur(c.lock)}`
    );
  });
}

function fmtCalDay(ymd) {
  const p = (ymd || "").split("-").map(Number);
  if (p.length !== 3 || !p[0]) return ymd || "";
  return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function weekTotalsSum() {
  const week = (Lumen.data && Lumen.data.week) || [];
  return week.reduce(
    (acc, x) => {
      const t = x.totals || {};
      acc.active += t.active || 0;
      acc.idle += t.idle || 0;
      acc.lock += t.lock || 0;
      return acc;
    },
    { active: 0, idle: 0, lock: 0 }
  );
}

function hoverDayStats(cell) {
  const has = (key) => cell.dataset[key] !== undefined && cell.dataset[key] !== "";
  let active = has("active") ? Number(cell.dataset.active) : NaN;
  let idle = has("idle") ? Number(cell.dataset.idle) : NaN;
  let lock = has("lock") ? Number(cell.dataset.lock) : NaN;
  if (!Number.isFinite(active) || !Number.isFinite(idle) || !Number.isFinite(lock)) {
    const w = ((Lumen.data && Lumen.data.week) || []).find((x) => x.day === cell.dataset.day);
    const t = (w && w.totals) || {};
    if (!Number.isFinite(active)) active = t.active || 0;
    if (!Number.isFinite(idle)) idle = t.idle || 0;
    if (!Number.isFinite(lock)) lock = t.lock || 0;
  }
  return { active: active || 0, idle: idle || 0, lock: lock || 0 };
}

function iconMap() {
  const icons = {};
  for (const block of (Lumen.data && Lumen.data.week) || []) {
    for (const a of block.apps || []) if (a.app && a.icon) icons[a.app] = a.icon;
  }
  for (const a of (Lumen.data && Lumen.data.apps) || []) if (a.app && a.icon) icons[a.app] = a.icon;
  return icons;
}

function fmtDayTitle(ymd) {
  const p = (ymd || "").split("-").map(Number);
  if (p.length !== 3 || !p[0]) return ymd || "";
  return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function weekDayFallback(ymd) {
  const week = (Lumen.data && Lumen.data.week) || [];
  const w = week.find((x) => x.day === ymd);
  if (!w) return null;
  const t = w.totals || {};
  const sum = weekTotalsSum();
  const idx = week.findIndex((x) => x.day === ymd);
  const first = week[0] && week[0].date_label;
  const last = week[week.length - 1] && week[week.length - 1].date_label;
  return {
    ok: true,
    day: ymd,
    label: fmtDayTitle(ymd),
    totals: t,
    apps: (w.apps || []).slice(),
    hourly: w.hourly || [],
    detailed: Array.isArray(w.hourly) && w.hourly.some((n) => n > 0),
    empty: !(t.active || t.idle || t.lock || t.sleep),
    week_active: sum.active,
    week_idle: sum.idle,
    week_lock: sum.lock,
    week_label: first && last ? `${first} – ${last}` : "This week",
    week_days: week.map((x) => ({
      ymd: x.day,
      label: x.label,
      d: String((x.date_label || "").split(" ")[0] || ""),
      active: (x.totals && x.totals.active) || 0,
      idle: (x.totals && x.totals.idle) || 0,
      lock: (x.totals && x.totals.lock) || 0,
      is_sel: x.day === ymd,
      future: false,
    })),
    prev_day: idx > 0 ? week[idx - 1].day : "",
    next_day: idx >= 0 && idx < week.length - 1 ? week[idx + 1].day : "",
  };
}

function hydrateDay(detail) {
  if (!detail || !detail.ok) return detail;
  const w = ((Lumen.data && Lumen.data.week) || []).find((x) => x.day === detail.day);
  const tot = detail.totals || {};
  const emptyTot = !(tot.active || tot.idle || tot.lock);
  if (w) {
    if (emptyTot && w.totals) detail.totals = { ...w.totals, ...tot, ...w.totals };
    if (!(detail.apps && detail.apps.length) && w.apps) detail.apps = w.apps.slice();
    if ((!detail.hourly || !detail.hourly.some((n) => n > 0)) && w.hourly) {
      detail.hourly = w.hourly;
      detail.detailed = true;
    }
    const next = detail.totals || {};
    if (next.active || next.idle || next.lock) detail.empty = false;
    if (!detail.week_active) {
      const sum = weekTotalsSum();
      detail.week_active = detail.week_active || sum.active;
      detail.week_idle = detail.week_idle || sum.idle;
      detail.week_lock = detail.week_lock || sum.lock;
    }
  }
  const icons = iconMap();
  detail.apps = (detail.apps || []).map((a) => ({ ...a, icon: a.icon || icons[a.app] || "" }));
  return detail;
}

function showCalTip(cell) {
  const tip = document.getElementById("calTip");
  if (!tip || !cell || !cell.dataset.day) return;
  document.querySelectorAll("#stage [data-day].is-hot").forEach((el) => el.classList.remove("is-hot"));
  cell.classList.add("is-hot");
  const st = hoverDayStats(cell);
  const week = weekTotalsSum();
  tip.innerHTML = `
    <div class="cal-tip-day">${escapeHtml(fmtCalDay(cell.dataset.day))}</div>
    <div class="cal-tip-row"><span>Usage</span><strong>${fmtDur(st.active)}</strong></div>
    <div class="cal-tip-row"><span>Idle</span><strong>${fmtDur(st.idle)}</strong></div>
    <div class="cal-tip-row"><span>Lock</span><strong>${fmtDur(st.lock)}</strong></div>
    <div class="cal-tip-row"><span>This week</span><strong>${fmtDur(week.active)}</strong></div>`;
  tip.hidden = false;
  const r = cell.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  let y = r.bottom + 8;
  x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
  if (y + th > window.innerHeight - 8) y = r.top - th - 8;
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function hideCalTip() {
  const tip = document.getElementById("calTip");
  if (tip) tip.hidden = true;
  document.querySelectorAll("#stage [data-day].is-hot").forEach((el) => el.classList.remove("is-hot"));
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fitCanvas(c) {
  const r = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  const tw = Math.round(w * r);
  const th = Math.round(h * r);
  if (c.width !== tw || c.height !== th) {
    c.width = tw;
    c.height = th;
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(r, 0, 0, r, 0, 0);
  return { ctx, w, h };
}

function chartFingerprint(d) {
  const today = (d.week || []).find((w) => w.day === d.today) || {};
  const batt = (today.battery || []).map((s) => `${s.ts}:${s.pct}:${s.status}`).join(",");
  const week = (d.week || [])
    .map((w) => {
      const t = w.totals || {};
      return `${w.day}:${t.active || 0}:${t.idle || 0}:${t.lock || 0}`;
    })
    .join("|");
  const hour = (d.hourly || []).join(",");
  const pct = (d.battery && d.battery.pct) || (d.stats && d.stats.battery) || "";
  return `${hour}#${week}#${batt}#${pct}`;
}

function paintCanvases(d) {
  document.querySelectorAll("#stage canvas[data-chart]").forEach((c) => {
    const kind = c.dataset.chart;
    if (kind === "hourly") paintHourly(c, d.hourly || [], false);
    if (kind === "dayhour" && Lumen.day) paintHourly(c, Lumen.day.hourly || [], false);
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
    const isSel = day.day === Lumen.selectedWeekDay;
    if (Lumen.selectedWeekDay && !isSel) {
      ctx.globalAlpha = 0.45;
    } else {
      ctx.globalAlpha = 1.0;
    }
    stack.forEach(([sec, color]) => {
      const bh = sec * scale;
      y -= bh;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, Math.max(sec ? 4 : 0, bh), 6);
      ctx.fill();
    });
    ctx.globalAlpha = 1.0;

    if (isSel) {
      ctx.fillStyle = sage;
      ctx.beginPath();
      ctx.arc(x + bw / 2, h - 3, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = isSel ? (cssVar("--ink") || "#fff") : dim;
    ctx.font = (isSel ? "600 " : "500 ") + "12px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(day.label || "", x + bw / 2, h - 9);
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
      Lumen.q = e.target.value;
      Lumen.render();
      const input = document.getElementById("q");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
    q.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        Lumen.q = "";
        Lumen.render();
      }
    });
  }
  document.querySelectorAll("[data-clear-search]").forEach((b) => {
    b.addEventListener("click", () => {
      Lumen.q = "";
      Lumen.render();
    });
  });
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
  if (e.target.closest("[data-clear-search]")) {
    Lumen.q = "";
    Lumen.render();
    return;
  }
  const selectWeekBtn = e.target.closest("[data-select-week-day]");
  if (selectWeekBtn && selectWeekBtn.dataset.selectWeekDay) {
    const ymd = selectWeekBtn.dataset.selectWeekDay;
    Lumen.selectedWeekDay = ymd;
    Lumen.render();
    return;
  }
  const selectCalBtn = e.target.closest("[data-select-cal-day]");
  if (selectCalBtn && selectCalBtn.dataset.selectCalDay) {
    const ymd = selectCalBtn.dataset.selectCalDay;
    Lumen.selectedCalDay = ymd;
    if (!Lumen.calDayData || !Lumen.calDayData[ymd]) {
      send({ op: "day", day: ymd });
    }
    Lumen.render();
    return;
  }
  const timelineBtn = e.target.closest("[data-day-timeline]");
  if (timelineBtn && timelineBtn.dataset.dayTimeline) {
    hideCalTip();
    const ymd = timelineBtn.dataset.dayTimeline;
    Lumen._openingFullDay = true;
    const cached = weekDayFallback(ymd);
    if (cached) Lumen.dayDetail(cached);
    send({ op: "day", day: ymd });
    return;
  }
  const calBtn = e.target.closest("[data-cal]");
  if (calBtn && !calBtn.disabled) {
    const cal = Lumen.calOverride || (Lumen.data && Lumen.data.calendar) || {};
    const { year, month } = calYearMonth(cal);
    if (!year || !month) return;
    const next = shiftYm(year, month, Number(calBtn.dataset.cal));
    Lumen.calendarData(buildClientMonthGrid(next.year, next.month));
    send({ op: "calendar", year: next.year, month: next.month });
    return;
  }
  const dayBtn = e.target.closest("[data-day]");
  if (dayBtn && !dayBtn.disabled && dayBtn.dataset.day) {
    hideCalTip();
    const ymd = dayBtn.dataset.day;
    Lumen._openingFullDay = true;
    const cached = weekDayFallback(ymd);
    if (cached) Lumen.dayDetail(cached);
    send({ op: "day", day: ymd });
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

document.getElementById("stage").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    const card = e.target.closest("[data-select-week-day], [data-select-cal-day]");
    if (card && (card === e.target || card.contains(e.target))) {
      e.preventDefault();
      card.click();
    }
  }
});

document.getElementById("stage").addEventListener("pointerover", (e) => {
  const cell = e.target.closest("[data-day]");
  if (cell && !cell.disabled) showCalTip(cell);
});
document.getElementById("stage").addEventListener("pointerout", (e) => {
  const cell = e.target.closest("[data-day]");
  if (!cell) return;
  if (e.relatedTarget && cell.contains(e.relatedTarget)) return;
  hideCalTip();
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
    .then((d) => {
      Lumen.push(d);
      const params = new URLSearchParams(location.search);
      const v = params.get("view");
      if (v) Lumen.go(v);
      const m = params.get("month");
      if (m) {
        const [y, mo] = m.split("-").map(Number);
        if (y && mo) {
          Lumen.calendarData(buildClientMonthGrid(y, mo));
        }
      }
    })
    .catch(() => {});
}
