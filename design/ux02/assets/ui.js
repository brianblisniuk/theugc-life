(function () {
  var KEY = "ux02-theme";

  function theme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function applyTheme(next) {
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(KEY, next);
    } catch (err) {
      /* sample frames still switch without storage */
    }
    document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
      var dark = next === "dark";
      btn.setAttribute("aria-pressed", dark ? "true" : "false");
      btn.textContent = dark ? "Theme: Dark" : "Theme: Light";
    });
  }

  try {
    var stored = localStorage.getItem(KEY);
    if (stored === "dark" || stored === "light") applyTheme(stored);
    else applyTheme(theme());
  } catch (err) {
    applyTheme(theme());
  }

  document.addEventListener("click", function (event) {
    var toggle = event.target.closest("[data-theme-toggle]");
    if (toggle) {
      applyTheme(theme() === "dark" ? "light" : "dark");
      return;
    }

    var opener = event.target.closest("[data-popover-open]");
    if (opener) {
      var pop = document.getElementById(opener.getAttribute("aria-controls"));
      if (!pop) return;
      var open = opener.getAttribute("aria-expanded") === "true";
      closePopovers();
      if (!open) {
        pop.hidden = false;
        opener.setAttribute("aria-expanded", "true");
        var focusable = pop.querySelector("select, input, button, a, textarea");
        if (focusable) focusable.focus();
      }
      return;
    }

    if (!event.target.closest(".popover") && !event.target.closest(".sheet")) {
      closePopovers();
    }

    var pin = event.target.closest("[data-pin]");
    if (pin) {
      openPreview(pin);
      return;
    }

    var metricBtn = event.target.closest("[data-metric-pick]");
    if (metricBtn) {
      showMetric(metricBtn.getAttribute("data-metric-pick"));
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closePopovers();
      closePreview();
    }
  });

  function closePopovers() {
    document.querySelectorAll("[data-popover]").forEach(function (pop) {
      pop.hidden = true;
    });
    document.querySelectorAll("[data-popover-open]").forEach(function (btn) {
      btn.setAttribute("aria-expanded", "false");
    });
    document.querySelectorAll("[data-sheet]").forEach(function (sheet) {
      if (sheet.hasAttribute("data-sheet-locked")) return;
      sheet.hidden = true;
    });
  }

  document.querySelectorAll("[data-sort]").forEach(function (select) {
    select.addEventListener("change", function () {
      applySort(select);
    });
    applySort(select);
  });

  function applySort(select) {
    var option = select.options[select.selectedIndex];
    var premium = option && option.hasAttribute("data-premium");
    var plan = select.getAttribute("data-plan") || "free";
    var lock = document.getElementById(select.getAttribute("data-lock"));
    var list = document.getElementById(select.getAttribute("data-list"));
    if (premium && plan === "free") {
      if (lock) lock.hidden = false;
      if (list) orderRows(list, "name");
      return;
    }
    if (lock) lock.hidden = true;
    if (list) orderRows(list, select.value);
  }

  function orderRows(list, metric) {
    var rows = Array.prototype.slice.call(list.querySelectorAll("[data-hotel]"));
    rows.sort(function (a, b) {
      if (metric === "name") return a.getAttribute("data-name").localeCompare(b.getAttribute("data-name"));
      var ar = Number(a.getAttribute("data-" + metric + "-rank") || 999);
      var br = Number(b.getAttribute("data-" + metric + "-rank") || 999);
      return ar - br;
    });
    rows.forEach(function (row) {
      list.appendChild(row);
      var line = row.querySelector("[data-rank-line]");
      if (!line) return;
      if (metric === "name") {
        line.hidden = true;
        return;
      }
      var label = row.getAttribute("data-" + metric + "-label");
      var basis = row.getAttribute("data-" + metric + "-basis");
      var rank = row.getAttribute("data-" + metric + "-rank");
      if (!label || !rank) {
        line.hidden = true;
        return;
      }
      var title = metric === "response_rate" ? "Most responsive" : metric === "response_time" ? "Fastest replying" : "Most active with creators";
      line.hidden = false;
      line.textContent = rank + ". " + title + ": " + label + (basis ? " " + basis : "");
    });
  }

  function syncHotel(id) {
    document.querySelectorAll("[data-hotel]").forEach(function (row) {
      row.classList.toggle("is-synced", row.getAttribute("data-hotel") === id);
    });
    document.querySelectorAll("[data-pin]").forEach(function (pin) {
      var on = pin.getAttribute("data-pin") === id;
      pin.classList.toggle("is-synced", on);
    });
  }

  document.querySelectorAll("[data-hotel]").forEach(function (row) {
    row.addEventListener("mouseenter", function () {
      syncHotel(row.getAttribute("data-hotel"));
    });
    row.addEventListener("mouseleave", function () {
      syncHotel("");
    });
    row.addEventListener("focusin", function () {
      syncHotel(row.getAttribute("data-hotel"));
    });
  });

  document.querySelectorAll("[data-pin]").forEach(function (pin) {
    pin.addEventListener("mouseenter", function () {
      syncHotel(pin.getAttribute("data-pin"));
    });
    pin.addEventListener("focus", function () {
      syncHotel(pin.getAttribute("data-pin"));
    });
  });

  function openPreview(pin) {
    var panel = document.getElementById("map-preview");
    if (!panel) return;
    document.querySelectorAll("[data-pin]").forEach(function (other) {
      other.setAttribute("aria-expanded", other === pin ? "true" : "false");
    });
    panel.hidden = false;
    panel.querySelector("[data-preview-name]").textContent = pin.getAttribute("data-name");
    panel.querySelector("[data-preview-meta]").textContent = pin.getAttribute("data-meta");
    var link = panel.querySelector("[data-preview-link]");
    link.href = pin.getAttribute("data-href");
    syncHotel(pin.getAttribute("data-pin"));
    link.focus();
  }

  function closePreview() {
    var panel = document.getElementById("map-preview");
    if (panel) panel.hidden = true;
    document.querySelectorAll("[data-pin]").forEach(function (pin) {
      pin.setAttribute("aria-expanded", "false");
    });
  }

  document.querySelectorAll("[data-map-toggle]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var discover = document.querySelector("[data-discover]");
      if (!discover) return;
      var showMap = !discover.classList.contains("is-map");
      discover.classList.toggle("is-map", showMap);
      btn.setAttribute("aria-pressed", showMap ? "true" : "false");
      btn.textContent = showMap ? "List" : "Map";
    });
  });

  function showMetric(id) {
    document.querySelectorAll("[data-metric-panel]").forEach(function (panel) {
      var on = panel.getAttribute("data-metric-panel") === id;
      panel.hidden = !on;
    });
    document.querySelectorAll("[data-metric-pick]").forEach(function (btn) {
      var on = btn.getAttribute("data-metric-pick") === id;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("chip-selected", on);
    });
  }

  var initialMetric = document.querySelector("[data-metric-pick][aria-pressed='true']");
  if (initialMetric) showMetric(initialMetric.getAttribute("data-metric-pick"));
})();
