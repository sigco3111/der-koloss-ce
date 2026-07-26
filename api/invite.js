const SITE_URL = 'https://www.derkoloss.com';
const OG_IMAGE = `${SITE_URL}/assets/der-koloss-og-v06-courtyard-rev2-1200x630.png`;

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function cleanCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function jsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

module.exports = function inviteMetadata(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Method Not Allowed');
    return;
  }

  const code = cleanCode(first(req.query?.code));
  const inviter = cleanName(first(req.query?.from));

  if (code.length < 4) {
    res.statusCode = 302;
    res.setHeader('Location', SITE_URL);
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return;
  }

  const invitePath = `/invite/${encodeURIComponent(code)}${inviter ? `?from=${encodeURIComponent(inviter)}` : ''}`;
  const inviteUrl = `${SITE_URL}${invitePath}`;
  const joinUrl = `${SITE_URL}/?join=${encodeURIComponent(code)}${inviter ? `&from=${encodeURIComponent(inviter)}` : ''}`;
  const title = inviter
    ? `${inviter} invited you to join Der Koloss · Lobby ${code}`
    : `You're invited to join Der Koloss · Lobby ${code}`;
  const description = inviter
    ? `Join ${inviter}'s co-op game in Der Koloss. Use lobby code ${code} and fight together to survive.`
    : `Join a co-op game in Der Koloss with lobby code ${code}. Fight together to survive.`;

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'JoinAction',
    name: title,
    description,
    target: {
      '@type': 'EntryPoint',
      urlTemplate: joinUrl,
      actionPlatform: 'https://schema.org/DesktopWebPlatform',
    },
    object: {
      '@type': 'VideoGame',
      '@id': `${SITE_URL}/#game`,
      name: 'Der Koloss',
      url: `${SITE_URL}/`,
      image: OG_IMAGE,
    },
    ...(inviter ? { agent: { '@type': 'Person', name: inviter } } : {}),
  };

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
  <meta name="theme-color" content="#070b12">
  <link rel="canonical" href="${escapeHtml(inviteUrl)}">

  <meta property="og:type" content="website">
  <meta property="og:locale" content="en_US">
  <meta property="og:site_name" content="Der Koloss">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(inviteUrl)}">
  <meta property="og:image" content="${OG_IMAGE}">
  <meta property="og:image:secure_url" content="${OG_IMAGE}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Der Koloss co-op lobby invitation for code ${escapeHtml(code)}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${OG_IMAGE}">
  <meta name="twitter:image:alt" content="Der Koloss co-op lobby invitation for code ${escapeHtml(code)}">

  <script type="application/ld+json">${jsonLd(structuredData)}</script>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #070b12; color: #f3efe5; }
    main { width: min(92vw, 720px); text-align: center; }
    img { width: 100%; height: auto; border: 1px solid #3b3128; box-shadow: 0 24px 80px #000; }
    h1 { margin: 24px 0 8px; font-size: clamp(1.5rem, 5vw, 2.6rem); }
    p { color: #bdb6aa; }
    a { display: inline-block; margin-top: 12px; padding: 12px 20px; color: #fff; border: 1px solid #8d2430; text-decoration: none; background: #5e101a; }
  </style>
</head>
<body>
  <main>
    <img src="${OG_IMAGE}" width="1200" height="630" alt="Der Koloss">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(description)}</p>
    <a href="${escapeHtml(joinUrl)}">Join lobby ${escapeHtml(code)}</a>
  </main>
  <script>window.location.replace(${JSON.stringify(joinUrl).replace(/</g, '\\u003c')});</script>
</body>
</html>`;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https://www.derkoloss.com; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  res.end(method === 'HEAD' ? undefined : html);
};
