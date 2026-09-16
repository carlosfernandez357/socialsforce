const axios = require("axios");
const cheerio = require("cheerio");

async function extractPage(inputUrl) {
    let url = inputUrl.trim();

    if (!/^https?:\/\//i.test(url)) {
        url = "http://" + url;
    }

    const response = await axios.get(url, {
        timeout: 15000,
        maxRedirects: 10,

        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip, deflate, br",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1"
        },

        responseType: "text",
        validateStatus: status => status >= 200 && status < 400
    });

    const finalUrl = response.request?.res?.responseUrl || url;

    const $ = cheerio.load(response.data);

    $("script, style, noscript, svg, canvas, iframe, form, template, video, audio").remove();

    $("a[href]").each((_, element) => {
        const href = $(element).attr("href");

        if (href) {
            try {
                $(element).attr(
                    "href",
                    new URL(href, finalUrl).href
                );
            } catch {}
        }
    });

    $("img[src]").each((_, element) => {
        const src = $(element).attr("src");

        if (src) {
            try {
                $(element).attr(
                    "src",
                    new URL(src, finalUrl).href
                );
            } catch {}
        }
    });

    const title = $("title").first().text().trim();

    const description =
        $('meta[name="description"]').attr("content")?.trim() || "";

    const text = $("body")
        .text()
        .replace(/\s+/g, " ")
        .trim();

    const links = [];

    $("a[href]").each((_, element) => {
        const href = $(element).attr("href");
        const text = $(element).text().replace(/\s+/g, " ").trim();

        if (href && text) {
            links.push({
                text,
                url: href
            });
        }
    });

    const images = [];

    $("img[src]").each((_, element) => {
        images.push({
            url: $(element).attr("src"),
            alt: $(element).attr("alt") || ""
        });
    });

    const html = $("body").html();

    return {
        url,
        finalUrl,
        redirected: url !== finalUrl,
        status: response.status,
        title,
        description,
        text,
        links,
        images,
        html
    };
}

module.exports = extractPage;