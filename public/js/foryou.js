// For You: carga recomendaciones en cualquier contenedor [data-foryou].
// data-size = tarjetas por página; data-infinite = scroll infinito; data-ads = hueco de anuncio cada N tarjetas.
(function () {
    var grid = document.querySelector("[data-foryou]");
    if (!grid) return;
    var size = parseInt(grid.getAttribute("data-size"), 10) || 6;
    var infinite = grid.hasAttribute("data-infinite");
    var adsEvery = parseInt(grid.getAttribute("data-ads"), 10) || 0;
    var ctx = grid.getAttribute("data-context") || "";
    var page = 0, loading = false, done = false, shown = [];

    function esc(str) {
        return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function personalization() { return /(?:^|; )sf_consent=v1[^;]*\.p1/.test(document.cookie); }

    function params() {
        var p = new URLSearchParams({ page: page, size: size });
        if (ctx) p.set("ctx", ctx);
        if (personalization()) {
            try {
                var cats = JSON.parse(localStorage.getItem("sf_cats") || "[]");
                var seen = JSON.parse(localStorage.getItem("sf_seen") || "[]");
                var counts = cats.reduce(function (a, c) { a[c] = (a[c] || 0) + 1; return a; }, {});
                var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 3);
                if (top.length) p.set("cats", top.join(","));
                if (seen.length) p.set("exclude", seen.slice(-30).join(","));
            } catch (e) {}
        }
        return p.toString();
    }

    function card(p, pos) {
        var excerpt = String(p.excerpt || "");
        if (excerpt.length > 100) excerpt = excerpt.substring(0, 100).trim() + "...";
        return '<article class="foryou-card card-linked" data-rec-pl="foryou" data-rec-pos="' + pos + '" data-pid="' + Number(p.id) + '">' +
            (p.image ? '<img src="' + esc(p.image) + '" alt="' + esc(p.title) + '" loading="lazy">' : "") +
            '<div class="foryou-card-body">' +
                (p.category ? '<a href="/category/' + encodeURIComponent(String(p.category).toLowerCase()) + '" class="card-category card-category-link">' + esc(p.category) + "</a>" : "") +
                '<h3><a href="/article/' + encodeURIComponent(p.slug) + '" class="stretched-link">' + esc(p.title) + "</a></h3>" +
                (excerpt ? "<p>" + esc(excerpt) + "</p>" : "") +
            "</div></article>";
    }

    function load() {
        if (loading || done) return;
        loading = true;
        fetch("/api/para-ti?" + params(), { credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var posts = (data && data.success && data.posts) || [];
                posts = posts.filter(function (p) { return shown.indexOf(p.id) === -1; });
                if (!posts.length) { done = true; return; }
                var html = "";
                posts.forEach(function (p) {
                    shown.push(p.id);
                    html += card(p, shown.length - 1);
                    // Hueco reservado para anuncios (vacío hasta activar publicidad)
                    if (adsEvery && shown.length % adsEvery === 0) html += '<div class="ad-slot" data-ad-slot="foryou" aria-hidden="true"></div>';
                });
                grid.insertAdjacentHTML("beforeend", html);
                var section = grid.closest(".foryou-section");
                if (section) section.style.display = "block";
                if (window.sfRec) window.sfRec.scan();
                page++;
                if (!data.hasMore || !infinite) done = true;
            })
            .catch(function () { done = true; })
            .then(function () { loading = false; });
    }

    load();

    if (infinite && "IntersectionObserver" in window) {
        var sentinel = document.createElement("div");
        sentinel.className = "foryou-sentinel";
        grid.parentNode.insertBefore(sentinel, grid.nextSibling);
        new IntersectionObserver(function (entries) {
            if (entries[0].isIntersecting) load();
        }, { rootMargin: "600px" }).observe(sentinel);
    }
})();
