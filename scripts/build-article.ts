// 从文章的 Markdown 生成网页版 docs/article.html。Markdown 是唯一的源，HTML 生成后一起提交（Pages 直接发 /docs）。
// 零依赖，用 bun 自带的 Markdown 渲染：
//   bun scripts/build-article.ts
// 改了文章就重跑一次；测试会检查两者是否一致。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const SOURCE = join(ROOT, "docs", "注意力稀缺下的harness调度.md");
export const TARGET = join(ROOT, "docs", "article.html");

const REPO = "https://github.com/stofancy/omp-dispatch-desk";
const SOURCE_URL = `${REPO}/blob/main/docs/${encodeURIComponent("注意力稀缺下的harness调度.md")}`;
// 文章里指向本仓库其他文件的相对链接，网页版换成 GitHub 地址
const LINKS: Record<string, string> = { "../README.md": `${REPO}#readme` };
// 没有编号的章节给固定的锚点，方便从主页链过来
const NAMED_IDS: Record<string, string> = { 作者与致谢: "thanks", 参考: "refs" };

const strip = (html: string) => html.replace(/<[^>]+>/g, "");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function headingId(text: string, used: Set<string>): string {
	const num = text.match(/^(\d+(?:\.\d+)*)\.?\s/);
	const appendix = text.match(/^附录\s*([A-Z])/);
	let id = num ? `s-${num[1].replace(/\./g, "-")}` : appendix ? `appendix-${appendix[1].toLowerCase()}` : NAMED_IDS[text] ?? `h-${used.size + 1}`;
	while (used.has(id)) id += "-x";
	used.add(id);
	return id;
}

export function buildArticle(md: string): string {
	const title = md.match(/^# (.+)$/m)?.[1].trim() ?? "";
	const byline = md.match(/^# .+\n\n(.+)\n/)?.[1].trim() ?? "";
	// 标题和署名放进页头，正文从第一段开始
	const bodyMd = md.replace(/^# .+\n\n.+\n\n/, "");
	let html = Bun.markdown.html(bodyMd, { autolinks: true, tasklists: true, strikethrough: true });

	const used = new Set<string>();
	const toc: { level: number; id: string; text: string }[] = [];
	html = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_, level: string, inner: string) => {
		const text = strip(inner).trim();
		const id = headingId(text, used);
		toc.push({ level: Number(level), id, text });
		return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${level}>`;
	});

	let fig = 0;
	html = html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (_, src: string) => {
		fig += 1;
		return `<figure class="diagram" id="fig-${fig}"><pre class="mermaid-src" hidden>${src}</pre><div class="diagram-view" role="img" aria-label="图 ${fig}"><p class="diagram-wait">图 ${fig} 加载中…</p></div><figcaption><span>图 ${fig}</span><button type="button" class="zoom" aria-label="放大图 ${fig}">放大</button></figcaption></figure>`;
	});
	html = html.replace(/<table>([\s\S]*?)<\/table>/g, '<div class="table-wrap"><table>$1</table></div>');
	html = html.replace(/<!-- morning -->/g, '<div class="morning" data-morning><p>这里有一个分步演示，需要 JavaScript；文字版就是下面的列表。</p></div>');
	html = html.replace(/href="([^"]+)"/g, (all, href: string) => (LINKS[href] ? `href="${LINKS[href]}"` : all));
	html = html.replace(/<a href="(https?:\/\/[^"]+)"/g, (all, href: string) => (href.startsWith("https://stofancy.github.io/omp-dispatch-desk/") ? all : `<a href="${href}" rel="noopener"`));

	const chars = strip(html).replace(/\s/g, "").length;
	const minutes = Math.max(1, Math.round(chars / 500));
	const tocHtml = toc
		.map((t) => `<li class="l${t.level}"><a href="#${t.id}">${t.text}</a></li>`)
		.join("\n");

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- 这个文件由 scripts/build-article.ts 从 Markdown 生成，不要手改 -->
<title>${esc(title)} · 调度台</title>
<meta name="description" content="一个人同时推进几件事时，注意力花在派活验收和查看输入两条线上。这篇文章讲我们怎么把这两条线上的调度交给 harness，以及几天真实使用的初步数据。">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="article.css?v=1">
<link rel="stylesheet" href="morning.css?v=1">
<script src="morning.js?v=1" defer></script>
<script type="module" src="article.js?v=1"></script>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="gh-mark" viewBox="0 0 16 16"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></symbol></svg>
<a class="skip" href="#content">跳到正文</a>
<header class="topbar">
  <div class="topbar-in">
    <a class="brand" href="./">调度台 <span>omp-dispatch-desk</span></a>
    <nav aria-label="站点">
      <a href="./">主页</a>
      <a class="gh" href="${REPO}" rel="noopener" aria-label="GitHub 仓库"><svg width="20" height="20" aria-hidden="true"><use href="#gh-mark"/></svg></a>
    </nav>
  </div>
  <div class="progress" aria-hidden="true"><i></i></div>
</header>

<div class="layout">
  <aside class="toc" aria-label="目录">
    <details open>
      <summary>目录</summary>
      <ol>
${tocHtml}
      </ol>
    </details>
  </aside>

  <main id="content">
    <header class="post-head">
      <h1>${esc(title)}</h1>
      <p class="meta">${esc(byline)} · 约 ${minutes} 分钟读完 · <a href="${SOURCE_URL}" rel="noopener">在 GitHub 上看 Markdown 原文</a></p>
    </header>
    <article class="post">
${html}
    </article>
  </main>
</div>

<footer class="foot">
  <p>© 2026 stofancy · <a href="${REPO}/blob/main/LICENSE" rel="noopener">MIT License</a> · <a href="./">项目主页</a></p>
  <a class="gh" href="${REPO}" rel="noopener" aria-label="GitHub 仓库"><svg width="20" height="20" aria-hidden="true"><use href="#gh-mark"/></svg></a>
</footer>

<dialog class="zoom-dialog" aria-label="放大的图">
  <form method="dialog"><button class="close" aria-label="关闭">关闭</button></form>
  <div class="zoom-body"></div>
</dialog>
</body>
</html>
`;
}

if (import.meta.main) {
	writeFileSync(TARGET, buildArticle(readFileSync(SOURCE, "utf8")));
	console.log(`已生成 ${TARGET}`);
}
