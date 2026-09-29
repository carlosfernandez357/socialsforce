// Banner de consentimiento: cookie sf_consent = "v1.aX.pX.mX" (6 meses)
(function () {
    var box = document.getElementById("sf-consent");
    if (!box) return;
    var prefs = box.querySelector(".sf-consent-prefs");
    var btnSave = box.querySelector('[data-consent="save"]');
    var btnConfig = box.querySelector('[data-consent="config"]');

    function read() {
        var m = document.cookie.match(/(?:^|; )sf_consent=([^;]*)/);
        var v = m ? decodeURIComponent(m[1]) : "";
        return { set: v.indexOf("v1") === 0, analytics: /\.a1/.test(v), personalization: /\.p1/.test(v), marketing: /\.m1/.test(v) };
    }

    function apply(c) {
        if (typeof window.gtag === "function") {
            gtag("consent", "update", {
                analytics_storage: c.analytics ? "granted" : "denied",
                ad_storage: c.marketing ? "granted" : "denied",
                ad_user_data: c.marketing ? "granted" : "denied",
                ad_personalization: c.marketing ? "granted" : "denied"
            });
        }
        if (c.analytics && window.SF_GA_ID && !document.querySelector('script[src*="googletagmanager.com/gtag/js"]')) {
            var s = document.createElement("script");
            s.async = true;
            s.src = "https://www.googletagmanager.com/gtag/js?id=" + window.SF_GA_ID;
            document.head.appendChild(s);
        }
    }

    function save(c) {
        var prev = read();
        var v = "v1.a" + (c.analytics ? 1 : 0) + ".p" + (c.personalization ? 1 : 0) + ".m" + (c.marketing ? 1 : 0);
        document.cookie = "sf_consent=" + v + "; Max-Age=" + (180 * 24 * 3600) + "; Path=/; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
        window.sfConsent = read();
        apply(window.sfConsent);
        // Retirada de personalización: borrar historial local y datos del servidor
        if (prev.personalization && !c.personalization) {
            try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf("sf_") === 0) localStorage.removeItem(k); }); } catch (e) {}
            fetch("/api/privacy/forget", { method: "POST", credentials: "same-origin" }).catch(function () {});
        }
        // Retirada de analítica: borrar cookies de GA
        if (prev.analytics && !c.analytics) {
            document.cookie.split("; ").forEach(function (p) {
                var n = p.split("=")[0];
                if (n.indexOf("_ga") === 0) {
                    var host = location.hostname.replace(/^www\./, "");
                    document.cookie = n + "=; Max-Age=0; Path=/";
                    document.cookie = n + "=; Max-Age=0; Path=/; Domain=." + host;
                }
            });
        }
        box.hidden = true;
        document.dispatchEvent(new CustomEvent("sf:consent", { detail: window.sfConsent }));
    }

    function showPrefs(show) {
        prefs.hidden = !show;
        btnSave.hidden = !show;
        btnConfig.hidden = show;
    }

    window.sfConsent = read();

    box.addEventListener("click", function (e) {
        var action = e.target && e.target.getAttribute("data-consent");
        if (!action) return;
        if (action === "accept") save({ analytics: true, personalization: true, marketing: true });
        else if (action === "reject") save({ analytics: false, personalization: false, marketing: false });
        else if (action === "config") showPrefs(true);
        else if (action === "save") save({ analytics: prefs.a.checked, personalization: prefs.p.checked, marketing: prefs.m.checked });
    });

    document.addEventListener("click", function (e) {
        var t = e.target && e.target.closest && e.target.closest("[data-open-consent]");
        if (!t) return;
        e.preventDefault();
        var c = read();
        prefs.a.checked = c.analytics; prefs.p.checked = c.personalization; prefs.m.checked = c.marketing;
        showPrefs(true);
        box.hidden = false;
    });
})();
