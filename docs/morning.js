// 「一个上午，三件事」：主页和文章网页版共用的分步演示。挂在任何 [data-morning] 元素上，零依赖。
// 例子是构造的，用来说明流程；数字是示意，不是测量。
(() => {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

  // 节点：中心坐标、宽高、标题、小字；kind 决定样式
  const NODES = {
    U: { x: 80, y: 330, r: 34, t: "你", kind: "you" },
    M: { x: 280, y: 330, w: 150, h: 64, t: "主会话", s: "研判 · 转交 · 汇报" },
    T: { x: 280, y: 505, w: 150, h: 58, t: "任务表", s: "程序记账", kind: "store" },
    INB: { x: 280, y: 80, w: 150, h: 56, t: "收件箱", s: "谁 · 在哪 · 链接", kind: "store" },
    RCV: { x: 560, y: 80, w: 170, h: 56, t: "接收程序", s: "在会话之外 · 分拣" },
    LOG: { x: 560, y: 180, w: 150, h: 46, t: "分拣日志", s: "拦下的只记在这", kind: "log" },
    EXT: { x: 880, y: 105, w: 150, h: 130, t: "外部", lines: ["Slack 大频道", "thread", "PR"], kind: "ext" },
    A: { x: 590, y: 285, w: 170, h: 58, t: "负责 agent", s: "导出超时", kind: "owner" },
    B: { x: 590, y: 375, w: 170, h: 58, t: "负责 agent", s: "周报口径", kind: "owner" },
    C: { x: 590, y: 465, w: 170, h: 58, t: "负责 agent", s: "依赖升级", kind: "owner" },
    R: { x: 860, y: 375, w: 140, h: 58, t: "审查者", s: "没见过过程" },
  };

  // 连线：路径、标签位置
  const EDGES = {
    um: { d: "M114 330 L205 330", both: true, l: [160, 318, "说 · 回复"] },
    mt: { d: "M280 362 L280 476", l: [292, 425, "记账", "start"] },
    ma: { d: "M355 318 C420 290 450 285 505 285", l: [430, 280, "转交"] },
    mb: { d: "M355 330 C420 350 450 375 505 375" },
    mc: { d: "M355 342 C410 420 440 465 505 465" },
    mr: { d: "M340 298 C430 215 760 215 860 346", l: [760, 236, "派审查"] },
    rt: { d: "M860 404 C860 575 520 575 355 512", l: [640, 560, "记结论"] },
    ext: { d: "M805 82 L645 80", l: [725, 70, "有新消息"] },
    rl: { d: "M560 108 L560 157", l: [572, 138, "拦下", "start"] },
    ri: { d: "M475 80 L355 80", l: [415, 70, "写文件"] },
    im: { d: "M280 108 L280 298", l: [268, 210, "归位 · 叫醒", "end"] },
    ae: { d: "M675 285 C760 285 860 250 880 170", l: [818, 252, "回复"] },
    ce: { d: "M675 470 C985 470 985 250 935 170", l: [962, 330, "推分支", "end"] },
  };

  // 每一步：时间、标题、说明、亮起的节点、走的线、你的注意力花在哪、没有调度台时你要做什么
  // run：p 线，dir 方向，n 几个点，gap 点之间隔多久，at 什么时候出发，warm 是不是你的注意力
  const STEPS = [
    {
      time: "09:00",
      title: "一条消息，开三个任务",
      text: "你在主会话里说：开三个任务——修导出报表偶发的超时、核对周报的数据口径、升级一个依赖，各附上要盯的 thread 或 PR。主会话把三个任务记进任务表，各派一个负责 agent，回你一句谁在做。然后你去开会了。",
      on: "U M T A B C",
      run: [{ p: "um", warm: true }, { p: "mt", at: 900 }, { p: "ma", at: 900 }, { p: "mb", at: 900 }, { p: "mc", at: 900 }, { p: "um", dir: -1, warm: true, at: 2400 }],
      you: "发一条消息，开三个任务",
      without: "开三个会话，各讲一遍背景",
    },
    {
      time: "09:00 – 10:30",
      title: "三件事同时推进",
      text: "三个负责 agent 各干各的：查代码、改代码、跑数据。升级依赖的那个推了分支、开了 PR；推分支写在这个任务的白名单里，不用问你。",
      on: "A B C EXT",
      run: [{ p: "ce", at: 300 }],
      without: "在三个会话之间来回切，看谁卡住了",
    },
    {
      time: "10:10",
      title: "外面来了 24 条消息",
      text: "大频道里来了 22 条（其中 1 条 @你），导出超时的 thread 里同事回了一句，PR 上有一条评审意见。接收程序把每条写成谁、在哪、链接；大频道里不紧急的 21 条先让便宜的模型分拣，拦下 19 条，只记进分拣日志。送进收件箱的是 5 条。",
      on: "EXT RCV LOG INB",
      run: [{ p: "ext", n: 12, gap: 130 }, { p: "rl", n: 10, gap: 160, at: 700 }, { p: "ri", n: 5, gap: 260, at: 900 }],
      without: "翻完 22 条频道消息，刷两次 PR 页面",
    },
    {
      time: "10:11",
      title: "归到任务，交给各自的负责人",
      text: "thread 的回复归到导出超时，评审意见归到依赖升级，一条提到周报的频道消息归到周报口径：主会话分别转交给负责 agent。剩下两条——@你问会议时间的那条、一条全组通知——主会话记下，等你回来一起说。",
      on: "INB M A B C T",
      run: [{ p: "im" }, { p: "ma", at: 1000 }, { p: "mb", at: 1000 }, { p: "mc", at: 1000 }, { p: "mt", at: 1000 }],
      without: "找到对应的会话，把消息一条条贴进去",
    },
    {
      time: "10:40",
      title: "要你定的事，先登记，不打断",
      text: "周报的负责 agent 发现两种口径算出来差 3%，要你定用哪个。它交回主会话，主会话登记成一个编号提问，放进输入框上方的固定区。另外两件事照常推进，不等这个答案。",
      on: "B M T A C",
      run: [{ p: "mb", dir: -1 }, { p: "mt", at: 1100 }, { p: "ce", at: 600 }],
      without: "被叫回来回答，再切回去接着看别的",
    },
    {
      time: "11:20",
      title: "做完的，换一个 agent 审",
      text: "导出超时的负责 agent 补了改动，报整个任务做完。主会话派一个没见过过程的审查者：它自己重跑测试、对照完成判据，记下「通过」。依赖升级的负责 agent 按评审意见改完，又推了一次。",
      on: "A M R T C EXT",
      run: [{ p: "ma", dir: -1 }, { p: "mr", at: 1000 }, { p: "rt", at: 2300 }, { p: "ce", at: 400 }],
      without: "自己重跑测试，逐个验收",
    },
    {
      time: "11:30",
      title: "你回来：读一屏，回一行",
      text: "主会话先讲清你离开时的变化：导出超时已过审，依赖升级已按评审改完，@你的那条问的是会议时间，另有一条全组通知。然后两个编号提问：「1 周报用哪个口径？推荐：按自然周」「2 要不要在 thread 里回复同事、附上 PR？推荐：要」。你回「1 自然周 2 要」，程序记成两个决定，两个负责 agent 接着做。",
      on: "U M T A B EXT",
      run: [{ p: "um", dir: -1, warm: true }, { p: "um", warm: true, at: 1500 }, { p: "mt", at: 2600 }, { p: "mb", at: 2600 }, { p: "ma", at: 2600 }, { p: "ae", at: 3500 }],
      you: "读一屏，回「1 自然周 2 要」",
      without: "回 Slack、回 PR，把结果逐条转述",
    },
  ];

  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (parent) parent.append(n);
    return n;
  };
  const h = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  function drawSvg() {
    const svg = el("svg", { viewBox: "0 0 1000 600", class: "mn-svg", role: "img", "aria-label": "示意图：你、主会话、任务表、三个负责 agent、审查者、收件箱、接收程序、分拣日志和外部之间的流向" });
    const defs = el("defs", {}, svg);
    const marker = el("marker", { id: "mn-arr", viewBox: "0 0 10 10", refX: 8.6, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
    el("path", { d: "M1.2 1.4 L8.6 5 L1.2 8.6", class: "mn-arrow" }, marker);

    const bands = el("g", { class: "mn-bands", "aria-hidden": "true" }, svg);
    el("text", { x: 24, y: 30 }, bands).textContent = "输入线 · 在会话之外";
    el("line", { x1: 24, y1: 232, x2: 976, y2: 232 }, bands);
    el("text", { x: 24, y: 256 }, bands).textContent = "调度线 · 在会话之内";

    const edges = el("g", { class: "mn-edges" }, svg);
    const labels = el("g", { class: "mn-labels", "aria-hidden": "true" }, svg);
    const paths = {};
    for (const [id, e] of Object.entries(EDGES)) {
      const p = el("path", { d: e.d, class: "mn-edge", "marker-end": "url(#mn-arr)" }, edges);
      if (e.both) p.setAttribute("marker-start", "url(#mn-arr)");
      paths[id] = p;
      if (e.l) {
        const [x, y, text, anchor] = e.l;
        const t = el("text", { x, y, class: "mn-label", "text-anchor": anchor || "middle", "data-for": id }, labels);
        t.textContent = text;
      }
    }

    const nodes = el("g", { class: "mn-nodes" }, svg);
    const nodeEls = {};
    for (const [id, n] of Object.entries(NODES)) {
      const g = el("g", { class: `mn-node ${n.kind || ""}`.trim(), "data-node": id }, nodes);
      if (n.kind === "you") {
        el("circle", { cx: n.x, cy: n.y, r: n.r + 12, class: "halo" }, g);
        el("circle", { cx: n.x, cy: n.y, r: n.r, class: "core" }, g);
        el("text", { x: n.x, y: n.y + 6, class: "t", "text-anchor": "middle" }, g).textContent = n.t;
      } else {
        el("rect", { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h, rx: 10 }, g);
        if (n.lines) {
          el("text", { x: n.x, y: n.y - n.h / 2 + 30, class: "t", "text-anchor": "middle" }, g).textContent = n.t;
          n.lines.forEach((line, i) => {
            el("text", { x: n.x, y: n.y - n.h / 2 + 62 + i * 24, class: "s", "text-anchor": "middle" }, g).textContent = line;
          });
        } else {
          el("text", { x: n.x, y: n.y - 4, class: "t", "text-anchor": "middle" }, g).textContent = n.t;
          el("text", { x: n.x, y: n.y + 17, class: "s", "text-anchor": "middle" }, g).textContent = n.s;
        }
      }
      nodeEls[id] = g;
    }
    const tokens = el("g", { class: "mn-tokens" }, svg);
    return { svg, paths, nodeEls, labels, tokens };
  }

  function mount(root) {
    const N = STEPS.length;
    root.classList.add("mn");
    root.innerHTML = "";
    const stage = h('<div class="mn-stage"></div>');
    const { svg, paths, nodeEls, labels, tokens } = drawSvg();
    stage.append(svg);
    const panel = h(`
      <div class="mn-panel">
        <div class="mn-bar">
          <ol class="mn-dots" aria-label="步骤">${STEPS.map((s, i) => `<li><button type="button" aria-label="第 ${i + 1} 步：${s.title}">${i + 1}</button></li>`).join("")}</ol>
          <div class="mn-ctrl">
            <button type="button" data-act="prev">上一步</button>
            <button type="button" data-act="play" aria-pressed="false">自动播放</button>
            <button type="button" data-act="next">下一步</button>
          </div>
        </div>
        <div class="mn-body">
          <div class="mn-step" aria-live="polite">
            <p class="mn-time"><span class="mn-n"></span><span class="mn-clock"></span></p>
            <h3 class="mn-title"></h3>
            <p class="mn-text"></p>
          </div>
          <div class="mn-tally">
            <div class="mn-with"><p>你的注意力花在</p><ol></ol></div>
            <div class="mn-without"><p>没有调度台时，你还要</p><ol></ol></div>
          </div>
        </div>
      </div>`);
    const note = h('<p class="mn-note">构造的例子，用来说明流程；数字是示意，不是测量。</p>');
    root.append(stage, panel, note);

    const $ = (s) => panel.querySelector(s);
    const dots = [...panel.querySelectorAll(".mn-dots button")];
    const playBtn = $('[data-act="play"]');
    const withOl = $(".mn-with ol");
    const withoutOl = $(".mn-without ol");
    let cur = -1;
    let runId = 0;
    let playing = false;
    let timer = 0;

    const fly = (run, id) => new Promise((done) => {
      const path = paths[run.p];
      const len = path.getTotalLength();
      const dur = Math.max(650, len * 3.2);
      const n = run.n || 1;
      let left = n;
      path.classList.add("is-live");
      if (run.warm) path.classList.add("warm");
      for (let k = 0; k < n; k++) {
        setTimeout(() => {
          if (id !== runId) { if (--left === 0) done(); return; }
          const dot = el("circle", { r: n > 1 ? 3.6 : 5, class: `mn-token${run.warm ? " warm" : ""}` }, tokens);
          const t0 = performance.now();
          const tick = (now) => {
            if (id !== runId) { dot.remove(); if (--left === 0) done(); return; }
            const p = Math.min(1, (now - t0) / dur);
            const e = ease(p);
            const pt = path.getPointAtLength(((run.dir || 1) > 0 ? e : 1 - e) * len);
            dot.setAttribute("cx", pt.x);
            dot.setAttribute("cy", pt.y);
            if (p < 1) requestAnimationFrame(tick);
            else {
              dot.remove();
              if (--left === 0) {
                path.classList.remove("is-live");
                path.classList.add("is-done");
                done();
              }
            }
          };
          requestAnimationFrame(tick);
        }, (run.at || 0) + k * (run.gap || 0));
      }
    });

    const setPlay = (on) => {
      playing = on;
      playBtn.setAttribute("aria-pressed", String(on));
      playBtn.textContent = on ? "暂停" : "自动播放";
      if (!on) clearTimeout(timer);
    };

    const tally = () => {
      const upTo = STEPS.slice(0, cur + 1);
      withOl.innerHTML = "";
      withoutOl.innerHTML = "";
      for (const s of upTo) {
        if (s.you) withOl.append(h(`<li>${s.you}</li>`));
        if (s.without) withoutOl.append(h(`<li>${s.without}</li>`));
      }
      if (!withOl.children.length) withOl.append(h('<li class="none">还没有</li>'));
    };

    const show = async (i) => {
      clearTimeout(timer);
      cur = (i + N) % N;
      const id = ++runId;
      const s = STEPS[cur];
      tokens.textContent = "";
      $(".mn-n").textContent = `${cur + 1} / ${N}`;
      $(".mn-clock").textContent = s.time;
      $(".mn-title").textContent = s.title;
      $(".mn-text").textContent = s.text;
      const step = $(".mn-step");
      step.classList.remove("is-swap");
      void step.offsetWidth;
      step.classList.add("is-swap");
      dots.forEach((d, k) => {
        d.setAttribute("aria-current", k === cur ? "step" : "false");
        d.classList.toggle("is-past", k < cur);
      });
      const on = s.on.split(" ");
      for (const [k, n] of Object.entries(nodeEls)) n.classList.toggle("is-on", on.includes(k));
      for (const p of Object.values(paths)) p.classList.remove("is-live", "is-done", "warm");
      const used = new Set(s.run.map((r) => r.p));
      for (const l of labels.children) l.classList.toggle("is-on", used.has(l.dataset.for));
      tally();
      if (reduce) {
        for (const r of s.run) paths[r.p].classList.add("is-done", ...(r.warm ? ["warm"] : []));
        return;
      }
      await Promise.all(s.run.map((r) => fly(r, id)));
      if (id !== runId || !playing) return;
      if (cur === N - 1) setPlay(false);
      else timer = setTimeout(() => show(cur + 1), 2600);
    };

    $('[data-act="prev"]').addEventListener("click", () => { setPlay(false); show(cur - 1); });
    $('[data-act="next"]').addEventListener("click", () => { setPlay(false); show(cur + 1); });
    playBtn.addEventListener("click", () => {
      if (playing) { setPlay(false); return; }
      setPlay(true);
      show(cur >= N - 1 ? 0 : cur + 1);
    });
    dots.forEach((d, k) => d.addEventListener("click", () => { setPlay(false); show(k); }));
    root.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      setPlay(false);
      show(cur + (e.key === "ArrowRight" ? 1 : -1));
    });

    show(0);
    // 第一次滚到这里时自己播一遍
    if (!reduce && "IntersectionObserver" in window) {
      const io = new IntersectionObserver(([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        setPlay(true);
        show(0);
      }, { threshold: 0.4 });
      io.observe(root);
    }
  }

  document.querySelectorAll("[data-morning]").forEach(mount);
})();
