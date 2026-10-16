// Website behaviour: mobile menu and the contact / job application forms (sent to the company's own suite).
(() => {
  // a sign-in email (magic link, password reset, social sign-in) that comes back to the website goes on to the app
  if (/(^|[#&])(access_token|error_code|type=recovery)/.test(location.hash) || /[?&]code=/.test(location.search)) {
    location.replace("/app/" + location.search + location.hash);
    return;
  }
  const endpoint = document.currentScript?.dataset.endpoint;
  const started = Date.now();

  const menu = document.querySelector(".menu");
  const nav = document.getElementById("nav");
  menu?.addEventListener("click", () => {
    const open = menu.getAttribute("aria-expanded") !== "true";
    menu.setAttribute("aria-expanded", String(open));
    nav?.classList.toggle("open", open);
  });

  for (const form of document.querySelectorAll("form[data-kind]")) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = form.querySelector(".status");
      const button = form.querySelector("button[type=submit]");
      const say = (text, ok) => { status.textContent = text; status.className = "status " + (ok ? "ok" : "bad"); };
      // the browser's own checks first (required fields, email format)
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const kind = form.dataset.kind;
      const fd = new FormData(form);
      fd.set("kind", kind); fd.set("started", String(started)); fd.set("page", location.pathname);
      const file = fd.get("resume");
      if (kind === "application" && file && file.size > 5 * 1024 * 1024) { say("Résumés can be up to 5 MB.", false); return; }
      button.disabled = true; say("Sending…", true);
      try {
        const r = kind === "application"
          ? await fetch(endpoint, { method: "POST", body: fd })
          : await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(fd)) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) throw new Error(j.error || "Something went wrong. Please try again.");
        form.reset();
        say(kind === "application" ? "Thank you! Your application has been received." : "Thank you! We'll be in touch shortly.", true);
      } catch (err) {
        say(err.message || "Couldn't send. Please check your connection and try again.", false);
      } finally {
        button.disabled = false;
      }
    });
  }
})();
