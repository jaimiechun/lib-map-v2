(function () {
  const STATUS_LABEL = { completed: "Completed", planned: "Planned", mixed: "In progress" };
  const TEAL = "#0e7c7b";
  const REP_FILL = "#82AEF3";

  // Full known tool list (mirrors the Submit Data form's Tool dropdown), so
  // the "See on map" filter always offers every tool as an option even
  // before any data using it has been added.
  const KNOWN_TOOLS = [
    "HWISE-12",
    "HWISE-4",
    "IWISE-12",
    "IWISE-4",
    "Healthcare Facility (HCF) - WISE",
    "SCHOOL-WISE",
  ];

  // Map dots, tool badges, and filter swatches are all colored per tool.
  const TOOL_COLORS = {
    "HWISE-12": "#00AEE5",
    "HWISE-4": "#00DF30",
    "IWISE-12": "#00DDDC",
    "IWISE-4": "#0078C4",
    "Healthcare Facility (HCF) - WISE": "#00C6A1",
    "SCHOOL-WISE": "#002565",
  };
  function toolColor(tool) {
    return TOOL_COLORS[tool] || TEAL;
  }
  // Picks readable text color against a given fill (used on badges/swatches).
  function contrastText(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? "#1c2430" : "#fff";
  }
  // Mirrors scripts/build_data.py's country-level status aggregation, but
  // applied per tool-group so each tool's dot reflects only its own entries.
  function aggregateStatus(entries) {
    const statuses = new Set(entries.map((e) => e.status));
    if ([...statuses].every((s) => s === "Completed")) return "completed";
    if ([...statuses].every((s) => s === "Planned")) return "planned";
    return "mixed";
  }

  // Visitor data submissions. If SUBMIT_ENDPOINT is set (e.g. a Google Apps
  // Script web app or Formspree URL), the form POSTs JSON there. If it is
  // empty, the form falls back to opening a pre-filled email to SUBMIT_EMAIL.
  const SUBMIT_ENDPOINT = "https://formspree.io/f/xeajjpzr";
  const SUBMIT_EMAIL = "sera.young@northwestern.edu";

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
    onEachFeature: (feature, layer) => {
      const name = feature.properties && feature.properties.name;
      if (!name) return;
      layer.bindTooltip(name, {
        permanent: true,
        direction: "center",
        className: "country-label",
      });
    },
  }).addTo(map);

  // Country name labels only past a certain zoom - all ~184 of them at once
  // would be unreadable clutter at the world view.
  const LABEL_MIN_ZOOM = 4;
  function updateLabelVisibility() {
    map.getContainer().classList.toggle("labels-hidden", map.getZoom() < LABEL_MIN_ZOOM);
  }
  map.on("zoomend", updateLabelVisibility);
  updateLabelVisibility();

  const detailCard = document.getElementById("detail-card");
  const detailContent = document.getElementById("detail-content");
  const statsEl = document.getElementById("stats");

  document.getElementById("detail-close").addEventListener("click", () => {
    detailCard.classList.add("hidden");
  });

  document.getElementById("expand-btn").addEventListener("click", () => {
    window.open(window.location.href, "_blank");
  });

  const filterPanel = document.getElementById("filter-panel");
  const panelToggle = document.getElementById("panel-toggle");
  panelToggle.addEventListener("click", () => {
    const collapsed = filterPanel.classList.toggle("collapsed");
    panelToggle.title = collapsed ? "Expand filters" : "Collapse filters";
    panelToggle.setAttribute("aria-expanded", String(!collapsed));
  });

  let countries = [];
  let markers = [];
  let borderLayer = null;
  let activeStatusFilter = "all";
  let activeDataType = "all";
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

  // Site-level entries carry their own real coordinates (e.g. Louisiana vs.
  // Ohio are genuinely different points) and are plotted there directly.
  // Only entries with no specific site (national-level surveys) fall back
  // to the country centroid. Within any single point, entries are further
  // split by tool and colored per TOOL_COLORS; if more than one tool lands
  // on the exact same point, they're nudged into a small ring so they don't
  // fully overlap. Status still reads via opacity: solid = completed,
  // translucent = planned, core+halo = mixed.
  function markersFor(country) {
    const visibleEntries = country.entries.filter(entryMatchesFilter);

    // Group by (real coordinate, or country centroid) + tool.
    const groups = new Map();
    visibleEntries.forEach((e) => {
      const hasCoords = typeof e.lat === "number" && typeof e.lng === "number";
      const lat = hasCoords ? e.lat : country.lat;
      const lng = hasCoords ? e.lng : country.lng;
      const locKey = hasCoords ? `${e.lat.toFixed(4)},${e.lng.toFixed(4)}` : "centroid";
      const tool = e.tool || "Other";
      const key = `${locKey}|${tool}`;
      if (!groups.has(key)) groups.set(key, { lat, lng, locKey, tool, entries: [] });
      groups.get(key).entries.push(e);
    });

    // Cluster tool-groups that share the same point so overlapping ones can
    // be nudged apart; the centroid fallback uses a wider ring since many
    // unrelated entries can land there, real sites use a tighter one.
    const byLocation = new Map();
    groups.forEach((g) => {
      if (!byLocation.has(g.locKey)) byLocation.set(g.locKey, []);
      byLocation.get(g.locKey).push(g);
    });

    const layers = [];
    byLocation.forEach((groupsAtLoc) => {
      const offsetDeg = groupsAtLoc[0].locKey === "centroid" ? 1.1 : 0.35;
      groupsAtLoc.forEach((g, i) => {
        let lat = g.lat;
        let lng = g.lng;
        if (groupsAtLoc.length > 1) {
          const angle = (2 * Math.PI * i) / groupsAtLoc.length;
          const latCos = Math.max(Math.cos((g.lat * Math.PI) / 180), 0.2);
          lat += offsetDeg * Math.sin(angle);
          lng += (offsetDeg * Math.cos(angle)) / latCos;
        }

        const color = toolColor(g.tool);
        const radius = radiusFor(g.entries.length);
        const status = aggregateStatus(g.entries);
        const base = { className: "wise-marker", weight: 0, fillColor: color };
        const filterInfo = { entries: g.entries, label: entryTitle(g.entries[0]) };
        const addMarker = (r, opacity) => {
          const marker = L.circleMarker([lat, lng], { ...base, radius: r, fillOpacity: opacity });
          marker.on("click", () => showDetail(country, filterInfo));
          layers.push(marker);
        };

        if (status === "completed") addMarker(radius, 1);
        else if (status === "planned") addMarker(radius, 0.35);
        else {
          addMarker(radius * 1.6, 0.3);
          addMarker(radius * 0.75, 1);
        }
      });
    });

    return layers;
  }

  // A country passes if at least one of its entries matches the active
  // status and the checked tools, so countries with both completed and
  // planned work show up under either status filter.
  function entryMatchesFilter(entry) {
    if (activeStatusFilter === "completed" && entry.status !== "Completed") return false;
    if (activeStatusFilter === "planned" && entry.status !== "Planned") return false;
    if (activeDataType === "national" && !entry.nationallyRepresentative) return false;
    if (activeDataType === "site" && entry.nationallyRepresentative) return false;
    if (entry.tool && !selectedTools.has(entry.tool)) return false;
    return true;
  }

  function passesFilter(country) {
    return country.entries.some(entryMatchesFilter);
  }

  // Same as entryMatchesFilter but ignores the tool checklist: shading marks
  // whether a country HAS nationally representative coverage at all, which
  // shouldn't disappear just because someone unchecked every tool (that
  // checklist only exists to filter which dots show).
  function entryMatchesShading(entry) {
    if (activeStatusFilter === "completed" && entry.status !== "Completed") return false;
    if (activeStatusFilter === "planned" && entry.status !== "Planned") return false;
    if (activeDataType === "national" && !entry.nationallyRepresentative) return false;
    if (activeDataType === "site" && entry.nationallyRepresentative) return false;
    return true;
  }

  // Countries get their whole territory shaded wherever they have at least
  // one *currently visible* nationally representative entry - so switching
  // to the Site-level data-type filter naturally clears the shading instead
  // of needing a separate toggle for it.
  function renderBorders() {
    if (borderLayer) {
      map.removeLayer(borderLayer);
      borderLayer = null;
    }
    if (!window.WISE_BORDERS) return;
    const byIso3 = new Map(countries.map((c) => [c.iso3, c]));
    const visible = new Set(
      countries
        .filter((c) => c.entries.filter(entryMatchesShading).some((e) => e.nationallyRepresentative))
        .map((c) => c.iso3)
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
    updateGlobe();
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    // Nationally Rep mode shows only the shaded territories, no dots - a
    // country's national coverage is its whole shaded region, not a point.
    if (activeDataType === "national") return;
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
    if (entry.tool) {
      const bg = toolColor(entry.tool);
      parts.push(
        `<span class="badge tool" style="background:${bg};color:${contrastText(bg)}">${entry.tool}</span>`
      );
    }
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
  // filter: { entries, label, heading? }. When heading is set (person
  // search results, which can span multiple countries) it replaces the
  // country name and the separate "Showing matches for" note is dropped
  // since the heading already says who/what this card is scoped to.
  function showDetail(country, filter) {
    const entries = filter ? filter.entries : country.entries;
    const completedCount = entries.filter((e) => e.status === "Completed").length;
    const ongoingCount = entries.filter((e) => e.status === "Ongoing").length;
    const plannedCount = entries.filter((e) => e.status === "Planned").length;
    const summaryParts = [`${completedCount} completed`];
    if (ongoingCount) summaryParts.push(`${ongoingCount} ongoing`);
    if (plannedCount) summaryParts.push(`${plannedCount} planned`);
    const heading = filter && filter.heading ? filter.heading : country.name;
    detailContent.innerHTML = `
      <p class="detail-country">${heading}</p>
      <p class="detail-summary">
        ${entries.length} data ${entries.length === 1 ? "entry" : "entries"}
        · ${summaryParts.join(" · ")}
      </p>
      ${filter && !filter.heading ? `
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

  // One shared tool checklist (used regardless of which status is active)
  // instead of a separate copy under each of the three status pills.
  function renderToolList() {
    const list = document.getElementById("tool-list");
    list.innerHTML = allTools
      .map(
        (tool) => `
        <label class="tool-option">
          <input type="checkbox" value="${tool}" ${selectedTools.has(tool) ? "checked" : ""}>
          <span class="tool-swatch" style="background:${toolColor(tool)}"></span>
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

  document.getElementById("tools-check-all").addEventListener("click", () => {
    selectedTools = new Set(allTools);
    renderToolList();
    renderMarkers();
  });
  document.getElementById("tools-uncheck-all").addEventListener("click", () => {
    selectedTools = new Set();
    renderToolList();
    renderMarkers();
  });

  document.querySelectorAll("#status-toggle .status-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#status-toggle .status-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeStatusFilter = btn.dataset.filter;
      renderMarkers();
    });
  });

  document.querySelectorAll("#datatype-toggle .status-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#datatype-toggle .status-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeDataType = btn.dataset.datatype;
      renderMarkers();
    });
  });

  // --- Search: country names, plus contacts/sources ("who is involved") ---
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");

  function focusCountry(country, filter) {
    map.setView([country.lat, country.lng], 5);
    if (globeActive && globe) globe.pointOfView({ lat: country.lat, lng: country.lng, altitude: 1.2 }, 800);
    showDetail(country, filter);
    searchResults.classList.add("hidden");
    searchInput.value = "";
  }

  // For person/source hits, which can span multiple countries: fit the map
  // to every matched point instead of centering on just one country.
  function focusPoints(points, filter) {
    if (points.length === 1) {
      map.setView(points[0], 5);
    } else {
      map.fitBounds(L.latLngBounds(points), { padding: [60, 60], maxZoom: 5 });
    }
    if (globeActive && globe) {
      const lat = points.reduce((s, p) => s + p[0], 0) / points.length;
      const lng = points.reduce((s, p) => s + p[1], 0) / points.length;
      globe.pointOfView({ lat, lng, altitude: 1.4 }, 800);
    }
    showDetail(null, filter);
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

  function personResultButton(label, sub, points, filter) {
    const btn = document.createElement("button");
    btn.className = "search-result";
    btn.innerHTML = `${label}${sub ? `<span class="result-sub">${sub}</span>` : ""}`;
    btn.addEventListener("click", () => focusPoints(points, filter));
    return btn;
  }

  // Turns a raw contact email into a readable name: "vanessa.bly@..." ->
  // "Vanessa Bly". Non-email fields (survey/source names) pass through
  // unchanged since they're already human-readable.
  function personDisplayName(field) {
    if (!field.includes("@")) return field;
    const local = field.split("@")[0];
    return local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
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

    // Cities/regional sites: match entry locations, remembering which
    // entries matched so the card can show just that place's studies.
    const locationHits = [];
    const seenLocations = new Map();
    countries.forEach((c) => {
      c.entries.forEach((e) => {
        if (!fieldMatches(e.location, tokens)) return;
        const key = e.location.trim().toLowerCase() + "|" + c.iso3;
        if (!seenLocations.has(key)) {
          const hit = { location: e.location, country: c, entries: [] };
          seenLocations.set(key, hit);
          locationHits.push(hit);
        }
        seenLocations.get(key).entries.push(e);
      });
    });

    // People/organizations: match against contact emails and survey sources.
    // Grouped by the field alone (not per-country) so someone involved
    // across multiple countries shows as one consolidated result covering
    // every site they touched, not a separate row per country.
    const personHits = [];
    const seen = new Map();
    countries.forEach((c) => {
      c.entries.forEach((e) => {
        [e.contact, e.source].forEach((field) => {
          if (!fieldMatches(field, tokens)) return;
          if (!seen.has(field)) {
            const hit = { field, entries: [], countries: new Set(), points: [] };
            seen.set(field, hit);
            personHits.push(hit);
          }
          const hit = seen.get(field);
          if (!hit.entries.includes(e)) hit.entries.push(e);
          hit.countries.add(c);
          const point = typeof e.lat === "number" ? [e.lat, e.lng] : [c.lat, c.lng];
          if (!hit.points.some((p) => p[0] === point[0] && p[1] === point[1])) hit.points.push(point);
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
    if (locationHits.length) {
      const title = document.createElement("div");
      title.className = "search-group-title";
      title.textContent = "Locations";
      searchResults.appendChild(title);
      locationHits.slice(0, 10).forEach(({ location, country, entries }) => {
        searchResults.appendChild(resultButton(location, country.name, country, { entries, label: location }));
      });
    }
    if (personHits.length) {
      const title = document.createElement("div");
      title.className = "search-group-title";
      title.textContent = "Contacts & sources";
      searchResults.appendChild(title);
      personHits.slice(0, 10).forEach(({ field, entries, countries: hitCountries, points }) => {
        const name = personDisplayName(field);
        const countryList = [...hitCountries].map((c) => c.name);
        const sub = countryList.length > 1 ? `${countryList.length} countries` : countryList[0];
        searchResults.appendChild(
          personResultButton(name, sub, points, { entries, heading: `Showing results for ${name}` })
        );
      });
    }
    if (!countryHits.length && !locationHits.length && !personHits.length) {
      // Distinguish "this is a real country, we just have no data for it"
      // (e.g. France) from a genuinely unrecognized search.
      const worldMatch = window.WISE_WORLD && window.WISE_WORLD.features.some(
        (f) => (f.properties.name || "").toLowerCase().includes(q)
      );
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = worldMatch ? "No data yet" : "No matches";
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
  const submitCountry = document.getElementById("submit-country");

  if (submitCountry && window.WISE_WORLD) {
    const countryNames = [...new Set(
      window.WISE_WORLD.features.map((f) => f.properties.name)
    )].sort((a, b) => a.localeCompare(b));
    for (const name of countryNames) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      submitCountry.appendChild(opt);
    }
  }

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

  // Pulls an email address out of the free-text "Jane Doe, jane@example.org"
  // submitter field so Formspree can set Reply-To to the actual visitor.
  function extractEmail(text) {
    const match = (text || "").match(/[^\s<>()]+@[^\s<>()]+\.[^\s<>()]+/);
    return match ? match[0] : "";
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
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          ...data,
          _subject: `WISE map data submission: ${data.country}`,
          _replyto: extractEmail(data.submitter) || undefined,
        }),
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

  // --- Globe view (lazy-loaded WebGL globe; same data and filters) ---
  const globeBtn = document.getElementById("globe-btn");
  const globeEl = document.getElementById("globe");
  const mapEl = document.getElementById("map");
  let globe = null;
  let globeActive = false;
  let globeLoading = false;

  // Radius in globe "points" units (globe.gl scale, roughly comparable to
  // the 2D marker radius formula).
  function globeDotRadius(country) {
    return Math.min(0.35 + Math.sqrt(country.entries.length) * 0.22, 1.6);
  }

  function globeDotColor(country) {
    // Solid teal for completed, translucent teal for planned, and a
    // slightly-less-translucent teal for mixed (no room for the 2D
    // halo-plus-core layering with a single WebGL point layer).
    if (country.status === "completed") return TEAL;
    if (country.status === "planned") return "rgba(14, 124, 123, 0.4)";
    return "rgba(14, 124, 123, 0.75)";
  }

  function updateGlobe() {
    if (!globe) return;
    // Nationally Rep mode shows only the shaded territories, no points.
    const visible = activeDataType === "national" ? [] : countries.filter(passesFilter);
    const rep = new Set(
      countries
        .filter((c) => c.entries.filter(entryMatchesShading).some((e) => e.nationallyRepresentative))
        .map((c) => c.iso3)
    );
    globe
      .polygonCapColor((f) => (rep.has(f.id) ? "rgba(130, 174, 243, 0.9)" : "#f7f7f4"))
      .pointsData(visible)
      .pointColor(globeDotColor)
      // Just above the land polygon cap altitude (0.008) so dots sit on
      // top of the surface instead of being hidden beneath it, but still
      // low enough to read as a flat disc rather than an extruded pill.
      .pointAltitude(0.009)
      .pointRadius(globeDotRadius)
      .pointResolution(48);
  }

  function initGlobe() {
    const script = document.createElement("script");
    script.src = "https://unpkg.com/globe.gl@2.34.5/dist/globe.gl.min.js";
    script.onload = () => {
      globe = Globe({ rendererConfig: { antialias: true, alpha: true } })(globeEl)
        .backgroundColor("rgba(0,0,0,0)")
        .showAtmosphere(true)
        .atmosphereColor("#b9d6e8")
        .polygonsData(window.WISE_WORLD.features)
        .polygonAltitude(0.008)
        // Finer tessellation so large polygons follow the sphere's curvature
        // instead of cutting through it (which shimmered/glitched).
        .polygonCapCurvatureResolution(1)
        .polygonsTransitionDuration(0)
        .polygonSideColor(() => "rgba(20, 30, 40, 0.05)")
        .polygonStrokeColor(() => "#c6cbd4")
        .onPointClick((c) => showDetail(c))
        .onPolygonClick((f) => {
          const c = countries.find((x) => x.iso3 === f.id);
          if (c) showDetail(c);
        });
      globe.globeMaterial().color.set("#fdffe9");
      // Render at the display's native pixel density so the globe isn't
      // pixelated on retina screens (must be set before the first frame).
      globe.renderer().setPixelRatio(window.devicePixelRatio || 1);
      globe.pointOfView({ lat: 15, lng: 10, altitude: 2 });
      new ResizeObserver(() => {
        globe.width(globeEl.clientWidth).height(globeEl.clientHeight);
      }).observe(globeEl);
      globeLoading = false;
      updateGlobe();
    };
    script.onerror = () => {
      globeLoading = false;
      globeBtn.textContent = "🌐";
      globeBtn.title = "Globe view";
      globeEl.classList.remove("active");
      mapEl.style.display = "block";
      globeActive = false;
    };
    document.body.appendChild(script);
  }

  globeBtn.addEventListener("click", () => {
    if (globeActive) {
      globeActive = false;
      globeEl.classList.remove("active");
      mapEl.style.display = "block";
      globeBtn.textContent = "🌐";
      globeBtn.title = "Globe view";
      map.invalidateSize();
      return;
    }
    globeActive = true;
    mapEl.style.display = "none";
    globeEl.classList.add("active");
    globeBtn.textContent = "🗺️";
    globeBtn.title = "2D view";
    if (!globe && !globeLoading) {
      globeLoading = true;
      initGlobe();
    } else {
      updateGlobe();
    }
  });

  document.getElementById("search-btn").addEventListener("click", () => {
    runSearch(searchInput.value);
    searchInput.focus();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#search-wrap")) searchResults.classList.add("hidden");
  });

  // Data is loaded via a <script> tag (data/countries.js) rather than fetch()
  // so the page also works when opened directly from the filesystem (file://).
  const data = window.WISE_COUNTRIES;
  if (!Array.isArray(data)) {
    statsEl.textContent = "Failed to load data";
    console.error("data/countries.js did not load");
  } else {
    countries = data.filter((c) => typeof c.lat === "number" && typeof c.lng === "number");
    // Union of the known tool list and whatever tools actually appear in the
    // data, so nothing is silently dropped if the data has a tool that
    // predates KNOWN_TOOLS being updated.
    const dataTools = countries.flatMap((c) => c.entries.map((e) => e.tool)).filter(Boolean);
    allTools = [...new Set([...KNOWN_TOOLS, ...dataTools])];
    // Everything is visible on first load, so every tool starts checked.
    selectedTools = new Set(allTools);
    renderToolList();
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
