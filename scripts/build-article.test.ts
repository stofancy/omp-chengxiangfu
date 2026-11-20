import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildArticle, SOURCE, TARGET } from "./build-article";

// 改了文章却忘了重新生成网页版，线上就会和 GitHub 上的 Markdown 对不上
test("docs/article.html 和文章的 Markdown 同步（不一致就跑 bun scripts/build-article.ts）", () => {
	expect(readFileSync(TARGET, "utf8")).toBe(buildArticle(readFileSync(SOURCE, "utf8")));
});
