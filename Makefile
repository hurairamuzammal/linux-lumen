VERSION := 1.0.0
ARCH    := $(shell uname -m)
DIST    := lumen-v$(VERSION)-linux-$(ARCH)

PREFIX  ?= $(HOME)/.local
BINDIR  := $(PREFIX)/bin
DATADIR := $(PREFIX)/share/lumen
APPDIR  := $(PREFIX)/share/applications
ICONDIR := $(PREFIX)/share/icons/hicolor/scalable/apps
UNITDIR := $(HOME)/.config/systemd/user

CC      ?= gcc
CFLAGS  ?= -std=c11 -Os -Wall -Wextra -fno-ident -ffunction-sections -fdata-sections -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE
CFLAGS  += $(shell pkg-config --cflags glib-2.0 gio-2.0 atspi-2)
LDFLAGS ?= -Wl,--gc-sections -Wl,-z,relro,-z,now -pie -s
LIBS    := $(shell pkg-config --libs glib-2.0 gio-2.0 atspi-2)

.PHONY: all collect clean install uninstall test dist

all: collect

collect: build/lumen-collect

build/lumen-collect: src/lumen-collect.c
	@mkdir -p build
	$(CC) $(CFLAGS) $< -o $@ $(LIBS) $(LDFLAGS)
	@size $@ || true

clean:
	rm -rf build

test:
	python3 -m unittest discover -s tests -v

install: collect
	install -d $(BINDIR) $(DATADIR)/web/fonts $(APPDIR) $(ICONDIR) $(UNITDIR)
	install -m 755 build/lumen-collect $(BINDIR)/lumen-collect
	install -m 755 scripts/lumen $(BINDIR)/lumen
	install -m 644 ui/lumen_store.py ui/lumen_app.py $(DATADIR)/
	cp -a ui/web/. $(DATADIR)/web/
	rm -f $(DATADIR)/web/preview.html $(DATADIR)/web/preview-data.json
	sed "s|^Exec=.*|Exec=$(BINDIR)/lumen|" packaging/org.lumen.Wellbeing.desktop > $(APPDIR)/org.lumen.Wellbeing.desktop
	chmod 644 $(APPDIR)/org.lumen.Wellbeing.desktop
	install -m 644 packaging/icons/org.lumen.Wellbeing.svg $(ICONDIR)/
	install -m 644 packaging/systemd/lumen-collect.service $(UNITDIR)/
	rm -f $(HOME)/.config/autostart/lumen-collect.desktop
	@command -v update-desktop-database >/dev/null && update-desktop-database $(APPDIR) || true
	@command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f $(PREFIX)/share/icons/hicolor >/dev/null 2>&1 || true
	@echo "Installed to $(PREFIX). Enable collector with:"
	@echo "  systemctl --user daemon-reload && systemctl --user enable --now lumen-collect.service"

uninstall:
	-systemctl --user disable --now lumen-collect.service
	rm -f $(BINDIR)/lumen $(BINDIR)/lumen-collect
	rm -rf $(DATADIR)
	rm -f $(APPDIR)/org.lumen.Wellbeing.desktop
	rm -f $(ICONDIR)/org.lumen.Wellbeing.svg
	rm -f $(UNITDIR)/lumen-collect.service
	rm -f $(HOME)/.config/autostart/lumen-collect.desktop

dist: collect
	@rm -rf build/$(DIST) build/$(DIST).tar.gz
	@mkdir -p build/$(DIST)/build build/$(DIST)/src build/$(DIST)/scripts build/$(DIST)/ui build/$(DIST)/packaging build/$(DIST)/docs build/$(DIST)/tests
	cp -a build/lumen-collect build/$(DIST)/build/
	cp -a src/lumen-collect.c build/$(DIST)/src/
	cp -a scripts/install.sh scripts/lumen build/$(DIST)/scripts/
	cp -a ui/lumen_app.py ui/lumen_store.py ui/web build/$(DIST)/ui/
	rm -f build/$(DIST)/ui/web/preview.html build/$(DIST)/ui/web/preview-data.json
	cp -a packaging/. build/$(DIST)/packaging/
	cp -a docs/. build/$(DIST)/docs/
	cp -a tests/*.py build/$(DIST)/tests/
	cp -a Makefile README.md SECURITY.md LICENSE build/$(DIST)/
	tar -C build -czf build/$(DIST).tar.gz $(DIST)
	@rm -rf build/$(DIST)
	@cd build && sha256sum $(DIST).tar.gz > $(DIST).tar.gz.sha256
	@echo "Built release archive: build/$(DIST).tar.gz"
