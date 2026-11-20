// 文章网页版：按需渲染 mermaid 图、放大看图、目录高亮、阅读进度
const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs";
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const font = getComputedStyle(document.body).fontFamily;

// 两套配色：冷色给系统，暖色只给人的注意力，和主页一致
function theme() {
  const d = dark.matches;
  // scale：思维导图、时间线按分支轮换的底色，字一律用正文色
  const c = d
    ? { bg: "#151b23", node: "#1b2633", border: "#5d8fa3", text: "#e6edf3", muted: "#9198a1", line: "#7d8b99", accent: "#88c5d9", warm: "#e6b56b", soft: "#20303d", note: "#2d2615", noteBorder: "#8a6a32", scale: ["#1f4152", "#4a3a1c", "#283746", "#1d3a3a"] }
    : { bg: "#f6f8fa", node: "#ffffff", border: "#6f9fb3", text: "#1f2328", muted: "#59636e", line: "#8a96a3", accent: "#1f6f8b", warm: "#b7791f", soft: "#e8f2f6", note: "#fdf5e6", noteBorder: "#d9b26f", scale: ["#d7eaf1", "#f5e3c4", "#e3e8ee", "#d9ece6"] };
  const scale = (name, f) => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${name}${i}`, f(i)]));
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: font,
    themeVariables: {
      darkMode: d,
      fontFamily: font,
      fontSize: "15px",
      background: c.bg,
      primaryColor: c.node,
      primaryBorderColor: c.border,
      primaryTextColor: c.text,
      secondaryColor: c.soft,
      secondaryBorderColor: c.border,
      secondaryTextColor: c.text,
      tertiaryColor: c.bg,
      tertiaryBorderColor: c.border,
      tertiaryTextColor: c.text,
      lineColor: c.line,
      textColor: c.text,
      mainBkg: c.node,
      nodeBorder: c.border,
      clusterBkg: c.soft,
      clusterBorder: c.border,
      titleColor: c.text,
      edgeLabelBackground: c.bg,
      noteBkgColor: c.note,
      noteBorderColor: c.noteBorder,
      noteTextColor: c.text,
      actorBkg: c.node,
      actorBorder: c.border,
      actorTextColor: c.text,
      actorLineColor: c.line,
      signalColor: c.text,
      signalTextColor: c.text,
      labelBoxBkgColor: c.soft,
      labelBoxBorderColor: c.border,
      labelTextColor: c.text,
      loopTextColor: c.text,
      activationBkgColor: c.soft,
      sequenceNumberColor: c.bg,
      pie1: c.accent,
      pie2: c.warm,
      pieStrokeColor: c.bg,
      pieOuterStrokeColor: c.border,
      pieTitleTextColor: c.text,
      pieSectionTextColor: d ? "#0d1117" : "#ffffff",
      pieOpacity: "0.9",
      pieLegendTextColor: c.text,
      quadrant1Fill: c.soft,
      quadrant2Fill: c.bg,
      quadrant3Fill: c.bg,
      quadrant4Fill: c.bg,
      quadrant1TextFill: c.text,
      quadrant2TextFill: c.muted,
      quadrant3TextFill: c.muted,
      quadrant4TextFill: c.muted,
      quadrantPointFill: c.accent,
      quadrantPointTextFill: c.text,
      quadrantXAxisTextFill: c.text,
      quadrantYAxisTextFill: c.text,
      quadrantInternalBorderStrokeFill: c.border,
      quadrantExternalBorderStrokeFill: c.border,
      quadrantTitleFill: c.text,
      xyChart: {
        backgroundColor: c.bg,
        titleColor: c.text,
        xAxisLabelColor: c.text,
        xAxisTitleColor: c.muted,
        xAxisTickColor: c.line,
        xAxisLineColor: c.line,
        yAxisLabelColor: c.text,
        yAxisTitleColor: c.muted,
        yAxisTickColor: c.line,
        yAxisLineColor: c.line,
        plotColorPalette: c.accent,
      },
      ...scale("cScale", (i) => c.scale[i % c.scale.length]),
      ...scale("cScaleLabel", () => c.text),
      ...scale("cScalePeer", () => c.border),
      git0: c.accent,
    },
    // 思维导图的根节点默认是实心强调色配浅色字，看不清；改成和其他节点同一套
    themeCSS: `.mindmap-node.section-root circle, .mindmap-node.section-root rect, .mindmap-node.section-root path { fill: ${c.node}; stroke: ${c.accent}; stroke-width: 1.5px; } .mindmap-node.section-root text, .mindmap-node.section-root .nodeLabel, .mindmap-node.section-root span { fill: ${c.text}; color: ${c.text}; }`,
    flowchart: { curve: "basis", padding: 14, nodeSpacing: 44, rankSpacing: 52, htmlLabels: true },
    sequence: { mirrorActors: false, messageMargin: 34, boxMargin: 8, noteMargin: 12, actorMargin: 60, messageFontSize: 15, actorFontSize: 15, noteFontSize: 14 },
    xyChart: { width: 720, height: 380 },
    quadrantChart: { chartWidth: 560, chartHeight: 460, pointLabelFontSize: 13 },
    mindmap: { padding: 14 },
    timeline: { disableMulticolor: false },
  };
}

let mermaidP = null;
const loadMermaid = () => {
  mermaidP ??= import(MERMAID).then((m) => m.default);
  return mermaidP;
};

let seq = 0;
async function render(fig) {
  const view = fig.querySelector(".diagram-view");
  const src = fig.querySelector(".mermaid-src").textContent;
  try {
    const mermaid = await loadMermaid();
    mermaid.initialize(theme());
    const { svg } = await mermaid.render(`mmd-${++seq}`, src);
    view.innerHTML = svg;
    fig.dataset.rendered = "1";
  } catch (err) {
    view.innerHTML = "";
    const p = document.createElement("p");
    p.className = "diagram-error";
    p.textContent = `图没能渲染出来（${err?.message ?? err}）。原文：\n${src}`;
    view.append(p);
  }
}

// 只渲染滚到附近的图，首屏不为后面二十张图付出代价
const figs = [...document.querySelectorAll("figure.diagram")];
const queue = [];
let busy = false;
const pump = async () => {
  if (busy) return;
  busy = true;
  while (queue.length) await render(queue.shift());
  busy = false;
};
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    io.unobserve(e.target);
    queue.push(e.target);
  }
  pump();
}, { rootMargin: "900px 0px" });
figs.forEach((f) => io.observe(f));

// 系统切换深浅色时，已经渲染的图重画一遍
dark.addEventListener("change", () => {
  for (const f of figs) if (f.dataset.rendered) queue.push(f);
  pump();
});

// 放大看图
const dialog = document.querySelector(".zoom-dialog");
const zoomBody = dialog.querySelector(".zoom-body");
const openZoom = (fig) => {
  const svg = fig.querySelector(".diagram-view svg");
  if (!svg) return;
  zoomBody.innerHTML = "";
  zoomBody.append(svg.cloneNode(true));
  dialog.showModal();
};
for (const f of figs) {
  f.querySelector(".zoom").addEventListener("click", () => openZoom(f));
  f.querySelector(".diagram-view").addEventListener("click", () => openZoom(f));
}
dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });

// 目录：窄屏默认收起；高亮当前读到的章节
const toc = document.querySelector(".toc details");
if (window.matchMedia("(max-width: 1100px)").matches) toc.open = false;
const links = new Map([...document.querySelectorAll(".toc a")].map((a) => [a.getAttribute("href").slice(1), a]));
const heads = [...document.querySelectorAll(".post h2[id], .post h3[id]")];
let active = null;
const markActive = () => {
  const y = 90;
  let cur = heads[0];
  for (const h of heads) {
    if (h.getBoundingClientRect().top - y > 0) break;
    cur = h;
  }
  const a = links.get(cur.id);
  if (a === active) return;
  active?.classList.remove("is-active");
  a?.classList.add("is-active");
  active = a;
  if (a && toc.open && getComputedStyle(toc.parentElement).position === "sticky") a.scrollIntoView({ block: "nearest" });
};

// 阅读进度
const bar = document.querySelector(".progress i");
let ticking = false;
const onScroll = () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
    markActive();
    ticking = false;
  });
};
addEventListener("scroll", onScroll, { passive: true });
onScroll();
