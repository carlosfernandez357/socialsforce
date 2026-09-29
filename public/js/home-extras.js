(function () {
    var els = document.querySelectorAll(".hx-reveal");
    if (!("IntersectionObserver" in window)) { els.forEach(function (e) { e.classList.add("is-in"); }); return; }
    var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    els.forEach(function (e) { io.observe(e); });

    // Mosaico: barajar las tarjetas con animación
    var btn = document.querySelector("[data-hx-shuffle]"), grid = document.querySelector("[data-hx-mosaic]");
    if (btn && grid) btn.addEventListener("click", function () {
        grid.classList.add("is-shuffling");
        setTimeout(function () {
            var tiles = Array.prototype.slice.call(grid.children);
            for (var i = tiles.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = tiles[i]; tiles[i] = tiles[j]; tiles[j] = t; }
            tiles.forEach(function (t, i) { t.className = t.className.replace(/hx-tile-\d+/, "hx-tile-" + i); grid.appendChild(t); });
            grid.classList.remove("is-shuffling");
        }, 400);
    });
})();
(function () {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document.querySelectorAll("[data-hx-count]").forEach(function (el) {
        var end = parseInt(el.getAttribute("data-hx-count"), 10) || 0, t0 = null;
        if (!end) return;
        function step(t) { t0 = t0 || t; var k = Math.min(1, (t - t0) / 1200); el.textContent = Math.round(end * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); }
        requestAnimationFrame(step);
    });
})();
