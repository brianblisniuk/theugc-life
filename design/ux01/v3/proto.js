/* UX01 v3 interactions. Sample data stays in the HTML. */
(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* Discover: chips, keyword chips, list/map sync */
  const discover = $("[data-discover]");
  if (discover) {
    const list = $("#hotel-list");
    const cards = () => $$(".hcard", list);
    const pins = () => $$(".pin", discover);
    const keywords = [];
    const keywordRow = $("#keyword-chips");
    const state = $("#filter-state");
    const count = $("#result-count");
    const empty = $("#discover-empty");
    const search = $("#q");

    function pressed(facet, value) {
      return $$(".chip[data-facet]").filter((chip) => {
        if (chip.getAttribute("aria-pressed") !== "true") return false;
        if (chip.dataset.facet !== facet) return false;
        if (value == null) return true;
        return chip.dataset.value === value;
      });
    }

    function labels() {
      const names = $$(".chip[aria-pressed='true']").map((chip) => chip.dataset.label || chip.textContent.trim());
      return names.concat(keywords.map((word) => "“" + word + "”"));
    }

    function apply() {
      const collabs = pressed("collab").map((chip) => chip.dataset.value);
      const dests = pressed("dest").map((chip) => chip.dataset.value);
      const types = pressed("type").map((chip) => chip.dataset.value);
      const fast = pressed("fast").length > 0;
      const high = pressed("activity").length > 0;
      const stars = pressed("stars").length > 0;
      let visible = 0;
      cards().forEach((card) => {
        const collabOk = !collabs.length || collabs.some((item) => (card.dataset.collab || "").split(" ").includes(item));
        const destOk = !dests.length || dests.includes(card.dataset.destination);
        const typeOk = !types.length || types.includes(card.dataset.type);
        const fastOk = !fast || card.dataset.fast === "1";
        const highOk = !high || card.dataset.activity === "high";
        const starOk = !stars || Number(card.dataset.stars) >= 4;
        const blob = card.dataset.name || "";
        const wordOk = keywords.every((word) => blob.includes(word));
        const ok = collabOk && destOk && typeOk && fastOk && highOk && starOk && wordOk;
        card.hidden = !ok;
        if (ok) visible += 1;
      });
      pins().forEach((pin) => {
        const card = list.querySelector('.hcard[data-id="' + pin.dataset.id + '"]');
        pin.hidden = !card || card.hidden;
      });
      const on = labels();
      if (state) {
        state.textContent = on.length ? "Filtering by " + on.join(", ") : "No filters. The catalog is 4- and 5-star hotels.";
      }
      if (count) count.textContent = visible + (visible === 1 ? " hotel" : " hotels");
      if (empty) empty.hidden = visible !== 0;
      const clear = $("#clear-filters");
      if (clear) clear.hidden = on.length === 0;
      const selected = $(".hcard.is-hot", list);
      if (selected && selected.hidden) select("");
    }

    function select(id) {
      cards().forEach((card) => card.classList.toggle("is-hot", card.dataset.id === id));
      pins().forEach((pin) => {
        const on = pin.dataset.id === id;
        pin.classList.toggle("is-hot", on);
        pin.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    function setChip(chip, on) {
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.classList.toggle("is-on", on);
    }

    function pressFacet(facet, value) {
      const chip = $$(".chip[data-facet]").find((item) => {
        return item.dataset.facet === facet && (value == null || item.dataset.value === value);
      });
      if (chip) setChip(chip, true);
    }

    function addKeyword(word) {
      const clean = word.trim().toLowerCase();
      if (clean.length < 2 || keywords.includes(clean)) return;
      keywords.push(clean);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip is-on";
      chip.dataset.keyword = clean;
      chip.setAttribute("aria-pressed", "true");
      chip.innerHTML = clean + ' <span class="x" aria-hidden="true">×</span>';
      chip.addEventListener("click", () => {
        const index = keywords.indexOf(clean);
        if (index >= 0) keywords.splice(index, 1);
        chip.remove();
        apply();
      });
      keywordRow.appendChild(chip);
    }

    function absorb(raw) {
      let rest = " " + raw.toLowerCase() + " ";
      const rules = [
        [/stay\s*\+\s*paid|stay\s+and\s+paid|stay\s*&\s*paid/g, "collab", "stay_plus_paid"],
        [/fast response|\bfast\b|\bresponsive\b|\bquick\b/g, "fast", null],
        [/high activity|\bactive\b/g, "activity", "high"],
        [/4\s*[–-]\s*5|4 and 5|five star|4-star|5-star/g, "stars", "4-5"],
        [/\bstay\b|\bbarter\b/g, "collab", "stay"],
        [/\bpaid\b|\bcash\b/g, "collab", "paid"],
        [/\bbali\b|\buluwatu\b|\bubud\b|\bamed\b|\bcanggu\b/g, "dest", "bali"],
        [/cartagena/g, "dest", "cartagena"],
        [/lisbon|lisboa/g, "dest", "lisbon"],
        [/cabo|los cabos/g, "dest", "cabos"],
        [/tulum/g, "dest", "tulum"],
        [/ibiza/g, "dest", "ibiza"],
        [/mexico city|cdmx|roma norte/g, "dest", "mexico"],
        [/\bresort\b/g, "type", "resort"],
        [/\bboutique\b/g, "type", "boutique"],
        [/\bbeach\b/g, "type", "beach"],
        [/\bcity\b/g, "type", "city"],
        [/\bvilla\b/g, "type", "villa"],
      ];
      rules.forEach(([re, facet, value]) => {
        re.lastIndex = 0;
        if (!re.test(rest)) return;
        pressFacet(facet, value);
        re.lastIndex = 0;
        rest = rest.replace(re, " ");
      });
      rest
        .split(/[^a-z0-9+]+/)
        .filter((word) => word && !["and", "the", "hotel", "with", "for"].includes(word))
        .forEach(addKeyword);
    }

    $$(".chip[data-facet]").forEach((chip) => {
      chip.addEventListener("click", () => {
        setChip(chip, chip.getAttribute("aria-pressed") !== "true");
        apply();
      });
    });

    $("#search-form").addEventListener("submit", (event) => {
      event.preventDefault();
      absorb(search.value);
      search.value = "";
      apply();
    });

    $("#clear-filters").addEventListener("click", () => {
      $$(".chip[data-facet]").forEach((chip) => setChip(chip, false));
      keywords.splice(0, keywords.length);
      keywordRow.innerHTML = "";
      search.value = "";
      apply();
    });

    cards().forEach((card) => {
      card.addEventListener("mouseenter", () => select(card.dataset.id));
      card.addEventListener("focus", () => select(card.dataset.id));
    });
    pins().forEach((pin) => {
      pin.addEventListener("mouseenter", () => select(pin.dataset.id));
      pin.addEventListener("click", () => {
        select(pin.dataset.id);
        const card = list.querySelector('.hcard[data-id="' + pin.dataset.id + '"]');
        if (card) card.scrollIntoView({ block: "nearest" });
      });
    });

    const order = $("#order");
    if (order) {
      order.addEventListener("change", () => {
        const mode = order.value;
        const plan = document.documentElement.dataset.plan;
        const note = $("#order-note");
        if ((mode === "time" || mode === "rate") && plan === "free") {
          if (note) note.hidden = false;
          order.value = "name";
          return;
        }
        if (note) note.hidden = true;
        const nodes = cards();
        const rank = {
          name: (card) => card.dataset.name,
          activity: (card) => ({ high: "0", medium: "1", emerging: "2" }[card.dataset.activity] || "3") + card.dataset.name,
          time: (card) => (card.dataset.band || "9") + card.dataset.name,
          rate: (card) => String(900 - Number(card.dataset.rate || 0)).padStart(4, "0") + card.dataset.name,
        };
        nodes.sort((a, b) => rank[mode](a).localeCompare(rank[mode](b)));
        nodes.forEach((node) => list.appendChild(node));
      });
    }

    const mapToggle = $("#map-toggle");
    if (mapToggle) {
      mapToggle.addEventListener("click", () => {
        const on = discover.classList.toggle("show-map");
        mapToggle.textContent = on ? "Show list" : "Show map";
        mapToggle.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    apply();
    select("casa-marea");
  }

  /* Unlock */
  $$("[data-unlock]").forEach((button) => {
    button.addEventListener("click", () => {
      const root = $("[data-unlock-root]");
      if (root) root.classList.add("contact-open");
      button.hidden = true;
      const open = $("[data-unlocked]");
      if (open) open.hidden = false;
      $$("[data-balance]").forEach((node) => {
        const current = parseInt(node.textContent, 10);
        if (!Number.isNaN(current)) node.textContent = String(Math.max(0, current - 1));
      });
      if (window.uxToast) window.uxToast("Contact unlocked. 1 credit. Added to Pipeline.");
    });
  });

  /* Pitch studio */
  const studio = $("[data-studio]");
  if (studio) {
    let gens = 0;
    $$("[data-tone], [data-lang], [data-point]").forEach((button) => {
      button.addEventListener("click", () => {
        const group = button.parentElement;
        $$("button", group).forEach((item) => {
          const on = item === button;
          item.classList.toggle("is-on", on);
          item.setAttribute("aria-pressed", on ? "true" : "false");
        });
      });
    });
    $$("[data-delay]").forEach((input) => {
      input.addEventListener("change", () => {
        let value = parseInt(input.value, 10);
        if (Number.isNaN(value)) value = input.dataset.delay === "1" ? 3 : 5;
        value = Math.min(30, Math.max(1, value));
        input.value = String(value);
      });
    });
    const generate = $("[data-generate]");
    if (generate) {
      generate.addEventListener("click", () => {
        gens += 1;
        const body = $("#draft");
        const hotel = studio.dataset.hotel || "Casa Marea";
        const max = document.documentElement.dataset.plan === "max";
        const reason = max
          ? " The cliff pool in the late light is the shot I want to make."
          : "";
        if (body) {
          body.value =
            "Hi,\n\nI'm Maya Chen. I shoot short films for hotels, the kind a guest watches before they book.\n\nI would like to propose three reels and a photo set for " +
            hotel +
            "." +
            reason +
            "\n\nI am not asking to stay as a guest in this note. If we agree on the work, we can set dates.\n\nA recent film: https://example.com/maya/reef\n\nMaya";
        }
        const note = $("#gen-note");
        if (note) {
          note.textContent =
            gens === 1
              ? "Draft ready. This first one for the hotel this month used 1 credit. The next three regenerations are free."
              : gens < 5
                ? "Regeneration " + (gens - 1) + " of 3 free ones. No credit."
                : "Further regenerations use 1 credit.";
        }
        if (gens === 1 || gens >= 5) {
          $$(".for-pro[data-balance], .for-max[data-balance]").forEach((node) => {
            if (document.documentElement.dataset.plan === "free") return;
            const show =
              (document.documentElement.dataset.plan === "pro" && node.classList.contains("for-pro")) ||
              (document.documentElement.dataset.plan === "max" && node.classList.contains("for-max"));
            if (!show) return;
            const current = parseInt(node.textContent, 10);
            if (!Number.isNaN(current)) node.textContent = String(current - 1);
          });
        }
      });
    }
    const send = $("[data-send]");
    if (send) {
      send.addEventListener("click", () => {
        const line = $("#send-note");
        if (line) {
          line.hidden = false;
          line.textContent =
            "Queued. It sends between 09:00 and 18:00 in Asia/Makassar, a few minutes after the last one. Sending is free. Pipeline status stays where you left it.";
        }
      });
    }
    const follow = $("[data-schedule]");
    if (follow) {
      follow.addEventListener("click", () => {
        const a = $("#delay-1").value;
        const b = $("#delay-2").value;
        const line = $("#follow-note");
        if (line) {
          line.hidden = false;
          line.textContent =
            "Scheduled. Follow-up 1 waits " +
            a +
            " days from the send. Follow-up 2 waits " +
            b +
            " days after that. A reply, a bounce, or a closed deal stops them. Scheduling is free.";
        }
      });
    }
  }

  /* Pipeline drag */
  const board = $("[data-board]");
  if (board) {
    let dragged = null;
    $$(".deal", board).forEach((card) => {
      card.setAttribute("draggable", "true");
      card.addEventListener("dragstart", () => {
        dragged = card;
        card.style.opacity = "0.5";
      });
      card.addEventListener("dragend", () => {
        card.style.opacity = "";
        dragged = null;
        $$(".column", board).forEach((col) => col.classList.remove("is-over"));
      });
    });
    $$(".column", board).forEach((col) => {
      col.addEventListener("dragover", (event) => {
        event.preventDefault();
        col.classList.add("is-over");
      });
      col.addEventListener("dragleave", () => col.classList.remove("is-over"));
      col.addEventListener("drop", (event) => {
        event.preventDefault();
        col.classList.remove("is-over");
        if (!dragged) return;
        col.appendChild(dragged);
        $$(".column", board).forEach((column) => {
          const n = $$(".deal", column).length;
          const count = $(".col-count", column);
          if (count) count.textContent = String(n);
          let slot = $(".drop-slot", column);
          if (n === 0 && !slot) {
            slot = document.createElement("p");
            slot.className = "drop-slot small";
            slot.textContent = "Drop a hotel here";
            column.appendChild(slot);
          } else if (n > 0 && slot) {
            slot.remove();
          }
        });
      });
    });
  }

  /* Profile: as a hotel sees you */
  const hotelView = $("[data-hotel-view]");
  if (hotelView) {
    hotelView.addEventListener("click", () => {
      const on = document.body.classList.toggle("as-hotel");
      hotelView.setAttribute("aria-pressed", on ? "true" : "false");
      hotelView.textContent = on ? "See your desk" : "As a hotel sees you";
    });
    $$("[data-opt]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const on = chip.getAttribute("aria-pressed") !== "true";
        chip.setAttribute("aria-pressed", on ? "true" : "false");
        chip.classList.toggle("is-on", on);
        const panel = $('[data-opt-panel="' + chip.dataset.opt + '"]');
        if (panel) panel.classList.toggle("opt-off", !on);
      });
    });
  }

  /* Portfolio layout */
  $$("[data-template]").forEach((button) => {
    button.addEventListener("click", () => {
      $$("[data-template]").forEach((item) => {
        const on = item === button;
        item.classList.toggle("is-on", on);
        item.setAttribute("aria-pressed", on ? "true" : "false");
      });
      const folio = $("#folio");
      if (folio) folio.dataset.template = button.dataset.template;
    });
  });

  $$("[data-approve]").forEach((button) => {
    button.addEventListener("click", () => {
      const card = button.closest("[data-collab]");
      if (!card) return;
      const on = card.dataset.state !== "published";
      card.dataset.state = on ? "published" : "suggested";
      button.textContent = on ? "Published" : "Publish";
    });
  });

  /* Inbox confirm */
  $$("[data-confirm]").forEach((button) => {
    button.addEventListener("click", () => {
      const box = button.closest("[data-suggestion]");
      if (box) {
        box.innerHTML =
          "<p><strong>" +
          (button.dataset.confirm === "yes"
            ? "Recorded. That confirmation can feed the anonymous aggregate. It is not a deal by itself."
            : "Dismissed. A no never becomes a network fact.") +
          "</strong></p>";
      }
    });
  });

  /* Generic choice groups */
  $$(".choice").forEach((button) => {
    if (button.dataset.tone || button.dataset.lang || button.dataset.point || button.dataset.template) return;
    button.addEventListener("click", () => {
      $$(".choice", button.parentElement).forEach((item) => {
        const on = item === button;
        item.classList.toggle("is-on", on);
        item.setAttribute("aria-pressed", on ? "true" : "false");
      });
    });
  });

  /* Billing interval */
  $$("[data-bill]").forEach((button) => {
    button.addEventListener("click", () => {
      const annual = button.dataset.bill === "annual";
      $$("[data-price-annual]").forEach((node) => {
        node.hidden = !annual;
      });
      $$("[data-price-month]").forEach((node) => {
        node.hidden = annual;
      });
    });
  });

  /* Onboarding steps */
  const nextStep = $("[data-step-next]");
  if (nextStep) {
    nextStep.addEventListener("click", () => {
      const a = $("#step-dest");
      const b = $("#step-hotel");
      if (a) a.hidden = true;
      if (b) b.hidden = false;
    });
  }
})();
