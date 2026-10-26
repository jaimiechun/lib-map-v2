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

  // Equal Earth projection (Šavrič, Patterson & Jenny, 2018) instead of
  // Leaflet's default Web Mercator. Mercator inflates area with latitude —
  // Greenland reads as large as Africa — which misrepresents this dataset in
  // particular: coverage concentrates near the equator (Sub-Saharan Africa
  // alone is ~48% of all entries) exactly where Mercator shrinks land, while
  // the near-empty high latitudes dominate the frame.
  //
  // Equal Earth is equal-area — every country's screen area stays proportional
  // to its true area — but curves the meridians, so equatorial landmasses keep
  // recognisable shapes instead of the vertical stretching a cylindrical
  // equal-area projection gives them.
  //
  // Implemented directly from the published polynomial rather than pulling in
  // proj4 + Proj4Leaflet, keeping the site dependency-free. This is only
  // practical at all because the basemap is vector (data/world.js); raster
  // tiles would be locked to the projection they were cut in.
  const DEG = Math.PI / 180;
  const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796;
  const M = Math.sqrt(3) / 2;

  // y(θ) and its derivative, shared by the forward and inverse transforms.
  const eqEarthY = (t) => t * (A1 + A2 * t * t + t ** 6 * (A3 + A4 * t * t));
  const eqEarthDY = (t) => A1 + 3 * A2 * t * t + t ** 6 * (7 * A3 + 9 * A4 * t * t);

  const EqualEarthProjection = {
    project(latlng) {
      const lat = Math.max(-90, Math.min(90, latlng.lat));
      const theta = Math.asin(M * Math.sin(lat * DEG));
      return new L.Point(
        (latlng.lng * DEG * Math.cos(theta)) / (M * eqEarthDY(theta)),
        eqEarthY(theta)
      );
    },
    // No closed-form inverse; Newton-Raphson converges in a handful of steps.
    unproject(point) {
      let theta = point.y;
      for (let i = 0; i < 12; i++) {
        const dt = (eqEarthY(theta) - point.y) / eqEarthDY(theta);
        theta -= dt;
        if (Math.abs(dt) < 1e-12) break;
      }
      const sinLat = Math.max(-1, Math.min(1, Math.sin(theta) / M));
      return new L.LatLng(
        Math.asin(sinLat) / DEG,
        (M * point.x * eqEarthDY(theta)) / Math.cos(theta) / DEG
      );
    },
    bounds: L.bounds(
      [-Math.PI / (M * A1), -eqEarthY(Math.asin(M))],
      [Math.PI / (M * A1), eqEarthY(Math.asin(M))]
    ),
  };

  // One shared scale factor for x and y, so equal-area holds on screen too;
  // the world then spans exactly 1 unit wide (256px at zoom 0).
  const UNIT = (M * A1) / (2 * Math.PI);

  const EqualAreaCRS = L.extend({}, L.CRS.Earth, {
    code: "WISE:EqualEarth",
    projection: EqualEarthProjection,
    transformation: new L.Transformation(UNIT, 0.5, -UNIT, 0.5),
  });

  const map = L.map("map", {
    crs: EqualAreaCRS,
    zoomSnap: 0.5, // allows the half-step nudge on the initial fit
    // Narrow screens need to go below the old floor of 2 to fit the data
    // band at all — clamping there forced a zoomed-in view that pushed the
    // Americas off the edge on phones.
    minZoom: 1,
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
      fillColor: "#fbfaf6",
      fillOpacity: 1,
      color: "#d6d0c5",
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
  // The placement half of markersFor(), kept separate so the globe can plot
  // exactly the same points without duplicating the grouping rules.
  // Returns [{ lat, lng, tool, entries }] with the ring offsets applied.
  function markerGroups(country) {
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

    const placed = [];
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
        placed.push({ lat, lng, tool: g.tool, entries: g.entries });
      });
    });
    return placed;
  }

  function markersFor(country) {
    const layers = [];
    markerGroups(country).forEach((g) => {
      const color = toolColor(g.tool);
      const radius = radiusFor(g.entries.length);
      const status = aggregateStatus(g.entries);
      const base = { className: "wise-marker", weight: 0, fillColor: color };
      const filterInfo = { entries: g.entries, label: entryTitle(g.entries[0]) };
      const addMarker = (r, opacity) => {
        const marker = L.circleMarker([g.lat, g.lng], { ...base, radius: r, fillOpacity: opacity });
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
      parts.push(
        `<span class="badge tool"><span class="badge-dot" style="background:${toolColor(entry.tool)}"></span>${entry.tool}</span>`
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

  // Country poster (Canva design) shown at the foot of the card, clicking
  // through to that country's DOI. Only countries with both a design and a
  // DOI are in data/posters.js, so there's nothing to render otherwise.
  // Needs both halves: `image` (a PNG exported from Canva) to show, and `doi`
  // to link to. Countries missing either are simply left without a poster.
  function posterHtml(country) {
    const poster = window.WISE_POSTERS && window.WISE_POSTERS[country.iso3];
    if (!poster || !poster.doi || !poster.image) return "";
    const alt = `Water insecurity brief for ${country.name}`;
    const media = `<img class="poster-media" src="${poster.image}" alt="${alt}" loading="lazy">`;
    return `
      <a class="poster" href="${poster.doi}" target="_blank" rel="noopener"
         aria-label="Open the ${country.name} water insecurity brief record (DOI)">
        ${media}
        <span class="poster-cover"></span>
        <span class="poster-open">Open <span aria-hidden="true">↗</span></span>
      </a>
    `;
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
      ${filter && filter.heading ? "" : posterHtml(country)}
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
    if (globeActive && globe) globeGoTo(country.lat, country.lng);
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
      globeGoTo(lat, lng);
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

  // --- Globe view (vector orthographic globe; same data and filters) ---
  //
  // Drawn with d3-geo onto a canvas rather than as WebGL geometry. The old
  // globe.gl version extruded each country to altitude 0.008 and floated the
  // dots at 0.009 — a gap of about 7km at globe scale, too thin for the GPU
  // to resolve, so surfaces shimmered and bled into each other while
  // rotating, and raised polygon *sides* made borders read as walls. Here
  // land lies flat on the sphere exactly as it does on the 2D map, using the
  // same palette, the same marker grouping and the same status encoding, so
  // the two views finally agree. It also drops ~600KB of three.js for ~30KB
  // of projection maths.
  const globeBtn = document.getElementById("globe-btn");
  const globeEl = document.getElementById("globe");
  const mapEl = document.getElementById("map");
  let globe = null; // { canvas, ctx, projection, path, rotation, scale }
  let globeActive = false;
  let globeLoading = false;
  let globeDots = []; // screen-space hit targets, rebuilt every render
  // Globe equivalent of the 2D map's LABEL_MIN_ZOOM: names appear once the
  // globe has been zoomed past roughly 1.5x its default size.
  const GLOBE_LABEL_MIN_SCALE = 1.5;

  // Just the two d3 modules the globe needs (~53KB) rather than the whole
  // d3 bundle (~280KB); d3-geo depends on d3-array, so order matters.
  const D3_SCRIPTS = [
    "https://cdn.jsdelivr.net/npm/d3-array@3/dist/d3-array.min.js",
    "https://cdn.jsdelivr.net/npm/d3-geo@3/dist/d3-geo.min.js",
  ];

  function loadScripts(urls, onDone, onError) {
    const next = (i) => {
      if (i >= urls.length) return onDone();
      const s = document.createElement("script");
      s.src = urls[i];
      s.onload = () => next(i + 1);
      s.onerror = onError;
      document.body.appendChild(s);
    };
    next(0);
  }

  // d3-geo reads polygons on the sphere, where ring direction decides which
  // side is "inside": a clockwise exterior ring means everything *except*
  // that shape, so a single mis-wound country (Antarctica, typically) paints
  // over the whole globe and the ocean disappears. Leaflet renders the same
  // data planar and doesn't care, so this is fixed up for the globe only.
  let globeFeatures = null;
  function rewindForSphere(features) {
    return features.map((f) => {
      const geom = f.geometry;
      const polys = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
      const fixed = polys.map((rings) =>
        rings.map((ring, i) => {
          const area = d3.geoArea({ type: "Polygon", coordinates: [ring] });
          // Exterior rings should cover less than a hemisphere; holes more.
          const tooBig = i === 0 ? area > 2 * Math.PI : area < 2 * Math.PI;
          return tooBig ? ring.slice().reverse() : ring;
        })
      );
      return {
        ...f,
        geometry: {
          type: geom.type,
          coordinates: geom.type === "MultiPolygon" ? fixed : fixed[0],
        },
      };
    });
  }

  function globeSize() {
    return { w: globeEl.clientWidth || 800, h: globeEl.clientHeight || 600 };
  }

  function renderGlobe() {
    if (!globe) return;
    const { ctx, projection, path } = globe;
    const { w, h } = globeSize();
    const dpr = window.devicePixelRatio || 1;

    if (globe.canvas.width !== Math.round(w * dpr) || globe.canvas.height !== Math.round(h * dpr)) {
      globe.canvas.width = Math.round(w * dpr);
      globe.canvas.height = Math.round(h * dpr);
      globe.canvas.style.width = w + "px";
      globe.canvas.style.height = h + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    projection
      .rotate(globe.rotation)
      .translate([w / 2, h / 2])
      .scale(globe.scale * Math.min(w, h) / 2.4);

    // Ocean sphere — same sea colour as the 2D map.
    ctx.beginPath();
    path({ type: "Sphere" });
    ctx.fillStyle = "#20B2AA";
    ctx.fill();

    const rep = new Set(
      countries
        .filter((c) => c.entries.filter(entryMatchesShading).some((e) => e.nationallyRepresentative))
        .map((c) => c.iso3)
    );

    // Land, then the blue wash over nationally representative territories.
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = "#d6d0c5";
    globeFeatures.forEach((f) => {
      ctx.beginPath();
      path(f);
      ctx.fillStyle = "#fbfaf6";
      ctx.fill();
      if (rep.has(f.id)) {
        ctx.fillStyle = "rgba(130, 174, 243, 0.35)";
        ctx.fill();
      }
      ctx.stroke();
    });

    // Dots: same grouping, sizing and status encoding as the 2D markers.
    // Nationally Rep mode shows shaded territories only, matching the map.
    globeDots = [];
    if (activeDataType !== "national") {
      const centre = [-globe.rotation[0], -globe.rotation[1]];
      // Match the 2D marker scale rather than the globe's radius: the 2D map
      // shrinks dots when zoomed out (zoomScale) and the globe shows far
      // fewer degrees per pixel than the flat map, so sizing straight off the
      // radius made the dots roughly half again too big and badly crowded.
      // Capped so zooming right in doesn't inflate them past readability.
      const radius = (globe.scale * Math.min(w, h)) / 2.4;
      const dotScale = Math.min(radius / 580, 1.1);
      countries.filter(passesFilter).forEach((country) => {
        markerGroups(country).forEach((g) => {
          // Skip anything on the far side of the globe.
          if (d3.geoDistance([g.lng, g.lat], centre) > Math.PI / 2) return;
          const xy = projection([g.lng, g.lat]);
          if (!xy) return;
          const r = Math.min(6 + Math.sqrt(g.entries.length) * 3, 20) * dotScale;
          const color = toolColor(g.tool);
          const status = aggregateStatus(g.entries);
          const disc = (radius, alpha) => {
            ctx.beginPath();
            ctx.arc(xy[0], xy[1], radius, 0, 2 * Math.PI);
            ctx.globalAlpha = alpha;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.globalAlpha = 1;
          };
          if (status === "completed") disc(r, 1);
          else if (status === "planned") disc(r, 0.35);
          else {
            disc(r * 1.6, 0.3);
            disc(r * 0.75, 1);
          }
          globeDots.push({
            x: xy[0], y: xy[1], r: Math.max(r, 6), country,
            filter: { entries: g.entries, label: entryTitle(g.entries[0]) },
          });
        });
      });
    }

    drawGlobeLabels();
  }

  // Country names, mirroring the 2D map's behaviour of only labelling once
  // you've zoomed in. A country is labelled when its projected area is big
  // enough to hold the text, so labels appear progressively as you zoom
  // rather than all at once, and tiny or edge-on countries stay clear.
  function drawGlobeLabels() {
    const { ctx, projection, path } = globe;
    if (globe.scale < GLOBE_LABEL_MIN_SCALE) return;

    ctx.font = '500 11px Geist, -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const centre = [-globe.rotation[0], -globe.rotation[1]];
    const placed = [];

    globeFeatures.forEach((f) => {
      const name = f.properties && f.properties.name;
      if (!name) return;
      const centroid = d3.geoCentroid(f);
      // Keep well inside the limb: text near the edge is badly distorted.
      if (d3.geoDistance(centroid, centre) > Math.PI / 2.4) return;
      if (path.area(f) < 900) return; // too small at this zoom to label

      const xy = projection(centroid);
      if (!xy) return;
      const half = ctx.measureText(name).width / 2;
      // Skip anything that would sit on top of a label already drawn.
      const clash = placed.some(
        (p) => Math.abs(p.x - xy[0]) < p.half + half + 6 && Math.abs(p.y - xy[1]) < 14
      );
      if (clash) return;
      placed.push({ x: xy[0], y: xy[1], half });

      ctx.fillStyle = "#4d4a44";
      ctx.fillText(name, xy[0], xy[1]);
    });
  }

  // Kept for the call sites that used to drive globe.gl.
  function updateGlobe() {
    renderGlobe();
  }

  // Spins the globe to bring a coordinate to the centre, matching the way
  // the 2D view recentres on search hits.
  function globeGoTo(lat, lng) {
    if (!globe) return;
    const from = globe.rotation.slice();
    const to = [-lng, -lat, 0];
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 700);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      globe.rotation = from.map((v, i) => v + (to[i] - v) * ease);
      renderGlobe();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function initGlobe() {
    loadScripts(
      D3_SCRIPTS,
      () => {
        const canvas = document.createElement("canvas");
        canvas.style.display = "block";
        canvas.style.cursor = "grab";
        globeEl.appendChild(canvas);
        const ctx = canvas.getContext("2d");
        globeFeatures = rewindForSphere(window.WISE_WORLD.features);
        const projection = d3.geoOrthographic().clipAngle(90).precision(0.3);
        globe = {
          canvas,
          ctx,
          projection,
          path: d3.geoPath(projection, ctx),
          rotation: [-10, -15, 0],
          scale: 1,
        };

        // Drag to spin; the divisor keeps a drag across the canvas feeling
        // like turning a globe rather than flinging it.
        let dragging = null;
        canvas.addEventListener("pointerdown", (e) => {
          dragging = { x: e.clientX, y: e.clientY, rotation: globe.rotation.slice(), moved: 0 };
          canvas.setPointerCapture(e.pointerId);
          canvas.style.cursor = "grabbing";
        });
        canvas.addEventListener("pointermove", (e) => {
          if (!dragging) return;
          const dx = e.clientX - dragging.x;
          const dy = e.clientY - dragging.y;
          dragging.moved = Math.max(dragging.moved, Math.abs(dx) + Math.abs(dy));
          const k = 0.25 / globe.scale;
          globe.rotation = [
            dragging.rotation[0] + dx * k,
            Math.max(-90, Math.min(90, dragging.rotation[1] - dy * k)),
            0,
          ];
          renderGlobe();
        });
        const endDrag = (e) => {
          if (!dragging) return;
          const wasClick = dragging.moved < 4;
          dragging = null;
          canvas.style.cursor = "grab";
          if (wasClick) globeClick(e);
        };
        canvas.addEventListener("pointerup", endDrag);
        canvas.addEventListener("pointercancel", () => { dragging = null; });

        canvas.addEventListener("wheel", (e) => {
          e.preventDefault();
          globe.scale = Math.max(0.8, Math.min(6, globe.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
          renderGlobe();
        }, { passive: false });

        new ResizeObserver(renderGlobe).observe(globeEl);
        globeLoading = false;
        renderGlobe();
      },
      () => {
        globeLoading = false;
        globeBtn.textContent = "🌐";
        globeBtn.title = "Globe view";
        globeEl.classList.remove("active");
        mapEl.style.display = "block";
        globeActive = false;
      }
    );
  }

  // Nearest dot wins, then fall back to whichever country was clicked.
  function globeClick(e) {
    const rect = globe.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best = null;
    globeDots.forEach((d) => {
      const dist = Math.hypot(d.x - x, d.y - y);
      if (dist <= d.r && (!best || dist < best.dist)) best = { dist, dot: d };
    });
    if (best) {
      showDetail(best.dot.country, best.dot.filter);
      return;
    }
    const lonlat = globe.projection.invert([x, y]);
    if (!lonlat) return;
    const hit = globeFeatures.find((f) => d3.geoContains(f, lonlat));
    const country = hit && countries.find((c) => c.iso3 === hit.id);
    if (country) showDetail(country);
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
    // Framing the full extent of the data would mean fitting all 360° of
    // longitude, because a handful of Pacific sites sit either side of the
    // dateline (Tonga at -175°, Fiji at +175°) — which shrinks the dense
    // Africa/Asia/Latin America band most people come here to look at. Fit
    // the 2nd-98th percentile of data points instead: ~96% of entries in
    // frame at a usable size, with the stragglers a zoom-out away. Derived
    // from the data rather than hardcoded, so it re-frames itself as
    // coverage grows.
    const points = countries.flatMap((c) =>
      c.entries.map((e) => [
        typeof e.lat === "number" ? e.lat : c.lat,
        typeof e.lng === "number" ? e.lng : c.lng,
      ])
    );
    const spread = (values, p) => {
      const sorted = [...values].sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0,
        Math.round((q / 100) * (sorted.length - 1))))];
      return [at(p), at(100 - p)];
    };
    const [south, north] = spread(points.map((p) => p[0]), 2);
    const [west, east] = spread(points.map((p) => p[1]), 2);
    const bounds = L.latLngBounds([south, west], [north, east]);
    let fitted = false;
    const tryFit = () => {
      map.invalidateSize();
      const size = map.getSize();
      if (!fitted && size.x > 0 && size.y > 0) {
        fitted = true;
        // Reserve the left gutter so the filter panel doesn't sit on top of
        // the data, and lean in half a zoom step past the exact fit: the
        // data band is much wider than it is tall, so a strict fit leaves
        // big empty margins top and bottom. Clipping the quiet edges reads
        // better than framing empty ocean.
        const wide = size.x > 640;
        const panel = document.getElementById("filter-panel");
        const gutter = wide && panel ? panel.offsetWidth + 28 : 20;
        map.fitBounds(bounds, {
          paddingTopLeft: [gutter, 20],
          paddingBottomRight: [20, 20],
        });
        // Only on wide screens: there the frame is taller than the data band
        // needs, so half a step in trims empty ocean. A narrow screen is
        // already height-constrained, and the same nudge would push the
        // Americas off the edge.
        if (wide) map.setZoom(map.getZoom() + 0.5, { animate: false });
      }
    };
    tryFit();
    new ResizeObserver(tryFit).observe(document.getElementById("map"));
  }
})();
