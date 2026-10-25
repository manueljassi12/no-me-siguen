/*
 * Diagnóstico NoMeSiguen — pega esto en la consola de instagram.com
 * y comparte TODO lo que imprime. Solo hace peticiones de prueba.
 */
(async () => {
  const cookie = (n) => {
    const m = document.cookie.match(new RegExp("(?:^|; )" + n + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  };

  console.log("== COOKIES DE SESIÓN ==");
  ["sessionid", "ds_user_id", "csrftoken", "ig_did", "mid"].forEach((n) =>
    console.log(`  ${n}: ${cookie(n) ? "✔ presente" : "✘ FALTA"}`));

  const uid = cookie("ds_user_id");
  const csrf = cookie("csrftoken");
  const claim = localStorage.getItem("www-claim-v2");
  console.log("  www-claim-v2:", claim || "(no hay)");

  const H = {
    "X-IG-App-ID": "936619743392459",
    "X-ASBD-ID": "129477",
    "X-CSRFToken": csrf || "",
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "*/*",
  };

  const rest = `https://www.instagram.com/api/v1/friendships/${uid}/following/?count=5&search_surface=follow_list_page`;
  const restFers = `https://www.instagram.com/api/v1/friendships/${uid}/followers/?count=5&search_surface=follow_list_page`;
  const info = `https://www.instagram.com/api/v1/users/${uid}/info/`;

  const tests = [
    ["REST following (www)", rest, H, "same-origin"],
    ["REST + X-IG-WWW-Claim", rest, { ...H, "X-IG-WWW-Claim": claim || "0" }, "same-origin"],
    ["REST followers (www)", restFers, H, "same-origin"],
    ["users/info", info, H, "same-origin"],
  ];

  for (const [name, url, headers, creds] of tests) {
    try {
      const r = await fetch(url, { credentials: creds, headers });
      const t = await r.text();
      const esJson = !t.trimStart().startsWith("<");
      console.log(`\n=== ${name} ===`);
      console.log(`  status: ${r.status} | url_final: ${r.url.slice(0, 60)} | JSON: ${esJson ? "SI ✔" : "NO (HTML)"}`);
      console.log("  " + t.slice(0, 200).replace(/\n/g, " "));
    } catch (e) {
      console.log(`\n=== ${name} === FALLO: ${e.message}`);
    }
  }
  console.log("\n=== FIN ===");
})();
