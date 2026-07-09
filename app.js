(function () {
  const STATUS_LABEL = { completed: "Completed", planned: "Planned", mixed: "In progress" };
  const TEAL = "#0e7c7b";
  const REP_FILL = "#CB7AA5";

  const map = L.map("map", {
    worldCopyJump: true,
    minZoom: 2,
    zoomControl: false,
  }).setView([15, 10], 2);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  const detailCard = document.getElementById("detail-card");
  const detailContent = document.getElementById("detail-content");
  const statsEl = document.getElementById("stats");

  document.getElementById("detail-close").addEventListener("click", () => {
    detailCard.classList.add("hidden");
  });

  document.getElementById("expand-btn").addEventListener("click", () => {
    window.open(window.location.href, "_blank");
  });

  let countries = [];
  let markers = [];
  let borderLayer = null;
  let activeStatusFilter = "all";
  let showRepShading = true;
  let selectedTools = new Set();
  let allTools = [];

  function radiusFor(entryCount) {
    return Math.min(6 + Math.sqrt(entryCount) * 3, 20);
  }

  // Single teal hue: completed = solid, planned = translucent.
  // Mixed countries get a solid core plus a translucent halo (both at once).
  function markersFor(country) {
    const radius = radiusFor(country.entries.length);
    const base = {
      className: "wise-marker",
      weight: 0,
      fillColor: TEAL,
    };
    const layers = [];
    if (country.status === "completed") {
      layers.push(L.circleMarker([country.lat, country.lng], { ...base, radius, fillOpacity: 1 }));
    } else if (country.status === "planned") {
      layers.push(L.circleMarker([country.lat, country.lng], { ...base, radius, fillOpacity: 0.35 }));
    } else {
      layers.push(L.circleMarker([country.lat, country.lng], { ...base, radius: radius * 1.6, fillOpacity: 0.3 }));
      layers.push(L.circleMarker([country.lat, country.lng], { ...base, radius: radius * 0.75, fillOpacity: 1 }));
    }
    layers.forEach((l) => l.on("click", () => showDetail(country)));
    return layers;
  }

  // A country passes if at least one of its entries matches the active
  // status and the checked tools, so countries with both completed and
  // planned work show up under either status filter.
  function entryMatchesFilter(entry) {
    if (activeStatusFilter === "completed" && entry.status !== "Completed") return false;
    if (activeStatusFilter === "planned" && entry.status !== "Planned") return false;
    if (selectedTools.size && !selectedTools.has(entry.tool)) return false;
    return true;
  }

  function passesFilter(country) {
    return country.entries.some(entryMatchesFilter);
  }

  // Countries with nationally representative data get their whole territory
  // shaded. Follows the active filters, and sits under the circle markers.
  function renderBorders() {
    if (borderLayer) {
      map.removeLayer(borderLayer);
      borderLayer = null;
    }
    if (!showRepShading || !window.WISE_BORDERS) return;
    const byIso3 = new Map(countries.map((c) => [c.iso3, c]));
    const visible = new Set(
      countries.filter((c) => c.nationallyRepresentative && passesFilter(c)).map((c) => c.iso3)
    );
    borderLayer = L.geoJSON(window.WISE_BORDERS, {
      filter: (feature) => visible.has(feature.id),
      style: {
        fillColor: REP_FILL,
        fillOpacity: 0.35,
        color: REP_FILL,
        weight: 1,
        opacity: 0.6,
      },
      onEachFeature: (feature, layer) => {
        const country = byIso3.get(feature.id);
        if (country) layer.on("click", () => showDetail(country));
      },
    }).addTo(map);
    borderLayer.bringToBack();
  }

  function renderMarkers() {
    renderBorders();
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    countries.filter(passesFilter).forEach((country) => {
      markersFor(country).forEach((marker) => {
        marker.addTo(map);
        markers.push(marker);
      });
    });
  }

  function badgeHtml(entry) {
    const parts = [];
    const statusClass = entry.status.toLowerCase();
    parts.push(`<span class="badge ${statusClass}">${entry.status}</span>`);
    if (entry.tool) parts.push(`<span class="badge tool">${entry.tool}</span>`);
    parts.push(
      `<span class="badge rep">${entry.nationallyRepresentative ? "Nationally representative" : "Site-level"}</span>`
    );
    return `<div class="badge-row">${parts.join("")}</div>`;
  }

  function entryHtml(entry) {
    const title = entry.location || entry.source || (entry.level === "national" ? "National survey" : "Site data");
    const metaParts = [];
    if (entry.source) metaParts.push(entry.source);
    if (entry.dates) metaParts.push(entry.dates);
    const links = [];
    if (entry.link) {
      links.push(
        `<a class="info-btn" href="${entry.link}" target="_blank" rel="noopener"><span>More info</span><span class="info-btn-arrow">↗</span></a>`
      );
    }
    if (entry.contact) links.push(`<a href="mailto:${entry.contact}">${entry.contact}</a>`);

    return `
      <div class="entry">
        ${badgeHtml(entry)}
        <p class="entry-loc">${title}</p>
        ${metaParts.length ? `<p class="entry-meta">${metaParts.join(" · ")}</p>` : ""}
        ${links.length ? `<div class="entry-links">${links.join("")}</div>` : ""}
      </div>
    `;
  }

  function showDetail(country) {
    const completedCount = country.entries.filter((e) => e.status === "Completed").length;
    const plannedCount = country.entries.filter((e) => e.status === "Planned").length;
    detailContent.innerHTML = `
      <p class="detail-country">${country.name}</p>
      <p class="detail-summary">
        ${country.entries.length} data collection ${country.entries.length === 1 ? "entry" : "entries"}
        · ${completedCount} completed${plannedCount ? ` · ${plannedCount} planned` : ""}
      </p>
      ${country.entries.map(entryHtml).join("")}
    `;
    detailCard.classList.remove("hidden");
  }

  function updateStats() {
    const total = countries.length;
    const completed = countries.filter((c) => c.status === "completed").length;
    const planned = countries.filter((c) => c.status === "planned").length;
    statsEl.innerHTML = `<span><b>${total}</b> countries</span><span><b>${completed}</b> completed</span><span><b>${planned}</b> planned only</span>`;
  }

  function renderToolList(group) {
    const list = group.querySelector(".tool-list");
    list.innerHTML = allTools
      .map(
        (tool) => `
        <label class="tool-option">
          <input type="checkbox" value="${tool}" ${selectedTools.has(tool) ? "checked" : ""}>
          ${tool}
        </label>`
      )
      .join("");
    list.querySelectorAll("input").forEach((box) => {
      box.addEventListener("change", () => {
        if (box.checked) selectedTools.add(box.value);
        else selectedTools.delete(box.value);
        renderMarkers();
      });
    });
  }

  document.querySelectorAll(".filter-group").forEach((group) => {
    const chip = group.querySelector(".chip");
    chip.addEventListener("click", () => {
      const wasActive = group.classList.contains("open");
      document.querySelectorAll(".filter-group").forEach((g) => {
        g.classList.remove("open");
        g.querySelector(".chip").classList.remove("active");
        g.querySelector(".tool-list").innerHTML = "";
      });
      chip.classList.add("active");
      if (activeStatusFilter !== group.dataset.filter) selectedTools.clear();
      activeStatusFilter = group.dataset.filter;
      if (!wasActive) {
        group.classList.add("open");
        renderToolList(group);
      }
      renderMarkers();
    });
  });

  document.getElementById("rep-shading").addEventListener("change", (e) => {
    showRepShading = e.target.checked;
    renderBorders();
  });

  // Data is loaded via a <script> tag (data/countries.js) rather than fetch()
  // so the page also works when opened directly from the filesystem (file://).
  const data = window.WISE_COUNTRIES;
  if (!Array.isArray(data)) {
    statsEl.textContent = "Failed to load data";
    console.error("data/countries.js did not load");
  } else {
    countries = data.filter((c) => typeof c.lat === "number" && typeof c.lng === "number");
    allTools = [...new Set(countries.flatMap((c) => c.entries.map((e) => e.tool)).filter(Boolean))].sort();
    updateStats();
    renderMarkers();
    const bounds = L.latLngBounds(countries.map((c) => [c.lat, c.lng]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }
})();
