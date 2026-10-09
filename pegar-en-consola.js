/*
 * NoMeSiguen
 *
 * App para ver quién no te sigue de vuelta en Instagram, en tiempo real.
 * Se ejecuta dentro de instagram.com usando tu propia sesión del navegador.
 *
 * Uso:
 *   1. Abre instagram.com e inicia sesión
 *   2. F12 → pestaña "Console"
 *      (si Chrome bloquea el pegado, escribe: allow pasting)
 *   3. Pega TODO este archivo y presiona Enter
 *
 * Funciones:
 *   - Escaneo en vivo: los usuarios aparecen mientras se descargan
 *   - Pestañas: No me siguen / Fans / Solicitudes pendientes / Lista blanca
 *   - Filtros (verificados, privados, sin foto) y búsqueda
 *   - Lista blanca persistente (clic en el avatar para proteger)
 *   - Exportar a JSON / CSV / copiar lista
 *   - Dejar de seguir seleccionados (con pausas de seguridad)
 *
 * Nada sale de tu navegador. Para salir: botón ✕ o recarga la página.
 */
(() => {
  "use strict";

  if (!location.hostname.endsWith("instagram.com")) {
    alert("Abre instagram.com con tu sesión iniciada y vuelve a pegar el código.");
    return;
  }

  /* ================= configuración ================= */

  const PAGE_SIZE = 50;
  const PAGE_DELAY = [900, 1800];
  const CYCLE_EVERY = 6;
  const CYCLE_DELAY = [8000, 14000];
  const RETRY_DELAY = 30000;
  const MAX_RETRIES = 3;
  const UNFOLLOW_DELAY = [3500, 6000];
  const UNFOLLOW_EVERY = 5;
  const UNFOLLOW_REST = 90000;
  const PER_PAGE = 50;
  const WL_KEY = "nms_whitelist";

  /* ================= helpers ================= */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => a + Math.floor(Math.random() * (b - a));
  const cookie = (name) => {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = (u) => String(u.pk ?? u.pk_id ?? u.id);
  const normalize = (u, followsMe) => ({
    id: uid(u),
    username: u.username,
    full_name: u.full_name || "",
    pic: u.profile_pic_url || "",
    is_private: !!u.is_private,
    is_verified: !!u.is_verified,
    follows_viewer: followsMe,   // null = pendiente de confirmar
    pending: followsMe === null,
  });

  const USER_ID = cookie("ds_user_id");
  const CSRF = cookie("csrftoken");
  if (!USER_ID || !CSRF) {
    alert("No encontré tu sesión de Instagram. Inicia sesión primero.");
    return;
  }

  /* ================= estado ================= */

  const loadWhitelist = () => {
    try { return JSON.parse(localStorage.getItem(WL_KEY)) || []; }
    catch { return []; }
  };

  const S = {
    status: "home",        // home | scanning | done | unfollowing
    paused: false,
    statusText: "",
    progress: 0,
    following: 0,
    followers: 0,
    incomplete: false,
    results: [],
    resultsMap: new Map(),
    fans: [],
    requests: [],          // solicitudes de seguimiento enviadas sin aceptar
    whitelist: loadWhitelist(),
    selected: new Set(),
    tab: "nome",           // nome | fans | sol | wl
    search: "",
    filter: { verificados: true, privados: true, sinfoto: true },
    page: 1,
    renderedIds: new Set(),
    unfollowTotal: 0,
  };

  const saveWhitelist = () =>
    localStorage.setItem(WL_KEY, JSON.stringify(S.whitelist));
  const inWhitelist = (id) => S.whitelist.some((u) => u.id === id);
  const noMeSiguenCount = () =>
    S.results.filter((u) => u.follows_viewer === false && !inWhitelist(u.id)).length;

  function visibleUsers() {
    const base =
      S.tab === "fans" ? S.fans :
      S.tab === "sol"  ? S.requests :
      S.tab === "wl"   ? S.whitelist :
      S.results.filter((u) => !inWhitelist(u.id) && u.follows_viewer !== true);
    return base
      .filter((u) => {
        if (!S.filter.verificados && u.is_verified) return false;
        if (!S.filter.privados && u.is_private) return false;
        if (!S.filter.sinfoto && !u.pic) return false;
        const q = S.search.trim().toLowerCase();
        return !q || u.username.toLowerCase().includes(q) ||
               u.full_name.toLowerCase().includes(q);
      })
      .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
  }

  /* ================= API de Instagram ================= */

  const HEADERS = {
    "X-IG-App-ID": "936619743392459",
    "X-ASBD-ID": "129477",
    "X-CSRFToken": CSRF,
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "*/*",
  };
  const wwwClaim = localStorage.getItem("www-claim-v2");
  if (wwwClaim) HEADERS["X-IG-WWW-Claim"] = wwwClaim;

  // Instagram migró muchas cuentas de /api/v1/friendships/ a GraphQL.
  // Probamos ambos; el primero que responda JSON válido se usa para todo.
  const GQL = {
    followers: { hash: "c76146de99bb02f6415203be841dd25a", edge: "edge_followed_by" },
    following: { hash: "d04b0a864b4b54837c0d870b0e77e076", edge: "edge_follow" },
  };
  let strategy = null; // "rest" | "gql" — se fija con la primera página válida

  async function fetchJSON(url) {
    const res = await fetch(url, { credentials: "same-origin", headers: HEADERS });
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) return null;
    const text = await res.text();
    if (text.trimStart().startsWith("<")) {
      console.warn("[NoMeSiguen] HTML en vez de JSON:", res.status, res.url.slice(0, 80));
      return null;
    }
    try { return { data: JSON.parse(text) }; }
    catch { return null; }
  }

  async function pageREST(kind, cursor) {
    const url = new URL(`https://www.instagram.com/api/v1/friendships/${USER_ID}/${kind}/`);
    url.searchParams.set("count", PAGE_SIZE);
    if (cursor) url.searchParams.set("max_id", cursor);
    const r = await fetchJSON(url);
    if (!r) return null;
    if (r.rateLimited) return r;
    if (!Array.isArray(r.data.users)) return null;
    return { users: r.data.users, next: r.data.next_max_id || null,
             hasMore: !!r.data.has_more && !!r.data.next_max_id };
  }

  async function pageGQL(kind, cursor) {
    const vars = { id: USER_ID, include_reel: true, fetch_mutual: false, first: PAGE_SIZE };
    if (cursor) vars.after = cursor;
    const url = `https://www.instagram.com/graphql/query/?query_hash=${GQL[kind].hash}` +
      `&variables=${encodeURIComponent(JSON.stringify(vars))}`;
    const r = await fetchJSON(url);
    if (!r) return null;
    if (r.rateLimited) return r;
    const edge = r.data?.data?.user?.[GQL[kind].edge];
    if (!edge) return null;
    return { users: (edge.edges || []).map((e) => e.node),
             next: edge.page_info?.end_cursor || null,
             hasMore: !!edge.page_info?.has_next_page };
  }

  async function fetchPage(kind, cursor) {
    const strats = strategy ? [strategy] : ["rest", "gql"];
    for (const st of strats) {
      const r = st === "rest" ? await pageREST(kind, cursor) : await pageGQL(kind, cursor);
      if (r && r.rateLimited) return r;
      if (r) {
        if (!strategy) {
          strategy = st;
          console.info(`[NoMeSiguen] Usando endpoint ${st === "rest" ? "REST" : "GraphQL"}`);
        }
        return r;
      }
    }
    return null;
  }

  async function fetchList(kind, onPage) {
    const users = [];
    let cursor = null, pages = 0;
    for (;;) {
      while (S.paused) await sleep(500);

      let page = null;
      for (let t = 0; t <= MAX_RETRIES; t++) {
        page = await fetchPage(kind, cursor);
        if (!page || !page.rateLimited) break;
        if (t === MAX_RETRIES) return { users, complete: false };
        setStatus(`Instagram pidió pausa, esperando ${RETRY_DELAY / 1000}s…`);
        await sleep(RETRY_DELAY);
      }
      if (!page) return { users, complete: false };

      users.push(...page.users);
      onPage(page.users, users.length);
      if (!page.hasMore || !page.users.length) break;
      cursor = page.next;
      if (++pages % CYCLE_EVERY === 0) {
        const d = rand(CYCLE_DELAY);
        setStatus(`Pausa de seguridad ${Math.round(d / 1000)}s…`);
        await sleep(d);
      }
      await sleep(rand(PAGE_DELAY));
    }
    return { users, complete: true };
  }

  // solicitudes de seguimiento salientes (cuentas privadas que no te aceptaron)
  async function fetchPending(onPage) {
    const users = [];
    let cursor = null;
    for (;;) {
      while (S.paused) await sleep(500);
      const url = new URL("https://www.instagram.com/api/v1/friendships/pending/");
      url.searchParams.set("count", PAGE_SIZE);
      if (cursor) url.searchParams.set("max_id", cursor);
      const r = await fetchJSON(url);
      if (!r || r.rateLimited || !Array.isArray(r.data?.users)) break;
      users.push(...r.data.users);
      onPage?.(r.data.users, users.length);
      if (!r.data.has_more || !r.data.next_max_id) break;
      cursor = r.data.next_max_id;
      await sleep(rand(PAGE_DELAY));
    }
    return users;
  }

  async function unfollowUser(id) {
    const res = await fetch(
      `https://www.instagram.com/web/friendships/${id}/unfollow/`, {
        method: "POST", credentials: "same-origin",
        headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
      });
    return res.ok;
  }

  /* ================= estilos ================= */

  const CSS = `
    * { box-sizing: border-box; margin: 0; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
    body { background: #0b0e13 !important; }
    #app { min-height: 100vh; color: #e6e8ee; position: relative; }
    button { border: none; cursor: pointer; font-family: inherit; }
    ::selection { background: rgba(99,102,241,.45); }

    ::-webkit-scrollbar { width: 9px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 5px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.25); }

    /* resplandor superior sutil */
    #app::before {
      content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background: radial-gradient(ellipse 60% 40% at 50% -10%,
        rgba(99,102,241,.14), transparent 70%);
    }

    @keyframes fadeSlide {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes pop {
      from { transform: scale(.96); opacity: 0; }
      to   { transform: scale(1); opacity: 1; }
    }
    @keyframes sweep {
      0% { left: -60%; }
      100% { left: 120%; }
    }
    @keyframes breathe {
      0%, 100% { opacity: 1; }
      50% { opacity: .55; }
    }

    /* ---- pantalla inicial ---- */
    .home { min-height: 100vh; display: flex; align-items: center;
      justify-content: center; position: relative; z-index: 1; padding: 20px; }
    .home-card {
      position: relative; text-align: center; max-width: 440px; width: 100%;
      padding: 52px 48px 40px; border-radius: 20px;
      background: #12161d;
      border: 1px solid rgba(255,255,255,.09);
      box-shadow: 0 24px 70px rgba(0,0,0,.55);
      animation: pop .35s ease both;
    }
    .mark {
      width: 72px; height: 72px; margin: 0 auto 20px; border-radius: 20px;
      display: grid; place-items: center;
      background: linear-gradient(145deg, #6366f1, #4f46e5);
      box-shadow: 0 10px 30px rgba(99,102,241,.4);
    }
    .mark span { font-size: 32px; color: #fff; }
    .home-card h1 { font-size: 26px; margin-bottom: 8px; font-weight: 800;
      letter-spacing: .2px; color: #f0f1f5; }
    .home-card p { color: #8b93a5; font-size: 13.5px; line-height: 1.7;
      margin-bottom: 28px; }
    .btn-main {
      background: #6366f1; color: #fff; border-radius: 12px;
      padding: 14px 36px; font-size: 14px; font-weight: 700;
      letter-spacing: .3px; box-shadow: 0 8px 24px rgba(99,102,241,.35);
      transition: background .15s, transform .15s, box-shadow .15s;
    }
    .btn-main:hover { background: #5457e8; transform: translateY(-1px);
      box-shadow: 0 12px 30px rgba(99,102,241,.45); }
    .btn-main:active { transform: scale(.98); }
    .hint { margin-top: 18px; font-size: 11px; color: #565e70; letter-spacing: .3px; }

    /* ---- header ---- */
    header.top {
      position: sticky; top: 0; z-index: 10; display: flex; align-items: center;
      gap: 12px; padding: 13px 26px;
      background: rgba(11,14,19,.82); backdrop-filter: blur(14px);
      border-bottom: 1px solid rgba(255,255,255,.08);
    }
    .logo { font-size: 16px; font-weight: 800; white-space: nowrap;
      letter-spacing: .3px; color: #f0f1f5; display: flex; align-items: center; gap: 9px; }
    .logo i {
      width: 26px; height: 26px; border-radius: 8px; display: grid;
      place-items: center; font-style: normal; font-size: 13px; color: #fff;
      background: linear-gradient(145deg, #6366f1, #4f46e5);
    }
    .searchwrap { flex: 1; max-width: 320px; position: relative; }
    .searchwrap span {
      position: absolute; left: 13px; top: 50%; transform: translateY(-50%);
      color: #565e70; font-size: 14px; pointer-events: none;
    }
    .search {
      width: 100%; height: 38px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,.09);
      padding: 0 14px 0 35px; font-size: 13px;
      background: rgba(255,255,255,.05); color: #e6e8ee; outline: none;
      transition: border-color .15s, background .15s, box-shadow .15s;
    }
    .search::placeholder { color: #565e70; }
    .search:focus {
      border-color: #6366f1; background: rgba(99,102,241,.06);
      box-shadow: 0 0 0 3px rgba(99,102,241,.15);
    }
    .top-btn {
      background: rgba(255,255,255,.05); color: #b9bfcc;
      border: 1px solid rgba(255,255,255,.1); border-radius: 10px;
      padding: 9px 14px; font-size: 12px; font-weight: 600; white-space: nowrap;
      transition: all .15s;
    }
    .top-btn:hover {
      background: rgba(99,102,241,.14); color: #c7c9fb;
      border-color: rgba(99,102,241,.45);
    }

    /* ---- layout ---- */
    .body { display: flex; max-width: 1180px; margin: 0 auto; gap: 20px;
      padding: 22px 26px; position: relative; z-index: 1; }
    aside { width: 258px; flex-shrink: 0; }
    main { flex: 1; min-width: 0; }

    .card {
      border-radius: 14px; padding: 16px 18px; margin-bottom: 16px;
      background: #12161d; border: 1px solid rgba(255,255,255,.08);
      animation: fadeSlide .35s ease both;
    }
    .card h3 {
      font-size: 10.5px; text-transform: uppercase; letter-spacing: 1.8px;
      color: #565e70; margin-bottom: 12px; font-weight: 700;
    }

    /* escáner */
    .pct { font-size: 32px; font-weight: 800; line-height: 1; color: #a5b0ff; }
    .pbar {
      height: 8px; background: rgba(255,255,255,.07); border-radius: 6px;
      overflow: hidden; margin: 10px 0 8px;
    }
    .pbar i {
      display: block; height: 100%; width: 0; border-radius: 6px;
      background: linear-gradient(90deg, #6366f1, #38bdf8);
      transition: width .4s cubic-bezier(.4,0,.2,1);
    }
    .scan-status { font-size: 11.5px; color: #8b93a5; min-height: 16px; }
    .btn-sec {
      width: 100%; border-radius: 10px; padding: 10px 0; margin-top: 12px;
      font-size: 12px; font-weight: 700; letter-spacing: .3px;
      background: rgba(56,189,248,.1); color: #7dd3fc;
      border: 1px solid rgba(56,189,248,.3); transition: all .15s;
    }
    .btn-sec:hover { background: rgba(56,189,248,.2); }

    /* filtros tipo chip */
    .fchip { display: block; cursor: pointer; margin: 6px 0; }
    .fchip input { position: absolute; opacity: 0; pointer-events: none; }
    .fchip span {
      display: flex; align-items: center; gap: 9px; padding: 9px 13px;
      border-radius: 10px; font-size: 12.5px; font-weight: 600;
      background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08);
      color: #565e70; transition: all .15s;
    }
    .fchip span::before {
      content: ""; width: 7px; height: 7px; border-radius: 50%;
      background: rgba(255,255,255,.15); transition: all .15s;
    }
    .fchip input:checked + span {
      background: rgba(99,102,241,.12); border-color: rgba(99,102,241,.5);
      color: #c7c9fb;
    }
    .fchip input:checked + span::before { background: #6366f1; }

    /* resumen */
    .stat-row {
      display: flex; justify-content: space-between; align-items: center;
      font-size: 12.5px; padding: 6px 0; color: #8b93a5;
    }
    .stat-row b { color: #e6e8ee; font-weight: 700; font-variant-numeric: tabular-nums; }
    .stat-row .dot { display: inline-block; width: 7px; height: 7px;
      border-radius: 50%; margin-right: 8px; }
    .stat-row .wl { color: #fbbf24; }
    .stat-row .hot { color: #a5b0ff; }

    /* selección */
    .sel-btns { display: flex; gap: 7px; margin: 8px 0 10px; }
    .sel-btns button {
      flex: 1; background: rgba(255,255,255,.05); color: #b9bfcc;
      border: 1px solid rgba(255,255,255,.1); border-radius: 9px;
      padding: 7px 0; font-size: 11px; font-weight: 700; transition: all .15s;
    }
    .sel-btns button:hover { background: rgba(99,102,241,.15);
      border-color: rgba(99,102,241,.4); color: #c7c9fb; }
    .btn-unfollow {
      width: 100%; background: #ef4444; color: #fff; border-radius: 12px;
      padding: 12px 0; font-size: 13px; font-weight: 700; letter-spacing: .3px;
      transition: all .15s; box-shadow: 0 6px 18px rgba(239,68,68,.25);
    }
    .btn-unfollow:hover:not(:disabled) { background: #dc2626; }
    .btn-unfollow:disabled { opacity: .35; cursor: not-allowed; box-shadow: none; }

    /* pestañas */
    .tabs {
      display: flex; gap: 4px; padding: 4px; margin-bottom: 16px;
      background: #12161d; border: 1px solid rgba(255,255,255,.08);
      border-radius: 12px; width: fit-content;
    }
    .tab {
      border-radius: 9px; padding: 8px 18px; font-size: 13px; font-weight: 600;
      background: transparent; color: #8b93a5; transition: all .15s;
    }
    .tab:hover { color: #e6e8ee; }
    .tab.active { background: #6366f1; color: #fff; }
    .tab .n { opacity: .7; font-weight: 500; font-variant-numeric: tabular-nums; }

    .banner {
      background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.35);
      color: #fca5a5; border-radius: 11px; padding: 12px 16px;
      font-size: 12.5px; margin-bottom: 16px; line-height: 1.5;
    }

    /* filas */
    .row {
      position: relative; display: flex; align-items: center; gap: 13px;
      background: #12161d; border: 1px solid rgba(255,255,255,.07);
      border-radius: 13px; padding: 10px 16px; margin-bottom: 8px;
      transition: border-color .15s, transform .15s, background .15s;
      overflow: hidden;
    }
    .row.enter { animation: fadeSlide .3s ease both; animation-delay: var(--d, 0ms); }
    .row:hover {
      transform: translateX(3px);
      border-color: rgba(99,102,241,.4);
      background: #141922;
    }
    .row.pending { opacity: .5; }
    .row.pending::after {
      content: ""; position: absolute; top: 0; left: -60%; width: 45%; height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.05), transparent);
      animation: sweep 1.6s ease-in-out infinite;
    }
    .ava {
      border-radius: 50%; flex-shrink: 0; cursor: pointer;
      border: 2px solid rgba(255,255,255,.1);
      transition: border-color .15s, transform .15s;
    }
    .ava:hover { border-color: #6366f1; transform: scale(1.06); }
    .ava img {
      display: block; width: 42px; height: 42px; border-radius: 50%;
      object-fit: cover; background: #1a1f29;
    }
    .pending .ava img { filter: grayscale(.9); }
    .row .who { flex: 1; min-width: 0; }
    .row .who a { color: #e6e8ee; font-size: 14px; font-weight: 700;
      text-decoration: none; transition: color .15s; }
    .row .who a:hover { color: #a5b0ff; }
    .row .who .sub { font-size: 12px; color: #8b93a5; margin-top: 1px; }
    .badge-v { color: #38bdf8; font-size: 12px; }
    .badge-p { color: #4ade80; font-size: 10px; font-weight: 700;
      border: 1px solid rgba(74,222,128,.35); border-radius: 7px; padding: 1px 7px; }
    .badge-w { color: #fbbf24; font-size: 13px; }
    .chip-pending {
      font-size: 10px; color: #8b93a5; font-weight: 600;
      border: 1px dashed rgba(139,147,165,.5); border-radius: 7px;
      padding: 1px 7px; margin-left: 5px; animation: breathe 1.6s ease-in-out infinite;
    }
    .row input[type=checkbox] { width: 16px; height: 16px; accent-color: #6366f1;
      cursor: pointer; }
    .row input[type=checkbox]:disabled { opacity: .3; cursor: default; }

    .empty { text-align: center; color: #8b93a5; padding: 46px 0; font-size: 13px; }
    .empty .pulse-dot { display: inline-block; width: 10px; height: 10px;
      border-radius: 50%; background: #6366f1; margin-bottom: 8px;
      animation: breathe 1.4s ease-in-out infinite; }

    .pager { display: flex; align-items: center; justify-content: center; gap: 16px;
      margin-top: 14px; font-size: 12.5px; color: #8b93a5; }
    .pager button {
      background: rgba(255,255,255,.05); color: #b9bfcc; border-radius: 9px;
      width: 32px; height: 32px; font-size: 15px; font-weight: 700;
      border: 1px solid rgba(255,255,255,.1); transition: all .15s;
    }
    .pager button:hover:not(:disabled) { background: rgba(99,102,241,.2);
      border-color: rgba(99,102,241,.4); }
    .pager button:disabled { opacity: .3; }

    .log-ok { color: #4ade80; font-size: 13px; padding: 7px 4px;
      animation: fadeSlide .25s ease both; }
    .log-fail { color: #f87171; font-size: 13px; padding: 7px 4px;
      animation: fadeSlide .25s ease both; }

    @media (max-width: 800px) {
      .body { flex-direction: column; }
      aside { width: 100%; }
      .tabs { width: 100%; }
      .tab { flex: 1; padding: 8px 6px; font-size: 12px; }
    }
  `;

  /* ================= construcción del DOM ================= */

  document.title = "NoMeSiguen";
  document.body.innerHTML = "";
  const styleEl = document.createElement("style");
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
  const app = document.createElement("div");
  app.id = "app";
  document.body.appendChild(app);

  const $ = (s) => app.querySelector(s);
  const $$ = (s) => [...app.querySelectorAll(s)];

  function setStatus(t) {
    S.statusText = t;
    const el = $("#scan-status");
    if (el) el.textContent = t;
  }

  function setN(id, n) { const el = $(id); if (el) el.textContent = n; }

  /* ---------- pantalla inicial ---------- */

  function renderHome() {
    const old = $("#home-root"); if (old) old.remove();
    const div = document.createElement("div");
    div.id = "home-root";
    div.innerHTML = `
      <div class="home"><div class="home-card">
        <div class="mark"><span>♡</span></div>
        <h1>NoMeSiguen</h1>
        <p>Descubre quién no te sigue de vuelta.<br>
           Resultados en tiempo real, directo en tu navegador.</p>
        <button class="btn-main" id="start">Escanear mi cuenta</button>
        <div class="hint">nada sale de esta ventana</div>
      </div></div>`;
    app.appendChild(div);
    $("#start").onclick = () => startScan().catch((e) => {
      console.error("[NoMeSiguen]", e);
      setStatus(`Error: ${e.message}`);
      S.status = "done";
      updateProgress();
    });
  }

  /* ---------- workspace ---------- */

  function renderWorkspace() {
    const old = $("#ws-root"); if (old) old.remove();
    const home = $("#home-root"); if (home) home.remove();
    const div = document.createElement("div");
    div.id = "ws-root";
    div.innerHTML = `
      <header class="top">
        <div class="logo"><i>♡</i> NoMeSiguen</div>
        <div class="searchwrap"><span>⌕</span>
          <input class="search" id="search" placeholder="Buscar usuarios…"
                 value="${esc(S.search)}">
        </div>
        <button class="top-btn" id="copy">Copiar lista</button>
        <button class="top-btn" id="exp-json">JSON</button>
        <button class="top-btn" id="exp-csv">CSV</button>
        <button class="top-btn" id="exit">✕ Salir</button>
      </header>
      <div class="body">
        <aside>
          <div class="card">
            <h3>Escáner</h3>
            <div class="pct" id="pct">${S.progress}%</div>
            <div class="pbar"><i id="pfill" style="width:${S.progress}%"></i></div>
            <div class="scan-status" id="scan-status">${esc(S.statusText)}</div>
            ${S.status === "scanning"
              ? `<button class="btn-sec" id="pause">${S.paused ? "▶ Reanudar" : "⏸ Pausar"}</button>`
              : ""}
          </div>
          <div class="card">
            <h3>Filtros</h3>
            <label class="fchip"><input type="checkbox" id="f-ver" ${S.filter.verificados ? "checked" : ""}><span>Verificados</span></label>
            <label class="fchip"><input type="checkbox" id="f-priv" ${S.filter.privados ? "checked" : ""}><span>Privados</span></label>
            <label class="fchip"><input type="checkbox" id="f-sf" ${S.filter.sinfoto ? "checked" : ""}><span>Sin foto</span></label>
          </div>
          <div class="card">
            <h3>Resumen</h3>
            <div class="stat-row"><span><i class="dot" style="background:#8b5cf6"></i>Siguiendo</span><b id="st-fwing">${S.following}</b></div>
            <div class="stat-row"><span><i class="dot" style="background:#38bdf8"></i>Seguidores</span><b id="st-fwers">${S.followers}</b></div>
            <div class="stat-row"><span><i class="dot" style="background:#6366f1"></i>No me siguen</span><b class="hot" id="st-nome">${noMeSiguenCount()}</b></div>
            <div class="stat-row"><span><i class="dot" style="background:#565e70"></i>Analizando</span><b id="st-pend">${S.results.filter(u => u.pending).length}</b></div>
            <div class="stat-row"><span><i class="dot" style="background:#f59e0b"></i>Solicitudes</span><b id="st-sol">${S.requests.length}</b></div>
            <div class="stat-row"><span><i class="dot" style="background:#fbbf24"></i>Lista blanca</span><b class="wl" id="st-wl">${S.whitelist.length}</b></div>
            <div class="stat-row"><span><i class="dot" style="background:#4ade80"></i>Seleccionados</span><b id="st-sel">${S.selected.size}</b></div>
          </div>
          <div class="card">
            <h3>Selección</h3>
            <div class="sel-btns">
              <button id="sel-page">Página</button>
              <button id="sel-all">Todos</button>
              <button id="sel-none">Limpiar</button>
            </div>
            <button class="btn-unfollow" id="unfollow" ${S.incomplete || S.status !== "done" ? "disabled" : ""}>
              Dejar de seguir (<span id="uf-n">${S.selected.size}</span>)
            </button>
          </div>
        </aside>
        <main>
          ${S.incomplete ? `<div class="banner">⚠ Escaneo incompleto: la lista se interrumpió.
            Podrían aparecer cuentas que sí te siguen. Unfollow desactivado por seguridad.</div>` : ""}
          <div class="tabs">
            <button class="tab ${S.tab === "nome" ? "active" : ""}" data-t="nome">No me siguen <span class="n" id="n-nome"></span></button>
            <button class="tab ${S.tab === "fans" ? "active" : ""}" data-t="fans">Fans <span class="n" id="n-fans"></span></button>
            <button class="tab ${S.tab === "sol" ? "active" : ""}" data-t="sol">⏳ Solicitudes <span class="n" id="n-sol"></span></button>
            <button class="tab ${S.tab === "wl" ? "active" : ""}" data-t="wl">★ Lista blanca <span class="n" id="n-wl"></span></button>
          </div>
          <div id="list"></div>
          <div class="pager" id="pager"></div>
        </main>
      </div>`;
    app.appendChild(div);

    $("#exit").onclick = () => location.reload();
    $("#search").oninput = (e) => { S.search = e.target.value; S.page = 1; updateList(); };
    $("#copy").onclick = copyList;
    $("#exp-json").onclick = () => exportFile("json");
    $("#exp-csv").onclick = () => exportFile("csv");
    const pb = $("#pause");
    if (pb) pb.onclick = () => {
      S.paused = !S.paused;
      pb.textContent = S.paused ? "▶ Reanudar" : "⏸ Pausar";
    };
    $$(".tab").forEach((t) => (t.onclick = () => {
      S.tab = t.dataset.t; S.page = 1;
      $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
      updateList();
    }));
    ["f-ver", "f-priv", "f-sf"].forEach((id, i) => {
      $("#" + id).onchange = (e) => {
        S.filter[["verificados", "privados", "sinfoto"][i]] = e.target.checked;
        S.page = 1; updateList();
      };
    });
    $("#sel-page").onclick = () => { pageUsers().forEach((u) => S.selected.add(u.id)); updateList(); };
    $("#sel-all").onclick = () => { visibleUsers().forEach((u) => S.selected.add(u.id)); updateList(); };
    $("#sel-none").onclick = () => { S.selected.clear(); updateList(); };
    $("#unfollow").onclick = startUnfollow;
    S.renderedIds.clear();
    updateList();
  }

  function pageUsers() {
    return visibleUsers().slice((S.page - 1) * PER_PAGE, S.page * PER_PAGE);
  }

  function updateStats() {
    setN("#st-fwing", S.following);
    setN("#st-fwers", S.followers);
    setN("#st-nome", noMeSiguenCount());
    setN("#st-pend", S.results.filter((u) => u.pending).length);
    setN("#st-wl", S.whitelist.length);
    setN("#st-sel", S.selected.size);
    setN("#uf-n", S.selected.size);
    setN("#n-nome", `(${S.results.filter(u => !inWhitelist(u.id) && u.follows_viewer !== true).length})`);
    setN("#n-fans", `(${S.fans.length})`);
    setN("#n-sol", `(${S.requests.length})`);
    setN("#st-sol", S.requests.length);
    setN("#n-wl", `(${S.whitelist.length})`);
  }

  function updateList() {
    updateStats();
    const users = visibleUsers();
    const maxPage = Math.max(1, Math.ceil(users.length / PER_PAGE));
    if (S.page > maxPage) S.page = maxPage;

    const list = $("#list");
    const rows = pageUsers();
    if (!users.length) {
      list.innerHTML = `<div class="empty">
        <div class="pulse-dot"></div><br>
        ${S.status === "scanning"
          ? "Escaneando… los usuarios aparecerán aquí en vivo"
          : "Nadie por aquí"}
      </div>`;
    } else {
      list.innerHTML = rows.map((u, i) => {
        const isNew = !S.renderedIds.has(u.id);
        S.renderedIds.add(u.id);
        return `
        <div class="row ${isNew ? "enter" : ""} ${u.pending ? "pending" : ""}"
             style="--d:${(i % PER_PAGE) * 25}ms">
          <div class="ava" title="Clic para ${inWhitelist(u.id) ? "quitar de" : "añadir a"} lista blanca" data-wl="${u.id}">
            <img src="${esc(u.pic)}" alt="" loading="lazy"
                 onerror="this.style.visibility='hidden'">
          </div>
          <div class="who">
            <a href="/${esc(u.username)}" target="_blank">@${esc(u.username)}</a>
            ${u.is_verified ? '<span class="badge-v"> ✔</span>' : ""}
            ${u.is_private ? ' <span class="badge-p">privado</span>' : ""}
            ${inWhitelist(u.id) ? ' <span class="badge-w">★</span>' : ""}
            ${u.pending ? '<span class="chip-pending">analizando…</span>' : ""}
            ${u.requested ? '<span class="chip-pending">⏳ solicitud enviada</span>' : ""}
            <div class="sub">${esc(u.full_name)}</div>
          </div>
          <input type="checkbox" data-id="${u.id}" ${S.selected.has(u.id) ? "checked" : ""} ${u.pending || u.requested ? "disabled" : ""}>
        </div>`;
      }).join("");
      list.querySelectorAll(".ava[data-wl]").forEach((a) => {
        a.onclick = () => toggleWhitelist(a.dataset.wl);
      });
      list.querySelectorAll("input[data-id]").forEach((cb) => {
        cb.onchange = () => {
          cb.checked ? S.selected.add(cb.dataset.id) : S.selected.delete(cb.dataset.id);
          updateStats();
        };
      });
    }

    $("#pager").innerHTML = users.length > PER_PAGE ? `
      <button id="pg-prev" ${S.page <= 1 ? "disabled" : ""}>‹</button>
      <span>Página ${S.page} / ${maxPage}</span>
      <button id="pg-next" ${S.page >= maxPage ? "disabled" : ""}>›</button>` : "";
    const pv = $("#pg-prev"), nx = $("#pg-next");
    if (pv) pv.onclick = () => { S.page--; updateList(); };
    if (nx) nx.onclick = () => { S.page++; updateList(); };
  }

  function toggleWhitelist(id) {
    if (inWhitelist(id)) {
      S.whitelist = S.whitelist.filter((u) => u.id !== id);
    } else {
      const u = S.resultsMap.get(id) || S.fans.find((x) => x.id === id) ||
                S.requests.find((x) => x.id === id);
      if (!u) return;
      S.whitelist.push({ ...u });
      S.selected.delete(id);
    }
    saveWhitelist();
    updateList();
  }

  /* ---------- exportar ---------- */

  function copyList() {
    navigator.clipboard.writeText(
      visibleUsers().map((u) => u.username).join("\n")
    ).then(() => setStatus("¡Lista copiada!"));
  }

  function exportFile(fmt) {
    const users = visibleUsers();
    let data, name, type;
    if (fmt === "json") {
      data = JSON.stringify(users, null, 2);
      name = "no_me_siguen.json"; type = "application/json";
    } else {
      data = "username,nombre,verificado,privado,perfil\n" + users.map((u) =>
        [u.username, `"${u.full_name.replace(/"/g, '""')}"`, u.is_verified, u.is_private,
         `https://instagram.com/${u.username}`].join(",")).join("\n");
      name = "no_me_siguen.csv"; type = "text/csv";
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------- escaneo en tiempo real ---------- */

  async function startScan() {
    S.status = "scanning";
    renderWorkspace();
    setStatus("Descargando seguidos…");

    const fwing = await fetchList("following", (page, total) => {
      page.forEach((u) => {
        const n = normalize(u, null);
        S.results.push(n);
        S.resultsMap.set(n.id, n);
      });
      S.following = total;
      S.progress = Math.min(45, Math.round(total / 20));
      updateProgress();
      setStatus(`Descargando seguidos… ${total}`);
      updateList();
    });
    if (!fwing.users.length) {
      S.incomplete = true;
      S.status = "done";
      setStatus("Instagram no devolvió datos — recarga instagram.com, confirma tu sesión y reintenta.");
      renderWorkspace();
      return;
    }

    setStatus("Descargando seguidores…");
    const fwers = await fetchList("followers", (page, total) => {
      const followingIds = S.resultsMap;
      page.forEach((u) => {
        const id = uid(u);
        const r = followingIds.get(id);
        if (r) { r.follows_viewer = true; r.pending = false; }
        else S.fans.push({ ...normalize(u, true), follows_them: false });
      });
      S.followers = total;
      S.progress = 45 + Math.min(50, Math.round(total / 30));
      updateProgress();
      setStatus(`Descargando seguidores… ${total}`);
      updateList();
    });

    // solicitudes enviadas que aún no aceptan (si falla, no rompe el escaneo)
    setStatus("Buscando solicitudes pendientes…");
    try {
      const pend = await fetchPending((page, total) => {
        page.forEach((u) => {
          const n = normalize(u, false);
          n.requested = true;
          S.requests.push(n);
        });
        updateList();
      });
      setStatus(pend.length
        ? `${pend.length} solicitudes pendientes`
        : "Sin solicitudes pendientes");
    } catch (e) {
      console.warn("[NoMeSiguen] No se pudieron cargar solicitudes pendientes:", e);
    }

    S.results.forEach((u) => {
      if (u.pending) { u.pending = false; u.follows_viewer = false; }
    });
    // quita de la selección a quienes resultaron seguidores
    S.selected.forEach((id) => {
      const r = S.resultsMap.get(id);
      if (r && r.follows_viewer === true) S.selected.delete(id);
    });
    S.incomplete = !(fwing.complete && fwers.complete);
    S.status = "done";
    S.progress = 100;
    setStatus(S.incomplete ? "Escaneo incompleto ⚠" : "Escaneo completo");
    renderWorkspace();
  }

  function updateProgress() {
    const p = $("#pct"), f = $("#pfill");
    if (p) p.textContent = S.progress + "%";
    if (f) f.style.width = S.progress + "%";
  }

  /* ---------- unfollow ---------- */

  async function startUnfollow() {
    if (S.incomplete || S.status !== "done") return;
    const targets = S.results.filter(
      (u) => S.selected.has(u.id) && !inWhitelist(u.id));
    if (!targets.length) { setStatus("Selecciona al menos un usuario."); return; }
    if (!confirm(`¿Dejar de seguir a ${targets.length} cuentas? Esto no se puede deshacer.`)) return;

    S.status = "unfollowing";
    S.unfollowTotal = targets.length;
    renderWorkspace();
    $("#list").innerHTML = `<div id="uf-log"></div>`;

    let done = 0;
    for (const u of targets) {
      let ok = false;
      try { ok = await unfollowUser(u.id); } catch {}
      done++;
      if (ok) {
        S.results = S.results.filter((x) => x.id !== u.id);
        S.resultsMap.delete(u.id);
        S.selected.delete(u.id);
      }
      S.progress = Math.round((done / targets.length) * 100);
      updateProgress();
      setStatus(`Dejando de seguir… ${done}/${targets.length}`);
      const log = $("#uf-log");
      if (log) log.innerHTML += ok
        ? `<div class="log-ok">✔ @${esc(u.username)} [${done}/${targets.length}]</div>`
        : `<div class="log-fail">✘ @${esc(u.username)} — falló [${done}/${targets.length}]</div>`;
      if (u === targets[targets.length - 1]) break;
      if (done % UNFOLLOW_EVERY === 0) {
        setStatus(`Descanso de seguridad ${UNFOLLOW_REST / 1000}s…`);
        await sleep(UNFOLLOW_REST);
      } else {
        await sleep(rand(UNFOLLOW_DELAY));
      }
    }
    S.status = "done";
    setStatus("Todo listo");
    renderWorkspace();
  }

  /* ================= arranque ================= */

  renderHome();
})();
