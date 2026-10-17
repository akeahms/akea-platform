// Stop-motion "boil": swap the clay set between three hand-made frames at 8 fps, only while it's on screen and the
// visitor hasn't asked for reduced motion. Also starts the closing headline when it scrolls into view.
(function () {
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var clay = document.querySelector(".scene .clay");
  var frames = ["url(#clay1)", "url(#clay2)", "url(#clay3)"];
  var i = 0, timer = null, visible = true;
  function tick() { i = (i + 1) % frames.length; clay.setAttribute("filter", frames[i]); }
  function run() {
    var go = visible && !document.hidden && !still;
    if (go && !timer) timer = setInterval(tick, 125);
    if (!go && timer) { clearInterval(timer); timer = null; }
  }
  if (clay && "IntersectionObserver" in window) {
    new IntersectionObserver(function (es) { visible = es[0].isIntersecting; run(); }).observe(clay.ownerSVGElement);
    document.addEventListener("visibilitychange", run);
    run();
  }
  var close = document.querySelector(".close");
  if (close) {
    if (still || !("IntersectionObserver" in window)) { close.classList.add("in"); }
    else {
      close.classList.add("armed");
      var io = new IntersectionObserver(function (es) {
        if (es[0].isIntersecting) { close.classList.add("in"); io.disconnect(); }
      }, { threshold: 0.35 });
      io.observe(close);
    }
  }
})();
