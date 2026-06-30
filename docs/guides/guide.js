(function () {
  var clipSVG = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var checkSVG = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

  var liveRegion = document.createElement("div");
  liveRegion.className = "sr-only";
  liveRegion.setAttribute("role", "status");
  liveRegion.setAttribute("aria-live", "polite");
  document.body.appendChild(liveRegion);

  document.querySelectorAll(".command").forEach(function (block) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.setAttribute("aria-label", "Copy command");
    button.innerHTML = clipSVG;
    block.appendChild(button);

    function markCopied() {
      button.innerHTML = checkSVG;
      button.classList.add("copied");
      liveRegion.textContent = "Copied.";
      setTimeout(function () {
        button.innerHTML = clipSVG;
        button.classList.remove("copied");
        liveRegion.textContent = "";
      }, 1400);
    }

    button.addEventListener("click", function () {
      var text = block.querySelector("pre").innerText || "";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(markCopied, function () {
          fallbackCopy(text);
        });
        return;
      }
      fallbackCopy(text);
    });

    function fallbackCopy(text) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
        markCopied();
      } finally {
        document.body.removeChild(area);
      }
    }
  });

  document.querySelectorAll(".view-switch").forEach(function (switcher) {
    var scope = switcher.closest(".article") || document;
    var tabs = Array.prototype.slice.call(switcher.querySelectorAll(".view-tab"));
    var views = Array.prototype.slice.call(scope.querySelectorAll(".guide-view"));

    function select(viewName, focus) {
      tabs.forEach(function (tab) {
        var selected = tab.getAttribute("data-view") === viewName;
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) tab.focus();
      });
      views.forEach(function (view) {
        view.hidden = view.getAttribute("data-view") !== viewName;
      });
    }

    tabs.forEach(function (tab, index) {
      tab.addEventListener("click", function () {
        select(tab.getAttribute("data-view"), false);
      });
      tab.addEventListener("keydown", function (event) {
        var offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!offset) return;
        event.preventDefault();
        var next = tabs[(index + offset + tabs.length) % tabs.length];
        select(next.getAttribute("data-view"), true);
      });
    });
  });

  function selectViewForTarget(target, focus) {
    if (!target || !target.closest) return false;
    var view = target.closest(".guide-view");
    if (!view) return false;
    var viewName = view.getAttribute("data-view");
    var shell = view.closest(".guide-shell") || document;
    var article = view.closest(".article") || shell;
    var tabs = Array.prototype.slice.call(article.querySelectorAll(".view-tab"));
    var views = Array.prototype.slice.call(article.querySelectorAll(".guide-view"));

    tabs.forEach(function (tab) {
      var selected = tab.getAttribute("data-view") === viewName;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    views.forEach(function (view) {
      view.hidden = view.getAttribute("data-view") !== viewName;
    });
    return true;
  }

  function openHash(hash, focus) {
    if (!hash || hash === "#") return false;
    var target = document.getElementById(hash.slice(1));
    if (!selectViewForTarget(target, focus)) return false;
    target.scrollIntoView({ block: "start" });
    return true;
  }

  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener("click", function (event) {
      var hash = link.getAttribute("href");
      if (!openHash(hash, false)) return;
      event.preventDefault();
      history.pushState(null, "", hash);
    });
  });

  window.addEventListener("hashchange", function () {
    openHash(window.location.hash, false);
  });

  openHash(window.location.hash, false);
})();
