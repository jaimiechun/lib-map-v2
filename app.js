(function () {
  const STATUS_LABEL = { completed: "Completed", planned: "Planned", mixed: "Mixed" };

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
  let activeStatusFilter = "all";
  let repOnly = false;

  function radiusFor(entryCount) {
    return Math.min(6 + Math.sqrt(entryCount) * 3, 20);
  }

  function markerFor(country) {
    const marker = L.circleMarker([country.lat, country.lng], {
      radius: radiusFor(country.entries.length),
      className: "wise-marker " + country.status,
      weight: 2,
      color: "#fff",
      fillOpacity: 0.9,
      fillColor: colorFor(country.status),
    });
    marker.on("click", () => showDetail(country));
    return marker;
  }

  function colorFor(status) {
    if (status === "completed") return "#2fae5f";
    if (status === "planned") return "#e8a53d";
    return "#7a5cf0";
  }

  function passesFilter(country) {
    if (repOnly && !country.nationallyRepresentative) return false;
    if (activeStatusFilter === "all") return true;
    return country.status === activeStatusFilter;
  }

  function renderMarkers() {
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    countries.filter(passesFilter).forEach((country) => {
      const marker = markerFor(country);
      marker.addTo(map);
      markers.push(marker);
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
    if (entry.link) links.push(`<a href="${entry.link}" target="_blank" rel="noopener">More info ↗</a>`);
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

  document.querySelectorAll(".chip[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip[data-filter]").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      activeStatusFilter = chip.dataset.filter;
      renderMarkers();
    });
  });

  document.getElementById("rep-only").addEventListener("change", (e) => {
    repOnly = e.target.checked;
    renderMarkers();
  });

  fetch("data/countries.json")
    .then((res) => res.json())
    .then((data) => {
      countries = data.filter((c) => typeof c.lat === "number" && typeof c.lng === "number");
      updateStats();
      renderMarkers();
      const bounds = L.latLngBounds(countries.map((c) => [c.lat, c.lng]));
      map.fitBounds(bounds, { padding: [40, 40] });
    })
    .catch((err) => {
      statsEl.textContent = "Failed to load data";
      console.error(err);
    });
})();
