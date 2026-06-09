/*!
 * NailIQ booking widget — drop-in embeddable booking for any salon site.
 *
 *   <script src="https://www.nailiq.ca/embed.js" data-salon="your-slug"></script>
 *
 * Opens the salon's booking flow in a premium slide-over modal so the customer
 * never leaves the host page. Intercepts clicks on existing "Book" links that
 * point at the salon's NailIQ booking page (and any [data-nailiq-book] element),
 * and can render its own floating button (data-floating="true").
 *
 * Options (script data-* attributes):
 *   data-salon     (required) salon slug, e.g. "hilite-anaheim"
 *   data-floating  "true" to show a floating launcher button (default off)
 *   data-label     floating button label (default "Book Now")
 *   data-position  floating button corner: "br" (default) | "bl"
 */
(function () {
  "use strict";
  if (window.__nailiqEmbedLoaded) return;
  window.__nailiqEmbedLoaded = true;

  var script =
    document.currentScript ||
    (function () {
      var s = document.getElementsByTagName("script");
      for (var i = s.length - 1; i >= 0; i--) {
        if ((s[i].src || "").indexOf("embed.js") !== -1) return s[i];
      }
      return null;
    })();
  if (!script) return;

  var slug = (script.getAttribute("data-salon") || "").trim();
  if (!slug) {
    console.warn("[nailiq] embed.js: missing data-salon");
    return;
  }
  var origin = new URL(script.src, location.href).origin;
  var embedUrl = origin + "/embed/" + encodeURIComponent(slug);
  var floating = script.getAttribute("data-floating") === "true";
  var label = script.getAttribute("data-label") || "Book Now";
  var position = script.getAttribute("data-position") === "bl" ? "bl" : "br";

  // ── Styles ───────────────────────────────────────────────────────
  var css =
    "" +
    ".nq-embed-overlay{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
    "background:rgba(8,8,10,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:0;transition:opacity .28s ease;padding:max(16px,env(safe-area-inset-top)) 16px;}" +
    ".nq-embed-overlay.nq-open{opacity:1;}" +
    ".nq-embed-panel{position:relative;width:100%;max-width:460px;height:540px;max-height:90vh;background:#0b0b0c;border-radius:22px;overflow:hidden;" +
    "box-shadow:0 30px 80px -20px rgba(0,0,0,.7);transform:translateY(18px) scale(.985);opacity:0;" +
    "transition:transform .3s cubic-bezier(.2,.8,.2,1),opacity .3s ease,height .28s cubic-bezier(.2,.8,.2,1);}" +
    ".nq-embed-overlay.nq-open .nq-embed-panel{transform:none;opacity:1;}" +
    ".nq-embed-frame{width:100%;height:100%;border:0;display:block;background:transparent;}" +
    ".nq-embed-close{position:absolute;top:10px;right:10px;z-index:2;width:34px;height:34px;border:0;border-radius:999px;cursor:pointer;" +
    "background:rgba(0,0,0,.45);color:#fff;font-size:20px;line-height:34px;text-align:center;backdrop-filter:blur(4px);transition:background .15s;}" +
    ".nq-embed-close:hover{background:rgba(0,0,0,.7);}" +
    ".nq-embed-spinner{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;}" +
    ".nq-embed-spinner i{width:30px;height:30px;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:nqspin .8s linear infinite;}" +
    "@keyframes nqspin{to{transform:rotate(360deg)}}" +
    ".nq-embed-fab{position:fixed;z-index:2147483645;bottom:max(18px,env(safe-area-inset-bottom));" +
    "padding:13px 22px;border:0;border-radius:999px;cursor:pointer;font:600 15px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
    "color:#0b0b0c;background:#fff;box-shadow:0 10px 30px -8px rgba(0,0,0,.45);transition:transform .15s,box-shadow .15s;}" +
    ".nq-embed-fab:hover{transform:translateY(-2px);box-shadow:0 16px 36px -8px rgba(0,0,0,.55);}" +
    ".nq-embed-fab.br{right:20px;}.nq-embed-fab.bl{left:20px;}" +
    "@media(max-width:520px){.nq-embed-overlay{padding:0;align-items:flex-end;}" +
    ".nq-embed-panel{max-width:none;max-height:92vh;border-radius:22px 22px 0 0;transform:translateY(100%);}" +
    ".nq-embed-overlay.nq-open .nq-embed-panel{transform:none;}}";
  var styleEl = document.createElement("style");
  styleEl.textContent = css;

  var overlay, panel, frame, spinner, lastFocus;
  var built = false;

  function build() {
    if (built) return;
    built = true;
    document.head.appendChild(styleEl);

    overlay = document.createElement("div");
    overlay.className = "nq-embed-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Book an appointment");

    panel = document.createElement("div");
    panel.className = "nq-embed-panel";

    spinner = document.createElement("div");
    spinner.className = "nq-embed-spinner";
    spinner.innerHTML = "<i></i>";

    var close = document.createElement("button");
    close.className = "nq-embed-close";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = "&times;";
    close.addEventListener("click", closeModal);

    frame = document.createElement("iframe");
    frame.className = "nq-embed-frame";
    frame.setAttribute("title", "Book an appointment");
    frame.setAttribute("allow", "payment; clipboard-write");
    frame.setAttribute("loading", "lazy");

    panel.appendChild(spinner);
    panel.appendChild(close);
    panel.appendChild(frame);
    overlay.appendChild(panel);
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) closeModal();
    });
    document.body.appendChild(overlay);
  }

  function openModal() {
    build();
    if (!frame.src) frame.src = embedUrl;
    lastFocus = document.activeElement;
    overlay.style.display = "flex";
    document.documentElement.style.overflow = "hidden";
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        overlay.classList.add("nq-open");
      });
    });
    document.addEventListener("keydown", onKey);
  }

  function closeModal() {
    if (!overlay) return;
    overlay.classList.remove("nq-open");
    document.documentElement.style.overflow = "";
    document.removeEventListener("keydown", onKey);
    setTimeout(function () {
      overlay.style.display = "none";
    }, 300);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function onKey(e) {
    if (e.key === "Escape") closeModal();
  }

  // ── postMessage from the embedded flow ───────────────────────────
  window.addEventListener("message", function (e) {
    if (e.origin !== origin) return;
    var d = e.data;
    if (!d || d.source !== "nailiq-embed") return;
    if (d.type === "ready" && spinner) spinner.style.display = "none";
    if (d.type === "resize" && panel && typeof d.height === "number") {
      // Size the modal to the flow's content (compact for the phone gate,
      // taller once services/calendar appear), clamped to the viewport.
      var h = Math.max(300, Math.min(d.height + 2, Math.round(window.innerHeight * 0.92)));
      panel.style.height = h + "px";
    }
    if (d.type === "booked") {
      // Let the success screen breathe, then close.
      setTimeout(closeModal, 4200);
    }
  });

  // ── Bind triggers ────────────────────────────────────────────────
  function isBookingLink(a) {
    if (!a || !a.getAttribute) return false;
    if (a.hasAttribute("data-nailiq-book")) return true;
    var href = a.getAttribute("href") || "";
    if (!href) return false;
    try {
      var u = new URL(href, location.href);
      if (u.origin !== origin) return false;
      var p = u.pathname.replace(/\/+$/, "");
      return p === "/" + slug || p === "/embed/" + slug;
    } catch (_) {
      return false;
    }
  }

  // Capture-phase click interception so existing "Book" links open the modal
  // instead of navigating away.
  document.addEventListener(
    "click",
    function (e) {
      var node = e.target;
      while (node && node !== document.body) {
        if (
          node.nodeName === "A" ||
          (node.hasAttribute && node.hasAttribute("data-nailiq-book"))
        ) {
          if (isBookingLink(node) || node.hasAttribute("data-nailiq-book")) {
            e.preventDefault();
            e.stopPropagation();
            openModal();
            return;
          }
        }
        node = node.parentNode;
      }
    },
    true,
  );

  if (floating) {
    var fab = document.createElement("button");
    fab.className = "nq-embed-fab " + position;
    fab.type = "button";
    fab.textContent = label;
    fab.addEventListener("click", openModal);
    (document.body
      ? document.body
      : document.documentElement).appendChild(fab);
  }

  // Public API for custom triggers: NailIQBooking.open()
  window.NailIQBooking = { open: openModal, close: closeModal };
})();
