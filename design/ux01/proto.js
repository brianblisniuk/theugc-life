(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const discover = $("[data-discover]");
  if (discover) {
    const form = $("#discover-filters", discover);
    const rows = () => $$(".hotel-row", discover);
    const pins = () => $$(".pin", discover);
    const map = $(".map", discover);
    const count = $("#result-count");
    const caption = $("#map-caption");
    const names = {
      "": "Todos los destinos",
      bali: "Sur de Bali",
      cartagena: "Cartagena",
      lisboa: "Lisboa",
      cdmx: "Ciudad de México",
      ibiza: "Ibiza",
      cabos: "Los Cabos",
      maya: "Riviera Maya",
      samana: "Río San Juan",
    };

    function select(id) {
      rows().forEach((row) => {
        const on = row.dataset.id === id;
        row.classList.toggle("is-selected", on);
      });
      pins().forEach((pin) => {
        const on = pin.dataset.id === id;
        pin.classList.toggle("is-selected", on);
        pin.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    function apply() {
      const q = ($("#q").value || "").trim().toLowerCase();
      const dest = $("#destination").value;
      const activity = $("#activity").value;
      const collab = $("#collab").value;
      const stars = $("#stars").value;
      let visible = 0;
      rows().forEach((row) => {
        const ok =
          (!q || (row.dataset.name || "").includes(q)) &&
          (!dest || row.dataset.destination === dest) &&
          (!activity || row.dataset.activity === activity) &&
          (!collab || row.dataset.collab === collab) &&
          (!stars || Number(row.dataset.stars) >= Number(stars));
        row.hidden = !ok;
        if (ok) visible += 1;
      });
      const scope = dest === "bali" ? "bali" : "world";
      if (map) map.dataset.scope = scope;
      pins().forEach((pin) => {
        const row = discover.querySelector('.hotel-row[data-id="' + pin.dataset.id + '"]');
        pin.hidden = !row || row.hidden;
      });
      if (count) count.textContent = visible + (visible === 1 ? " hotel" : " hoteles");
      if (caption) {
        caption.textContent =
          scope === "bali"
            ? "Mapa de muestra · " + names.bali
            : "Mapa de muestra · " + (names[dest] || names[""]);
      }
      const selected = $(".hotel-row.is-selected", discover);
      if (selected && selected.hidden) select("");
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      apply();
    });
    $("#clear-filters").addEventListener("click", () => {
      form.reset();
      apply();
    });
    rows().forEach((row) => {
      row.addEventListener("mouseenter", () => select(row.dataset.id));
      row.addEventListener("focusin", () => select(row.dataset.id));
    });
    pins().forEach((pin) => {
      pin.addEventListener("click", () => {
        select(pin.dataset.id);
        const row = discover.querySelector('.hotel-row[data-id="' + pin.dataset.id + '"]');
        if (row) row.scrollIntoView({ block: "nearest" });
      });
    });
    const toggle = $("#map-toggle");
    if (toggle) {
      toggle.addEventListener("click", () => {
        const on = discover.classList.toggle("show-map");
        toggle.textContent = on ? "Ver lista" : "Ver mapa";
        toggle.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    apply();
    select("alila");
  }

  const unlock = $("[data-unlock]");
  if (unlock) {
    unlock.addEventListener("click", () => {
      const root = $("[data-unlock-root]");
      if (root) root.dataset.state = "open";
      const locked = $("[data-locked]");
      const open = $("[data-open]");
      if (locked) locked.hidden = true;
      if (open) open.hidden = false;
      const balance = $("[data-balance]");
      if (balance) balance.textContent = "141 créditos";
    });
  }

  $$("[data-tone]").forEach((button) => {
    button.addEventListener("click", () => {
      $$("[data-tone]").forEach((item) => item.classList.remove("is-on"));
      button.classList.add("is-on");
      const label = $("[data-tone-label]");
      if (label) label.textContent = button.dataset.tone;
    });
  });

  const queue = $("[data-queue]");
  if (queue) {
    queue.addEventListener("click", () => {
      const status = $("[data-send-status]");
      if (status) {
        status.hidden = false;
        status.textContent =
          "En cola. Sale en tu horario hábil, con minutos de separación. Alila no queda marcado como enviado.";
      }
    });
  }
  const send = $("[data-send]");
  if (send) {
    send.addEventListener("click", () => {
      const status = $("[data-send-status]");
      if (status) {
        status.hidden = false;
        status.textContent =
          "Enviado desde tu Gmail. Alila no queda marcado como enviado. El estado del pipeline lo cambiás vos.";
      }
    });
  }

  const periodRoot = $("[data-periods]");
  if (periodRoot) {
    $$("[data-period]", periodRoot).forEach((button) => {
      button.addEventListener("click", () => {
        const period = button.dataset.period;
        $$("[data-period]", periodRoot).forEach((item) => {
          item.classList.toggle("is-on", item === button);
          item.setAttribute("aria-pressed", item === button ? "true" : "false");
        });
        $$("[data-annual]").forEach((node) => {
          node.hidden = period !== "annual";
        });
        $$("[data-monthly]").forEach((node) => {
          node.hidden = period !== "monthly";
        });
      });
    });
  }

  $$("[data-checkout]").forEach((button) => {
    button.addEventListener("click", () => {
      const note = $("[data-checkout-note]");
      if (!note) return;
      note.hidden = false;
      note.textContent =
        "Esto abriría el checkout de Rebill para " +
        button.dataset.checkout +
        ". Un pago no enciende el plan ni suma créditos hasta el webhook verificado.";
    });
  });

  const deleteForm = $("[data-delete-form]");
  if (deleteForm) {
    const input = $("#delete-confirmation");
    const submit = $("#delete-submit");
    const ask = $("[data-delete-ask]");
    input.addEventListener("input", () => {
      submit.disabled = input.value !== "DELETE";
    });
    deleteForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (input.value !== "DELETE") return;
      deleteForm.hidden = true;
      if (ask) ask.hidden = true;
      const scheduled = $("[data-delete-scheduled]");
      if (scheduled) scheduled.hidden = false;
    });
    const open = $("[data-delete-open]");
    if (open) {
      open.addEventListener("click", () => {
        deleteForm.hidden = false;
        open.hidden = true;
        input.focus();
      });
    }
  }

  const signup = $("[data-signup]");
  if (signup) {
    signup.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = $("#display-name");
      const email = $("#email");
      const password = $("#password");
      const error = $("[data-signup-error]");
      const invalid = !name.value.trim() || !email.value.includes("@") || password.value.length < 8;
      name.setAttribute("aria-invalid", name.value.trim() ? "false" : "true");
      email.setAttribute("aria-invalid", email.value.includes("@") ? "false" : "true");
      password.setAttribute("aria-invalid", password.value.length >= 8 ? "false" : "true");
      if (invalid) {
        error.hidden = false;
        return;
      }
      window.location.href = "onboarding.html";
    });
  }

  const toHotels = $("[data-to-hotels]");
  if (toHotels) {
    toHotels.addEventListener("click", () => {
      $("#step-dest").hidden = true;
      $("#step-hotels").hidden = false;
    });
  }
  $$("[data-save-hotel]").forEach((button) => {
    button.addEventListener("click", () => {
      button.textContent = "Guardado";
      button.disabled = true;
      const note = $("[data-saved-note]");
      if (note) note.hidden = false;
    });
  });
  $$("[data-onboard-unlock]").forEach((button) => {
    button.addEventListener("click", () => {
      const note = $("[data-onboard-note]");
      if (note) note.hidden = false;
    });
  });

  const boardToggle = $("[data-board-toggle]");
  if (boardToggle) {
    const board = $("[data-board]");
    const list = $("[data-pipeline-list]");
    const setBoard = (show) => {
      board.hidden = !show;
      list.hidden = show;
      boardToggle.textContent = show ? "Ver lista" : "Ver tablero";
      boardToggle.setAttribute("aria-pressed", show ? "true" : "false");
    };
    setBoard(window.matchMedia("(min-width: 980px)").matches);
    boardToggle.addEventListener("click", () => setBoard(board.hidden));
  }

  $$(".choice").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".choice", button.parentElement).forEach((item) => item.classList.toggle("is-on", item === button));
    });
  });

  $$("[data-template]").forEach((button) => {
    button.addEventListener("click", () => {
      $$("[data-template]").forEach((item) => {
        item.classList.toggle("is-on", item === button);
        item.setAttribute("aria-pressed", item === button ? "true" : "false");
      });
      const folio = $("#folio");
      if (folio) folio.dataset.template = button.dataset.template;
    });
  });

  const dismiss = $("[data-dismiss-check]");
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      const list = $("[data-checklist]");
      if (list) list.hidden = true;
      dismiss.hidden = true;
    });
  }

  const tripForm = $("[data-trip-form]");
  if (tripForm) {
    tripForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const note = $("[data-trip-note]");
      if (note) note.hidden = false;
    });
  }

  const stage = $("#preview-stage");
  if (stage) {
    const frame = $("#screen-frame");
    const caption = $("#preview-caption");
    const buttons = $$("button[data-viewport]");
    const previews = $$(".screen-preview");
    const versionButtons = $$("[data-version]");
    let version = "v1";
    const copy = {
      v1: {
        desktop:
          "v1 · Escritorio · 1280 px. Barra a la izquierda, columnas, mapa junto a la lista y panel en la ficha.",
        mobile:
          "v1 · Celular · 390 px. Barra abajo, Descubrir en lista y el mapa en su propia pantalla.",
      },
      v2: {
        desktop:
          "v2 · Escritorio · 1280 px. Grilla de hoteles, Generar pitch siempre visible, sol solo en la acción.",
        mobile:
          "v2 · Celular · 390 px. Una columna, créditos y pitch en la barra, mapa en su pantalla.",
      },
      v3: {
        desktop:
          "v3 · Desktop · 1280 px. Dark desk, English. List on the left, map on the right. Generate pitch is the hotel hero.",
        mobile:
          "v3 · Phone · 390 px. Bottom bar. Discover opens on the list, and the map is one tap away.",
      },
    };
    const notes = {
      v1: "v1 · filas sobre papel. v2 deja el hotel, la respuesta y el contacto adelante. v3 es el escritorio oscuro, en inglés.",
      v2: 'v2 · el hotel es la interfaz. Sun en Generar pitch, Desbloquear, Upgrade y las chapas. <a href="v2/index.html">Sistema v2</a>',
      v3: 'v3 · English, dark only, tennis-ball yellow on the primary action. Notes mark live vs to build. <a href="v3/inicio.html">Open home</a>',
    };
    const note = $("#version-note");
    const deskW = 1280;
    const deskH = 800;

    function screenFile(src) {
      return (src || "").replace(/^(v2|v3)\//, "");
    }

    function screenUrl(file) {
      if (version === "v2") return "v2/" + file;
      if (version === "v3") return "v3/" + file;
      return file;
    }

    function applyChrome() {
      const mode = stage.dataset.viewport || "desktop";
      if (caption) caption.textContent = (copy[version] && copy[version][mode]) || "";
      if (note) note.innerHTML = notes[version] || "";
      $$("[data-screen]").forEach((link) => {
        link.setAttribute("href", screenUrl(link.dataset.screen));
      });
    }

    function fit() {
      const mode = stage.dataset.viewport;
      if (mode === "mobile") {
        const width = Math.min(390, stage.clientWidth);
        frame.style.width = width + "px";
        frame.style.height = "760px";
        frame.style.transform = "none";
        stage.style.height = "auto";
        return;
      }
      const scale = Math.min(1, stage.clientWidth / deskW);
      frame.style.width = deskW + "px";
      frame.style.height = deskH + "px";
      frame.style.transformOrigin = "top left";
      frame.style.transform = "scale(" + scale + ")";
      stage.style.height = Math.ceil(deskH * scale) + "px";
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.dataset.viewport;
        stage.dataset.viewport = mode;
        applyChrome();
        buttons.forEach((item) => {
          const on = item === button;
          item.classList.toggle("is-on", on);
          item.setAttribute("aria-pressed", on ? "true" : "false");
        });
        fit();
      });
    });

    previews.forEach((link) => {
      link.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        frame.src = link.getAttribute("href");
        const name = $("strong", link);
        frame.title = "Vista previa de " + (name ? name.textContent : "la pantalla");
        previews.forEach((item) => item.classList.toggle("is-selected", item === link));
      });
    });

    versionButtons.forEach((button) => {
      button.addEventListener("click", () => {
        version = button.dataset.version;
        versionButtons.forEach((item) => {
          const on = item === button;
          item.classList.toggle("is-on", on);
          item.setAttribute("aria-pressed", on ? "true" : "false");
        });
        const file = screenFile(frame.getAttribute("src"));
        applyChrome();
        frame.src = screenUrl(file);
      });
    });

    window.addEventListener("resize", fit);
    applyChrome();
    fit();
  }
})();
