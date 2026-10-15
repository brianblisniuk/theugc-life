import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = dirname(new URL(import.meta.url).pathname);

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

const ICON = {
  home: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 7.5 8 2l6 5.5V14H10V9H6v5H2z"/></svg>',
  discover: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2"/></svg>',
  pipeline: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h8"/></svg>',
  trips: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12h12M4 12V7l4-3 4 3v5"/></svg>',
  profile: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="6" r="2.5"/><path d="M3 13c1.2-2 2.8-3 5-3s3.8 1 5 3"/></svg>',
};

function write(rel, html) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
}

function asset(depth) {
  return depth === 0 ? "assets" : "../assets";
}

function shell({ title, depth, nav, plan, credits, mobile, action, body, sheet }) {
  const a = asset(depth);
  const home = depth === 0 ? "index.html" : "../index.html";
  const discover = depth === 0 ? "discover/1440-free.html" : nav === "discover" ? "1440-free.html" : "../discover/1440-free.html";
  const item = (id, href, label) =>
    `<a href="${href}" ${nav === id ? 'aria-current="page"' : ""}>${ICON[id]}${label}</a>`;
  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="${a}/tokens.css">
  <link rel="stylesheet" href="${a}/app.css">
</head>
<body class="${[mobile ? "force-mobile" : "", action ? "has-action" : ""].filter(Boolean).join(" ")}">
  <a class="skip" href="#main">Skip to content</a>
  <div class="${mobile ? "device" : ""}">
    <header class="app-header">
      <a class="wordmark" href="${home}">theugc<span>.life</span></a>
      <nav class="primary-nav" aria-label="Primary">
        <a href="${home}#workspaces" ${nav === "home" ? 'aria-current="page"' : ""}>Home</a>
        <a href="${discover}" ${nav === "discover" ? 'aria-current="page"' : ""}>Discover</a>
        <a href="${home}#workspaces">Pipeline</a>
        <a href="${home}#workspaces">Trips</a>
        <a href="${home}#workspaces">Profile</a>
      </nav>
      <div class="header-tools">
        ${plan ? `<span class="chip plan-chip">${esc(plan)}</span>` : ""}
        ${credits ? `<span class="secondary credit-readout">${esc(credits)}</span>` : ""}
        <button type="button" class="btn btn-quiet" data-theme-toggle aria-pressed="false">Theme: Light</button>
      </div>
    </header>
    <main id="main" tabindex="-1">${body}</main>
    ${action || ""}
    ${sheet || ""}
    <nav class="bottom-nav" aria-label="Primary mobile">
      ${item("home", home + "#workspaces", "Home")}
      ${item("discover", discover, "Discover")}
      ${item("pipeline", home + "#workspaces", "Pipeline")}
      ${item("trips", home + "#workspaces", "Trips")}
      ${item("profile", home + "#workspaces", "Profile")}
    </nav>
  </div>
  <script src="${a}/ui.js"></script>
</body>
</html>
`;
}

const HOTELS = [
  {
    id: "atelier",
    initials: "AC",
    name: "Atelier do Chiado",
    dest: "Lisbon",
    country: "Portugal",
    type: "Boutique hotel",
    stars: 5,
    signals: ["High creator activity"],
    x: 22,
    y: 46,
    activity: ["1", "High", "Based on activity from 6 creators"],
    rate: ["2", "58%", "Based on activity from 7 creators"],
    time: ["1", "Under 24h", "Based on activity from 6 creators"],
  },
  {
    id: "lucia",
    initials: "CL",
    name: "Casa Lucía",
    dest: "Barcelona",
    country: "Spain",
    type: "Boutique hotel",
    stars: 5,
    signals: ["High creator activity", "Creator collaboration observed"],
    badge: "Pitched",
    trip: true,
    x: 68,
    y: 42,
    activity: ["2", "High", "Based on activity from 8 creators"],
    rate: ["1", "64%", "Based on activity from 11 creators"],
    time: ["2", "1–3 days", "Based on activity from 6 creators"],
  },
  {
    id: "mar",
    initials: "MA",
    name: "Hotel Mar Azul",
    dest: "Palma",
    country: "Spain",
    type: "Resort",
    stars: 4,
    signals: ["Creator activity detected"],
    closed: true,
    x: 62,
    y: 64,
    activity: ["", "", ""],
    rate: ["", "", ""],
    time: ["", "", ""],
  },
  {
    id: "elowen",
    initials: "ME",
    name: "Maison Elowen",
    dest: "Lyon",
    country: "France",
    type: "Hotel",
    stars: 4,
    signals: [],
    x: 48,
    y: 30,
    activity: ["", "", ""],
    rate: ["", "", ""],
    time: ["", "", ""],
  },
  {
    id: "norte",
    initials: "RN",
    name: "Residencia Norte",
    dest: "Madrid",
    country: "Spain",
    type: "Residence",
    stars: 5,
    signals: ["Creator collaboration observed"],
    x: 40,
    y: 54,
    activity: ["4", "Emerging", "Based on activity from 5 creators"],
    rate: ["4", "41%", "Based on activity from 5 creators"],
    time: ["4", "1–2 weeks", "Based on activity from 5 creators"],
  },
  {
    id: "serra",
    initials: "VS",
    name: "Villa Serra",
    dest: "Deià",
    country: "Spain",
    type: "Villa",
    stars: 5,
    signals: ["Medium creator activity"],
    badge: "Planned",
    x: 58,
    y: 58,
    activity: ["3", "Medium", "Based on activity from 5 creators"],
    rate: ["3", "51%", "Based on activity from 6 creators"],
    time: ["3", "3–7 days", "Based on activity from 5 creators"],
  },
  {
    id: "reconquista",
    initials: "HR",
    name: "Hotel de la Reconquista Marina",
    dest: "Valencia",
    country: "Spain",
    type: "Hotel",
    stars: 4,
    signals: ["Emerging creator activity"],
    x: 52,
    y: 50,
    activity: ["5", "Emerging", "Based on activity from 5 creators"],
    rate: ["", "", ""],
    time: ["5", "2+ weeks", "Based on activity from 5 creators"],
  },
];

function dataAttrs(h) {
  const pair = (key, tuple) =>
    tuple[0]
      ? ` data-${key}-rank="${tuple[0]}" data-${key}-label="${esc(tuple[1])}" data-${key}-basis="${esc(tuple[2])}"`
      : "";
  return `data-hotel="${h.id}" data-name="${esc(h.name.toLowerCase())}"${pair("creator_activity", h.activity)}${pair("response_rate", h.rate)}${pair("response_time", h.time)}`;
}

function row(h, href, { showBadge = true, rank = "" } = {}) {
  const signals = h.signals.slice(0, 2);
  const saved = Boolean(showBadge && h.badge);
  const badges = [];
  if (saved) badges.push(`<span class="tag tag-private">Your pipeline · ${esc(h.badge)}</span>`);
  if (showBadge && h.trip) badges.push(`<span class="tag tag-private">On trip</span>`);
  return `<li class="hotel-row" ${dataAttrs(h)}>
    <a class="row-link" href="${href}">
      <span class="photo"><span class="sr-only">No photograph. Initials </span>${esc(h.initials)}</span>
      <span class="stack-sm">
        <span class="hotel-name">${esc(h.name)}</span>
        <span class="meta-line">${esc(h.dest)}, ${esc(h.country)} · ${esc(h.type)}</span>
        <span class="meta-line">${h.stars}-star classification</span>
        ${signals.length ? `<span class="signal">${esc(signals.join(" · "))}</span>` : ""}
        ${h.closed ? `<span class="closed-note">Temporarily closed</span>` : ""}
        ${badges.join(" ")}
        <span class="secondary" data-rank-line ${rank ? "" : "hidden"}>${rank ? esc(rank) : ""}</span>
      </span>
    </a>
    <div class="save-slot">
      <button type="button" class="btn" ${saved ? 'aria-pressed="true"' : ""}>${saved ? "Saved" : "Save"}</button>
    </div>
  </li>`;
}

const MAP_SVG = `<svg viewBox="0 0 644 560" role="img" aria-label="Schematic map. Pins are neutral and match the list.">
  <rect width="644" height="560" fill="var(--map-water)"></rect>
  <path fill="var(--map-land)" stroke="var(--map-line)" stroke-width="1" d="M40 80l80-20 70 30 90-10 60 40 80-20 70 50 40 80-30 70 20 60-80 40-90-10-70 30-100-20-60-50-40-80z"></path>
  <path fill="none" stroke="var(--map-line)" stroke-width="1" d="M180 160h90M300 220v70M220 300h120"></path>
</svg>`;

function mapPanel(hotels, hrefFor, mode) {
  if (mode === "failed") {
    return `<div class="map-column"><div class="map-panel" role="alert">
      <div class="map-error stack-sm">
        <h2>Map unavailable</h2>
        <p>The hotel list is still available.</p>
        <button type="button" class="btn">Retry</button>
      </div>
    </div></div>`;
  }
  if (mode === "search-failed") {
    return `<div class="map-column"><div class="map-panel">
      <div class="map-note stack-sm">
        <p>Map shows hotels on this results page.</p>
        <p class="secondary">There are no pins until the list loads. This is not a map failure.</p>
      </div>
    </div></div>`;
  }
  const pins = hotels
    .map(
      (h) => `<button type="button" class="pin" style="left:${h.x}%;top:${h.y}%" data-pin="${h.id}" data-name="${esc(h.name)}" data-meta="${esc(`${h.dest}, ${h.country} · ${h.type} · ${h.stars}-star classification`)}" data-href="${hrefFor(h)}" aria-expanded="false" aria-label="${esc(`${h.name}, ${h.dest}. Show preview.`)}"><i></i></button>`,
    )
    .join("");
  return `<div class="map-column"><div class="map-panel">
    <div class="map-canvas" data-map>
      ${MAP_SVG}
      ${pins}
    </div>
    <p class="map-note">Map shows hotels on this results page.</p>
    <div class="preview stack-sm" id="map-preview" hidden>
      <p class="hotel-name" data-preview-name></p>
      <p class="meta-line" data-preview-meta></p>
      <a class="btn" data-preview-link href="#">View hotel</a>
    </div>
  </div></div>`;
}

function filterFields(prefix) {
  return `<div class="field"><label class="label" for="${prefix}-country">Country</label>
    <select class="select" id="${prefix}-country"><option>Any country</option><option>Spain</option><option>Portugal</option><option>France</option><option>Italy</option></select></div>
    <div class="field"><label class="label" for="${prefix}-stars">Classification</label>
    <select class="select" id="${prefix}-stars"><option>Any published classification</option><option>4-star</option><option>5-star</option></select></div>
    <div class="field"><label class="label" for="${prefix}-verified">Editorial verification</label>
    <select class="select" id="${prefix}-verified"><option>Any status</option><option>Editorially verified</option><option>Needs review</option><option>Verification stale</option><option>Unverified</option></select></div>
    <div class="field"><label class="label" for="${prefix}-activity">Creator activity</label>
    <select class="select" id="${prefix}-activity"><option>Any disclosed activity</option><option>High creator activity</option><option>Medium creator activity</option><option>Emerging creator activity</option><option>Creator activity detected</option></select></div>
    <label class="check"><input type="checkbox" id="${prefix}-collab"> Creator collaboration observed</label>`;
}

function toolbar({ prefix, destination = "All destinations", type = "All types", popover = true }) {
  return `<form class="toolbar" role="search" action="#" onsubmit="return false">
    <div class="field search-field"><label class="label" for="${prefix}-q">Search</label>
      <input class="search-input" id="${prefix}-q" type="search" placeholder="Search hotels or destinations" autocomplete="off"></div>
    <div class="field select-field"><label class="label" for="${prefix}-dest">Destination</label>
      <select class="select" id="${prefix}-dest"><option>${esc(destination)}</option><option>Barcelona</option><option>Lisbon</option><option>Madrid</option><option>Palma</option><option>Lyon</option><option>Deià</option></select></div>
    <div class="field select-field"><label class="label" for="${prefix}-type">Hotel type</label>
      <select class="select" id="${prefix}-type"><option>${esc(type)}</option><option>Hotel</option><option>Resort</option><option>Boutique hotel</option><option>Aparthotel</option><option>Hostel</option><option>Villa</option><option>Residence</option><option>Guesthouse</option><option>Lodge</option><option>Other</option></select></div>
    ${
      popover
        ? `<div class="popover-anchor"><button type="button" class="btn" data-popover-open aria-expanded="false" aria-controls="${prefix}-more">More filters</button>
      <div class="popover" id="${prefix}-more" data-popover hidden>
        <h2>More filters</h2>
        ${filterFields(prefix)}
      </div></div>`
        : `<button type="button" class="btn" data-popover-open aria-expanded="true" aria-controls="${prefix}-more">More filters</button>`
    }
    <button type="button" class="btn btn-primary">Apply</button>
  </form>`;
}

function sortControl({ id, plan, value }) {
  const opt = (v, label, premium = false) =>
    `<option value="${v}" ${premium ? "data-premium" : ""} ${value === v ? "selected" : ""}>${label}</option>`;
  return `<div class="field sort-field"><label class="label" for="${id}">Sort by</label>
    <select class="select" id="${id}" data-sort data-plan="${plan}" data-list="hotel-list" data-lock="sort-lock">
      ${opt("name", "Name")}
      ${opt("creator_activity", "Most active with creators")}
      ${opt("response_rate", "Most responsive (Pro)", true)}
      ${opt("response_time", "Fastest replying (Pro)", true)}
    </select></div>`;
}

function lockPanel() {
  return `<div class="lock-panel" id="sort-lock" hidden>
    <h2>Hotel response insights</h2>
    <p>See confirmed reply-rate and response-time signals when enough creator data is available.</p>
    <p class="secondary">Available on Pro and Max, or with a Destination Pass for this destination. A locked metric shows no value and no ranking. These results stayed in name order.</p>
    <a class="btn" href="../index.html#plans">View plans</a>
  </div>`;
}

function resultsBar(text, sort) {
  return `<div class="results-bar">
    <p role="status">${esc(text)} <span class="sample-tag">Sample data</span></p>
    ${sort}
  </div>`;
}

function pagination(page, pages) {
  return `<nav class="pagination" aria-label="Pagination">
    <button type="button" class="btn" ${page === 1 ? "disabled" : ""}>Previous</button>
    <span>Page ${page} of ${pages}</span>
    <button type="button" class="btn" ${page === pages ? "disabled" : ""}>Next</button>
  </nav>`;
}

function discoverBody({ intro, tools, chips, list, map, note, mapOpen }) {
  const toggle = `<button type="button" class="btn view-toggle" data-map-toggle aria-pressed="${mapOpen ? "true" : "false"}">${mapOpen ? "List" : "Map"}</button>`;
  return `<div class="page"><div class="discover${mapOpen ? " is-map" : ""}" data-discover>
    <div class="list-column">
      <p class="sample-banner"><span class="sample-tag">Sample data</span> ${note || "Names, counts, and signals on this frame are illustrative. The frame draws representative rows, not all 24."}</p>
      <div class="spread">
        <div class="stack-sm">
          <h1>Discover</h1>
          <p class="lede">Find hotels, explore creator activity, and build your next collaboration.</p>
        </div>
        ${toggle}
      </div>
      ${tools}
      ${chips || ""}
      <div class="list-results stack">
        ${intro || ""}
        ${list || ""}
      </div>
    </div>
    ${map}
  </div></div>`;
}

function chips(items) {
  if (!items.length) return "";
  return `<div class="chips" aria-label="Active filters">${items
    .map(
      (item) =>
        `<span class="chip chip-selected">${esc(item)} <button type="button" aria-label="Remove ${esc(item)}">×</button></span>`,
    )
    .join("")}<a class="btn btn-quiet" href="1440-free.html">Clear all</a></div>`;
}

function listBlock(hotels, href, opts, count, sort, pages = 8) {
  return `${resultsBar(count, sort)}
    ${lockPanel()}
    <h2 class="sr-only">Hotel results</h2>
    <ul class="hotel-list" id="hotel-list">${hotels.map((h) => row(h, href(h), opts(h))).join("")}</ul>
    ${pagination(1, pages)}`;
}

const byId = Object.fromEntries(HOTELS.map((h) => [h.id, h]));

function discoverPage(file, opts) {
  const href = opts.href || (() => "1440-free.html");
  const hotels = (opts.ids || []).map((id) => byId[id]);
  const body = discoverBody({
    tools: toolbar({ prefix: "d", destination: opts.destination, type: opts.type, popover: !opts.sheet }),
    chips: chips(opts.chips || []),
    intro: opts.intro || "",
    list: opts.list === false ? opts.empty : listBlock(hotels, href, opts.rowOpts || (() => ({})), opts.count, sortControl({ id: "sort", plan: opts.plan, value: opts.sort || "name" }), opts.pages || 8),
    map: mapPanel(hotels, href, opts.map || "ok"),
    note: opts.note,
    mapOpen: Boolean(opts.mapOpen),
  });
  const sheet = opts.sheet
    ? `<div class="sheet-open" data-sheet data-sheet-locked>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="sheet-body">
          <h2 id="sheet-title">More filters</h2>
          ${filterFields("sheet")}
        </div>
        <div class="sheet-apply">
          <button type="button" class="btn">Close</button>
          <button type="button" class="btn btn-primary">Apply</button>
        </div>
      </div>
    </div>`
    : "";
  write(
    file,
    shell({
      title: opts.title,
      depth: 1,
      nav: "discover",
      plan: opts.planLabel,
      credits: opts.credits,
      mobile: opts.mobile,
      body,
      sheet,
    }),
  );
}

discoverPage("discover/1440-free.html", {
  title: "Discover · Free · no filters",
  plan: "free",
  planLabel: "Free",
  credits: "4 credits available",
  ids: ["atelier", "elowen", "lucia", "mar", "norte", "reconquista", "serra"],
  count: "Showing 1–24 of 186 hotels",
  href: () => "../hotel/free-locked.html",
  rowOpts: () => ({ showBadge: false }),
});

discoverPage("discover/1440-pro-filters.html", {
  title: "Discover · Pro · filters",
  plan: "pro",
  planLabel: "Pro",
  credits: "128 credits available",
  destination: "Barcelona",
  type: "Boutique hotel",
  chips: ["Barcelona", "Boutique hotel", "5-star", "Editorially verified", "High creator activity", "Creator collaboration observed"],
  ids: ["lucia", "atelier", "serra", "norte"],
  sort: "creator_activity",
  count: "Showing 1–24 of 42 hotels",
  href: (h) => (h.id === "lucia" ? "../hotel/pitched.html" : "../hotel/pro-intel.html"),
  rowOpts: (h) => ({
    showBadge: true,
    rank: h.activity[0] ? `${h.activity[0]}. Most active with creators: ${h.activity[1]} ${h.activity[2]}` : "",
  }),
});

discoverPage("discover/1440-max-sort.html", {
  title: "Discover · Max · premium sort",
  plan: "max",
  planLabel: "Max",
  credits: "420 credits available",
  ids: ["lucia", "atelier", "serra", "norte"],
  sort: "response_rate",
  count: "Showing 1–24 of 37 hotels",
  href: () => "../hotel/max-fit.html",
  rowOpts: (h) => ({
    showBadge: false,
    rank: h.rate[0] ? `${h.rate[0]}. Most responsive: ${h.rate[1]} ${h.rate[2]}` : "",
  }),
  note: "One metric is applied: Most responsive. Reply rate is the published H01 value, not a match score.",
});

discoverPage("discover/insufficient.html", {
  title: "Discover · insufficient data",
  plan: "pro",
  planLabel: "Pro",
  credits: "128 credits available",
  sort: "creator_activity",
  list: false,
  ids: [],
  empty: `${sortControl({ id: "sort", plan: "pro", value: "creator_activity" })}
    <div class="state-panel" role="status">
      <h2>Not enough data</h2>
      <p>Not enough data. Hotels that have not cleared the floor for this metric are left out of the order.</p>
      <p class="secondary">Shown when at least 3 creators have confirmed activity and the sample reaches emerging (5 or more confirmed events). Below that, not enough data.</p>
      <a class="btn btn-primary" href="1440-free.html">Show the catalog order</a>
    </div>`,
});

discoverPage("discover/no-results.html", {
  title: "Discover · no results",
  plan: "free",
  planLabel: "Free",
  credits: "4 credits available",
  chips: ["Iceland", "5-star"],
  list: false,
  ids: [],
  empty: `<div class="state-panel" role="status">
      <h2>No hotels match your filters.</h2>
      <p>Try another destination or remove some filters.</p>
      <a class="btn btn-primary" href="1440-free.html">Clear filters</a>
    </div>`,
});

discoverPage("discover/search-error.html", {
  title: "Discover · search error",
  plan: "free",
  planLabel: "Free",
  credits: "4 credits available",
  list: false,
  ids: [],
  map: "search-failed",
  empty: `<div class="state-panel" role="alert">
      <h2>Hotels couldn't be loaded.</h2>
      <p>Your search is still available. Try again.</p>
      <button type="button" class="btn btn-primary">Retry</button>
    </div>`,
});

discoverPage("discover/map-unavailable.html", {
  title: "Discover · map unavailable",
  plan: "free",
  planLabel: "Free",
  credits: "4 credits available",
  ids: ["atelier", "elowen", "lucia", "mar", "norte", "serra"],
  count: "Showing 1–24 of 186 hotels",
  map: "failed",
  href: () => "../hotel/free-locked.html",
  rowOpts: () => ({ showBadge: false }),
});

discoverPage("discover/empty-catalog.html", {
  title: "Discover · empty catalog",
  plan: "free",
  planLabel: "Free",
  credits: "5 credits available",
  list: false,
  ids: [],
  empty: `<div class="state-panel" role="status">
      <h2>No published hotels yet</h2>
      <p>Hotels appear here once they are in the published catalog.</p>
    </div>`,
  note: "This is an empty catalog. It is not a filter miss and not a failed search.",
});

discoverPage("discover/390-list.html", {
  title: "Discover · 390 · list",
  plan: "free",
  planLabel: "Free",
  mobile: true,
  ids: ["lucia", "mar", "elowen", "reconquista"],
  count: "Showing 1–24 of 186 hotels",
  href: () => "../hotel/390-no-relation.html",
  rowOpts: () => ({ showBadge: false }),
});

discoverPage("discover/390-map.html", {
  title: "Discover · 390 · map",
  plan: "free",
  planLabel: "Free",
  mobile: true,
  mapOpen: true,
  ids: ["lucia", "mar", "atelier", "serra"],
  count: "Showing 1–24 of 186 hotels",
  href: () => "../hotel/390-no-relation.html",
  rowOpts: () => ({ showBadge: false }),
  note: "Mobile map. The list is one toggle away.",
});

discoverPage("discover/390-filters.html", {
  title: "Discover · 390 · more filters",
  plan: "free",
  planLabel: "Free",
  mobile: true,
  sheet: true,
  ids: ["lucia", "mar"],
  count: "Showing 1–24 of 186 hotels",
  href: () => "../hotel/390-no-relation.html",
  rowOpts: () => ({ showBadge: false }),
});


function crumbs(items, depthHome) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${items
    .map((item, i) => (i === items.length - 1 ? `<span aria-current="page">${esc(item.label)}</span>` : `<a href="${item.href}">${esc(item.label)}</a><span aria-hidden="true">/</span>`))
    .join(" ")}</nav>`;
}

function identity() {
  return `<header class="identity" id="overview">
    <p class="eyebrow">Hotel information</p>
    ${crumbs([
      { href: "../discover/1440-free.html", label: "Discover" },
      { label: "Casa Lucía" },
    ])}
    <h1>Casa Lucía</h1>
    <p class="lede">Barcelona, Spain · Boutique hotel</p>
    <div class="hero-block" aria-label="No verified photograph on file">
      <strong>CL</strong>
      <span>No verified photograph on file.</span>
    </div>
    <div class="row-wrap">
      <span class="tag">5-star classification</span>
      <span class="tag">Editorially verified</span>
      <span class="tag">Open</span>
    </div>
    <p class="secondary">Carrer de Mallorca 401, Barcelona</p>
    <div class="row-wrap">
      <a class="secondary" href="https://example.com/casa-lucia">Website</a>
      <a class="secondary" href="https://example.com/casa-lucia-instagram">Instagram</a>
    </div>
  </header>
  <nav class="subnav" aria-label="Hotel sections">
    <a href="#overview" aria-current="true">Overview</a>
    <a href="#intelligence">Intelligence</a>
    <a href="#contact">Contact</a>
    <a href="#work">My work</a>
  </nav>`;
}

function howItWorks() {
  return `<div class="popover-anchor">
    <button type="button" class="btn" data-popover-open aria-expanded="false" aria-controls="how-metrics">How this works</button>
    <div class="popover" id="how-metrics" data-popover hidden>
      <h2>How this works</h2>
      <p>Creator activity is shown when at least 3 creators have confirmed activity and the sample reaches emerging (5 or more confirmed events). Below that, not enough data.</p>
      <p>Reply rate is shown when at least 15 confirmed pitches from at least 5 creators fall in the last 365 days. A follow-up is not another pitch. Below that, not enough data.</p>
      <p>Typical reply time is shown when at least 10 confirmed replies from at least 5 creators fall in the last 365 days. The value is a time band, not an hour count. Below that, not enough data.</p>
      <p class="secondary">Confidence and freshness sit beside a metric. They are not a score. Insufficient data is never 0% and never Low.</p>
    </div>
  </div>`;
}

function metricCell({ name, layer, state, value, meta, basis, plans = "../index.html#plans" }) {
  if (state === "locked") {
    return `<article class="metric">
      <p class="label">${esc(name)}</p>
      <h3>Hotel response insights</h3>
      <p>See confirmed reply-rate and response-time signals when enough creator data is available.</p>
      <p class="secondary">Available on Pro and Max, or with a Destination Pass for this destination.</p>
      <a href="${plans}">View plans</a>
    </article>`;
  }
  if (state === "insufficient") {
    return `<article class="metric">
      <p class="label">${esc(name)}</p>
      <p><strong>Not enough data</strong> <span class="sample-tag">Sample data</span></p>
      <p class="secondary">The sample is below this metric’s floor. That is not 0% and not Low.</p>
    </article>`;
  }
  if (state === "error") {
    return `<article class="metric">
      <p class="label">${esc(name)}</p>
      <h3>Couldn’t be loaded</h3>
      <p>Metric rankings couldn't be loaded. This is a temporary problem, not an empty ranking.</p>
      <button type="button" class="btn">Retry</button>
    </article>`;
  }
  return `<article class="metric">
    <p class="label">${esc(name)} · ${esc(layer)}</p>
    <p class="key-number">${esc(value)} <span class="sample-tag">Sample data</span></p>
    <p class="secondary">${esc(meta)}</p>
    <p class="secondary">${esc(basis)}</p>
  </article>`;
}

function intelligence({ activity, reply, time }) {
  return `<section class="stack" id="intelligence">
    <div class="spread">
      <div class="stack-sm">
        <p class="eyebrow">Creator network</p>
        <h2>Creator intelligence</h2>
        <p class="secondary">Signals based on confirmed creator activity.</p>
      </div>
      ${howItWorks()}
    </div>
    <div class="metrics">
      ${metricCell(activity)}
      ${metricCell(reply)}
      ${metricCell(time)}
    </div>
  </section>`;
}

function fitBlock(state) {
  if (state === "locked") {
    return `<section class="layer">
      <h2>Relevant to your experience</h2>
      <p class="secondary">Based on collaboration types you've confirmed.</p>
      <div class="lock-panel">
        <h2>Creator fit</h2>
        <p>Creator fit is Premium Intelligence. A Pass covers this destination. Pro and Max cover every destination. A locked fit shows no hotels.</p>
        <a class="btn" href="../index.html#plans">View plans</a>
      </div>
    </section>`;
  }
  if (state === "empty") {
    return `<section class="layer">
      <h2>Relevant to your experience</h2>
      <p class="secondary">Based on collaboration types you've confirmed.</p>
      <p>No hotel here matches a collaboration type you have confirmed. A type needs three other creators before it can match, and hotels below the activity floor stay off the list.</p>
    </section>`;
  }
  const advanced = state === "advanced";
  const rows = advanced
    ? [
        ["1", "Casa Lucía", "High. Matches Stay.", "Confidence: Strong. Freshness: Past month."],
        ["2", "Atelier do Chiado", "Medium. Matches Stay.", "Confidence: Moderate. Freshness: Past quarter."],
      ]
    : [
        ["", "Casa Lucía", "High. Matches Stay.", ""],
        ["", "Atelier do Chiado", "Medium. Matches Stay.", ""],
      ];
  return `<section class="layer">
    <h2>Relevant to your experience</h2>
    <p class="secondary">Based on collaboration types you've confirmed. ${advanced ? "Max adds rank, confidence, and recency. There is no percentage score." : "Pro shows the match. Rank, confidence, and recency are on Max."}</p>
    <ol class="rank-list">${rows
      .map(
        ([rank, name, line, extra]) => `<li><span>${rank}</span><span><strong>${name}</strong><br><span class="sample-tag">Sample data</span> ${line}${extra ? `<br><span class="secondary">${extra}</span>` : ""}</span></li>`,
      )
      .join("")}</ol>
    <p class="secondary">You chose to pursue this hotel. This choice stays on your account. It does not change the network.</p>
    <div class="row-wrap">
      <button type="button" class="btn" aria-pressed="true">Pursue</button>
      <button type="button" class="btn btn-quiet">Skip</button>
    </div>
  </section>`;
}

function ranking(plan, mode) {
  const list = (metric) => {
    if (mode === "insufficient") {
      return `<div data-metric-panel="${metric}" ${metric === "creator_activity" ? "" : "hidden"}><p>No hotel in this destination has enough confirmed data for this metric yet.</p></div>`;
    }
    if (mode === "error") {
      return `<div data-metric-panel="${metric}" ${metric === "creator_activity" ? "" : "hidden"}><p>Metric rankings couldn't be loaded. This is a temporary problem, not an empty ranking.</p><button type="button" class="btn">Retry</button></div>`;
    }
    if (plan === "free" && metric !== "creator_activity") {
      return `<div class="lock-panel" data-metric-panel="${metric}" hidden>
        <h2>Hotel response insights</h2>
        <p>See confirmed reply-rate and response-time signals when enough creator data is available.</p>
        <p class="secondary">Available on Pro and Max, or with a Destination Pass for this destination. A locked metric shows no value and no ranking.</p>
        <a class="btn" href="../index.html#plans">View plans</a>
      </div>`;
    }
    const rows =
      metric === "response_rate"
        ? [["1", "Casa Lucía", "64%", "Based on activity from 11 creators"], ["2", "Atelier do Chiado", "58%", "Based on activity from 7 creators"], ["3", "Villa Serra", "51%", "Based on activity from 6 creators"]]
        : metric === "response_time"
          ? [["1", "Atelier do Chiado", "Under 24h", "Based on activity from 6 creators"], ["2", "Casa Lucía", "1–3 days", "Based on activity from 6 creators"], ["3", "Villa Serra", "3–7 days", "Based on activity from 5 creators"]]
          : [["1", "Atelier do Chiado", "High", "Based on activity from 6 creators"], ["2", "Casa Lucía", "High", "Based on activity from 8 creators"], ["3", "Villa Serra", "Medium", "Based on activity from 5 creators"]];
    return `<ol class="rank-list" data-metric-panel="${metric}" ${metric === "creator_activity" ? "" : "hidden"}>${rows
      .map(
        ([n, name, value, basis]) =>
          `<li><span>${n}</span><span><strong>${name}</strong><br>${value} <span class="sample-tag">Sample data</span><br><span class="secondary">${basis}</span></span></li>`,
      )
      .join("")}</ol>`;
  };
  const pressed = (id) => (id === "creator_activity" ? 'aria-pressed="true" class="chip chip-selected"' : 'aria-pressed="false" class="chip"');
  return `<section class="layer">
    <h2>Compare hotels in this destination</h2>
    <p class="secondary">Barcelona and its destinations. One metric at a time.</p>
    <div class="row-wrap" role="group" aria-label="Ranking metric">
      <button type="button" data-metric-pick="creator_activity" ${pressed("creator_activity")}>Most active with creators</button>
      <button type="button" data-metric-pick="response_rate" ${pressed("response_rate")}>Most responsive (Pro)</button>
      <button type="button" data-metric-pick="response_time" ${pressed("response_time")}>Fastest replying (Pro)</button>
    </div>
    ${list("creator_activity")}
    ${list("response_rate")}
    ${list("response_time")}
  </section>`;
}

function contactLocked(balance) {
  if (balance === "out") {
    return `<section class="stack" id="contact">
      <h2>Hotel contact</h2>
      <p>Unlock available contact information for this hotel.</p>
      <div class="notice">
        <p><strong>0 credits available</strong> <span class="sample-tag">Sample data</span></p>
        <p>You're out of credits. Pack purchases are not open yet. An admin can grant credits.</p>
        <button type="button" class="btn" disabled>Unlock contact · 1 credit</button>
      </div>
    </section>`;
  }
  return `<section class="stack" id="contact">
    <h2>Hotel contact</h2>
    <p>Unlock available contact information for this hotel.</p>
    <button type="button" class="btn">Unlock contact · 1 credit</button>
    <p class="secondary">1 credit is charged only after a successful unlock. A contact that is not on file is stored and is not charged.</p>
    <p>4 credits available <span class="sample-tag">Sample data</span></p>
  </section>`;
}

function contactCards() {
  return `<section class="stack" id="contact">
    <h2>Hotel contact</h2>
    <p>Already unlocked. <span class="sample-tag">Sample data</span></p>
    <article class="contact-card">
      <h3>Elena Varga</h3>
      <p class="secondary">Partnerships Manager</p>
      <dl>
        <dt>Department</dt><dd>Partnerships</dd>
        <dt>Organization</dt><dd>Casa Lucía</dd>
        <dt>Email</dt><dd><a href="mailto:partnerships@example.com">partnerships@example.com</a></dd>
        <dt>Phone</dt><dd><a href="tel:+34930000000">+34 93 000 0000</a></dd>
        <dt>LinkedIn</dt><dd><a href="https://example.com/elena-varga">LinkedIn profile for Elena Varga</a></dd>
      </dl>
      <p class="secondary">Verified contact · Last verified 2026-09-02</p>
    </article>
    <article class="contact-card">
      <h3>PR contact</h3>
      <p class="secondary">Role-based mailbox — no named individual on file.</p>
      <dl>
        <dt>Department</dt><dd>PR</dd>
        <dt>Email</dt><dd><a href="mailto:press@example.com">press@example.com</a></dd>
      </dl>
      <p class="secondary">Probable contact · Last verified 2026-08-18</p>
    </article>
    <button type="button" class="btn">Report incorrect contact</button>
  </section>`;
}

function contactEmpty() {
  return `<section class="stack" id="contact">
    <h2>Hotel contact</h2>
    <div class="notice" role="status">
      <h2>No contact on file yet.</h2>
      <p>We haven’t published a verified contact for this hotel yet. This did not use a credit.</p>
    </div>
  </section>`;
}

function contactError() {
  return `<section class="stack" id="contact">
    <h2>Hotel contact</h2>
    <div class="notice" role="alert">
      <h2>Contact details couldn’t be loaded</h2>
      <p>This is a temporary problem on our side, not a missing contact. Reload the page to try again.</p>
      <button type="button" class="btn">Retry</button>
    </div>
  </section>`;
}

function overviewMap() {
  return `<div class="layer" id="map">
    <h2>Map</h2>
    <div class="map-panel map-section">
      <div class="map-canvas">${MAP_SVG}
        <button type="button" class="pin" style="left:68%;top:42%" aria-label="Casa Lucía, Barcelona"><i></i></button>
      </div>
      <p class="map-note">One published hotel. The sections above are the text alternative.</p>
    </div>
  </div>`;
}

function workNone(plan) {
  return `<section class="stack" id="work">
    <p class="eyebrow">Your history</p>
    <h2>Your work with this hotel</h2>
    <p>You have no open relationship with this hotel.</p>
    <div class="layer" id="activity"><h3>Activity</h3><p class="secondary">Saving the hotel starts a private pipeline row.</p></div>
    <div class="layer" id="inbox"><h3>Inbox</h3><p>An inbox link attaches to an open pipeline cycle for this hotel.</p><p class="secondary">${plan === "free" ? "Gmail send is on Pro and Max. A Destination Pass does not send mail." : "No conversation is linked yet."}</p></div>
    <div class="layer" id="collaboration"><h3>Collaboration</h3><p>A collaboration opens here once this hotel is won.</p></div>
    <div class="layer" id="trip"><h3>Trip</h3>${plan === "free" ? `<p>The Free plan includes 1 active trip. Complete or cancel one to plan another, or review billing.</p><p class="secondary">Sample data · Lisbon, 2–6 June 2026 is the active trip.</p>` : `<p class="secondary">Pro and Max are not capped at one active trip.</p>`}</div>
  </section>`;
}

function timeline(items) {
  return `<ol class="timeline">${items
    .map(
      (item) =>
        `<li><p><strong>${esc(item.type)}</strong> · ${esc(item.date)}</p><p class="secondary">${esc(item.source)} <span class="sample-tag">Sample data</span></p></li>`,
    )
    .join("")}</ol>`;
}

function stageTag(stage) {
  const kind = {
    Saved: "tag",
    Planned: "tag",
    Pitched: "tag tag-process",
    Replied: "tag tag-process",
    "Follow-up": "tag tag-warning",
    Negotiating: "tag tag-process",
    Won: "tag tag-success",
    Closed: "tag",
  }[stage];
  return `<span class="${kind}">${esc(stage)}</span>`;
}

function workRelationship(cfg) {
  const follow = cfg.follow
    ? `<div class="layer">
        <h3>Follow-ups</h3>
        <p class="secondary">A follow-up waits 1 to 30 days, spends no credits, and stops when the hotel replies, a message bounces, the deal is won or closed, or you cancel. Defaults are 3 days, then 5. This thread already has two follow-ups.</p>
        <ol class="timeline">
          <li><p><span class="tag">Sent</span> <strong>Follow-up</strong> · 11 Oct 2026</p><p class="secondary">Gmail · sent after 3 days <span class="sample-tag">Sample data</span></p></li>
          <li><p><span class="tag tag-warning">Scheduled</span> <strong>Follow-up</strong> · 16 Oct 2026</p><p class="secondary">Gmail · will not send before 5 days</p><button type="button" class="btn">Cancel follow-up</button></li>
        </ol>
        <div class="notice">
          <p><span class="tag">Draft</span> Draft is not scheduled and is not sent.</p>
        </div>
      </div>`
    : `<div class="layer"><h3>Follow-ups</h3><p>No follow-up scheduled. You can schedule up to two, each 1 to 30 days out.</p></div>`;
  const collab =
    cfg.stage === "Won"
      ? `<div class="layer" id="collaboration">
          <h3>Collaboration</h3>
          <p>${stageTag("Won")} Collaboration agreed</p>
          <p>Compensation · Hybrid · 2,400 USD cash · 3 nights in kind <span class="sample-tag">Sample data</span></p>
          <div class="deliverable"><span>1 Reel</span><span>1,600 USD</span><span>Due 12 Nov 2026</span></div>
          <div class="deliverable"><span>3 Stories</span><span>800 USD</span><span>Due 14 Nov 2026</span></div>
          <p class="secondary">Contract draft — not a signed contract.</p>
        </div>`
      : `<div class="layer" id="collaboration"><h3>Collaboration</h3><p>A collaboration opens here once this hotel is won.</p></div>`;
  return `<section class="stack" id="work">
    <p class="eyebrow">Your history</p>
    <h2>Your work with this hotel</h2>
    <p>${stageTag(cfg.stage)} Private to you.</p>
    <div class="layer" id="activity"><h3>Activity</h3>${timeline(cfg.events)}</div>
    <div class="layer" id="inbox">
      <h3>Inbox</h3>
      <p><strong>Re: A stay and two films in May</strong></p>
      <p class="secondary">Linked Gmail conversation · last message 10 Oct 2026 <span class="sample-tag">Sample data</span></p>
      <a class="btn" href="#inbox">Open conversation</a>
    </div>
    ${follow}
    ${collab}
    <div class="layer" id="trip"><h3>Trip</h3><p>On trip · Summer Barcelona · 12–18 May 2026 <span class="sample-tag">Sample data</span></p></div>
  </section>`;
}

function side(cfg) {
  const credit =
    cfg.credits === "unknown"
      ? `<div class="notice" role="status"><p><strong>Credits unavailable</strong></p><p class="secondary">This is not a balance of 0.</p><button type="button" class="btn">Retry</button></div>`
      : `<p><strong>${esc(cfg.credits)}</strong> <span class="sample-tag">Sample data</span></p><p class="secondary">${esc(cfg.cadence)}</p>`;
  return `<aside class="side-panel" aria-label="Your next step">
    <p class="eyebrow">Your next step</p>
    <h2>${esc(cfg.title)}</h2>
    ${cfg.primary}
    ${cfg.secondary || ""}
    ${cfg.stage ? `<p>${stageTag(cfg.stage)}</p>` : ""}
    ${cfg.followLine ? `<p class="secondary">${esc(cfg.followLine)}</p>` : ""}
    ${credit}
    ${cfg.extra || ""}
  </aside>`;
}

function hotelPage(file, cfg) {
  const crumbsHtml =
    cfg.origin === "pipeline"
      ? crumbs([
          { href: "../index.html#workspaces", label: "Pipeline" },
          { label: "Casa Lucía" },
        ])
      : cfg.origin === "trip"
        ? crumbs([
            { href: "../index.html#workspaces", label: "Trips" },
            { href: "../index.html#workspaces", label: "Summer Barcelona" },
            { label: "Casa Lucía" },
          ])
        : crumbs([
            { href: "../discover/1440-free.html", label: "Discover" },
            { label: "Casa Lucía" },
          ]);
  const body = `<div class="page"><p class="sample-banner"><span class="sample-tag">Sample data</span> ${esc(cfg.banner)}</p>
    <div class="hotel-layout">
      <div class="hotel-main">
        <header class="identity" id="overview">
          <p class="eyebrow">Hotel information</p>
          ${crumbsHtml}
          <h1>Casa Lucía</h1>
          <p class="lede">Barcelona, Spain · Boutique hotel</p>
          <div class="hero-block"><strong>CL</strong><span>No verified photograph on file.</span></div>
          <div class="row-wrap"><span class="tag">5-star classification</span><span class="tag">Editorially verified</span><span class="tag">Open</span></div>
          <p class="secondary">Carrer de Mallorca 401, Barcelona</p>
          <div class="row-wrap"><a class="secondary" href="https://example.com/casa-lucia">Website</a><a class="secondary" href="https://example.com/casa-lucia-instagram">Instagram</a></div>
        </header>
        <nav class="subnav" aria-label="Hotel sections">
          <a href="#overview" aria-current="true">Overview</a>
          <a href="#intelligence">Intelligence</a>
          <a href="#contact">Contact</a>
          <a href="#work">My work</a>
        </nav>
        ${overviewMap()}
        ${cfg.intel}
        ${cfg.fit}
        ${cfg.rank}
        ${cfg.contact}
        ${cfg.work}
      </div>
      ${cfg.side}
    </div>
  </div>`;
  const action = cfg.action
    ? `<div class="action-bar">${cfg.action}</div>`
    : "";
  write(
    file,
    shell({
      title: cfg.title,
      depth: 1,
      nav: "hotel",
      plan: cfg.planLabel,
      credits: cfg.headerCredits,
      mobile: cfg.mobile,
      action,
      body,
    }),
  );
}

const pub = { name: "Creator activity · Public", layer: "Creator network", state: "available", value: "High", meta: "Confidence: Moderate. Freshness: Past month.", basis: "Based on activity from 8 creators" };
const replyOk = { name: "Reply rate · Pro", layer: "Creator network", state: "available", value: "64%", meta: "Confidence: Moderate. Freshness: Past month.", basis: "Based on activity from 11 creators" };
const timeOk = { name: "Typical reply time · Pro", layer: "Creator network", state: "available", value: "1–3 days", meta: "Confidence: Moderate. Freshness: Past quarter.", basis: "Based on activity from 6 creators" };
const replyLock = { name: "Reply rate · Pro", state: "locked" };
const timeLock = { name: "Typical reply time · Pro", state: "locked" };
const actLow = { name: "Creator activity · Public", state: "insufficient" };
const replyLow = { name: "Reply rate · Pro", state: "insufficient" };
const timeLow = { name: "Typical reply time · Pro", state: "insufficient" };

const unlockPrimary = `<a class="btn btn-primary" href="#contact">Unlock contact · 1 credit</a>`;
const pitchPrimary = `<a class="btn btn-primary" href="#contact">Create pitch</a>`;
const convoPrimary = `<a class="btn btn-primary" href="#inbox">Open conversation</a><a class="btn" href="#work">View pipeline</a>`;
const wonPrimary = `<a class="btn btn-primary" href="#collaboration">Manage collaboration</a>`;

hotelPage("hotel/free-locked.html", {
  title: "Hotel · Free · contact locked",
  planLabel: "Free",
  headerCredits: "4 credits available",
  banner: "Free, not saved, contact still locked. Reply rate and reply time stay locked.",
  intel: intelligence({ activity: pub, reply: replyLock, time: timeLock }),
  fit: fitBlock("locked"),
  rank: ranking("free", "ok"),
  contact: contactLocked("ok"),
  work: workNone("free"),
  side: side({
    title: "Unlock contact",
    primary: unlockPrimary,
    secondary: `<button type="button" class="btn">Save hotel</button><button type="button" class="btn">Add to trip</button>`,
    credits: "4 credits available",
    cadence: "Free includes 5 credits per rolling week. Unused weekly credits do not stack past 5.",
    extra: `<p class="secondary">Trip limit · The Free plan includes 1 active trip. Complete or cancel one to plan another, or review billing.</p>`,
  }),
});

hotelPage("hotel/free-unlocked.html", {
  title: "Hotel · Free · contact unlocked",
  planLabel: "Free",
  headerCredits: "3 credits available",
  banner: "Free, contact unlocked. Pitch templates only. Reply insights stay locked.",
  intel: intelligence({ activity: pub, reply: replyLock, time: timeLock }),
  fit: fitBlock("locked"),
  rank: ranking("free", "ok"),
  contact: contactCards(),
  work: workNone("free"),
  side: side({
    title: "Create pitch",
    primary: pitchPrimary,
    credits: "3 credits available",
    cadence: "Free includes pitch templates. Claude drafts are on Pro and Max. The first AI draft is 1 credit. Gmail send is on Pro and Max.",
  }),
});

hotelPage("hotel/free-credit-limit.html", {
  title: "Hotel · Free · credit limit",
  planLabel: "Free",
  headerCredits: "0 credits available",
  banner: "Known zero is shown as 0 with the out-of-credits explanation. An unreadable balance is a different state and is not 0.",
  intel: intelligence({ activity: pub, reply: replyLock, time: timeLock }),
  fit: fitBlock("locked"),
  rank: ranking("free", "ok"),
  contact: `${contactLocked("out")}
    <section class="layer">
      <h2>When the balance cannot be read</h2>
      <div class="notice" role="status">
        <p><strong>Credits unavailable</strong></p>
        <p>Retry the balance. Do not show 0, and do not offer an upgrade in place of the number.</p>
        <button type="button" class="btn">Retry</button>
      </div>
    </section>`,
  work: workNone("free"),
  side: side({
    title: "Unlock contact",
    primary: `<button type="button" class="btn" disabled>Unlock contact · 1 credit</button>`,
    credits: "0 credits available",
    cadence: "You're out of credits. Pack purchases are not open yet. An admin can grant credits.",
  }),
});

hotelPage("hotel/pro-intel.html", {
  title: "Hotel · Pro · intelligence available",
  planLabel: "Pro",
  headerCredits: "128 credits available",
  banner: "Pro sees reply rate, reply time, and Creator Fit. Max-only rank and freshness stay off this fit list.",
  intel: intelligence({ activity: pub, reply: replyOk, time: timeOk }),
  fit: fitBlock("pro"),
  rank: ranking("pro", "ok"),
  contact: contactCards(),
  work: workNone("pro"),
  side: side({
    title: "Create pitch",
    primary: pitchPrimary,
    credits: "128 credits available",
    cadence: "Pro includes 150 credits per 30 days. The first AI draft is 1 credit.",
  }),
});

hotelPage("hotel/pro-insufficient.html", {
  title: "Hotel · Pro · intelligence insufficient",
  planLabel: "Pro",
  headerCredits: "128 credits available",
  banner: "Pro is entitled. The network has not cleared the floor. This is not locked and not an error.",
  intel: intelligence({ activity: actLow, reply: replyLow, time: timeLow }),
  fit: fitBlock("empty"),
  rank: ranking("pro", "insufficient"),
  contact: contactEmpty(),
  work: workNone("pro"),
  side: side({
    title: "Create pitch",
    primary: pitchPrimary,
    credits: "128 credits available",
    cadence: "Pro includes 150 credits per 30 days.",
  }),
});

hotelPage("hotel/max-fit.html", {
  title: "Hotel · Max · advanced fit",
  planLabel: "Max",
  headerCredits: "420 credits available",
  banner: "Max adds rank, confidence, and recency on Creator Fit. There is still no percentage score.",
  intel: intelligence({ activity: pub, reply: replyOk, time: timeOk }),
  fit: fitBlock("advanced"),
  rank: ranking("max", "ok"),
  contact: contactCards(),
  work: workNone("pro"),
  side: side({
    title: "Create pitch",
    primary: pitchPrimary,
    credits: "420 credits available",
    cadence: "Max includes 500 credits per 30 days. Priority AI adds a fuller draft and more context on the same model. The first AI draft is 1 credit.",
  }),
});

const pitchedEvents = [
  { type: "Saved", date: "2 Oct 2026", source: "Manual" },
  { type: "Pitch sent", date: "8 Oct 2026", source: "Gmail" },
];

hotelPage("hotel/pitched.html", {
  title: "Hotel · Pitched",
  planLabel: "Pro",
  headerCredits: "128 credits available",
  origin: "pipeline",
  banner: "Pitched is a private stage. Collaboration stays closed until the deal is won.",
  intel: intelligence({ activity: pub, reply: replyOk, time: timeOk }),
  fit: fitBlock("pro"),
  rank: ranking("pro", "ok"),
  contact: contactCards(),
  work: workRelationship({ stage: "Pitched", events: pitchedEvents, follow: false }),
  side: side({
    title: "Open conversation",
    primary: convoPrimary,
    stage: "Pitched",
    followLine: "Next follow-up: none scheduled.",
    credits: "128 credits available",
    cadence: "Pro includes 150 credits per 30 days. Scheduling a follow-up spends no credits.",
  }),
});

hotelPage("hotel/reply-followup.html", {
  title: "Hotel · Reply and follow-up",
  planLabel: "Pro",
  headerCredits: "128 credits available",
  origin: "pipeline",
  banner: "Two follow-ups is the cap. Draft, scheduled, and sent stay distinct.",
  intel: intelligence({ activity: pub, reply: replyOk, time: timeOk }),
  fit: fitBlock("pro"),
  rank: ranking("pro", "ok"),
  contact: contactCards(),
  work: workRelationship({
    stage: "Replied",
    events: [
      ...pitchedEvents,
      { type: "Reply received", date: "10 Oct 2026", source: "Gmail" },
      { type: "Follow-up sent", date: "11 Oct 2026", source: "Gmail" },
    ],
    follow: true,
  }),
  side: side({
    title: "Open conversation",
    primary: convoPrimary,
    stage: "Replied",
    followLine: "Next follow-up: scheduled for 16 Oct 2026. Cancel it from My work.",
    credits: "128 credits available",
    cadence: "A follow-up spends no credits.",
  }),
});

hotelPage("hotel/won.html", {
  title: "Hotel · Won",
  planLabel: "Pro",
  headerCredits: "128 credits available",
  origin: "pipeline",
  banner: "Collaboration, compensation, and deliverables appear only because the stage is Won. The contract on screen is a draft.",
  intel: intelligence({ activity: pub, reply: replyOk, time: timeOk }),
  fit: fitBlock("pro"),
  rank: ranking("pro", "ok"),
  contact: contactCards(),
  work: workRelationship({
    stage: "Won",
    events: [
      ...pitchedEvents,
      { type: "Marked won", date: "12 Oct 2026", source: "Manual" },
    ],
    follow: false,
  }),
  side: side({
    title: "Manage collaboration",
    primary: wonPrimary,
    stage: "Won",
    followLine: "Next deliverable due 12 Nov 2026.",
    credits: "128 credits available",
    cadence: "Pro includes 150 credits per 30 days.",
  }),
});

hotelPage("hotel/contact-error.html", {
  title: "Hotel · contact error",
  planLabel: "Pro",
  headerCredits: "128 credits available",
  banner: "The contact read failed. This is not “no contact on file” and not a locked plan.",
  intel: intelligence({ activity: pub, reply: replyOk, time: timeOk }),
  fit: fitBlock("pro"),
  rank: ranking("pro", "error"),
  contact: contactError(),
  work: workNone("pro"),
  side: side({
    title: "Contact unavailable",
    primary: `<a class="btn btn-primary" href="#contact">Retry</a>`,
    credits: "128 credits available",
    cadence: "The balance was read. The contact was not. Do not treat this as an empty file.",
  }),
});

hotelPage("hotel/390-no-relation.html", {
  title: "Hotel · 390 · no relation",
  planLabel: "Free",
  headerCredits: "4 credits available",
  mobile: true,
  banner: "Mobile, no saved relationship. One bottom action sits above the global nav.",
  intel: intelligence({ activity: pub, reply: replyLock, time: timeLock }),
  fit: fitBlock("locked"),
  rank: ranking("free", "ok"),
  contact: contactLocked("ok"),
  work: workNone("free"),
  side: side({
    title: "Unlock contact",
    primary: unlockPrimary,
    secondary: `<button type="button" class="btn">Save hotel</button>`,
    credits: "4 credits available",
    cadence: "Free includes 5 credits per rolling week.",
  }),
  action: `<a class="btn btn-primary" href="#contact">Unlock contact · 1 credit</a><p class="secondary">4 credits available <span class="sample-tag">Sample data</span></p>`,
});

hotelPage("hotel/390-negotiating.html", {
  title: "Hotel · 390 · negotiating",
  planLabel: "Pro",
  headerCredits: "128 credits available",
  mobile: true,
  origin: "trip",
  banner: "Mobile negotiating. The stage is written, not color alone. The bottom bar does not cover Pipeline, Trips, or Profile.",
  intel: intelligence({ activity: pub, reply: replyOk, time: timeOk }),
  fit: fitBlock("pro"),
  rank: ranking("pro", "ok"),
  contact: contactCards(),
  work: workRelationship({
    stage: "Negotiating",
    events: [
      ...pitchedEvents,
      { type: "Negotiation started", date: "14 Oct 2026", source: "Manual" },
    ],
    follow: false,
  }),
  side: side({
    title: "Open conversation",
    primary: convoPrimary,
    stage: "Negotiating",
    followLine: "Next follow-up in 4 days.",
    credits: "128 credits available",
    cadence: "Pro includes 150 credits per 30 days.",
  }),
  action: `<p>${stageTag("Negotiating")} Next follow-up in 4 days</p><a class="btn btn-primary" href="#inbox">Open conversation</a>`,
});

const notFound = shell({
  title: "Hotel not found",
  depth: 1,
  nav: "hotel",
  plan: "Free",
  credits: "4 credits available",
  body: `<div class="page"><div class="state-panel" role="status">
    <p class="sample-banner"><span class="sample-tag">Sample data</span> Unknown id.</p>
    <h1>Hotel not found</h1>
    <p>This hotel is not in the published catalog.</p>
    <a class="btn btn-primary" href="../discover/1440-free.html">Back to Discover</a>
  </div></div>`,
});
write("hotel/not-found.html", notFound);

const indexBody = `<div class="page stack">
  <p class="sample-banner"><span class="sample-tag">Sample data</span> Static UX02 frames. Light is the master. Dark uses the same token names.</p>
  <div class="stack-sm">
    <h1>Discover and Hotel Detail</h1>
    <p class="lede">Product design specification v1.0, grounded on main 2549b96. The brand accent on these frames is #DFFF4F. Text on that fill is #17191B. The accent is never used as text or as an icon on a light surface, and primary buttons keep a #5E6C00 edge because the fill is 1.08:1 against the paper background.</p>
  </div>
  <p><button type="button" class="btn" data-theme-toggle aria-pressed="false">Theme: Light</button></p>
  <div class="frame-index">
    <div class="index-group"><h2>Discover</h2>
      <a href="discover/1440-free.html">1440 · Free · no filters<span>List and map</span></a>
      <a href="discover/1440-pro-filters.html">1440 · Pro · filters and data<span>Chips, one metric</span></a>
      <a href="discover/1440-max-sort.html">1440 · Max · premium sort<span>Most responsive</span></a>
      <a href="discover/insufficient.html">Insufficient data<span>Below the floor</span></a>
      <a href="discover/no-results.html">No results<span>Clear filters</span></a>
      <a href="discover/search-error.html">Search error<span>Retry</span></a>
      <a href="discover/map-unavailable.html">Map unavailable<span>List still works</span></a>
      <a href="discover/390-list.html">390 · list<span>Map toggle</span></a>
      <a href="discover/390-map.html">390 · map<span>List toggle</span></a>
      <a href="discover/390-filters.html">390 · More filters<span>Bottom sheet</span></a>
    </div>
    <div class="index-group"><h2>Hotel detail</h2>
      <a href="hotel/free-locked.html">Free · contact locked<span>Unlock · 1 credit</span></a>
      <a href="hotel/free-unlocked.html">Free · contact unlocked<span>Templates only</span></a>
      <a href="hotel/free-credit-limit.html">Free · credit limit<span>0 and unreadable</span></a>
      <a href="hotel/pro-intel.html">Pro · intelligence available<span>Fit without rank</span></a>
      <a href="hotel/pro-insufficient.html">Pro · intelligence insufficient<span>Not locked</span></a>
      <a href="hotel/max-fit.html">Max · advanced Fit<span>Rank, confidence, recency</span></a>
      <a href="hotel/pitched.html">Pitched<span>Open conversation</span></a>
      <a href="hotel/reply-followup.html">Reply and follow-up<span>Draft, scheduled, sent</span></a>
      <a href="hotel/won.html">Won<span>Deliverables</span></a>
      <a href="hotel/contact-error.html">Contact error<span>Not an empty file</span></a>
      <a href="hotel/390-no-relation.html">390 · no relation<span>Bottom action</span></a>
      <a href="hotel/390-negotiating.html">390 · negotiating<span>Above the nav</span></a>
    </div>
  </div>
  <div class="index-group">
    <h2>Required states outside the 22 frames</h2>
    <a href="discover/empty-catalog.html">Empty catalog<span>Not a filter miss</span></a>
    <a href="hotel/not-found.html">Hotel not found<span>Published catalog</span></a>
    <a href="specimens.html">Component specimens<span>Skeleton, tags, four states</span></a>
  </div>
  <section class="layer" id="plans">
    <h2>Plans</h2>
    <p>The same product architecture. A price is not an entitlement. A Destination Pass covers premium intelligence inside its destination and descendants. It does not unlock a contact, a Claude draft, or Gmail send.</p>
    <div class="deliverable"><span>Free</span><span>5 credits / rolling week</span><span>Templates, 1 active trip</span></div>
    <div class="deliverable"><span>Pro</span><span>150 credits / 30 days</span><span>Reply insights, Fit, Claude, Gmail</span></div>
    <div class="deliverable"><span>Max</span><span>500 credits / 30 days</span><span>Advanced Fit and more AI context</span></div>
    <p class="secondary">Contact unlock is 1 credit on every plan, charged only after a successful unlock. The first AI draft is 1 credit.</p>
  </section>
  <section class="layer" id="workspaces">
    <h2>Workspaces</h2>
    <p class="secondary">Home, Pipeline, Trips, and Profile are named here so the shell can link to them. They are not part of this UX02 pair.</p>
    <ul class="rank-list">
      <li><span>1</span><span><strong>Discover</strong><br><span class="secondary">Published hotels and the map</span></span></li>
      <li><span>2</span><span><strong>Trips</strong><br><span class="secondary">Destination, dates, and shortlist</span></span></li>
      <li><span>3</span><span><strong>Pipeline</strong><br><span class="secondary">Private hotel tracking</span></span></li>
      <li><span>4</span><span><strong>Inbox</strong><br><span class="secondary">Gmail readings beside each open cycle. A pipeline surface, not a new primary item.</span></span></li>
      <li><span>5</span><span><strong>Collaborations</strong><br><span class="secondary">Won deals, deliverables, and agreed compensation.</span></span></li>
    </ul>
  </section>
  <p class="secondary">Desktop frames use the 708/644 and 900/452 columns from 1024px upward, and the exact 708 + 24 + 644 split from 1440px. Mobile frames are 390-wide artboards and reflow at 320. Contrast notes are in WCAG.md.</p>
</div>`;

write("index.html", shell({ title: "UX02 · Discover and Hotel Detail", depth: 0, nav: "home", body: indexBody }));

const specimens = `<div class="page stack">
  <p class="sample-banner"><span class="sample-tag">Sample data</span> Component specimens. Toggle the theme in the header.</p>
  <h1>Components</h1>
  <div class="specimen-grid">
    <section class="specimen"><h2>Buttons</h2><div class="row-wrap"><button type="button" class="btn btn-primary">Apply</button><button type="button" class="btn">Save</button><button type="button" class="btn" disabled>Saved</button><button type="button" class="btn btn-quiet">Clear all</button></div><p class="secondary">One primary per context. The accent fill has a #5E6C00 edge.</p></section>
    <section class="specimen"><h2>Chips and pipeline</h2><div class="row-wrap"><span class="chip chip-selected">Barcelona <button type="button" aria-label="Remove Barcelona">×</button></span><span class="tag">Saved</span><span class="tag">Planned</span><span class="tag tag-process">Pitched</span><span class="tag tag-process">Replied</span><span class="tag tag-warning">Follow-up</span><span class="tag tag-process">Negotiating</span><span class="tag tag-success">Won</span><span class="tag">Closed</span><span class="tag tag-private">On trip</span></div></section>
    <section class="specimen"><h2>Photo placeholder</h2><span class="photo">CL</span><p class="secondary">Neutral initials. No hotel photograph.</p></section>
    <section class="specimen"><h2>Skeleton</h2><div class="skeleton-row" aria-hidden="true"><div class="sk sk-photo"></div><div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div><div class="sk sk-line"></div></div><p class="secondary">Same size as a row. No shimmer.</p></section>
    <section class="specimen"><h2>Metric · available</h2>${metricCell(replyOk)}</section>
    <section class="specimen"><h2>Metric · locked</h2>${metricCell({ ...replyLock, plans: "index.html#plans" })}</section>
    <section class="specimen"><h2>Metric · insufficient</h2>${metricCell(replyLow)}</section>
    <section class="specimen"><h2>Metric · error</h2>${metricCell({ name: "Reply rate · Pro", state: "error" })}</section>
    <section class="specimen"><h2>Contact · empty</h2><div class="notice"><h2>No contact on file yet.</h2><p>We haven’t published a verified contact for this hotel yet.</p></div></section>
    <section class="specimen"><h2>Contact · error</h2><div class="notice"><h2>Contact details couldn’t be loaded</h2><p>This is a temporary problem on our side, not a missing contact.</p><button type="button" class="btn">Retry</button></div></section>
    <section class="specimen"><h2>Credits · unreadable</h2><div class="notice"><p><strong>Credits unavailable</strong></p><button type="button" class="btn">Retry</button></div></section>
    <section class="specimen"><h2>Empty and error</h2><div class="notice"><h2>No hotels match your filters.</h2><p>Try another destination or remove some filters.</p></div><div class="notice"><h2>Hotels couldn't be loaded.</h2><p>Your search is still available. Try again.</p></div></section>
  </div>
</div>`;

write("specimens.html", shell({ title: "UX02 · components", depth: 0, nav: "home", body: specimens }));

console.log("wrote ux02 frames");
