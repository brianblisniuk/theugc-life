(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const discover = $("[data-discover]");
  if (discover) {
    const form = $("#discover-filters", discover);
    const rows = () => $$(".hcard", discover);
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
      rows().forEach((row) => row.classList.toggle("is-selected", row.dataset.id === id));
      pins().forEach((pin) => {
        const on = pin.dataset.id === id;
        pin.classList.toggle("is-selected", on);
        pin.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    let scene = "";

    function setScene(next) {
      scene = next || "";
      $$("[data-scene-chip]", discover).forEach((chip) => {
        const on = (chip.dataset.sceneChip || "") === scene;
        chip.classList.toggle("is-on", on);
        chip.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    function apply() {
      const q = ($("#q").value || "").trim().toLowerCase();
      const dest = $("#destination").value;
      const activity = $("#activity").value;
      const collab = $("#collab").value;
      const stars = $("#stars").value;
      const country = $("#country") ? $("#country").value : "";
      const hotelType = $("#hotel-type") ? $("#hotel-type").value : "";
      let visible = 0;
      rows().forEach((row) => {
        const ok =
          (!q || (row.dataset.name || "").includes(q)) &&
          (!dest || row.dataset.destination === dest) &&
          (!activity || row.dataset.activity === activity) &&
          (!collab || row.dataset.collab === collab) &&
          (!stars || Number(row.dataset.stars) >= Number(stars)) &&
          (!scene || row.dataset.scene === scene) &&
          (!country || row.dataset.country === country) &&
          (!hotelType || row.dataset.htype === hotelType);
        row.hidden = !ok;
        if (ok) visible += 1;
      });
      const scope = dest === "bali" ? "bali" : "world";
      if (map) map.dataset.scope = scope;
      pins().forEach((pin) => {
        const row = discover.querySelector('.hcard[data-id="' + pin.dataset.id + '"]');
        pin.hidden = !row || row.hidden;
      });
      if (count) count.textContent = visible + (visible === 1 ? " hotel" : " hoteles");
      if (caption) {
        caption.textContent =
          scope === "bali"
            ? "Mapa de muestra · " + names.bali
            : "Mapa de muestra · " + (names[dest] || names[""]);
      }
      const selected = $(".hcard.is-selected", discover);
      if (selected && selected.hidden) select("");
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      apply();
    });
    form.addEventListener("change", apply);
    $("#clear-filters").addEventListener("click", () => {
      form.reset();
      setScene("");
      const more = $("#more-filters");
      const moreToggle = $("#more-filters-toggle");
      if (more) more.hidden = true;
      if (moreToggle) {
        moreToggle.classList.remove("is-on");
        moreToggle.setAttribute("aria-expanded", "false");
      }
      apply();
    });
    $$("[data-scene-chip]", discover).forEach((chip) => {
      chip.addEventListener("click", () => {
        setScene(chip.dataset.sceneChip || "");
        apply();
      });
    });
    const moreToggle = $("#more-filters-toggle");
    const more = $("#more-filters");
    if (moreToggle && more) {
      moreToggle.addEventListener("click", () => {
        const open = more.hidden;
        more.hidden = !open;
        moreToggle.classList.toggle("is-on", open);
        moreToggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }
    setScene("");
    rows().forEach((row) => {
      row.addEventListener("mouseenter", () => select(row.dataset.id));
      row.addEventListener("focusin", () => select(row.dataset.id));
    });
    pins().forEach((pin) => {
      pin.addEventListener("click", () => {
        select(pin.dataset.id);
        const row = discover.querySelector('.hcard[data-id="' + pin.dataset.id + '"]');
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
      const locked = $("[data-locked]");
      const open = $("[data-open]");
      if (locked) locked.hidden = true;
      if (open) open.hidden = false;
      const contact = $("[data-contact-state]");
      if (contact) {
        contact.textContent = "Listo";
        contact.classList.add("pip-ready");
      }
      $$("[data-balance-num]").forEach((node) => {
        node.textContent = "141";
      });
      $$("[data-balance]").forEach((node) => {
        node.textContent = "141 créditos";
      });
    });
  }

  $$("[data-tone]").forEach((button) => {
    button.addEventListener("click", () => {
      $$("[data-tone]").forEach((item) => {
        item.classList.remove("is-on");
        item.setAttribute("aria-pressed", "false");
      });
      button.classList.add("is-on");
      button.setAttribute("aria-pressed", "true");
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
          "En cola. Sale en tu horario hábil, con minutos de separación. No gasta créditos y Alila no queda marcado como enviado.";
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
          "Enviado desde tu Gmail. No gastó créditos. Alila no queda marcado como enviado. El estado del pipeline lo cambiás vos.";
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
    setBoard(true);
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

  const generate = $("[data-generate]");
  if (generate) {
    generate.addEventListener("click", () => {
      const status = $("[data-generate-status]");
      if (status) {
        status.hidden = false;
        status.textContent =
          "Borrador listo. Tono cercano, en español. Este botón no cobra. No se envió y no se marcó el hotel.";
      }
    });
  }

  $$("[data-follow-day]").forEach((input) => {
    input.addEventListener("change", () => {
      let n = Number(input.value);
      if (!Number.isInteger(n)) n = 3;
      if (n < 1) n = 1;
      if (n > 30) n = 30;
      input.value = String(n);
      const note = $("[data-follow-note]");
      const days = $$("[data-follow-day]").map((el) => el.value);
      if (note) {
        note.textContent =
          "Quedaron en " +
          days.join(" y ") +
          " días. Hasta 2 seguimientos, entre 1 y 30. D05 todavía no programa esto.";
      }
    });
  });

  const tripForm = $("[data-trip-form]");
  if (tripForm) {
    tripForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const note = $("[data-trip-note]");
      if (note) note.hidden = false;
    });
  }
})();
