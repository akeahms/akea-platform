// The redesigned home page, published at /preview/ (hidden from search engines) for review before it replaces "/".
// Direction: quiet editorial luxury, with one orchestrated moment — a clay hotel built in stop motion beside a
// kinetic headline. Everything is inline SVG + CSS; the only script swaps the clay "boil" frames and starts reveals.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function buildPreview({ c, legal, out, here, img, csp, esc, appPath }) {
  const words = c.home.title.split(" ");
  const kinetic = words.map((w, i) => `<span class="w w${i + 1}"><span>${esc(w)}</span></span>`).join(" ");
  const verbs = ["develop", "build", "run", "turn around"];
  const services = c.home.services.map((s, i) => `
      <li class="svc">
        <svg class="clay-icon" viewBox="0 0 96 96" aria-hidden="true">${ICONS[i] || ""}</svg>
        <div><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></div>
      </li>`).join("");
  const hotel = (h, future) => `
      <li class="row${future ? " future" : ""}">
        <span class="name">${h.url ? `<a href="${esc(h.url)}" rel="noopener" target="_blank">${esc(h.name)}</a>` : esc(h.name)}</span>
        <span class="where">${h.lines.map(esc).join("<br>")}</span>
        ${h.img ? `<img class="logo" src="${img(h.img)}" alt="" loading="lazy" decoding="async" width="160" height="64">` : ""}
      </li>`;
  const team = c.about.team.map(([n, r]) => `<li><span class="n">${esc(n)}</span><span class="r">${esc(r)}</span></li>`).join("");
  const closing = "Let’s build the next one.".split("").map((ch, i) => ch === " " ? " " : `<span class="l l${(i % 12) + 1}">${esc(ch)}</span>`).join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="robots" content="noindex, nofollow">
<title>${esc(c.company)} | Hotel development and management</title>
<meta name="description" content="${esc(c.blurb)}">
<meta name="theme-color" content="#14241F">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/cormorant-italic.woff" as="font" type="font/woff" crossorigin>
<link rel="preload" href="/fonts/jost.woff" as="font" type="font/woff" crossorigin>
<link rel="stylesheet" href="/preview/preview.css">
<script src="/preview/preview.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header class="nav">
  <a class="mark" href="/" aria-label="${esc(c.company)} home"><img src="/brand/wordmark-light.svg" alt="${esc(c.company)}" width="87" height="40"></a>
  <nav aria-label="Main">
    <a href="/about-us/">About</a><a href="/portfolio/">Portfolio</a><a href="/careers/">Careers</a><a href="/contact-us/">Contact</a><a class="login" href="${appPath}">Log in</a>
  </nav>
</header>
<main id="main">
  <section class="stage" aria-labelledby="h1">
    <div class="copy">
      <h1 id="h1" class="kinetic" aria-label="${esc(c.home.title)}"><span aria-hidden="true">${kinetic}</span></h1>
      <p class="rotator"><span class="sr">We develop, build, run and turn around hotels.</span><span aria-hidden="true">Hotels we <span class="verb">${verbs.map((v, i) => `<span class="v v${i + 1}">${v}.</span>`).join("")}</span></span></p>
      <p class="cta"><a class="btn" href="/contact-us/">Talk to us</a><a class="quiet" href="/portfolio/">See the portfolio</a></p>
    </div>
    <figure class="set" aria-label="A hand-made clay model of a hotel being built, frame by frame">
      ${SCENE}
    </figure>
  </section>

  <section class="intro">
    <p class="lede">${esc(c.home.intro[0])}</p>
    <p class="aside">${esc(c.home.intro[1])}</p>
  </section>

  <section class="what" aria-labelledby="what">
    <h2 id="what" class="slide">What we do</h2>
    <ul class="svcs">${services}</ul>
  </section>

  <section class="hotels" aria-labelledby="port">
    <h2 id="port" class="slide">${esc(c.portfolio.title)}</h2>
    <ul class="rows">${c.portfolio.current.map((h) => hotel(h, false)).join("")}</ul>
    <h3 class="soon">Opening in 2027</h3>
    <ul class="rows">${c.portfolio.future.map((h) => hotel(h, true)).join("")}</ul>
  </section>

  <section class="people" aria-labelledby="team">
    <h2 id="team" class="slide">${esc(c.about.title)}</h2>
    <p class="blurb">${esc(c.blurb)}</p>
    <ul class="team">${team}</ul>
  </section>

  <section class="close" aria-labelledby="next">
    <h2 id="next" class="kinetic-close" aria-label="Let’s build the next one."><span aria-hidden="true">${closing}</span></h2>
    <p class="reach"><a href="${c.phoneHref}">${esc(c.phone)}</a><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>
    <p class="cta"><a class="btn light" href="/contact-us/">Start a conversation</a><a class="quiet light" href="/careers/">Careers</a></p>
  </section>
</main>
<footer class="foot">
  <span>${esc(c.copyright)}</span>
  <span class="links">${legal.order.filter((s) => ["terms", "privacy-policy", "disclaimers", "cookie-policy", "accessibility"].includes(s)).map((s) => `<a href="/${s}/">${esc(legal.docs[s].title.replace(/ (Statement|Policy)$/, ""))}</a>`).join("")}<a href="/legal/">All legal</a></span>
</footer>
</body>
</html>
`;
  mkdirSync(join(out, "preview"), { recursive: true });
  writeFileSync(join(out, "preview", "index.html"), html);
  copyFileSync(join(here, "preview.css"), join(out, "preview", "preview.css"));
  copyFileSync(join(here, "preview.js"), join(out, "preview", "preview.js"));
}

// ---------------------------------------------------------------------------------------------------------------
// The clay set. Shapes are flat fills; the "clay" look (soft bevel, fingerprint grain, wobbly hand-made edges)
// comes from the filters. Three filter frames with different noise seeds are swapped at 8 fps for the stop-motion
// "boil". Each part has a class the load sequence uses (ground, floors, roof, door, tree, cart, windows, sun).
const CLAY_FILTER = (id, seed) => `
  <filter id="${id}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="${seed}" result="warp"/>
    <feDisplacementMap in="SourceGraphic" in2="warp" scale="5" xChannelSelector="R" yChannelSelector="G" result="shape"/>
    <feGaussianBlur in="shape" stdDeviation="4" result="soft"/>
    <feSpecularLighting in="soft" surfaceScale="4" specularConstant="0.55" specularExponent="16" lighting-color="#FFF6E6" result="spec">
      <fePointLight x="-120" y="-220" z="260"/>
    </feSpecularLighting>
    <feComposite in="spec" in2="shape" operator="in" result="shine"/>
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="1" seed="${seed + 7}" result="grain"/>
    <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -0.6 0.34" result="grainA"/>
    <feComposite in="grainA" in2="shape" operator="in" result="grainIn"/>
    <feComposite in="shape" in2="shine" operator="arithmetic" k1="0" k2="1" k3="0.7" k4="0" result="lit"/>
    <feBlend in="lit" in2="grainIn" mode="multiply"/>
  </filter>`;

const win = (x, y, n) => `<rect class="win n${n}" x="${x}" y="${y}" width="30" height="34" rx="9"/>`;
const floor = (i, y) => `
    <g class="floor f${i}">
      <rect x="196" y="${y}" width="232" height="68" rx="14" fill="#D9CDB5"/>
      <rect x="196" y="${y + 56}" width="232" height="12" rx="6" fill="#B9AA8E"/>
      ${[0, 1, 2, 3].map((k) => win(216 + k * 54, y + 16, i * 4 + k + 1)).join("")}
    </g>`;

const SCENE = `<svg class="scene" viewBox="0 0 620 600" role="img" aria-hidden="true">
  <defs>${CLAY_FILTER("clay1", 3)}${CLAY_FILTER("clay2", 11)}${CLAY_FILTER("clay3", 23)}</defs>
  <g class="clay" filter="url(#clay1)">
    <circle class="sun" cx="512" cy="112" r="46" fill="#C9A66B"/>
    <g class="ground"><ellipse cx="310" cy="540" rx="276" ry="44" fill="#5E7A5B"/><ellipse cx="310" cy="528" rx="262" ry="34" fill="#7F9A7A"/></g>
    <g class="base"><rect x="182" y="430" width="260" height="96" rx="18" fill="#8E4A33"/><rect x="182" y="510" width="260" height="16" rx="8" fill="#6F3826"/></g>
    <g class="door"><rect x="284" y="456" width="56" height="70" rx="22" fill="#14241F"/><rect x="262" y="440" width="100" height="22" rx="11" fill="#9C7A43"/></g>
    ${floor(3, 160)}${floor(2, 232)}${floor(1, 304)}${floor(0, 376)}
    <g class="roof"><rect x="184" y="126" width="256" height="40" rx="16" fill="#14241F"/><rect x="306" y="70" width="8" height="58" rx="4" fill="#5F5A51"/><path d="M314 74 h46 l-12 14 l12 14 h-46 z" fill="#9C7A43"/></g>
    <g class="tree"><rect x="104" y="440" width="14" height="80" rx="7" fill="#6F5A3E"/><circle cx="110" cy="420" r="40" fill="#4F6E4C"/><circle cx="86" cy="446" r="26" fill="#5E7A5B"/><circle cx="136" cy="444" r="26" fill="#5E7A5B"/></g>
    <g class="cart"><rect x="468" y="456" width="64" height="44" rx="12" fill="#8E4A33"/><rect x="490" y="434" width="40" height="26" rx="9" fill="#2E3F39"/><rect x="460" y="500" width="84" height="8" rx="4" fill="#9C7A43"/><rect x="462" y="420" width="8" height="86" rx="4" fill="#9C7A43"/><circle cx="476" cy="514" r="10" fill="#14241F"/><circle cx="530" cy="514" r="10" fill="#14241F"/></g>
  </g>
</svg>`;

// Small clay objects for the services list (same clay filter, one frame, no boil).
const ICONS = [
  // development: a plot of earth with a sprout
  `<g filter="url(#clay1)"><ellipse cx="48" cy="70" rx="38" ry="14" fill="#6F5A3E"/><rect x="45" y="34" width="6" height="36" rx="3" fill="#5E7A5B"/><ellipse cx="34" cy="38" rx="14" ry="8" fill="#7F9A7A"/><ellipse cx="62" cy="30" rx="14" ry="8" fill="#7F9A7A"/></g>`,
  // construction support: a hard hat
  `<g filter="url(#clay1)"><path d="M18 62 a30 30 0 0 1 60 0 z" fill="#C9A66B"/><rect x="10" y="60" width="76" height="12" rx="6" fill="#9C7A43"/><rect x="44" y="30" width="8" height="30" rx="4" fill="#B08A4E"/></g>`,
  // management: a reception bell
  `<g filter="url(#clay1)"><rect x="14" y="68" width="68" height="10" rx="5" fill="#14241F"/><path d="M22 68 a26 26 0 0 1 52 0 z" fill="#C9A66B"/><circle cx="48" cy="38" r="6" fill="#9C7A43"/></g>`,
  // asset & turnaround: a curved arrow climbing
  `<g filter="url(#clay1)"><path d="M16 70 C30 70 40 40 66 36" fill="none" stroke="#8E4A33" stroke-width="12" stroke-linecap="round"/><path d="M58 22 L80 34 L62 52 z" fill="#8E4A33"/></g>`,
];
