// Builds the public company website (static pages) from site/content.json into dist/.
// The suite itself lives at /app/ on the same domain. Page addresses match the old Wix site so links keep working.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function buildSite(out, { supabaseUrl, siteUrl = "https://akeahms.com", tenantSlug = "akea", appPath = "/app/" }) {
  const c = JSON.parse(readFileSync(join(here, "content.json"), "utf8"));
  const legal = JSON.parse(readFileSync(join(here, "legal.json"), "utf8"));
  // images were copied from Wix into our own storage (functions/site-assets); same file names without "~mv2"
  const img = (u) => {
    if (!u) return "";
    const file = new URL(u).pathname.split("/")[2].replace(/~mv2/, "").replace(/[^A-Za-z0-9._-]/g, "_");
    return `${supabaseUrl}/storage/v1/object/public/site/${tenantSlug}/${file}`;
  };
  const fn = `${supabaseUrl}/functions/v1/website`;
  const sb = new URL(supabaseUrl).origin;
  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'",
    `img-src 'self' data: ${sb}`, `connect-src ${sb}`, "object-src 'none'", "base-uri 'self'", "form-action 'none'", "frame-src 'none'",
  ].join("; ");
  const nav = [["/", "Home"], ["/about-us/", "About Us"], ["/portfolio/", "Portfolio"], ["/careers/", "Careers"], ["/contact-us/", "Contact Us"]];

  const contactForm = (id, heading) => `
    <form class="form" id="${id}" data-kind="contact" novalidate>
      ${heading ? `<h3>${heading}</h3>` : ""}
      <div class="grid2">
        <label>First name<input name="first_name" autocomplete="given-name" required maxlength="80"></label>
        <label>Phone<input name="phone" type="tel" autocomplete="tel" required maxlength="40"></label>
      </div>
      <label>Email<input name="email" type="email" autocomplete="email" required maxlength="254"></label>
      <label>Message<textarea name="message" rows="4" required maxlength="5000"></textarea></label>
      <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
      <button class="btn" type="submit">Submit</button>
      <p class="status" role="status" aria-live="polite"></p>
    </form>`;

  const page = ({ path, title, description, hero, heroTitle, body, footerForm = true }) => {
    const canonical = siteUrl + path;
    const navHtml = nav.map(([href, label]) => `<a href="${href}"${href === path ? ' aria-current="page"' : ""}>${label}</a>`).join("");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${esc(title)} | ${esc(c.company)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${esc(title)} | ${esc(c.company)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="website">
${hero ? `<meta property="og:image" content="${img(hero)}">` : ""}
<meta name="theme-color" content="#14241F">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<link rel="preload" href="/fonts/jost.woff" as="font" type="font/woff" crossorigin>
<link rel="preload" href="/fonts/cormorant-italic.woff" as="font" type="font/woff" crossorigin>
<link rel="stylesheet" href="/site.css">
<script src="/site.js" defer data-endpoint="${fn}"></script>
</head>
<body>
<a class="skip" href="#main">Skip to main content</a>
<header class="top">
  <div class="wrap bar">
    <a class="brand" href="/" aria-label="${esc(c.company)} home"><img src="/brand/wordmark.svg" alt="${esc(c.company)}" width="87" height="40"><span>Hotel Management<br>Services</span></a>
    <button class="menu" aria-expanded="false" aria-controls="nav" aria-label="Menu"><span></span><span></span><span></span></button>
    <nav id="nav" aria-label="Main">${navHtml}<a class="login" href="${appPath}">Login</a></nav>
  </div>
</header>
<main id="main">
${hero ? `<section class="hero"><img class="hero-img" src="${img(hero)}" alt="" fetchpriority="high"><div class="wrap"><p class="eyebrow">${esc(title === "Home" ? "Hotel Management Services" : title)}</p><h1>${esc(heroTitle)}</h1><a class="btn light" href="/contact-us/">Let's Connect</a></div></section>` : ""}
${body}
</main>
<footer class="foot">
  <div class="wrap fgrid">
    <div>
      <img src="/brand/wordmark-light.svg" alt="${esc(c.company)}" width="113" height="52" loading="lazy">
      <p class="ruled">Hotel Management Services</p>
      <p>${esc(c.blurb)}</p>
      <p><a href="${c.phoneHref}">${esc(c.phone)}</a><br><a href="mailto:${c.email}">${esc(c.email)}</a></p>
    </div>
    <div><h6>Links</h6>${nav.map(([href, label]) => `<a href="${href}">${label}</a>`).join("")}<a href="${appPath}">Login</a></div>
    <div>${footerForm ? contactForm("footer-form", "Get in touch") : ""}</div>
  </div>
  <div class="wrap legal"><span>${esc(c.copyright)}</span><span><a href="/terms/">Terms</a> · <a href="/privacy-policy/">Privacy</a> · <a href="/disclaimers/">Disclaimers</a> · <a href="/cookie-policy/">Cookies</a> · <a href="/accessibility/">Accessibility</a> · <a href="/legal/">All legal</a></span></div>
</footer>
</body>
</html>
`;
  };

  const write = (path, html) => { const dir = join(out, path); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "index.html"), html); };
  const card = (h, opts = {}) => `
      <article class="hotel">
        <img src="${img(h.img)}" alt="${esc(h.name)}" loading="lazy">
        <div class="body"><h3>${esc(h.name)}</h3>${h.lines.map((l) => `<p>${esc(l)}</p>`).join("")}
        ${h.url ? `<a class="link" href="${esc(h.url)}" target="_blank" rel="noopener">Learn More Or Book Now</a>` : ""}</div>
      </article>`;
  const initials = (n) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2);

  // Home
  write("", page({
    path: "/", title: "Home", description: c.blurb, hero: c.images.hero, heroTitle: c.home.title,
    body: `
<section class="wrap intro">${c.home.intro.map((p) => `<p>${esc(p)}</p>`).join("")}</section>
<section class="brands" aria-label="Brands we operate"><div class="wrap">${c.images.brands.map((b) => `<img src="${img(b)}" alt="" loading="lazy">`).join("")}</div></section>
<section class="wrap services"><p class="eyebrow">What we do</p><h2>Our Services</h2><div class="cards">${c.home.services.map((s) => `
  <article class="svc"><img src="${img(s.img)}" alt="${esc(s.alt)}" loading="lazy"><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></article>`).join("")}</div></section>`,
  }));
  // About
  write("about-us", page({
    path: "/about-us/", title: "About Us", description: `${c.about.title} Meet the ${c.company} team.`, hero: c.images.hero, heroTitle: c.about.title,
    body: `<section class="wrap team"><p class="eyebrow">Leadership</p><h2>Our Team</h2><div class="people">${c.about.team.map(([n, r]) => `
  <article class="person"><div class="mono" aria-hidden="true">${esc(initials(n))}</div><h3>${esc(n)}</h3><p>${esc(r)}</p></article>`).join("")}</div></section>`,
  }));
  // Portfolio
  write("portfolio", page({
    path: "/portfolio/", title: "Portfolio", description: c.portfolio.title, hero: c.images.hero, heroTitle: c.portfolio.title,
    body: `<nav class="wrap tabs" aria-label="Portfolio sections"><a href="#current">Current Projects</a><a href="#future">Future Projects</a><a href="#past">Past Projects</a></nav>
<section class="wrap" id="current"><h2>Current Projects</h2><div class="hotels">${c.portfolio.current.map((h) => card(h)).join("")}</div></section>
<section class="wrap" id="future"><h2>Future Projects</h2><div class="hotels">${c.portfolio.future.map((h) => card(h)).join("")}</div></section>
<section class="wrap" id="past"><h2>Past Projects</h2><div class="hotels">${c.portfolio.past.map((h) => card(h)).join("")}</div></section>`,
  }));
  // Careers
  write("careers", page({
    path: "/careers/", title: "Careers", description: c.careers.title, hero: c.images.hero, heroTitle: c.careers.title, footerForm: false,
    body: `<section class="wrap split">
  <form class="form" id="apply" data-kind="application" novalidate>
    <h2>Apply</h2>
    <div class="grid2">
      <label>First name<input name="first_name" autocomplete="given-name" maxlength="80"></label>
      <label>Last name<input name="last_name" autocomplete="family-name" maxlength="80"></label>
    </div>
    <div class="grid2">
      <label>Phone<input name="phone" type="tel" autocomplete="tel" maxlength="40"></label>
      <label>Email*<input name="email" type="email" autocomplete="email" required maxlength="254"></label>
    </div>
    <label>Position You Want To Apply For*<input name="position" required maxlength="150"></label>
    <label>Linkedin Profile (If Available)<input name="linkedin" type="url" placeholder="https://www.linkedin.com/in/…" maxlength="300"></label>
    <label>Upload your Resume*<input name="resume" type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required></label>
    <p class="hint">PDF or Word, up to 5 MB.</p>
    <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
    <button class="btn" type="submit">Submit</button>
    <p class="status" role="status" aria-live="polite"></p>
  </form>
  <aside class="reach"><h2>Let's Connect</h2><p><span>Call</span><a href="${c.phoneHref}">${esc(c.phone)}</a></p><p><span>Mail</span><a href="mailto:${c.careersEmail}">${esc(c.careersEmail)}</a></p></aside>
</section>`,
  }));
  // Contact
  write("contact-us", page({
    path: "/contact-us/", title: "Contact Us", description: `${c.contact.title} Call ${c.phone} or email ${c.email}.`, hero: c.images.hero, heroTitle: c.contact.title, footerForm: false,
    body: `<section class="wrap split">${contactForm("contact", "Send us a message")}
  <aside class="reach"><h2>Let's Connect</h2><p><span>Call</span><a href="${c.phoneHref}">${esc(c.phone)}</a></p><p><span>Mail</span><a href="mailto:${c.email}">${esc(c.email)}</a></p></aside>
</section>`,
  }));
  // Legal pages (from legal.json). Paragraphs are separated by blank lines; lines starting "- " are list items.
  const prose = (t) => t.split(/\n\n/).map((para) => {
    const lines = para.split("\n");
    const items = lines.filter((l) => l.startsWith("- "));
    const lead = lines.filter((l) => !l.startsWith("- "));
    return (lead.length ? `<p>${lead.map(esc).join("<br>")}</p>` : "") + (items.length ? `<ul>${items.map((l) => `<li>${esc(l.slice(2))}</li>`).join("")}</ul>` : "");
  }).join("");
  const legalLinks = legal.order.map((slug) => `<li><a href="/${slug}/">${esc(legal.docs[slug].title)}</a> — ${esc(legal.docs[slug].summary)}</li>`).join("");
  for (const slug of legal.order) {
    const l = legal.docs[slug];
    write(slug, page({
      path: `/${slug}/`, title: l.title, description: `${legal.entity} ${l.title}. ${l.summary}`,
      body: `<article class="wrap legaltext"><h1>${esc(l.title)}</h1><p class="muted">${esc(legal.updated)} · Version ${esc(legal.version)}</p>${prose(l.intro)}
${l.sections.map(([h, t]) => `<h2>${esc(h)}</h2>${prose(t)}`).join("\n")}
<h2>Contact</h2><p><strong>${esc(legal.entity)}</strong><br>Phone: <a href="${c.phoneHref}">${esc(c.phone)}</a><br>Email: <a href="mailto:${c.email}">${esc(c.email)}</a></p>
<p class="muted small">Other documents: <a href="/legal/">all legal documents</a>.</p></article>`,
    }));
  }
  write("legal", page({
    path: "/legal/", title: "Legal", description: `${legal.entity} terms, policies and disclaimers.`,
    body: `<article class="wrap legaltext"><h1>Legal</h1><p class="muted">${esc(legal.updated)} · Version ${esc(legal.version)}</p><p>The terms, policies and disclaimers that apply to our website, the Akea AI Suite and our apps.</p><ul class="legal-index">${legalLinks}</ul></article>`,
  }));
  // 404
  writeFileSync(join(out, "404.html"), page({ path: "/404", title: "Page not found", description: "Page not found",
    body: `<section class="wrap legaltext"><h1>Page not found</h1><p>The page you're looking for isn't here. <a href="/">Go to the home page</a> or <a href="${appPath}">log in</a>.</p></section>` }));
  copyFileSync(join(here, "site.css"), join(out, "site.css"));
  cpSync(join(here, "brand"), join(out, "brand"), { recursive: true });
  cpSync(join(here, "fonts"), join(out, "fonts"), { recursive: true });
  copyFileSync(join(here, "site.js"), join(out, "site.js"));
  writeFileSync(join(out, "robots.txt"), `User-agent: *\nDisallow: ${appPath}\nSitemap: ${siteUrl}/sitemap.xml\n`);
  const pages = ["/", "/about-us/", "/portfolio/", "/careers/", "/contact-us/", "/legal/", ...legal.order.map((x) => `/${x}/`)];
  writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${siteUrl}${p}</loc></url>`).join("\n")}\n</urlset>\n`);
}
