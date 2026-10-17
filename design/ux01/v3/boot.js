/* UX01 v3 preview state. Runs before paint. */
(function () {
  var plan = "pro";
  var query = "";
  try {
    query = new URLSearchParams(location.search).get("plan") || "";
  } catch (e) {
    query = "";
  }
  try {
    var stored = localStorage.getItem("ux01v3plan");
    if (stored === "free" || stored === "pro" || stored === "max") plan = stored;
    if (query === "free" || query === "pro" || query === "max") plan = query;
    if (localStorage.getItem("ux01v3anno") === "off") {
      document.documentElement.classList.add("anno-off");
    }
  } catch (e) {
    if (query === "free" || query === "pro" || query === "max") plan = query;
  }
  document.documentElement.dataset.plan = plan;
})();
