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
