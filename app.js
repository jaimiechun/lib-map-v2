(function () {
  const STATUS_LABEL = { completed: "Completed", planned: "Planned", mixed: "In progress" };
  const TEAL = "#0e7c7b";
  const REP_FILL = "#CB7AA5";

  // Visitor data submissions. If SUBMIT_ENDPOINT is set (e.g. a Google Apps
  // Script web app or Formspree URL), the form POSTs JSON there. If it is
  // empty, the form falls back to opening a pre-filled email to SUBMIT_EMAIL.
  const SUBMIT_ENDPOINT = "";
  const SUBMIT_EMAIL = "wise_scales@northwestern.edu";

  const map = L.map("map", {
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 7,
    zoomControl: false,
    attributionControl: false,
  }).setView([15, 10], 2);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  // Tile-free basemap: sea is the map background color (see style.css),
  // land is drawn from Natural Earth polygons shipped in data/world.js.
  const worldLayer = L.geoJSON(window.WISE_WORLD, {
    interactive: false,
    style: {
      fillColor: "#f7f7f4",
      fillOpacity: 1,
      color: "#c6cbd4",
      weight: 0.7,
    },
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

  // Dots shrink when zoomed out so the world view doesn't look jumbled,
  // reaching full size around zoom 5.
  function zoomScale() {
    return Math.min(1, 0.45 + (map.getZoom() - 2) * 0.18);
  }

  function radiusFor(entryCount) {
    return Math.min(6 + Math.sqrt(entryCount) * 3, 20) * zoomScale();
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
    if (entry.tool && !selectedTools.has(entry.tool)) return false;
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
    // Shading sits below the markers but above the land basemap.
    borderLayer.bringToBack();
    worldLayer.bringToBack();
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

  function entryTitle(entry) {
    return entry.location || entry.source || (entry.level === "national" ? "National survey" : "Site data");
  }

  function entryHtml(entry, showTitle) {
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
        ${showTitle ? `<p class="entry-loc">${entryTitle(entry)}</p>` : ""}
        ${metaParts.length ? `<p class="entry-meta">${metaParts.join(" · ")}</p>` : ""}
        ${links.length ? `<div class="entry-links">${links.join("")}</div>` : ""}
      </div>
    `;
  }

  // Entries sharing a location (e.g. four studies in Gaza) collapse under one
  // expandable header so the card isn't a wall of near-identical rows.
  function groupedEntriesHtml(entries) {
    const groups = [];
    const byKey = new Map();
    entries.forEach((entry) => {
      const key = entryTitle(entry).trim().toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, []);
        groups.push(key);
      }
      byKey.get(key).push(entry);
    });

    return groups
      .map((key) => {
        const group = byKey.get(key);
        if (group.length === 1) return entryHtml(group[0], true);
        return `
          <details class="entry-group">
            <summary>
              <span class="group-title">${entryTitle(group[0])}</span>
              <span class="group-count"><span class="count-verb">View </span>${group.length} studies <span class="group-chev"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg></span></span>
            </summary>
            ${group.map((e) => entryHtml(e, false)).join("")}
          </details>
        `;
      })
      .join("");
  }

  // Optional filter ({entries, label}) narrows the card to a subset — used
  // when arriving from a contact/source search hit, so e.g. searching a
  // researcher shows only their entries, not everything in that country.
  function showDetail(country, filter) {
    const entries = filter ? filter.entries : country.entries;
    const completedCount = entries.filter((e) => e.status === "Completed").length;
    const plannedCount = entries.filter((e) => e.status === "Planned").length;
    detailContent.innerHTML = `
      <p class="detail-country">${country.name}</p>
      <p class="detail-summary">
        ${entries.length} data collection ${entries.length === 1 ? "entry" : "entries"}
        · ${completedCount} completed${plannedCount ? ` · ${plannedCount} planned` : ""}
      </p>
      ${filter ? `
        <div class="detail-filter-note">
          Showing matches for “${filter.label}”
        </div>` : ""}
      ${groupedEntriesHtml(entries)}
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
      if (activeStatusFilter !== group.dataset.filter) selectedTools = new Set(allTools);
      activeStatusFilter = group.dataset.filter;
      if (!wasActive) {
        group.classList.add("open");
        renderToolList(group);
      }
      renderMarkers();
    });
  });

  // --- Search: country names, plus contacts/sources ("who is involved") ---
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");

  function focusCountry(country, filter) {
    map.setView([country.lat, country.lng], 5);
    showDetail(country, filter);
    searchResults.classList.add("hidden");
    searchInput.value = "";
  }

  function resultButton(label, sub, country, filter) {
    const btn = document.createElement("button");
    btn.className = "search-result";
    btn.innerHTML = `${label}${sub ? `<span class="result-sub">${sub}</span>` : ""}`;
    btn.addEventListener("click", () => focusCountry(country, filter));
    return btn;
  }

  // Every whitespace-separated token must appear in the field, so
  // "vanessa bly" matches the contact "vanessa.bly@northwestern.edu".
  function fieldMatches(field, tokens) {
    if (!field) return false;
    const f = field.toLowerCase();
    return tokens.every((t) => f.includes(t));
  }

  function runSearch(query) {
    const q = query.trim().toLowerCase();
    searchResults.innerHTML = "";
    if (q.length < 2) {
      searchResults.classList.add("hidden");
      return;
    }
    const tokens = q.split(/\s+/);

    // A previously opened card would cover the results dropdown.
    detailCard.classList.add("hidden");

    const countryHits = countries.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);

    // People/organizations: match against contact emails and survey sources,
    // remembering which entries matched so the card can show just those.
    const personHits = [];
    const seen = new Map();
    countries.forEach((c) => {
      c.entries.forEach((e) => {
        [e.contact, e.source].forEach((field) => {
          if (!fieldMatches(field, tokens)) return;
          const key = field + "|" + c.iso3;
          if (!seen.has(key)) {
            const hit = { field, country: c, entries: [] };
            seen.set(key, hit);
            personHits.push(hit);
          }
          if (!seen.get(key).entries.includes(e)) seen.get(key).entries.push(e);
        });
      });
    });

    if (countryHits.length) {
      const title = document.createElement("div");
      title.className = "search-group-title";
      title.textContent = "Countries";
      searchResults.appendChild(title);
      countryHits.forEach((c) => searchResults.appendChild(resultButton(c.name, null, c)));
    }
    if (personHits.length) {
      const title = document.createElement("div");
      title.className = "search-group-title";
      title.textContent = "Contacts & sources";
      searchResults.appendChild(title);
      personHits.slice(0, 10).forEach(({ field, country, entries }) => {
        searchResults.appendChild(resultButton(country.name, field, country, { entries, label: field }));
      });
    }
    if (!countryHits.length && !personHits.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = "No matches";
      searchResults.appendChild(empty);
    }
    searchResults.classList.remove("hidden");
  }

  searchInput.addEventListener("input", (e) => runSearch(e.target.value));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") searchResults.classList.add("hidden");
    if (e.key === "Enter") {
      const first = searchResults.querySelector(".search-result");
      if (first) first.click();
    }
  });
  // --- Visitor data submission ---
  const submitOverlay = document.getElementById("submit-overlay");
  const submitForm = document.getElementById("submit-form");
  const submitStatus = document.getElementById("submit-status");
  const submitSend = document.getElementById("submit-send");

  document.getElementById("submit-open").addEventListener("click", () => {
    submitOverlay.classList.remove("hidden");
  });
  document.getElementById("submit-close").addEventListener("click", () => {
    submitOverlay.classList.add("hidden");
  });
  submitOverlay.addEventListener("click", (e) => {
    if (e.target === submitOverlay) submitOverlay.classList.add("hidden");
  });

  function submissionBody(data) {
    return [
      "New WISE map data submission",
      "----------------------------",
      `Level: ${data.level}`,
      `Country: ${data.country}`,
      `Location: ${data.location || "-"}`,
      `Status: ${data.status}`,
      `Tool: ${data.tool}`,
      `Dates: ${data.dates || "-"}`,
      `Source: ${data.source || "-"}`,
      `Link: ${data.link || "-"}`,
      `Data contact: ${data.contact || "-"}`,
      `Submitted by: ${data.submitter}`,
      `Notes: ${data.notes || "-"}`,
    ].join("\n");
  }

  submitForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(submitForm).entries());
    submitStatus.classList.remove("hidden", "error");

    if (SUBMIT_ENDPOINT) {
      submitSend.disabled = true;
      submitStatus.textContent = "Sending…";
      fetch(SUBMIT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(data),
      })
        .then((res) => {
          if (!res.ok) throw new Error("HTTP " + res.status);
          submitStatus.textContent = "Thank you! Your submission was sent to the research team for review.";
          submitForm.reset();
        })
        .catch(() => {
          submitStatus.classList.add("error");
          submitStatus.textContent = "Something went wrong sending your submission. Please try again or email " + SUBMIT_EMAIL + ".";
        })
        .finally(() => {
          submitSend.disabled = false;
        });
    } else {
      const subject = `WISE map data submission: ${data.country}`;
      window.location.href =
        `mailto:${SUBMIT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(submissionBody(data))}`;
      submitStatus.textContent = "Your email app should open with the submission pre-filled — just hit send.";
    }
  });

  map.on("zoomend", () => renderMarkers());

  document.getElementById("search-btn").addEventListener("click", () => {
    runSearch(searchInput.value);
    searchInput.focus();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#search-wrap")) searchResults.classList.add("hidden");
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
    // Everything is visible on first load, so every tool starts checked and
    // the active group starts expanded to make that state visible.
    selectedTools = new Set(allTools);
    const activeGroup = document.querySelector('.filter-group[data-filter="all"]');
    activeGroup.classList.add("open");
    renderToolList(activeGroup);
    updateStats();
    renderMarkers();

    // The container can have zero size at script time (embeds, slow layout),
    // which makes fitBounds zoom in to the max. Invalidate the cached size
    // and defer the initial fit until the container is actually laid out.
    const bounds = L.latLngBounds(countries.map((c) => [c.lat, c.lng]));
    let fitted = false;
    const tryFit = () => {
      map.invalidateSize();
      const size = map.getSize();
      if (!fitted && size.x > 0 && size.y > 0) {
        fitted = true;
        map.fitBounds(bounds, { padding: [40, 40] });
      }
    };
    tryFit();
    new ResizeObserver(tryFit).observe(document.getElementById("map"));
  }
})();
