// 调度台 · 项目主页的交互：滚动显现、数字滚动、首屏的注意力示意、跟着一条消息走一遍、界面示意、复盘循环。零依赖。
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const root = document.documentElement;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);

  root.classList.add("js");
  if (reduce) root.classList.add("reduce");

  /* ---------- 顶栏与阅读进度 ---------- */
  const topbar = $(".topbar");
  const progress = $(".progress span");
  const onScroll = () => {
    const y = window.scrollY;
    const max = root.scrollHeight - window.innerHeight;
    topbar.classList.toggle("is-scrolled", y > 24);
    if (progress) progress.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- 滚动显现，数字从 0 走到终值 ---------- */
  const countUp = (el) => {
    const raw = el.dataset.count;
    const to = Number(raw);
    const dec = (raw.split(".")[1] || "").length;
    if (reduce || !Number.isFinite(to)) return;
    const t0 = performance.now();
    const dur = 1500;
    el.textContent = (0).toFixed(dec);
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = (to * easeOut(p)).toFixed(dec);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const reveal = (el) => {
    el.classList.add("is-in");
    $$(".num[data-count]", el).forEach(countUp);
  };

  const watch = (els, fn, options) => {
    if (!("IntersectionObserver" in window)) {
      els.forEach(fn);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        fn(e.target);
      }
    }, options);
    els.forEach((el) => io.observe(el));
  };

  const revealAll = () => {
    const els = $$("[data-reveal]");
    if (reduce) els.forEach(reveal);
    else watch(els, reveal, { rootMargin: "0px 0px -10% 0px", threshold: 0.12 });
  };

  /* ---------- 首屏：注意力示意 ---------- */
  // 暖色的点是人的注意力，冷色的线是外部输入和交回。人自己调度时，每一条都打到人这里；
  // 交给调度台后，外圈先过滤一部分，再把一部分交给轨道上的负责 agent，只有少数要人定的才到中心。
  function field() {
    const canvas = $(".field");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const buttons = $$(".switch button");
    const readout = $("[data-readout]");
    const TAU = Math.PI * 2;

    let W = 0, H = 0, cx = 0, cy = 0, ring = 0, far = 0;
    let mode = "human";
    let deskA = 0;
    let pulse = 0;
    let strain = 0;
    let spawnAcc = 0;
    let t = 0;
    let userSet = false;
    let running = false;
    let raf = 0;
    let last = 0;
    let readT = 0;
    const parts = [];
    const sparks = [];
    const events = [];
    const owners = [0, 1, 2, 3].map((i) => ({ a: (i * TAU) / 4 + 0.55, pulse: 0 }));

    const size = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width;
      H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const wide = W >= 860;
      cx = wide ? W * 0.72 : W * 0.5;
      cy = wide ? H * 0.5 : H * 0.24;
      ring = Math.max(58, Math.min(W, H) * (wide ? 0.15 : 0.14));
      far = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) + 30;
    };

    const ownerPos = (o) => ({ x: cx + Math.cos(o.a) * ring * 1.85, y: cy + Math.sin(o.a) * ring * 1.85 });
    const nearestOwner = (x, y) => {
      let best = owners[0], d = Infinity;
      for (const o of owners) {
        const q = ownerPos(o);
        const dd = (q.x - x) ** 2 + (q.y - y) ** 2;
        if (dd < d) { d = dd; best = o; }
      }
      return best;
    };
    // 输入从四周的暗处浮现，越靠近中心越快
    const spawn = () => {
      const r = far * (0.42 + Math.random() * 0.62);
      parts.push({ a: Math.random() * TAU, r, pr: r, v: 78 + Math.random() * 72, curl: (Math.random() - 0.5) * 0.8, state: "in", warm: false, life: 1, age: 0, k: 0, x: 0, y: 0, sx: 0, sy: 0, o: null });
    };
    const log = (k) => events.push({ t, k });
    const hit = (p) => {
      log("hit");
      pulse = Math.min(1.6, pulse + (p.warm ? 0.9 : 0.5));
    };
    const decide = (p) => {
      p.r = ring;
      p.x = cx + Math.cos(p.a) * ring;
      p.y = cy + Math.sin(p.a) * ring;
      const roll = Math.random();
      if (roll < 0.66) {
        p.state = "fade";
        sparks.push({ x: p.x, y: p.y, life: 1 });
        log("filter");
      } else if (roll < 0.95) {
        p.state = "route";
        p.k = 0;
        p.sx = p.x;
        p.sy = p.y;
        p.o = nearestOwner(p.x, p.y);
      } else {
        p.state = "pass";
        p.warm = true;
      }
    };
    const recentHits = (sec) => events.filter((e) => e.k === "hit" && e.t >= t - sec).length;

    const step = (dt) => {
      t += dt;
      deskA += ((mode === "desk" ? 1 : 0) - deskA) * Math.min(1, dt * 2.4);
      spawnAcc += dt * 5.2;
      while (spawnAcc > 1) { spawn(); spawnAcc -= 1; }
      for (const o of owners) {
        o.a += dt * 0.05;
        o.pulse *= Math.exp(-dt * 2.4);
      }
      pulse *= Math.exp(-dt * (mode === "human" ? 3.2 : 1.5));
      strain += ((mode === "human" ? recentHits(3) / 9 : 0) - strain) * Math.min(1, dt * 1.5);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.age += dt;
        if (p.state === "in" || p.state === "pass") {
          p.pr = p.r;
          p.r -= p.v * dt * (1 + 0.7 * (1 - p.r / far));
          if (p.state === "in") p.a += p.curl * dt * (p.r / far);
          if (p.state === "in" && mode === "desk" && deskA > 0.5 && p.pr > ring && p.r <= ring) decide(p);
          if (p.state === "in" || p.state === "pass") {
            if (p.r <= 7) { hit(p); parts.splice(i, 1); continue; }
            p.x = cx + Math.cos(p.a) * p.r;
            p.y = cy + Math.sin(p.a) * p.r;
          }
        } else if (p.state === "route") {
          p.k = Math.min(1, p.k + dt / 0.95);
          const e = easeInOut(p.k);
          const q = ownerPos(p.o);
          p.x = p.sx + (q.x - p.sx) * e;
          p.y = p.sy + (q.y - p.sy) * e;
          if (p.k >= 1) { p.o.pulse = 1; log("route"); parts.splice(i, 1); }
        } else if (p.state === "fade") {
          p.life -= dt / 0.7;
          if (p.life <= 0) parts.splice(i, 1);
        }
      }
      for (let i = sparks.length - 1; i >= 0; i--) {
        sparks[i].life -= dt / 0.6;
        if (sparks[i].life <= 0) sparks.splice(i, 1);
      }
      while (events.length && events[0].t < t - 12) events.shift();
    };

    const glow = (x, y, r, rgb, a) => {
      if (r <= 0 || a <= 0) return;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    };
    const dot = (x, y, r, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    };
    const COLD = "136,197,217";
    const WARM = "230,181,107";

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      // 背景的几圈：注意力的半径
      ctx.lineWidth = 1;
      for (const [k, a] of [[0.55, 0.05], [2.7, 0.035], [3.9, 0.026], [5.3, 0.018]]) {
        ctx.strokeStyle = `rgba(148,178,216,${a})`;
        ctx.beginPath();
        ctx.arc(cx, cy, ring * k, 0, TAU);
        ctx.stroke();
      }
      // 调度台：一圈细环，外面是负责 agent 的轨道
      if (deskA > 0.01) {
        ctx.strokeStyle = `rgba(${COLD},${0.42 * deskA})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cy, ring, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([2, 7]);
        ctx.strokeStyle = `rgba(${COLD},${0.18 * deskA})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, ring * 1.85, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        for (const o of owners) {
          const q = ownerPos(o);
          glow(q.x, q.y, 12 + o.pulse * 16, COLD, (0.16 + o.pulse * 0.32) * deskA);
          dot(q.x, q.y, 3 + o.pulse * 1.4, `rgba(170,220,236,${0.9 * deskA})`);
        }
      }
      // 输入和交回：带一段尾迹
      for (const p of parts) {
        const near = 1 - Math.min(1, p.r / far);
        const fadeIn = Math.min(1, p.age / 0.9);
        const alpha = fadeIn * (p.state === "fade" ? 0.55 * p.life : p.state === "route" ? 0.7 : Math.min(0.85, 0.2 + 0.7 * near));
        let tx, ty;
        if (p.state === "route") {
          tx = p.x + (p.sx - p.x) * 0.35;
          ty = p.y + (p.sy - p.y) * 0.35;
        } else {
          const tail = 16 + p.v * 0.14;
          const ta = p.a - p.curl * 0.03;
          tx = cx + Math.cos(ta) * (p.r + tail);
          ty = cy + Math.sin(ta) * (p.r + tail);
        }
        const rgb = p.warm ? WARM : COLD;
        const g = ctx.createLinearGradient(tx, ty, p.x, p.y);
        g.addColorStop(0, `rgba(${rgb},0)`);
        g.addColorStop(1, `rgba(${rgb},${alpha})`);
        ctx.strokeStyle = g;
        ctx.lineWidth = p.warm ? 1.7 : 1.1;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        dot(p.x, p.y, p.warm ? 1.9 : 1.3, `rgba(${p.warm ? "244,206,146" : "190,230,242"},${alpha})`);
      }
      for (const s of sparks) glow(s.x, s.y, 4 + 10 * (1 - s.life), COLD, 0.4 * s.life);
      // 人：一个暖色的点；自己调度时会被打得发颤
      const j = strain > 0.03 ? strain * 2.6 : 0;
      const x = cx + (Math.random() - 0.5) * j;
      const y = cy + (Math.random() - 0.5) * j;
      const R0 = 30 + pulse * 26;
      glow(x, y, R0 * 2.4, WARM, 0.08 + pulse * 0.08);
      glow(x, y, R0, WARM, 0.2 + pulse * 0.2);
      dot(x, y, 5 + pulse * 1.4, "rgb(244,208,150)");
    };

    const describe = () => {
      if (!readout) return;
      const since = t - 10;
      const n = (k) => events.filter((e) => e.t >= since && e.k === k).length;
      if (reduce) {
        readout.innerHTML = mode === "human"
          ? "人自己调度：每一条输入和交回都直接到你这里。"
          : "交给调度台：大部分在外圈被过滤，或交给负责 agent；只有<b>要你定的</b>才到你这里。";
        return;
      }
      readout.innerHTML = mode === "human"
        ? `最近 10 秒，到你这里的：<b>${n("hit")}</b> 条`
        : `最近 10 秒：到你这里的 <b>${n("hit")}</b> 条 · 交给负责 agent <i>${n("route")}</i> 条 · 过滤 <i>${n("filter")}</i> 条`;
    };

    // 不要动效时：画一张不动的图
    const drawStatic = () => {
      parts.length = 0;
      sparks.length = 0;
      deskA = mode === "desk" ? 1 : 0;
      pulse = mode === "human" ? 1.2 : 0.35;
      strain = 0;
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 48; i++) {
        const a = rnd() * TAU;
        const r = mode === "desk" ? ring + 8 + rnd() * (far - ring) : 12 + rnd() * far;
        parts.push({ a, r, pr: r, v: 60, curl: 0, state: "in", warm: false, life: 1, age: 9, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      }
      if (mode === "desk") {
        const a = rnd() * TAU, r = ring * 0.6;
        parts.push({ a, r, pr: r, v: 60, curl: 0, state: "pass", warm: true, life: 1, age: 9, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      }
      draw();
      describe();
    };

    const frame = (now) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      step(dt);
      draw();
      readT += dt;
      if (readT > 0.5) { readT = 0; describe(); }
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (running || reduce) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const setMode = (m, byUser) => {
      if (byUser) userSet = true;
      if (m === mode) return;
      mode = m;
      events.length = 0; // 换了状态从头数，不把上一种状态的计数带过来
      buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
      if (reduce) drawStatic();
      else describe();
    };
    buttons.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode, true)));

    size();
    window.addEventListener("resize", () => {
      size();
      if (reduce) drawStatic();
    });

    if (reduce) {
      drawStatic();
    } else {
      // 先在后台跑几秒，打开页面时画面里已经有东西在流动
      for (let i = 0; i < 420; i++) step(1 / 60);
      events.length = 0;
      const hero = $(".hero");
      if ("IntersectionObserver" in window) {
        new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? start() : stop())).observe(hero);
      } else start();
      document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
      setTimeout(() => { if (!userSet) setMode("desk"); }, 4800);
    }
    requestAnimationFrame(() => canvas.classList.add("is-ready"));
  }

  /* ---------- 跟着一条消息走一遍 ---------- */
  function flow() {
    const svg = $(".flow-svg");
    const list = $$(".flow-list > li");
    if (!svg || !list.length) return;
    const steps = list.map((li) => ({
      title: $("h3", li).textContent,
      text: $("p", li).textContent,
      on: (li.dataset.on || "").split(/\s+/).filter(Boolean),
      run: (li.dataset.run || "").split(/\s+/).filter(Boolean).map((s) => {
        const [id, dir, tone] = s.split(":");
        return { path: svg.querySelector(`#${id}`), dir: Number(dir || 1), warm: tone === "warm" };
      }),
      you: li.dataset.you || "",
    }));
    const nodes = $$(".node", svg);
    const edges = $$(".edge", svg);
    const labels = $$(".elabel", svg);
    const token = $(".token", svg);
    const halo = $(".token-halo", svg);
    const box = $(".flow-step");
    const nEl = $("[data-flow-n]");
    const tEl = $("[data-flow-title]");
    const xEl = $("[data-flow-text]");
    const youEl = $("[data-flow-you]");
    const dots = $$(".flow-dots button");
    const playBtn = $('[data-flow="play"]');
    let cur = -1;
    let runId = 0;
    let playing = false;
    let timer = 0;

    const hideToken = () => {
      token.style.opacity = "0";
      halo.style.opacity = "0";
    };
    // 窄屏上图比屏幕宽，只能横向滚动：让视口跟着消息走
    const stage = $(".flow-stage");
    const follow = (x) => {
      const over = stage.scrollWidth - stage.clientWidth;
      if (over <= 0) return;
      const k = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
      stage.scrollLeft = Math.max(0, Math.min(over, x * k - stage.clientWidth / 2));
    };
    const travel = (path, dir, warm, id) => new Promise((done) => {
      const len = path.getTotalLength();
      const dur = Math.max(700, len * 3.4);
      const t0 = performance.now();
      token.classList.toggle("warm", warm);
      halo.classList.toggle("warm", warm);
      token.style.opacity = "1";
      halo.style.opacity = "0.55";
      const tick = (now) => {
        if (id !== runId) return done();
        const p = Math.min(1, (now - t0) / dur);
        const pt = path.getPointAtLength((dir > 0 ? easeInOut(p) : 1 - easeInOut(p)) * len);
        token.setAttribute("cx", pt.x);
        token.setAttribute("cy", pt.y);
        halo.setAttribute("cx", pt.x);
        halo.setAttribute("cy", pt.y);
        follow(pt.x);
        if (p < 1) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });

    const setPlay = (on) => {
      playing = on;
      playBtn.setAttribute("aria-pressed", String(on));
      playBtn.textContent = on ? "暂停" : "自动播放";
      if (!on) clearTimeout(timer);
    };

    const show = async (i) => {
      clearTimeout(timer);
      cur = (i + steps.length) % steps.length;
      const id = ++runId;
      const s = steps[cur];
      nEl.textContent = String(cur + 1);
      tEl.textContent = s.title;
      xEl.textContent = s.text;
      box.classList.remove("is-swap");
      void box.offsetWidth;
      box.classList.add("is-swap");
      dots.forEach((d, k) => {
        d.setAttribute("aria-current", k === cur ? "step" : "false");
        d.classList.toggle("is-past", k < cur);
      });
      nodes.forEach((n) => n.classList.toggle("is-on", s.on.includes(n.dataset.node)));
      edges.forEach((e) => e.classList.remove("is-live", "is-done", "warm"));
      const ids = s.run.map((r) => r.path && r.path.id);
      labels.forEach((l) => l.classList.toggle("is-on", ids.includes(l.dataset.for)));
      const spent = steps.slice(0, cur + 1).filter((x) => x.you);
      youEl.innerHTML = "";
      if (!spent.length) youEl.insertAdjacentHTML("beforeend", '<li class="none">还没有</li>');
      for (const x of spent) {
        const li = document.createElement("li");
        li.textContent = x.you;
        youEl.append(li);
      }
      hideToken();
      if (reduce) {
        for (const r of s.run) if (r.path) r.path.classList.add("is-done", ...(r.warm ? ["warm"] : []));
        const first = s.run.find((r) => r.path);
        if (first) follow(first.path.getPointAtLength(first.path.getTotalLength() / 2).x);
        return;
      }
      for (const r of s.run) {
        if (id !== runId) return;
        if (!r.path) continue;
        r.path.classList.add("is-live");
        r.path.classList.toggle("warm", r.warm);
        await travel(r.path, r.dir, r.warm, id);
        if (id !== runId) return;
        r.path.classList.remove("is-live");
        r.path.classList.add("is-done");
      }
      hideToken();
      if (!playing) return;
      if (cur === steps.length - 1) setPlay(false);
      else timer = setTimeout(() => show(cur + 1), 2400);
    };

    $('[data-flow="prev"]').addEventListener("click", () => { setPlay(false); show(cur - 1); });
    $('[data-flow="next"]').addEventListener("click", () => { setPlay(false); show(cur + 1); });
    playBtn.addEventListener("click", () => {
      if (playing) { setPlay(false); return; }
      setPlay(true);
      show(cur >= steps.length - 1 ? 0 : cur + 1);
    });
    dots.forEach((d, k) => d.addEventListener("click", () => { setPlay(false); show(k); }));
    $(".flow").addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      setPlay(false);
      show(cur + (e.key === "ArrowRight" ? 1 : -1));
    });

    show(0);
    if (!reduce) {
      // 第一次滚到这里时自己播一遍
      watch([$(".flow")], () => { setPlay(true); show(0); }, { threshold: 0.45 });
    }
  }

  /* ---------- 做法：踩过的坑 ---------- */
  function pits() {
    $$(".acard .pit-btn").forEach((b) => b.addEventListener("click", () => {
      const card = b.closest(".acard");
      const open = !card.classList.contains("open");
      card.classList.toggle("open", open);
      b.setAttribute("aria-expanded", String(open));
    }));
  }

  /* ---------- 界面示意 ---------- */
  function term() {
    const box = $(".term");
    if (!box) return;
    const typed = $(".typed", box);
    const log = $(".term-log", box);
    const q = $(".fx.q", box);
    const chips = $(".chips", box);
    const again = $("[data-term-reset]", box);
    let busy = false;

    const answer = async (text, yes) => {
      if (busy) return;
      busy = true;
      chips.hidden = true;
      for (const ch of text) {
        typed.textContent += ch;
        await sleep(reduce ? 0 : 120);
      }
      await sleep(reduce ? 0 : 420);
      typed.textContent = "";
      const lines = [
        ["tl you", `› ${text}`],
        // 和插件的真实标头一致：交给了负责 agent 就是「交出」，没交出去就是「回答」
        ["tl head", yes ? "━━━ 📤 交出 · 导出超时 ━━━" : "━━━ 💬 回答 ━━━"],
        ["tl", yes ? "记下了：回复同事。已交给负责 agent，去 thread 里回复并附上 PR 链接。" : "记下了：先不回复。任务照常收尾。"],
      ];
      for (const [cls, s] of lines) {
        const p = document.createElement("p");
        p.className = cls;
        p.textContent = s;
        log.append(p);
        await sleep(reduce ? 0 : 260);
      }
      q.classList.add("is-gone");
      again.hidden = false;
      busy = false;
    };
    $$(".chips .chip", box).forEach((c) => c.addEventListener("click", () => answer(c.dataset.answer, c.dataset.yes === "1")));
    again.addEventListener("click", () => {
      log.textContent = "";
      q.classList.remove("is-gone");
      chips.hidden = false;
      again.hidden = true;
    });

    // 右边的说明和界面里的那一块对上
    $$(".pin").forEach((p) => {
      const target = $(`[data-pin="${p.dataset.for}"]`, box);
      if (!target) return;
      const on = () => target.classList.add("is-lit");
      const off = () => target.classList.remove("is-lit");
      p.addEventListener("mouseenter", on);
      p.addEventListener("mouseleave", off);
      p.addEventListener("focus", on);
      p.addEventListener("blur", off);
    });
  }

  /* ---------- 复盘循环 ---------- */
  function loop() {
    const svg = $(".loop-svg");
    const items = $$(".loop-list > li");
    if (!svg || !items.length) return;
    const NS = "http://www.w3.org/2000/svg";
    const N = items.length;
    const C = 280;
    const R = 190;
    const STEP = (Math.PI * 2) / N;
    const g = $(".loop-nodes", svg);
    const arc = $(".loop-arc", svg);
    const box = $(".loop-detail");
    const kEl = $("[data-loop-k]");
    const tEl = $("[data-loop-title]");
    const xEl = $("[data-loop-text]");
    const ang = (u) => -Math.PI / 2 + u * STEP;
    let cur = 0;
    let shown = 0;
    let raf = 0;
    let auto = !reduce;
    let resume = 0;
    let visible = false;

    const nodes = items.map((li, i) => {
      const a = ang(i);
      const n = document.createElementNS(NS, "g");
      n.setAttribute("class", "loop-node");
      n.setAttribute("tabindex", "0");
      n.setAttribute("role", "button");
      n.setAttribute("aria-label", li.dataset.k);
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", String(C + Math.cos(a) * R));
      c.setAttribute("cy", String(C + Math.sin(a) * R));
      c.setAttribute("r", "6");
      const tx = document.createElementNS(NS, "text");
      const cos = Math.cos(a);
      tx.setAttribute("x", String(C + cos * (R + 26)));
      tx.setAttribute("y", String(C + Math.sin(a) * (R + 26) + 6));
      tx.setAttribute("text-anchor", Math.abs(cos) < 0.25 ? "middle" : cos > 0 ? "start" : "end");
      tx.textContent = li.dataset.k;
      n.append(c, tx);
      g.append(n);
      const pick = () => select(i, true);
      n.addEventListener("click", pick);
      n.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
      });
      return n;
    });

    const arcTo = (u) => {
      if (u <= 0.001) { arc.setAttribute("d", ""); return; }
      if (u >= N - 0.001) {
        arc.setAttribute("d", `M ${C} ${C - R} A ${R} ${R} 0 1 1 ${C - 0.01} ${C - R}`);
        return;
      }
      const a = ang(u);
      const large = u * STEP > Math.PI ? 1 : 0;
      arc.setAttribute("d", `M ${C} ${C - R} A ${R} ${R} 0 ${large} 1 ${C + Math.cos(a) * R} ${C + Math.sin(a) * R}`);
    };
    const moveArc = (i) => {
      cancelAnimationFrame(raf);
      const from = shown;
      const to = i === 0 && shown > 0 ? N : i; // 回到开头：先把这一圈画满
      if (reduce) { shown = i; arcTo(i); return; }
      const t0 = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / 1000);
        shown = from + (to - from) * easeOut(p);
        arcTo(shown);
        if (p < 1) raf = requestAnimationFrame(tick);
        else if (to === N) { shown = 0; arcTo(0); }
      };
      raf = requestAnimationFrame(tick);
    };
    const select = (i, byUser) => {
      cur = i;
      nodes.forEach((n, k) => n.classList.toggle("is-on", k === i));
      kEl.textContent = `第 ${i + 1} 步 / ${N}`;
      tEl.textContent = items[i].dataset.k;
      xEl.textContent = items[i].textContent.trim();
      box.classList.remove("is-swap");
      void box.offsetWidth;
      box.classList.add("is-swap");
      moveArc(i);
      if (byUser) {
        auto = false;
        clearTimeout(resume);
        resume = setTimeout(() => { auto = !reduce; }, 15000);
      }
    };

    select(0, false);
    if (!reduce) {
      if ("IntersectionObserver" in window) {
        new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0.3 }).observe(svg);
      } else visible = true;
      setInterval(() => { if (auto && visible && !document.hidden) select((cur + 1) % N, false); }, 3800);
    }
  }

  /* ---------- 交回：49 次送到 48 次 ---------- */
  function ticks() {
    const box = $(".ticks");
    if (!box) return;
    for (let i = 0; i < 49; i++) {
      const el = document.createElement("i");
      if (i === 37) el.className = "miss";
      el.style.transitionDelay = `${(reduce ? 0 : i * 0.025).toFixed(3)}s`;
      box.append(el);
    }
  }

  // 「11 / 19」那组点一个个出来
  if (!reduce) $$(".trial .dots i").forEach((d, i) => { d.style.transitionDelay = `${(i * 0.06).toFixed(2)}s`; });

  ticks();
  field();
  flow();
  pits();
  term();
  loop();
  revealAll();
})();
