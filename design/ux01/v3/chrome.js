/* UX01 v3 chrome. Product shell plus a preview bar for plan and notes. */
(function () {
  const page = document.body.dataset.page || "";
  const chrome = document.body.dataset.chrome || "app";
  const title = document.body.dataset.title || "theugc.life";

  const proto = document.createElement("div");
  proto.className = "protobar";
  proto.innerHTML =
    '<a class="proto-back" href="../index.html">UX01</a>' +
    '<span class="proto-mark">v3 preview · sample data</span>' +
    '<div class="proto-controls">' +
    '<button type="button" class="proto-notes" data-notes aria-pressed="true">Notes</button>' +
    '<div class="proto-plans" role="group" aria-label="Preview as">' +
    '<button type="button" data-plan-set="free">Free</button>' +
    '<button type="button" data-plan-set="pro">Pro</button>' +
    '<button type="button" data-plan-set="max">Max</button>' +
    "</div></div>";
  document.body.prepend(proto);

  const notesBtn = proto.querySelector("[data-notes]");
  function syncNotes() {
    const off = document.documentElement.classList.contains("anno-off");
    notesBtn.setAttribute("aria-pressed", off ? "false" : "true");
    notesBtn.textContent = off ? "Notes off" : "Notes on";
  }
  notesBtn.addEventListener("click", () => {
    document.documentElement.classList.toggle("anno-off");
    try {
      localStorage.setItem(
        "ux01v3anno",
        document.documentElement.classList.contains("anno-off") ? "off" : "on",
      );
    } catch (e) {
      /* ignore */
    }
    syncNotes();
  });
  syncNotes();

  function applyPlan(plan) {
    document.documentElement.dataset.plan = plan;
    try {
      localStorage.setItem("ux01v3plan", plan);
    } catch (e) {
      /* ignore */
    }
    proto.querySelectorAll("[data-plan-set]").forEach((button) => {
      const on = button.dataset.planSet === plan;
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.dispatchEvent(new CustomEvent("ux01:plan", { detail: plan }));
  }
  proto.querySelectorAll("[data-plan-set]").forEach((button) => {
    button.addEventListener("click", () => applyPlan(button.dataset.planSet));
  });
  applyPlan(document.documentElement.dataset.plan || "pro");

  if (chrome === "public" || chrome === "focus") {
    const bar = document.createElement("header");
    bar.className = "public-bar";
    bar.innerHTML =
      '<a class="mark" href="landing.html"><i class="mark-dot" aria-hidden="true"></i>theugc<em>.life</em></a>' +
      '<nav class="public-nav" aria-label="Product">' +
      '<a href="landing.html">Product</a>' +
      '<a href="discover.html">Discover</a>' +
      '<a href="pricing.html">Plans</a>' +
      "</nav>" +
      '<div class="public-actions">' +
      (chrome === "focus"
        ? '<a class="text-link" href="inicio.html">Skip for now</a>'
        : '<a class="text-link" href="signup.html">Sign in</a>') +
      '<a class="btn btn-ball btn-small" href="signup.html">Start</a></div>';
    const main = document.getElementById("contenido");
    if (main) main.parentNode.insertBefore(bar, main);
    return;
  }

  const items = [
    ["home", "inicio.html", "Home", iconHome()],
    ["discover", "discover.html", "Discover", iconCompass()],
    ["pipeline", "pipeline.html", "Pipeline", iconBoard()],
    ["trips", "trips.html", "Trips", iconPlane()],
    ["profile", "perfil.html", "Profile", iconPerson()],
  ];
  const more = [
    ["inbox.html", "Inbox"],
    ["pitch.html", "Pitch studio"],
    ["portfolio.html", "Portfolio"],
    ["pricing.html", "Plans"],
    ["billing.html", "Credits"],
    ["account.html", "Settings"],
  ];

  const shell = document.createElement("div");
  shell.className = "shell";
  const rail = document.createElement("aside");
  rail.className = "rail";
  rail.setAttribute("aria-label", "Primary");
  rail.innerHTML =
    '<a class="mark rail-mark" href="inicio.html" aria-label="theugc.life"><i class="mark-dot" aria-hidden="true"></i></a>' +
    '<nav class="rail-nav">' +
    items
      .map(([id, href, label, svg]) => {
        const on = id === page;
        return (
          '<a class="' +
          (on ? "is-active" : "") +
          '" href="' +
          href +
          '"' +
          (on ? ' aria-current="page"' : "") +
          ">" +
          svg +
          "<span>" +
          label +
          "</span></a>"
        );
      })
      .join("") +
    "</nav>" +
    '<nav class="rail-more" aria-label="More">' +
    more
      .map(([href, label]) => {
        const file = href.replace(".html", "");
        const active = page === file;
        return (
          '<a class="' +
          (active ? "is-active" : "") +
          '" href="' +
          href +
          '"' +
          (active ? ' aria-current="page"' : "") +
          ">" +
          label +
          "</a>"
        );
      })
      .join("") +
    "</nav>";

  const col = document.createElement("div");
  col.className = "maincol";
  const top = document.createElement("header");
  top.className = "topbar";
  top.innerHTML =
    '<div class="topbar-title"><a class="mark only-m" href="inicio.html"><i class="mark-dot" aria-hidden="true"></i>theugc<em>.life</em></a><p class="crumb">' +
    title +
    "</p></div>" +
    '<div class="topbar-tools">' +
    '<a class="credit-pill" href="billing.html">' +
    '<b class="for-free" data-balance>3</b><b class="for-pro" data-balance>142</b><b class="for-max" data-balance>420</b>' +
    '<span>credits</span></a>' +
    '<a class="avatar" href="perfil.html" aria-label="Maya Chen">MC</a>' +
    "</div>";

  const main = document.getElementById("contenido");
  if (main) {
    main.parentNode.insertBefore(shell, main);
    col.appendChild(top);
    col.appendChild(main);
    shell.appendChild(rail);
    shell.appendChild(col);
  }

  const tabs = document.createElement("nav");
  tabs.className = "tabbar";
  tabs.setAttribute("aria-label", "Primary");
  tabs.innerHTML = items
    .map(([id, href, label, svg]) => {
      const on = id === page;
      return (
        '<a class="' +
        (on ? "is-active" : "") +
        '" href="' +
        href +
        '"' +
        (on ? ' aria-current="page"' : "") +
        ">" +
        svg +
        "<span>" +
        label +
        "</span></a>"
      );
    })
    .join("");
  document.body.appendChild(tabs);

  const toast = document.createElement("div");
  toast.className = "toaster";
  toast.setAttribute("aria-live", "polite");
  document.body.appendChild(toast);
  window.uxToast = function (message) {
    const node = document.createElement("p");
    node.className = "toast";
    node.textContent = message;
    toast.appendChild(node);
    setTimeout(() => node.remove(), 3200);
  };
})();

function iconHome() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/></svg>';
}
function iconCompass() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="m14.8 9.2-1.3 4.3-4.3 1.3 1.3-4.3z"/></svg>';
}
function iconBoard() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4v16H5zM10.5 4h4v10h-4zM16 4h4v13h-4z"/></svg>';
}
function iconPlane() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12.5 21 4l-6.2 16-3.2-6.2z"/></svg>';
}
function iconPerson() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.2"/><path d="M6.5 19.2c.8-2.6 2.8-4 5.5-4s4.7 1.4 5.5 4"/></svg>';
}
