/* Alma AI — landing interactions (vanilla, no dependencies) */
(function () {
  "use strict";

  var root = document.documentElement;
  var isStatic = root.classList.contains("static");
  var finePointer = window.matchMedia && window.matchMedia("(pointer: fine)").matches;

  /* ---------- App URL for CTA buttons ---------- */
  function computeAppUrl() {
    if (window.ALMA_APP_URL) return String(window.ALMA_APP_URL).replace(/\/+$/, "");
    var host = location.hostname;
    if (!host || location.protocol === "file:" || host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:5173";
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return "http://" + host + ":5173";
    return "https://app." + host.replace(/^www\./, "");
  }

  var APP_URL = computeAppUrl();
  document.querySelectorAll("[data-app-link]").forEach(function (a) {
    var path = a.getAttribute("data-app-link") === "login" ? "/login" : "/register";
    a.setAttribute("href", APP_URL + path);
  });

  /* ---------- Footer year ---------- */
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  /* ---------- Header: blur on scroll + mobile menu ---------- */
  var header = document.querySelector(".site-header");
  var nav = document.getElementById("main-nav");
  var burger = document.querySelector(".burger");

  function onScrollHeader() {
    header.classList.toggle("scrolled", window.scrollY > 8);
  }
  onScrollHeader();
  window.addEventListener("scroll", onScrollHeader, { passive: true });

  function setMenu(open) {
    nav.classList.toggle("open", open);
    header.classList.toggle("menu-open", open);
    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
  }
  if (burger && nav) {
    burger.addEventListener("click", function () {
      setMenu(!nav.classList.contains("open"));
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setMenu(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("open")) {
        setMenu(false);
        burger.focus();
      }
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 960 && nav.classList.contains("open")) setMenu(false);
    });
  }

  /* ---------- FAQ accordion ---------- */
  var accItems = Array.prototype.slice.call(document.querySelectorAll(".acc-item"));
  function setAcc(item, open) {
    item.classList.toggle("open", open);
    item.querySelector(".acc-btn").setAttribute("aria-expanded", String(open));
  }
  accItems.forEach(function (item, i) {
    var btn = item.querySelector(".acc-btn");
    btn.addEventListener("click", function () {
      var willOpen = !item.classList.contains("open");
      accItems.forEach(function (other) {
        if (other !== item) setAcc(other, false);
      });
      setAcc(item, willOpen);
    });
    if (i === 0) setAcc(item, true);
  });

  /* ---------- Counters ---------- */
  function runCounter(el) {
    var to = parseInt(el.getAttribute("data-count"), 10);
    var from = parseInt(el.getAttribute("data-from") || "0", 10);
    if (isStatic) {
      el.textContent = String(to);
      return;
    }
    var duration = 1600;
    var start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(from + (to - from) * eased));
      if (t < 1) requestAnimationFrame(frame);
    }
    el.textContent = String(from);
    requestAnimationFrame(frame);
  }

  /* ---------- Scroll reveal ---------- */
  var revealEls = document.querySelectorAll("[data-reveal]");
  function reveal(el) {
    el.classList.add("in");
    el.querySelectorAll("[data-count]").forEach(runCounter);
  }

  if (isStatic || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) {
      el.classList.add("in");
    });
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            reveal(entry.target);
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.14, rootMargin: "0px 0px -6% 0px" }
    );
    revealEls.forEach(function (el) {
      io.observe(el);
    });
  }

  /* ---------- Steps timeline: line drawing on scroll ---------- */
  var steps = document.getElementById("steps");
  var progress = steps && steps.querySelector(".steps-progress");
  var stepItems = steps ? Array.prototype.slice.call(steps.querySelectorAll(".step")) : [];

  function updateSteps() {
    if (!steps || isStatic) return;
    var vh = window.innerHeight;
    var anchor = vh * 0.62;
    var rect = steps.getBoundingClientRect();
    var p = (anchor - rect.top) / rect.height;
    p = Math.max(0, Math.min(1, p));
    progress.style.setProperty("--p", p.toFixed(4));
    stepItems.forEach(function (step) {
      var num = step.querySelector(".step-num").getBoundingClientRect();
      step.classList.toggle("lit", num.top + num.height / 2 < anchor);
    });
  }

  var ticking = false;
  function onScrollSteps() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      updateSteps();
    });
  }
  if (!isStatic) {
    updateSteps();
    window.addEventListener("scroll", onScrollSteps, { passive: true });
    window.addEventListener("resize", onScrollSteps);
  }

  /* ---------- Spotlight cards ---------- */
  if (finePointer && !isStatic) {
    document.querySelectorAll(".spot").forEach(function (card) {
      card.addEventListener("pointermove", function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty("--x", e.clientX - r.left + "px");
        card.style.setProperty("--y", e.clientY - r.top + "px");
      });
    });
  }

  /* ---------- Magnetic buttons ---------- */
  if (finePointer && !isStatic) {
    document.querySelectorAll(".btn-magnetic").forEach(function (btn) {
      btn.addEventListener("pointermove", function (e) {
        var r = btn.getBoundingClientRect();
        var dx = (e.clientX - (r.left + r.width / 2)) * 0.18;
        var dy = (e.clientY - (r.top + r.height / 2)) * 0.3;
        btn.style.setProperty("--mx", Math.max(-8, Math.min(8, dx)) + "px");
        btn.style.setProperty("--my", Math.max(-6, Math.min(6, dy)) + "px");
      });
      btn.addEventListener("pointerleave", function () {
        btn.style.setProperty("--mx", "0px");
        btn.style.setProperty("--my", "0px");
      });
    });
  }

  /* ---------- Phone chat loop ---------- */
  var chat = document.getElementById("phone-chat");
  if (!chat || isStatic) return;

  var SCRIPT = [
    { type: "out", text: "Здравствуйте! Сколько стоит абонемент на месяц?", time: "23:47", pause: 700 },
    { type: "typing", pause: 1500 },
    {
      type: "in",
      text: "Добрый вечер! 👋 Безлимит на месяц — 18 000 ₸, утренний (до 16:00) — 12 000 ₸. Первое занятие бесплатно. Записать вас на пробное?",
      time: "23:47",
      pause: 2600
    },
    { type: "out", text: "Ертең кешкі 19:00-ге жазылуға бола ма?", time: "23:48", pause: 700 },
    { type: "typing", pause: 1500 },
    { type: "in", text: "Әрине! Ертең 19:00-ге сынақ жаттығуына жазып қойдым ✅ Атыңыз кім?", time: "23:48", pause: 2200 },
    { type: "out", text: "Айдана", time: "23:48", pause: 600 },
    { type: "typing", pause: 1300 },
    { type: "in", text: "Рахмет, Айдана! Менеджер таңертең растау жібереді 🙌", time: "23:48", pause: 1200 },
    { type: "sys", text: "Заявка передана менеджеру", pause: 4200 }
  ];

  var step = 0;
  var timer = null;
  var running = false;
  var typingEl = null;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function trim() {
    // Keep the DOM small: drop bubbles that have scrolled far out of view.
    while (chat.children.length > 9) chat.removeChild(chat.firstElementChild);
  }

  function render(item) {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
    if (item.type === "typing") {
      typingEl = el("div", "typing");
      typingEl.appendChild(el("i"));
      typingEl.appendChild(el("i"));
      typingEl.appendChild(el("i"));
      chat.appendChild(typingEl);
    } else if (item.type === "sys") {
      chat.appendChild(el("div", "sys-chip", item.text));
    } else {
      var msg = el("div", "msg " + item.type);
      msg.appendChild(el("p", null, item.text));
      msg.appendChild(el("time", null, item.time));
      if (item.type === "in") msg.appendChild(el("span", "ai-tag", "⚡ Alma AI"));
      chat.appendChild(msg);
    }
    trim();
  }

  function next() {
    if (!running) return;
    if (step >= SCRIPT.length) {
      chat.classList.add("fade-out");
      timer = setTimeout(function () {
        chat.classList.remove("fade-out");
        chat.textContent = "";
        step = 0;
        timer = setTimeout(next, 500);
      }, 700);
      return;
    }
    var item = SCRIPT[step++];
    render(item);
    timer = setTimeout(next, item.pause);
  }

  function start() {
    if (running) return;
    running = true;
    timer = setTimeout(next, 450);
  }

  function stop() {
    running = false;
    clearTimeout(timer);
  }

  chat.textContent = "";

  var phone = document.querySelector(".phone");
  if ("IntersectionObserver" in window && phone) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !document.hidden) start();
        else stop();
      });
    }, { threshold: 0.2 }).observe(phone);
  } else {
    start();
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else if (phone && phone.getBoundingClientRect().bottom > 0 && phone.getBoundingClientRect().top < window.innerHeight) start();
  });
})();
