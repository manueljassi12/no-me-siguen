/*
 * ♡ NoMeSiguen ♡ — Neon Edition
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
 *   - Pestañas: No me siguen / Fans / Lista blanca
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
    whitelist: loadWhitelist(),
    selected: new Set(),
    tab: "nome",           // nome | fans | wl
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
  };

  async function fetchList(kind, onPage) {
    const users = [];
    let maxId = null, pages = 0;
    for (;;) {
      while (S.paused) await sleep(500);
      const url = new URL(`https://www.instagram.com/api/v1/friendships/${USER_ID}/${kind}/`);
      url.searchParams.set("count", PAGE_SIZE);
      if (maxId) url.searchParams.set("max_id", maxId);

      let res = null;
      for (let t = 0; t <= MAX_RETRIES; t++) {
        res = await fetch(url, { credentials: "same-origin", headers: HEADERS });
        if (res.status !== 429) break;
        if (t === MAX_RETRIES) return { users, complete: false };
        setStatus(`Instagram pidió pausa, esperando ${RETRY_DELAY / 1000}s…`);
        await sleep(RETRY_DELAY);
      }
      if (!res.ok) return { users, complete: false };

      const text = await res.text();
      if (text.trimStart().startsWith("<")) {
        console.error("[NoMeSiguen] Instagram devolvió HTML en vez de JSON:",
          res.status, res.url, "\n", text.slice(0, 300));
        return { users, complete: false, htmlResponse: true };
      }
      let data;
      try { data = JSON.parse(text); }
      catch { return { users, complete: false }; }

      const page = data.users || [];
      users.push(...page);
      onPage(page, users.length);
      if (!data.has_more || !data.next_max_id || !page.length) break;
      maxId = data.next_max_id;
      if (++pages % CYCLE_EVERY === 0) {
        const d = rand(CYCLE_DELAY);
        setStatus(`Pausa de seguridad ${Math.round(d / 1000)}s…`);
        await sleep(d);
      }
      await sleep(rand(PAGE_DELAY));
    }
    return { users, complete: true };
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
    * { box-sizing: border-box; margin: 0; font-family: "Segoe UI", system-ui, sans-serif; }
    body { background: #07070e !important; }
    #app { min-height: 100vh; color: #f0eefc; position: relative; }
    button { border: none; cursor: pointer; font-family: inherit; }
    ::selection { background: rgba(255,79,216,.45); }

    ::-webkit-scrollbar { width: 9px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,79,216,.3); border-radius: 5px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,79,216,.55); }

    /* fondo: rejilla + orbes */
    #app::before {
      content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background-image:
        linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px);
      background-size: 44px 44px;
      -webkit-mask-image: radial-gradient(ellipse at 50% 0%, black 25%, transparent 78%);
      mask-image: radial-gradient(ellipse at 50% 0%, black 25%, transparent 78%);
    }
    .orb {
      position: fixed; border-radius: 50%; filter: blur(110px);
      pointer-events: none; z-index: 0;
      animation: float 16s ease-in-out infinite alternate;
    }
    .orb.o1 { width: 480px; height: 480px; top: -140px; left: -120px; opacity: .5;
      background: radial-gradient(circle, #ff3fa4, transparent 65%); }
    .orb.o2 { width: 420px; height: 420px; bottom: -120px; right: -100px; opacity: .45;
      background: radial-gradient(circle, #2ee6ff, transparent 65%); animation-delay: -6s; }
    .orb.o3 { width: 340px; height: 340px; top: 38%; left: 55%; opacity: .3;
      background: radial-gradient(circle, #8b5cf6, transparent 65%); animation-delay: -11s; }
    @keyframes float {
      0%   { transform: translate(0,0) scale(1); }
      50%  { transform: translate(70px,-50px) scale(1.18); }
      100% { transform: translate(-50px,60px) scale(.9); }
    }

    @keyframes fadeSlide {
      from { opacity: 0; transform: translateY(14px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.15); }
    }
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes sweep {
      0% { left: -60%; }
      100% { left: 120%; }
    }
    @keyframes pop {
      0% { transform: scale(.7); opacity: 0; }
      70% { transform: scale(1.06); }
      100% { transform: scale(1); opacity: 1; }
    }

    /* ---- pantalla inicial ---- */
    .home { min-height: 100vh; display: flex; align-items: center;
      justify-content: center; position: relative; z-index: 1; padding: 20px; }
    .home-card {
      position: relative; text-align: center; max-width: 440px; width: 100%;
      padding: 56px 48px 42px; border-radius: 28px;
      background: rgba(18,18,32,.72); backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,.09);
      box-shadow: 0 0 80px rgba(255,63,164,.12), 0 30px 90px rgba(0,0,0,.6);
      animation: pop .55s cubic-bezier(.2,.9,.3,1.2) both;
      overflow: hidden;
    }
    .home-card::before {
      content: ""; position: absolute; top: 0; left: 10%; right: 10%; height: 1px;
      background: linear-gradient(90deg, transparent, #ff4fd8, #2ee6ff, transparent);
    }
    .ring {
      width: 96px; height: 96px; margin: 0 auto 20px; border-radius: 50%;
      display: grid; place-items: center; position: relative;
      background: conic-gradient(#ff3fa4, #2ee6ff, #8b5cf6, #ff3fa4);
      animation: spin 3.5s linear infinite;
      box-shadow: 0 0 40px rgba(255,63,164,.4);
    }
    .ring::before { content: ""; position: absolute; inset: 5px;
      border-radius: 50%; background: #131320; }
    .ring span {
      position: relative; font-size: 40px; color: #ff4fd8;
      text-shadow: 0 0 22px #ff4fd8; animation: pulse 1.7s ease-in-out infinite;
    }
    .home-card h1 {
      font-size: 30px; margin-bottom: 8px; letter-spacing: .5px;
      background: linear-gradient(90deg, #ff4fd8, #2ee6ff, #a78bfa, #ff4fd8);
      background-size: 300% 100%; -webkit-background-clip: text;
      background-clip: text; color: transparent;
      animation: shimmer 4.5s linear infinite;
    }
    .home-card p { color: #8a86a3; font-size: 13.5px; line-height: 1.75; margin-bottom: 30px; }
    .btn-main {
      background: linear-gradient(90deg, #ff3fa4, #8b5cf6); color: #fff;
      border-radius: 16px; padding: 15px 40px; font-size: 15px; font-weight: 800;
      letter-spacing: .5px; box-shadow: 0 0 26px rgba(255,63,164,.4);
      transition: transform .18s, box-shadow .18s;
    }
    .btn-main:hover { transform: translateY(-3px) scale(1.04);
      box-shadow: 0 0 46px rgba(255,63,164,.65); }
    .btn-main:active { transform: scale(.96); }
    .hint { margin-top: 18px; font-size: 11px; color: #57536e; letter-spacing: .3px; }

    /* ---- header ---- */
    header.top {
      position: sticky; top: 0; z-index: 10; display: flex; align-items: center;
      gap: 12px; padding: 14px 26px;
      background: rgba(7,7,14,.7); backdrop-filter: blur(16px);
      border-bottom: 1px solid rgba(255,255,255,.07);
    }
    .logo { font-size: 17px; font-weight: 800; white-space: nowrap; letter-spacing: .3px; }
    .logo b { color: #ff4fd8; text-shadow: 0 0 14px #ff4fd8;
      display: inline-block; animation: pulse 2s ease-in-out infinite; }
    .searchwrap {
      flex: 1; max-width: 320px; position: relative;
    }
    .searchwrap span {
      position: absolute; left: 13px; top: 50%; transform: translateY(-50%);
      color: #57536e; font-size: 15px; pointer-events: none;
    }
    .search {
      width: 100%; height: 40px; border-radius: 13px;
      border: 1px solid rgba(255,255,255,.09);
      padding: 0 14px 0 36px; font-size: 13px;
      background: rgba(255,255,255,.05); color: #f0eefc; outline: none;
      transition: border-color .2s, box-shadow .2s, background .2s;
    }
    .search::placeholder { color: #57536e; }
    .search:focus {
      border-color: #2ee6ff; background: rgba(46,230,255,.05);
      box-shadow: 0 0 0 3px rgba(46,230,255,.12), 0 0 18px rgba(46,230,255,.2);
    }
    .top-btn {
      background: rgba(255,255,255,.05); color: #cfcadb;
      border: 1px solid rgba(255,255,255,.1); border-radius: 12px;
      padding: 9px 15px; font-size: 12px; font-weight: 700; white-space: nowrap;
      transition: all .2s;
    }
    .top-btn:hover {
      background: rgba(255,79,216,.15); color: #ff9ae4;
      border-color: rgba(255,79,216,.45); box-shadow: 0 0 16px rgba(255,79,216,.25);
      transform: translateY(-1px);
    }

    /* ---- layout ---- */
    .body { display: flex; max-width: 1180px; margin: 0 auto; gap: 20px;
      padding: 22px 26px; position: relative; z-index: 1; }
    aside { width: 258px; flex-shrink: 0; }
    main { flex: 1; min-width: 0; }

    .card {
      position: relative; border-radius: 18px; padding: 16px 18px; margin-bottom: 16px;
      background: rgba(255,255,255,.04); backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,.08);
      animation: fadeSlide .45s ease both;
      overflow: hidden;
    }
    .card::before {
      content: ""; position: absolute; top: 0; left: 12%; right: 12%; height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,79,216,.7), transparent);
    }
    .card h3 {
      font-size: 10.5px; text-transform: uppercase; letter-spacing: 2px;
      color: #8a86a3; margin-bottom: 12px; font-weight: 700;
    }

    /* escáner */
    .pct {
      font-size: 34px; font-weight: 800; line-height: 1;
      background: linear-gradient(90deg, #ff4fd8, #2ee6ff);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      filter: drop-shadow(0 0 14px rgba(255,79,216,.4));
    }
    .pbar {
      height: 10px; background: rgba(255,255,255,.06); border-radius: 8px;
      overflow: hidden; margin: 10px 0 8px; border: 1px solid rgba(255,255,255,.06);
    }
    .pbar i {
      display: block; height: 100%; width: 0; border-radius: 8px;
      background: linear-gradient(90deg, #ff3fa4, #8b5cf6, #2ee6ff);
      background-size: 200% 100%; animation: shimmer 1.8s linear infinite;
      box-shadow: 0 0 16px rgba(255,63,164,.6);
      transition: width .45s cubic-bezier(.4,0,.2,1);
    }
    .scan-status { font-size: 11.5px; color: #8a86a3; min-height: 16px; }
    .btn-sec {
      width: 100%; border-radius: 12px; padding: 10px 0; margin-top: 12px;
      font-size: 12px; font-weight: 800; letter-spacing: .5px;
      background: rgba(46,230,255,.1); color: #7deeff;
      border: 1px solid rgba(46,230,255,.3); transition: all .2s;
    }
    .btn-sec:hover { background: rgba(46,230,255,.22);
      box-shadow: 0 0 18px rgba(46,230,255,.3); }

    /* filtros tipo chip */
    .fchip { display: block; cursor: pointer; margin: 6px 0; }
    .fchip input { position: absolute; opacity: 0; pointer-events: none; }
    .fchip span {
      display: flex; align-items: center; gap: 9px; padding: 9px 13px;
      border-radius: 12px; font-size: 12.5px; font-weight: 600;
      background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08);
      color: #6b6783; transition: all .2s;
    }
    .fchip span::before {
      content: ""; width: 8px; height: 8px; border-radius: 50%;
      background: rgba(255,255,255,.15); transition: all .2s;
    }
    .fchip input:checked + span {
      background: rgba(255,79,216,.13); border-color: rgba(255,79,216,.5);
      color: #ff9ae4; box-shadow: 0 0 14px rgba(255,79,216,.12);
    }
    .fchip input:checked + span::before {
      background: #ff4fd8; box-shadow: 0 0 8px #ff4fd8;
    }

    /* resumen */
    .stat-row {
      display: flex; justify-content: space-between; align-items: center;
      font-size: 12.5px; padding: 6px 0; color: #8a86a3;
    }
    .stat-row b { color: #f0eefc; font-weight: 700; }
    .stat-row .dot { display: inline-block; width: 7px; height: 7px;
      border-radius: 50%; margin-right: 8px; }
    .stat-row .wl { color: #ffd166; text-shadow: 0 0 10px rgba(255,209,102,.5); }
    .stat-row .hot { color: #ff9ae4; }

    /* selección */
    .sel-btns { display: flex; gap: 7px; margin: 8px 0 10px; }
    .sel-btns button {
      flex: 1; background: rgba(139,92,246,.14); color: #c9a4ff;
      border: 1px solid rgba(139,92,246,.35); border-radius: 10px;
      padding: 7px 0; font-size: 11px; font-weight: 800; transition: all .2s;
    }
    .sel-btns button:hover { background: rgba(139,92,246,.3);
      box-shadow: 0 0 12px rgba(139,92,246,.25); }
    .btn-unfollow {
      width: 100%; background: linear-gradient(90deg, #ff3d5e, #ff7a3d);
      color: #fff; border-radius: 14px; padding: 13px 0; font-size: 13px;
      font-weight: 800; letter-spacing: .3px; transition: all .2s;
      box-shadow: 0 0 20px rgba(255,61,94,.35);
    }
    .btn-unfollow:hover:not(:disabled) {
      box-shadow: 0 0 34px rgba(255,61,94,.6); transform: translateY(-1px);
    }
    .btn-unfollow:disabled { opacity: .35; cursor: not-allowed; box-shadow: none; }

    /* pestañas cápsula */
    .tabs {
      display: flex; gap: 4px; padding: 5px; margin-bottom: 16px;
      background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08);
      border-radius: 15px; width: fit-content;
    }
    .tab {
      border-radius: 11px; padding: 9px 20px; font-size: 13px; font-weight: 700;
      background: transparent; color: #8a86a3; transition: all .25s;
    }
    .tab:hover { color: #f0eefc; }
    .tab.active {
      background: linear-gradient(90deg, #ff3fa4, #8b5cf6); color: #fff;
      box-shadow: 0 0 18px rgba(255,63,164,.4);
    }
    .tab .n { opacity: .75; font-weight: 500; }

    .banner {
      background: rgba(255,61,94,.1); border: 1px solid rgba(255,61,94,.4);
      color: #ff9aa8; border-radius: 13px; padding: 12px 16px;
      font-size: 12.5px; margin-bottom: 16px;
      box-shadow: 0 0 20px rgba(255,61,94,.12);
      animation: pulse 2.2s ease-in-out infinite;
    }

    /* filas de usuario */
    .row {
      position: relative; display: flex; align-items: center; gap: 13px;
      background: rgba(255,255,255,.035); backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 15px; padding: 10px 16px; margin-bottom: 9px;
      transition: transform .2s, border-color .2s, box-shadow .2s;
      overflow: hidden;
    }
    .row.enter { animation: fadeSlide .4s ease both; animation-delay: var(--d, 0ms); }
    .row:hover {
      transform: translateX(5px);
      border-color: rgba(46,230,255,.4);
      box-shadow: 0 0 20px rgba(46,230,255,.12);
    }
    .row.pending { opacity: .55; }
    .row.pending::after {
      content: ""; position: absolute; top: 0; left: -60%; width: 45%; height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.06), transparent);
      animation: sweep 1.6s ease-in-out infinite;
    }
    .ava {
      padding: 2.5px; border-radius: 50%; flex-shrink: 0; cursor: pointer;
      background: conic-gradient(#ff3fa4, #8b5cf6, #2ee6ff, #ff3fa4);
      transition: transform .2s, box-shadow .2s;
    }
    .ava:hover { transform: scale(1.08); box-shadow: 0 0 16px rgba(255,63,164,.5); }
    .ava img {
      display: block; width: 44px; height: 44px; border-radius: 50%;
      object-fit: cover; background: #131320;
    }
    .pending .ava { background: rgba(255,255,255,.12); }
    .pending .ava img { filter: grayscale(.9); }
    .row .who { flex: 1; min-width: 0; }
    .row .who a { color: #f0eefc; font-size: 14px; font-weight: 700;
      text-decoration: none; transition: color .15s; }
    .row .who a:hover { color: #2ee6ff; text-shadow: 0 0 12px rgba(46,230,255,.6); }
    .row .who .sub { font-size: 12px; color: #8a86a3; margin-top: 1px; }
    .badge-v { color: #2ee6ff; font-size: 12px;
      text-shadow: 0 0 10px rgba(46,230,255,.8); }
    .badge-p { color: #7dff9a; font-size: 10px; font-weight: 700;
      border: 1px solid rgba(125,255,154,.4); border-radius: 8px; padding: 1px 7px; }
    .badge-w { color: #ffd166; font-size: 13px;
      text-shadow: 0 0 10px rgba(255,209,102,.8); }
    .chip-pending {
      font-size: 10px; color: #8a86a3; font-weight: 600;
      border: 1px dashed rgba(139,134,163,.5); border-radius: 8px;
      padding: 1px 7px; margin-left: 5px;
    }
    .row input[type=checkbox] { width: 17px; height: 17px; accent-color: #ff4fd8;
      cursor: pointer; }
    .row input[type=checkbox]:disabled { opacity: .35; cursor: default; }

    .empty { text-align: center; color: #8a86a3; padding: 46px 0; font-size: 13px; }
    .empty .pulse-heart { display: inline-block; color: #ff4fd8; font-size: 24px;
      animation: pulse 1.4s ease-in-out infinite;
      text-shadow: 0 0 16px #ff4fd8; margin-bottom: 6px; }

    .pager { display: flex; align-items: center; justify-content: center; gap: 16px;
      margin-top: 14px; font-size: 12.5px; color: #8a86a3; }
    .pager button {
      background: rgba(255,79,216,.12); color: #ff9ae4; border-radius: 10px;
      width: 34px; height: 34px; font-size: 16px; font-weight: 700;
      border: 1px solid rgba(255,79,216,.3); transition: all .2s;
    }
    .pager button:hover:not(:disabled) {
      background: rgba(255,79,216,.28); box-shadow: 0 0 14px rgba(255,79,216,.3);
    }
    .pager button:disabled { opacity: .3; }

    .log-ok { color: #7dff9a; font-size: 13px; padding: 7px 4px;
      text-shadow: 0 0 10px rgba(125,255,154,.35);
      animation: fadeSlide .3s ease both; }
    .log-fail { color: #ff6a7a; font-size: 13px; padding: 7px 4px;
      animation: fadeSlide .3s ease both; }

    @media (max-width: 800px) {
      .body { flex-direction: column; }
      aside { width: 100%; }
      .tabs { width: 100%; }
      .tab { flex: 1; padding: 9px 6px; font-size: 12px; }
    }
  `;

  /* ================= construcción del DOM ================= */

  document.title = "NoMeSiguen ♡";
  document.body.innerHTML = "";
  const styleEl = document.createElement("style");
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
  const app = document.createElement("div");
  app.id = "app";
  app.innerHTML = `<div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div>`;
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
        <div class="ring"><span>♡</span></div>
        <h1>NoMeSiguen</h1>
        <p>Descubre quién no te sigue de vuelta.<br>
           Resultados en tiempo real, directo en tu navegador.</p>
        <button class="btn-main" id="start">▶ Escanear mi cuenta</button>
        <div class="hint">nada sale de esta ventana ♡</div>
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
        <div class="logo"><b>♡</b> NoMeSiguen</div>
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
            <div class="stat-row"><span><i class="dot" style="background:#2ee6ff"></i>Seguidores</span><b id="st-fwers">${S.followers}</b></div>
            <div class="stat-row"><span><i class="dot" style="background:#ff4fd8"></i>No me siguen</span><b class="hot" id="st-nome">${noMeSiguenCount()}</b></div>
            <div class="stat-row"><span><i class="dot" style="background:#57536e"></i>Pendientes</span><b id="st-pend">${S.results.filter(u => u.pending).length}</b></div>
            <div class="stat-row"><span><i class="dot" style="background:#ffd166"></i>Lista blanca</span><b class="wl" id="st-wl">${S.whitelist.length}</b></div>
            <div class="stat-row"><span><i class="dot" style="background:#7dff9a"></i>Seleccionados</span><b id="st-sel">${S.selected.size}</b></div>
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
        <div class="pulse-heart">♡</div>
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
            <div class="sub">${esc(u.full_name)}</div>
          </div>
          <input type="checkbox" data-id="${u.id}" ${S.selected.has(u.id) ? "checked" : ""} ${u.pending ? "disabled" : ""}>
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
      const u = S.resultsMap.get(id) || S.fans.find((x) => x.id === id);
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
    ).then(() => setStatus("¡Lista copiada! ♡"));
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
      setStatus(fwing.htmlResponse
        ? "Instagram no devolvió datos (respondió HTML) — verifica tu sesión."
        : "Instagram no devolvió datos — revisa tu sesión y reintenta.");
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
    setStatus(S.incomplete ? "Escaneo incompleto ⚠" : "¡Escaneo completo! ♡");
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
    setStatus("¡Todo listo! ♡");
    renderWorkspace();
  }

  /* ================= arranque ================= */

  renderHome();
})();
