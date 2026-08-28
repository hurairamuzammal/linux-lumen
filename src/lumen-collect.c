/*
 * lumen-collect — tiny native wellbeing recorder for Linux.
 *
 * Polls focus / idle / lock / suspend / battery, merges unchanged
 * slices, and appends a packed day file. The UI never has to stay open.
 *
 * Day file ~/.local/share/lumen/days/YYYY-MM-DD.lmn
 *   header 128 bytes: magic "LMN1", first_boot, sleep_sec ...
 *   rec 1 interval: u8 type=1, u32 start, u16 dur, u8 state, u32 ram_kb, u8 nlen, name
 *   rec 2 battery:  u8 type=2, u32 ts, u8 pct, u8 status, u16 power_mw
 *   rec 3 sleep:    u8 type=3, u32 start, u32 end
 */

#define _GNU_SOURCE
#include <atspi/atspi.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <gio/gio.h>
#include <glib-unix.h>
#include <glib.h>
#include <inttypes.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/sysinfo.h>
#include <time.h>
#include <unistd.h>

#define MAGIC "LMN1"
#define HDR_SIZE 128
#define NAME_CAP 48
#define POLL_DEFAULT 8
#define IDLE_DEFAULT 180
#define KEEP_DETAILED_DAYS 8
#define KEEP_MONTHS 12
#define DUR_FLUSH 45
#define BATT_GAP 60
#define MAX_DAY_BYTES (3u * 1024u * 1024u)

#define ST_ACTIVE 0
#define ST_IDLE 1
#define ST_LOCK 2
#define ST_SLEEP 3

#define BAT_DISCHARGE 0
#define BAT_CHARGE 1
#define BAT_FULL 2
#define BAT_AC_IDLE 3
#define BAT_UNKNOWN 4

typedef struct __attribute__((packed)) {
    char magic[4];
    guint8 version;
    guint8 flags;
    guint16 reserved;
    guint32 first_boot;
    guint32 last_flush;
    guint32 sleep_sec;
    guint32 recs;
    guint8 pad[104];
} Header;
_Static_assert(sizeof(Header) == HDR_SIZE, "LMN1 header must be 128 bytes");

typedef struct {
    guint32 start;
    guint16 dur;
    guint8 state;
    guint32 ram_kb;
    char name[NAME_CAP];
    long offset;
    int open;
} Interval;

typedef struct {
    char data_dir[512];
    char days_dir[512];
    char months_dir[512];
    char conf_path[512];
    char current_path[512];
    char lock_path[512];
    char day[16];
    FILE *fp;
    Header hdr;
    Interval cur;
    int lock_fd;
    int paused;
    int poll_sec;
    int idle_sec;
    int sleeping;
    guint32 last_batt_ts;
    guint8 last_batt_pct;
    guint8 last_batt_st;
    double last_suspend_sec;
    time_t conf_mtime;
    GMainLoop *loop;
    GDBusConnection *session;
    GDBusConnection *system;
    char session_path[256];
} Ctx;

static Ctx C;

static guint32 now_u32(void) {
    return (guint32)time(NULL);
}

static double clock_of(clockid_t id) {
    struct timespec ts;
    clock_gettime(id, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static void copy_name(char *dst, const char *src) {
    if (!src) {
        dst[0] = 0;
        return;
    }
    size_t n = strlen(src);
    if (n >= NAME_CAP)
        n = NAME_CAP - 1;
    while (n > 0 && ((unsigned char)src[n] & 0xC0) == 0x80)
        n--;
    memcpy(dst, src, n);
    dst[n] = 0;
}

static void local_day(char *out, time_t t) {
    struct tm tm;
    localtime_r(&t, &tm);
    strftime(out, 16, "%Y-%m-%d", &tm);
}

static int mkdir_p(const char *path) {
    return g_mkdir_with_parents(path, 0755);
}

static void json_esc(const char *s, char *out, size_t cap) {
    size_t j = 0;
    if (!s)
        s = "";
    for (size_t i = 0; s[i] && j + 2 < cap; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"' || c == '\\') {
            if (j + 3 >= cap)
                break;
            out[j++] = '\\';
            out[j++] = (char)c;
        } else if (c < 32) {
            continue;
        } else {
            out[j++] = (char)c;
        }
    }
    out[j] = 0;
}

static int ignore_name(const char *n) {
    static const char *exact[] = {
        "gnome-shell",
        "mutter-x11-frames",
        "gsd-keyboard",
        "gsd-color",
        "gsd-wacom",
        "gsd-power",
        "gsd-xsettings",
        "gsd-media-keys",
        "xdg-desktop-portal",
        "xdg-desktop-portal-gtk",
        "xdg-desktop-portal-gnome",
        "evolution-alarm-notify",
        "update-notifier",
        "at-spi2-registryd",
        "at-spi-bus-launcher",
        "pipewire",
        "wireplumber",
        "lumen-collect",
        "lumen",
        NULL
    };
    if (!n || !n[0])
        return 1;
    if (g_str_has_prefix(n, "gsd-") || g_str_has_prefix(n, "ibus"))
        return 1;
    for (int i = 0; exact[i]; i++) {
        if (strcmp(n, exact[i]) == 0)
            return 1;
    }
    return 0;
}

static void load_config(void) {
    struct stat st;
    if (stat(C.conf_path, &st) == 0) {
        if (C.conf_mtime && C.conf_mtime == st.st_mtime)
            return;
        C.conf_mtime = st.st_mtime;
    } else {
        if (C.conf_mtime == (time_t)-1)
            return;
        C.conf_mtime = (time_t)-1;
        C.poll_sec = POLL_DEFAULT;
        C.idle_sec = IDLE_DEFAULT;
        C.paused = 0;
        return;
    }
    C.poll_sec = POLL_DEFAULT;
    C.idle_sec = IDLE_DEFAULT;
    C.paused = 0;
    gchar *raw = NULL;
    if (!g_file_get_contents(C.conf_path, &raw, NULL, NULL) || !raw)
        return;
    gchar **lines = g_strsplit(raw, "\n", -1);
    for (gchar **p = lines; p && *p; p++) {
        gchar *line = g_strstrip(*p);
        if (!line[0] || line[0] == '#')
            continue;
        gchar *eq = strchr(line, '=');
        if (!eq)
            continue;
        *eq = 0;
        const char *k = g_strstrip(line);
        const char *v = g_strstrip(eq + 1);
        if (strcmp(k, "idle_sec") == 0) {
            int n = atoi(v);
            if (n >= 30 && n <= 3600)
                C.idle_sec = n;
        } else if (strcmp(k, "poll_sec") == 0) {
            int n = atoi(v);
            if (n >= 3 && n <= 60)
                C.poll_sec = n;
        } else if (strcmp(k, "paused") == 0) {
            C.paused = atoi(v) ? 1 : 0;
        }
    }
    g_strfreev(lines);
    g_free(raw);
}

static guint32 rss_pid_kb(pid_t pid) {
    char path[72], line[96];
    snprintf(path, sizeof path, "/proc/%d/smaps_rollup", (int)pid);
    FILE *f = fopen(path, "r");
    if (f) {
        unsigned long kb = 0;
        while (fgets(line, sizeof line, f)) {
            if (g_str_has_prefix(line, "Rss:")) {
                if (sscanf(line, "Rss: %lu", &kb) == 1) {
                    fclose(f);
                    return kb > G_MAXUINT32 ? G_MAXUINT32 : (guint32)kb;
                }
            }
        }
        fclose(f);
    }
    snprintf(path, sizeof path, "/proc/%d/statm", (int)pid);
    f = fopen(path, "r");
    if (!f)
        return 0;
    unsigned long size = 0, rss = 0;
    if (fscanf(f, "%lu %lu", &size, &rss) != 2) {
        fclose(f);
        return 0;
    }
    fclose(f);
    long page = sysconf(_SC_PAGESIZE);
    if (page <= 0)
        page = 4096;
    guint64 out = ((guint64)rss * (guint64)page) / 1024u;
    return out > G_MAXUINT32 ? G_MAXUINT32 : (guint32)out;
}

static int focus_app(char *name, pid_t *pid_out) {
    name[0] = 0;
    *pid_out = 0;
    AtspiAccessible *desktop = atspi_get_desktop(0);
    if (!desktop)
        return 0;
    GError *err = NULL;
    int n = atspi_accessible_get_child_count(desktop, &err);
    if (err) {
        g_error_free(err);
        err = NULL;
        n = 0;
    }
    char active_name[NAME_CAP] = {0};
    char focus_name[NAME_CAP] = {0};
    pid_t active_pid = 0, focus_pid = 0;

    for (int i = 0; i < n; i++) {
        err = NULL;
        AtspiAccessible *app = atspi_accessible_get_child_at_index(desktop, i, &err);
        if (err) {
            g_error_free(err);
            continue;
        }
        if (!app)
            continue;
        gchar *an = atspi_accessible_get_name(app, NULL);
        pid_t apid = 0;
        GError *perr = NULL;
        apid = (pid_t)atspi_accessible_get_process_id(app, &perr);
        if (perr)
            g_error_free(perr);

        err = NULL;
        int nw = atspi_accessible_get_child_count(app, &err);
        if (err) {
            g_error_free(err);
            nw = 0;
        }
        int interesting = an && !ignore_name(an);
        for (int j = 0; j < nw; j++) {
            AtspiAccessible *win = atspi_accessible_get_child_at_index(app, j, NULL);
            if (!win)
                continue;
            AtspiStateSet *ss = atspi_accessible_get_state_set(win);
            if (ss) {
                int is_active = atspi_state_set_contains(ss, ATSPI_STATE_ACTIVE);
                int is_focus = atspi_state_set_contains(ss, ATSPI_STATE_FOCUSED);
                if (interesting) {
                    if (is_active) {
                        copy_name(active_name, an);
                        active_pid = apid;
                    } else if (is_focus) {
                        copy_name(focus_name, an);
                        focus_pid = apid;
                    }
                }
                g_object_unref(ss);
            }
            g_object_unref(win);
        }
        g_free(an);
        g_object_unref(app);
    }

    if (active_name[0]) {
        memcpy(name, active_name, NAME_CAP);
        *pid_out = active_pid;
        g_object_unref(desktop);
        return 1;
    }
    if (focus_name[0]) {
        memcpy(name, focus_name, NAME_CAP);
        *pid_out = focus_pid;
        g_object_unref(desktop);
        return 1;
    }
    copy_name(name, "Desktop");
    *pid_out = 0;
    g_object_unref(desktop);
    return 0;
}

static guint64 mutter_idle_ms(void) {
    if (!C.session)
        return 0;
    GError *err = NULL;
    GVariant *ret = g_dbus_connection_call_sync(
        C.session,
        "org.gnome.Mutter.IdleMonitor",
        "/org/gnome/Mutter/IdleMonitor/Core",
        "org.gnome.Mutter.IdleMonitor",
        "GetIdletime",
        NULL,
        G_VARIANT_TYPE("(t)"),
        G_DBUS_CALL_FLAGS_NONE,
        250,
        NULL,
        &err);
    if (err) {
        g_error_free(err);
        return 0;
    }
    guint64 ms = 0;
    g_variant_get(ret, "(t)", &ms);
    g_variant_unref(ret);
    return ms;
}

static int screensaver_active(void) {
    if (!C.session)
        return 0;
    GError *err = NULL;
    GVariant *ret = g_dbus_connection_call_sync(
        C.session,
        "org.gnome.ScreenSaver",
        "/org/gnome/ScreenSaver",
        "org.gnome.ScreenSaver",
        "GetActive",
        NULL,
        G_VARIANT_TYPE("(b)"),
        G_DBUS_CALL_FLAGS_NONE,
        250,
        NULL,
        &err);
    if (err) {
        g_error_free(err);
        return 0;
    }
    gboolean a = FALSE;
    g_variant_get(ret, "(b)", &a);
    g_variant_unref(ret);
    return a ? 1 : 0;
}

static int locked_hint(void) {
    if (!C.system || !C.session_path[0])
        return 0;
    GError *err = NULL;
    GVariant *ret = g_dbus_connection_call_sync(
        C.system,
        "org.freedesktop.login1",
        C.session_path,
        "org.freedesktop.DBus.Properties",
        "Get",
        g_variant_new("(ss)", "org.freedesktop.login1.Session", "LockedHint"),
        G_VARIANT_TYPE("(v)"),
        G_DBUS_CALL_FLAGS_NONE,
        250,
        NULL,
        &err);
    if (err) {
        g_error_free(err);
        return 0;
    }
    GVariant *inner = NULL;
    g_variant_get(ret, "(v)", &inner);
    g_variant_unref(ret);
    gboolean locked = FALSE;
    if (inner) {
        g_variant_get(inner, "b", &locked);
        g_variant_unref(inner);
    }
    return locked ? 1 : 0;
}

static void resolve_session_path(void) {
    C.session_path[0] = 0;
    if (!C.system)
        return;
    const char *sid = getenv("XDG_SESSION_ID");
    GError *err = NULL;
    if (sid && sid[0]) {
        GVariant *ret = g_dbus_connection_call_sync(
            C.system,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
            "GetSession",
            g_variant_new("(s)", sid),
            G_VARIANT_TYPE("(o)"),
            G_DBUS_CALL_FLAGS_NONE,
            400,
            NULL,
            &err);
        if (!err && ret) {
            const char *p = NULL;
            g_variant_get(ret, "(&o)", &p);
            if (p)
                g_strlcpy(C.session_path, p, sizeof C.session_path);
            g_variant_unref(ret);
            return;
        }
        if (err)
            g_error_free(err);
        err = NULL;
    }
    GVariant *ret = g_dbus_connection_call_sync(
        C.system,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
        "ListSessions",
        NULL,
        G_VARIANT_TYPE("(a(susso))"),
        G_DBUS_CALL_FLAGS_NONE,
        400,
        NULL,
        &err);
    if (err || !ret) {
        if (err)
            g_error_free(err);
        return;
    }
    GVariantIter *it = NULL;
    g_variant_get(ret, "(a(susso))", &it);
    const gchar *id = NULL, *user = NULL, *seat = NULL, *path = NULL;
    guint32 uid = 0;
    uid_t me = getuid();
    while (g_variant_iter_loop(it, "(&su&s&s&o)", &id, &uid, &user, &seat, &path)) {
        if (uid == me && seat && seat[0] && path) {
            g_strlcpy(C.session_path, path, sizeof C.session_path);
            break;
        }
    }
    g_variant_iter_free(it);
    g_variant_unref(ret);
}

static int read_battery(guint8 *pct, guint8 *status, guint16 *mw) {
    *pct = 0;
    *status = BAT_UNKNOWN;
    *mw = 0;
    DIR *d = opendir("/sys/class/power_supply");
    if (!d)
        return 0;
    char bat[64] = {0};
    struct dirent *e;
    while ((e = readdir(d))) {
        if (g_str_has_prefix(e->d_name, "BAT")) {
            g_strlcpy(bat, e->d_name, sizeof bat);
            break;
        }
    }
    closedir(d);
    if (!bat[0])
        return 0;
    char path[128], buf[128];
    snprintf(path, sizeof path, "/sys/class/power_supply/%s/capacity", bat);
    FILE *f = fopen(path, "r");
    if (f) {
        int v = 0;
        if (fscanf(f, "%d", &v) == 1 && v >= 0 && v <= 100)
            *pct = (guint8)v;
        fclose(f);
    }
    snprintf(path, sizeof path, "/sys/class/power_supply/%s/status", bat);
    f = fopen(path, "r");
    if (f && fgets(buf, sizeof buf, f)) {
        if (g_str_has_prefix(buf, "Charging"))
            *status = BAT_CHARGE;
        else if (g_str_has_prefix(buf, "Full"))
            *status = BAT_FULL;
        else if (g_str_has_prefix(buf, "Not charging"))
            *status = BAT_AC_IDLE;
        else if (g_str_has_prefix(buf, "Discharging"))
            *status = BAT_DISCHARGE;
        fclose(f);
    } else if (f) {
        fclose(f);
    }
    snprintf(path, sizeof path, "/sys/class/power_supply/%s/power_now", bat);
    f = fopen(path, "r");
    if (f) {
        long v = 0;
        if (fscanf(f, "%ld", &v) == 1) {
            long pmw = v / 1000;
            if (pmw < 0)
                pmw = -pmw;
            if (pmw > 65535)
                pmw = 65535;
            *mw = (guint16)pmw;
        }
        fclose(f);
    }
    return 1;
}

static void header_sync(void) {
    if (!C.fp)
        return;
    long end = ftell(C.fp);
    C.hdr.last_flush = now_u32();
    memcpy(C.hdr.magic, MAGIC, 4);
    C.hdr.version = 1;
    rewind(C.fp);
    fwrite(&C.hdr, 1, HDR_SIZE, C.fp);
    if (end < HDR_SIZE)
        end = HDR_SIZE;
    fseek(C.fp, end, SEEK_SET);
    fflush(C.fp);
}

static int day_bytes_ok(void) {
    if (!C.fp)
        return 0;
    long pos = ftell(C.fp);
    return pos >= 0 && (unsigned long)pos < MAX_DAY_BYTES;
}

static void write_interval_at(long off, const Interval *iv) {
    guint8 nlen = (guint8)strlen(iv->name);
    if (nlen >= NAME_CAP)
        nlen = NAME_CAP - 1;
    fseek(C.fp, off, SEEK_SET);
    guint8 type = 1;
    fwrite(&type, 1, 1, C.fp);
    fwrite(&iv->start, 4, 1, C.fp);
    fwrite(&iv->dur, 2, 1, C.fp);
    fwrite(&iv->state, 1, 1, C.fp);
    fwrite(&iv->ram_kb, 4, 1, C.fp);
    fwrite(&nlen, 1, 1, C.fp);
    fwrite(iv->name, 1, nlen, C.fp);
}

static void append_battery(guint32 ts, guint8 pct, guint8 st, guint16 mw) {
    if (!C.fp || !day_bytes_ok())
        return;
    guint8 type = 2;
    fwrite(&type, 1, 1, C.fp);
    fwrite(&ts, 4, 1, C.fp);
    fwrite(&pct, 1, 1, C.fp);
    fwrite(&st, 1, 1, C.fp);
    fwrite(&mw, 2, 1, C.fp);
    C.hdr.recs++;
}

static void append_sleep(guint32 a, guint32 b) {
    if (!C.fp || !day_bytes_ok() || b <= a)
        return;
    guint8 type = 3;
    fwrite(&type, 1, 1, C.fp);
    fwrite(&a, 4, 1, C.fp);
    fwrite(&b, 4, 1, C.fp);
    C.hdr.sleep_sec += (b - a);
    C.hdr.recs++;
    header_sync();
}

static void close_interval(void) {
    if (!C.cur.open || !C.fp)
        return;
    guint32 n = now_u32();
    guint32 d = n >= C.cur.start ? n - C.cur.start : 0;
    if (d > 65535)
        d = 65535;
    if (d == 0)
        d = (guint16)C.poll_sec;
    C.cur.dur = (guint16)d;
    write_interval_at(C.cur.offset, &C.cur);
    fflush(C.fp);
    C.cur.open = 0;
}

static void open_interval(guint8 state, const char *name, guint32 ram) {
    if (!C.fp || !day_bytes_ok())
        return;
    memset(&C.cur, 0, sizeof C.cur);
    C.cur.start = now_u32();
    C.cur.dur = (guint16)C.poll_sec;
    C.cur.state = state;
    C.cur.ram_kb = ram;
    copy_name(C.cur.name, name);
    C.cur.offset = ftell(C.fp);
    write_interval_at(C.cur.offset, &C.cur);
    C.hdr.recs++;
    C.cur.open = 1;
    fflush(C.fp);
}

static void open_day_file(const char *day) {
    if (C.fp) {
        close_interval();
        header_sync();
        fclose(C.fp);
        C.fp = NULL;
    }
    g_strlcpy(C.day, day, sizeof C.day);
    char path[600];
    snprintf(path, sizeof path, "%s/%s.lmn", C.days_dir, day);
    int exists = access(path, F_OK) == 0;
    C.fp = fopen(path, exists ? "r+b" : "w+b");
    if (!C.fp)
        return;
    memset(&C.hdr, 0, sizeof C.hdr);
    if (exists) {
        if (fread(&C.hdr, 1, HDR_SIZE, C.fp) != HDR_SIZE || memcmp(C.hdr.magic, MAGIC, 4) != 0) {
            fclose(C.fp);
            C.fp = fopen(path, "w+b");
            memset(&C.hdr, 0, sizeof C.hdr);
            exists = 0;
        } else {
            fseek(C.fp, 0, SEEK_END);
        }
    }
    if (!exists) {
        memcpy(C.hdr.magic, MAGIC, 4);
        C.hdr.version = 1;
        header_sync();
    }
}

/* ---- month rollup: parse older day files into compact JSON ---- */

typedef struct {
    char name[NAME_CAP];
    guint32 sec;
} AppSum;

static int parse_day_totals(const char *path, guint32 *active, guint32 *idle, guint32 *lock,
                            guint32 *sleep, guint32 *boot, AppSum *apps, int *napp, int maxapp) {
    *active = *idle = *lock = *sleep = *boot = 0;
    *napp = 0;
    FILE *f = fopen(path, "rb");
    if (!f)
        return 0;
    Header h;
    if (fread(&h, 1, HDR_SIZE, f) != HDR_SIZE || memcmp(h.magic, MAGIC, 4) != 0) {
        fclose(f);
        return 0;
    }
    *boot = h.first_boot;
    *sleep = h.sleep_sec;
    for (;;) {
        int t = fgetc(f);
        if (t == EOF)
            break;
        if (t == 1) {
            guint32 start, ram;
            guint16 dur;
            guint8 st, nlen;
            char nm[NAME_CAP];
            if (fread(&start, 4, 1, f) != 1)
                break;
            if (fread(&dur, 2, 1, f) != 1)
                break;
            if (fread(&st, 1, 1, f) != 1)
                break;
            if (fread(&ram, 4, 1, f) != 1)
                break;
            if (fread(&nlen, 1, 1, f) != 1)
                break;
            if (nlen >= NAME_CAP)
                nlen = NAME_CAP - 1;
            memset(nm, 0, sizeof nm);
            if (nlen && fread(nm, 1, nlen, f) != nlen)
                break;
            if (st == ST_ACTIVE)
                *active += dur;
            else if (st == ST_IDLE)
                *idle += dur;
            else if (st == ST_LOCK)
                *lock += dur;
            else if (st == ST_SLEEP)
                *sleep += dur;
            if (st == ST_ACTIVE && nm[0] && *napp < maxapp) {
                int found = -1;
                for (int i = 0; i < *napp; i++) {
                    if (strcmp(apps[i].name, nm) == 0) {
                        found = i;
                        break;
                    }
                }
                if (found < 0) {
                    found = (*napp)++;
                    copy_name(apps[found].name, nm);
                    apps[found].sec = 0;
                }
                apps[found].sec += dur;
            }
        } else if (t == 2) {
            guint32 ts;
            guint8 pct, st;
            guint16 mw;
            if (fread(&ts, 4, 1, f) != 1)
                break;
            if (fread(&pct, 1, 1, f) != 1)
                break;
            if (fread(&st, 1, 1, f) != 1)
                break;
            if (fread(&mw, 2, 1, f) != 1)
                break;
            (void)ts;
            (void)pct;
            (void)st;
            (void)mw;
        } else if (t == 3) {
            guint32 a, b;
            if (fread(&a, 4, 1, f) != 1)
                break;
            if (fread(&b, 4, 1, f) != 1)
                break;
            if (b > a)
                *sleep += (b - a);
        } else {
            break;
        }
    }
    fclose(f);
    return 1;
}

static void json_put_day(GString *s, const char *dd, guint32 a, guint32 i, guint32 l, guint32 sl,
                         guint32 boot, AppSum *apps, int napp) {
    g_string_append_printf(s, "\"%s\":{\"a\":%u,\"i\":%u,\"l\":%u,\"s\":%u,\"boot\":%u,\"apps\":{",
                           dd, a, i, l, sl, boot);
    for (int k = 0; k < napp; k++) {
        char esc[NAME_CAP * 2];
        json_esc(apps[k].name, esc, sizeof esc);
        g_string_append_printf(s, "%s\"%s\":%u", k ? "," : "", esc, apps[k].sec);
    }
    g_string_append(s, "}}");
}

static time_t day_start_local(const char *ymd) {
    struct tm tm;
    memset(&tm, 0, sizeof tm);
    if (sscanf(ymd, "%d-%d-%d", &tm.tm_year, &tm.tm_mon, &tm.tm_mday) != 3)
        return 0;
    tm.tm_year -= 1900;
    tm.tm_mon -= 1;
    tm.tm_isdst = -1;
    return mktime(&tm);
}

static void rollup_old_days(void) {
    DIR *d = opendir(C.days_dir);
    if (!d)
        return;
    char today[16];
    local_day(today, time(NULL));
    time_t today_t = day_start_local(today);
    struct dirent *e;
    while ((e = readdir(d))) {
        size_t len = strlen(e->d_name);
        if (len != 14 || !g_str_has_suffix(e->d_name, ".lmn"))
            continue;
        char ymd[16];
        memcpy(ymd, e->d_name, 10);
        ymd[10] = 0;
        time_t dt = day_start_local(ymd);
        if (!dt || today_t - dt < KEEP_DETAILED_DAYS * 86400)
            continue;
        char path[600];
        snprintf(path, sizeof path, "%s/%s", C.days_dir, e->d_name);
        AppSum apps[128];
        int napp = 0;
        guint32 a, i, l, sl, boot;
        if (!parse_day_totals(path, &a, &i, &l, &sl, &boot, apps, &napp, 128))
            continue;
        char month[8];
        memcpy(month, ymd, 7);
        month[7] = 0;
        char mpath[600];
        snprintf(mpath, sizeof mpath, "%s/%s.json", C.months_dir, month);
        gchar *old = NULL;
        gsize oldn = 0;
        g_file_get_contents(mpath, &old, &oldn, NULL);
        GString *out = g_string_new("{\"month\":\"");
        g_string_append(out, month);
        g_string_append(out, "\",\"days\":{");
        /* Keep existing days except the one we replace, then append ours. */
        int first = 1;
        if (old && oldn > 10) {
            /* Naive merge: if this dd already in file, skip full rewrite via rebuild
             * from scratch of keys is hard without a parser. We append-replace by
             * dropping a previous '"dd":{...}' — keep it simple: if not present, insert. */
            if (!strstr(old, ymd)) {
                /* copy inner days object if present */
                char *days = strstr(old, "\"days\":{");
                if (days) {
                    days += 8;
                    char *end = strrchr(days, '}');
                    if (end && end > days + 1) {
                        g_string_append_len(out, days, (gssize)(end - days));
                        first = (end - days) < 2;
                    }
                }
            } else {
                unlink(path);
                g_string_free(out, TRUE);
                g_free(old);
                continue;
            }
        }
        if (!first)
            g_string_append_c(out, ',');
        json_put_day(out, ymd + 8, a, i, l, sl, boot, apps, napp);
        g_string_append(out, "}}");
        g_file_set_contents(mpath, out->str, out->len, NULL);
        g_string_free(out, TRUE);
        g_free(old);
        unlink(path);
    }
    closedir(d);

    /* Drop month files older than KEEP_MONTHS. */
    DIR *m = opendir(C.months_dir);
    if (!m)
        return;
    char curm[8];
    memcpy(curm, today, 7);
    curm[7] = 0;
    int cy = 0, cm = 0;
    sscanf(curm, "%d-%d", &cy, &cm);
    while ((e = readdir(m))) {
        int y = 0, mo = 0;
        if (sscanf(e->d_name, "%d-%d.json", &y, &mo) != 2)
            continue;
        int months = (cy - y) * 12 + (cm - mo);
        if (months > KEEP_MONTHS) {
            char p[600];
            snprintf(p, sizeof p, "%s/%s", C.months_dir, e->d_name);
            unlink(p);
        }
    }
    closedir(m);
}

static void write_current(guint8 state, const char *app, guint32 ram, guint64 idle_ms,
                          int locked, guint8 pct, guint8 bst, guint16 mw) {
    const char *stn[] = {"active", "idle", "lock", "sleep"};
    const char *bn[] = {"discharging", "charging", "full", "ac-idle", "unknown"};
    char esc[NAME_CAP * 2];
    json_esc(app, esc, sizeof esc);
    char json[768];
    snprintf(json, sizeof json,
             "{\"ts\":%u,\"day\":\"%s\",\"app\":\"%s\",\"state\":\"%s\",\"idle_ms\":%" PRIu64 ","
             "\"locked\":%s,\"paused\":%s,\"batt\":%u,\"batt_status\":\"%s\",\"power_mw\":%u,"
             "\"ram_kb\":%u,\"sleep_today\":%u,\"first_boot\":%u,\"poll_sec\":%d,\"idle_sec\":%d,"
             "\"pid\":%d}\n",
             now_u32(), C.day, esc, stn[state > 3 ? 0 : state], idle_ms,
             locked ? "true" : "false", C.paused ? "true" : "false", pct,
             bn[bst > 4 ? 4 : bst], mw, ram, C.hdr.sleep_sec, C.hdr.first_boot, C.poll_sec,
             C.idle_sec, (int)getpid());
    g_file_set_contents(C.current_path, json, -1, NULL);
}

static guint8 classify(int locked, guint64 idle_ms, int sleeping) {
    if (sleeping)
        return ST_SLEEP;
    if (locked)
        return ST_LOCK;
    if ((idle_ms / 1000ull) >= (guint64)C.idle_sec)
        return ST_IDLE;
    return ST_ACTIVE;
}

static void detect_suspend(void) {
    double bt = clock_of(CLOCK_BOOTTIME);
    double mo = clock_of(CLOCK_MONOTONIC);
    double sus = bt - mo;
    if (C.last_suspend_sec <= 0) {
        C.last_suspend_sec = sus;
        return;
    }
    double gap = sus - C.last_suspend_sec;
    if (gap >= 8.0) {
        guint32 n = now_u32();
        guint32 a = n > (guint32)gap ? n - (guint32)gap : n;
        append_sleep(a, n);
        if (C.cur.open && C.cur.state != ST_SLEEP)
            close_interval();
    }
    C.last_suspend_sec = sus;
}

static gboolean tick(gpointer data) {
    (void)data;
    load_config();

    char day[16];
    local_day(day, time(NULL));
    if (strcmp(day, C.day) != 0) {
        open_day_file(day);
        rollup_old_days();
    }
    if (!C.fp)
        open_day_file(day);

    detect_suspend();

    guint64 idle_ms = mutter_idle_ms();
    int locked = locked_hint() || screensaver_active();
    char app[NAME_CAP];
    pid_t pid = 0;
    focus_app(app, &pid);
    guint32 ram = rss_pid_kb(pid);
    guint8 pct = 0, bst = BAT_UNKNOWN;
    guint16 mw = 0;
    int have_bat = read_battery(&pct, &bst, &mw);
    guint8 state = classify(locked, idle_ms, C.sleeping);
    if (state != ST_ACTIVE)
        ram = C.cur.open && C.cur.state == state ? C.cur.ram_kb : ram;

    if (C.hdr.first_boot == 0 && !C.paused && state != ST_SLEEP) {
        C.hdr.first_boot = now_u32();
        header_sync();
    }

    if (!C.paused && C.fp) {
        int same = C.cur.open && C.cur.state == state && strcmp(C.cur.name, app) == 0;
        if (state == ST_LOCK || state == ST_SLEEP || state == ST_IDLE) {
            /* Keep a stable label so slices merge. */
            const char *label = state == ST_LOCK ? "Lock screen" : state == ST_SLEEP ? "Sleep"
                                                                                     : "Idle";
            same = C.cur.open && C.cur.state == state;
            copy_name(app, label);
        }
        if (!same) {
            close_interval();
            open_interval(state, app, ram);
        } else {
            guint32 n = now_u32();
            guint32 d = n >= C.cur.start ? n - C.cur.start : 0;
            if (d > 65000) {
                close_interval();
                open_interval(state, app, ram);
            } else {
                C.cur.dur = (guint16)(d ? d : (guint32)C.poll_sec);
                C.cur.ram_kb = ram ? ram : C.cur.ram_kb;
                if ((n - C.cur.start) % (guint32)DUR_FLUSH < (guint32)C.poll_sec + 1)
                    write_interval_at(C.cur.offset, &C.cur);
            }
        }
        if (have_bat) {
            guint32 ts = now_u32();
            int changed = pct != C.last_batt_pct || bst != C.last_batt_st;
            if (changed || ts - C.last_batt_ts >= BATT_GAP) {
                append_battery(ts, pct, bst, mw);
                C.last_batt_ts = ts;
                C.last_batt_pct = pct;
                C.last_batt_st = bst;
            }
        }
    }

    write_current(state, app, ram, idle_ms, locked, pct, bst, mw);
    return G_SOURCE_CONTINUE;
}

static void on_prepare_sleep(GDBusConnection *c, const gchar *s, const gchar *p, const gchar *i,
                             const gchar *n, GVariant *params, gpointer u) {
    (void)c;
    (void)s;
    (void)p;
    (void)i;
    (void)n;
    (void)u;
    gboolean going = FALSE;
    g_variant_get(params, "(b)", &going);
    C.sleeping = going ? 1 : 0;
    if (going) {
        char app[NAME_CAP];
        copy_name(app, "Sleep");
        close_interval();
        if (!C.paused && C.fp)
            open_interval(ST_SLEEP, app, 0);
        if (C.fp) {
            fflush(C.fp);
            fsync(fileno(C.fp));
        }
        header_sync();
    } else {
        close_interval();
        detect_suspend();
    }
}

static gboolean on_quit(gpointer data) {
    (void)data;
    close_interval();
    if (C.fp) {
        header_sync();
        fsync(fileno(C.fp));
        fclose(C.fp);
        C.fp = NULL;
    }
    if (C.session) {
        g_object_unref(C.session);
        C.session = NULL;
    }
    if (C.system) {
        g_object_unref(C.system);
        C.system = NULL;
    }
    atspi_exit();
    if (C.lock_fd >= 0) {
        close(C.lock_fd);
        C.lock_fd = -1;
    }
    if (C.loop)
        g_main_loop_quit(C.loop);
    return G_SOURCE_REMOVE;
}

static void paths_init(void) {
    const char *home = getenv("HOME");
    const char *xd = getenv("XDG_DATA_HOME");
    const char *xc = getenv("XDG_CONFIG_HOME");
    char base[400];
    if (xd && xd[0])
        snprintf(base, sizeof base, "%s/lumen", xd);
    else
        snprintf(base, sizeof base, "%s/.local/share/lumen", home ? home : ".");
    g_strlcpy(C.data_dir, base, sizeof C.data_dir);
    snprintf(C.days_dir, sizeof C.days_dir, "%s/days", C.data_dir);
    snprintf(C.months_dir, sizeof C.months_dir, "%s/months", C.data_dir);
    snprintf(C.current_path, sizeof C.current_path, "%s/current.json", C.data_dir);
    snprintf(C.lock_path, sizeof C.lock_path, "%s/lumen.lock", C.data_dir);
    if (xc && xc[0])
        snprintf(C.conf_path, sizeof C.conf_path, "%s/lumen/collector.conf", xc);
    else
        snprintf(C.conf_path, sizeof C.conf_path, "%s/.config/lumen/collector.conf", home ? home : ".");
    mkdir_p(C.data_dir);
    mkdir_p(C.days_dir);
    mkdir_p(C.months_dir);
    char cdir[512];
    g_strlcpy(cdir, C.conf_path, sizeof cdir);
    char *slash = strrchr(cdir, '/');
    if (slash) {
        *slash = 0;
        mkdir_p(cdir);
    }
}

static int take_lock(void) {
    C.lock_fd = open(C.lock_path, O_CREAT | O_RDWR, 0644);
    if (C.lock_fd < 0)
        return 0;
    if (flock(C.lock_fd, LOCK_EX | LOCK_NB) != 0) {
        close(C.lock_fd);
        C.lock_fd = -1;
        return 0;
    }
    char buf[32];
    int n = snprintf(buf, sizeof buf, "%d\n", (int)getpid());
    if (n > 0) {
        (void)!ftruncate(C.lock_fd, 0);
        (void)!write(C.lock_fd, buf, (size_t)n);
    }
    return 1;
}

static void print_once(void) {
    atspi_init();
    C.session = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL);
    C.system = g_bus_get_sync(G_BUS_TYPE_SYSTEM, NULL, NULL);
    resolve_session_path();
    char app[NAME_CAP];
    pid_t pid = 0;
    focus_app(app, &pid);
    guint64 idle = mutter_idle_ms();
    int locked = locked_hint() || screensaver_active();
    guint8 pct = 0, st = 0;
    guint16 mw = 0;
    read_battery(&pct, &st, &mw);
    printf("app=%s pid=%d ram_kb=%u idle_ms=%" PRIu64 " locked=%d batt=%u status=%u power_mw=%u "
           "suspend_sec=%.0f\n",
           app, (int)pid, rss_pid_kb(pid), idle, locked, pct, st, mw,
           clock_of(CLOCK_BOOTTIME) - clock_of(CLOCK_MONOTONIC));
}

int main(int argc, char **argv) {
    memset(&C, 0, sizeof C);
    C.lock_fd = -1;
    paths_init();
    load_config();

    if (argc > 1 && strcmp(argv[1], "--once") == 0) {
        print_once();
        return 0;
    }
    if (argc > 1 && (strcmp(argv[1], "--help") == 0 || strcmp(argv[1], "-h") == 0)) {
        fprintf(stderr, "lumen-collect [--once]\n  records screen time, idle, lock, sleep, battery\n");
        return 0;
    }

    if (!take_lock()) {
        fprintf(stderr, "lumen-collect already running\n");
        return 0; /* not a failure — systemd must not restart-loop */
    }

    atspi_init();
    C.session = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL);
    C.system = g_bus_get_sync(G_BUS_TYPE_SYSTEM, NULL, NULL);
    resolve_session_path();

    char day[16];
    local_day(day, time(NULL));
    open_day_file(day);
    rollup_old_days();
    C.last_suspend_sec = clock_of(CLOCK_BOOTTIME) - clock_of(CLOCK_MONOTONIC);

    if (C.system) {
        g_dbus_connection_signal_subscribe(
            C.system,
            "org.freedesktop.login1",
            "org.freedesktop.login1.Manager",
            "PrepareForSleep",
            "/org/freedesktop/login1",
            NULL,
            G_DBUS_SIGNAL_FLAGS_NONE,
            on_prepare_sleep,
            NULL,
            NULL);
    }

    C.loop = g_main_loop_new(NULL, FALSE);
    g_unix_signal_add(SIGTERM, on_quit, NULL);
    g_unix_signal_add(SIGINT, on_quit, NULL);
    g_unix_signal_add(SIGHUP, on_quit, NULL);
    tick(NULL);
    g_timeout_add_seconds((guint)C.poll_sec, tick, NULL);
    g_main_loop_run(C.loop);
    g_main_loop_unref(C.loop);
    return 0;
}
