/*
 * Diagnóstico NoMeSiguen — pega esto en la consola de instagram.com
 * y comparte TODO lo que imprime. Solo hace peticiones de prueba.
 */
(async () => {
  const uid = document.cookie.match(/ds_user_id=([^;]+)/)?.[1];
  const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
  console.log("ds_user_id:", uid, "| csrftoken:", csrf ? "✔" : "✘ FALTA");

  const H = {
    "X-IG-App-ID": "936619743392459",
    "X-ASBD-ID": "129477",
    "X-CSRFToken": csrf,
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "*/*",
  };

  const gqlFollowers = `https://www.instagram.com/graphql/query/?query_hash=c76146de99bb02f6415203be841dd25a&variables=` +
    encodeURIComponent(JSON.stringify({ id: uid, include_reel: true, fetch_mutual: true, first: 5 }));
  const gqlFollowing = `https://www.instagram.com/graphql/query/?query_hash=d04b0a864b4b54837c0d870b0e77e076&variables=` +
    encodeURIComponent(JSON.stringify({ id: uid, include_reel: true, fetch_mutual: true, first: 5 }));

  const tests = [
    ["REST headers completos", `https://www.instagram.com/api/v1/friendships/${uid}/following/?count=5`, H],
    ["GraphQL followers", gqlFollowers, H],
    ["GraphQL following", gqlFollowing, H],
  ];

  for (const [name, url, headers] of tests) {
    try {
      const r = await fetch(url, { credentials: "same-origin", headers });
      const t = await r.text();
      const esJson = !t.trimStart().startsWith("<");
      console.log(`\n=== ${name} ===`);
      console.log(`status: ${r.status} | url_final: ${r.url.slice(0, 60)} | JSON: ${esJson ? "SI ✔" : "NO (HTML)"}`);
      console.log(t.slice(0, 200));
    } catch (e) {
      console.log(`\n=== ${name} === FALLO: ${e.message}`);
    }
  }
  console.log("\n=== FIN ===");
})();
