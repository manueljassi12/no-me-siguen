/*
 * Diagnóstico NoMeSiguen — pega esto en la consola de instagram.com
 * y comparte lo que imprime. Solo hace peticiones de prueba.
 */
(async () => {
  const uid = document.cookie.match(/ds_user_id=([^;]+)/)?.[1];
  const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
  console.log("ds_user_id:", uid, "| csrftoken:", csrf ? "✔" : "✘ FALTA");

  const base = `https://www.instagram.com/api/v1/friendships/${uid}/following/?count=5`;
  const tests = {
    "A - sin headers": {},
    "B - solo app-id": { "X-IG-App-ID": "936619743392459" },
    "C - headers completos": {
      "X-IG-App-ID": "936619743392459",
      "X-ASBD-ID": "129477",
      "X-CSRFToken": csrf,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "*/*",
    },
    "D - host i.instagram.com": null, // se construye abajo
  };

  for (const [name, headers] of Object.entries(tests)) {
    try {
      const url = name.startsWith("D")
        ? `https://i.instagram.com/api/v1/friendships/${uid}/following/?count=5`
        : base;
      const r = await fetch(url, {
        credentials: "same-origin",
        mode: name.startsWith("D") ? "cors" : "same-origin",
        headers: headers || {},
      });
      const t = await r.text();
      console.log(`\n=== ${name} ===`);
      console.log(`status: ${r.status} | content-type: ${r.headers.get("content-type")} | url: ${r.url}`);
      console.log(t.slice(0, 180));
    } catch (e) {
      console.log(`\n=== ${name} === FALLO: ${e.message}`);
    }
  }
  console.log("\n=== FIN ===");
})();
