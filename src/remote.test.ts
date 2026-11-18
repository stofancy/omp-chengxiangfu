import { expect, test } from "bun:test";
import { commands, remoteWrite } from "./remote";

const bash = (command: string) => remoteWrite("bash", { command });

test("只读的 gh api / curl，同一行后面别的命令带 -f、-F、-d 不算远端写入", () => {
	expect(bash(`gh api repos/o/r/pulls/32/reviews -q '.[] | select(.id==1) | .body' > /tmp/rv.txt; for q in "a" "b"; do grep -c -F "$q" /tmp/rv.txt; done`)).toBeUndefined();
	expect(bash("gh api repos/o/r/pulls/32/comments && tail -f log.txt")).toBeUndefined();
	expect(bash("curl -s https://example.com/status | jq -r .state; rm -f /tmp/x; cut -d , -f 1 a.csv")).toBeUndefined();
});

test("写入照样认得出：带方法的、带字段的、带数据的；引号里和 $( ) 里的 | ; & 不打断", () => {
	expect(bash("gh api -X POST repos/o/r/issues/1/comments -f body=hi")).toStartWith("gh api write");
	expect(bash("cd /tmp && gh api repos/o/r/pulls/3/reviews -f event=COMMENT -f body=ok")).toStartWith("gh api write");
	expect(bash('gh api -H "X: $(echo a | tr a b)" repos/o/r/issues/1/comments -f body=hi')).toStartWith("gh api write");
	expect(bash('curl -s "https://example.com/api?a=1&b=2" -d \'{"x":1}\'')).toStartWith("curl write");
	expect(bash('curl "https://example.com/api?a=1;b=2" -d x=1')).toStartWith("curl write");
	expect(bash(`curl -s -H "Authorization: Bearer $(cat tok.json | jq -r .t)" -d '{"a":1}' https://example.com/api`)).toStartWith("curl write");
	expect(bash("curl -s --request DELETE https://example.com/api/item/1")).toStartWith("curl write");
	expect(bash("az group show -n a; az group delete -n a")).toStartWith("az write");
	expect(bash("cd repo && git push origin feature")).toStartWith("git push");
});

test("拆简单命令：引号、$( )、( ) 里面的分隔符不算；引号没配上时后面整段算一条", () => {
	expect(commands(`a 'x | y' | b "p; q $(c | d)" ; e && f`).map(s => s.trim()).filter(Boolean)).toEqual([`a 'x | y'`, `b "p; q $(c | d)"`, "e", "& f"]);
	expect(commands(`echo "it's fine" | wc -l`).map(s => s.trim())).toEqual([`echo "it's fine"`, "wc -l"]);
	expect(commands("echo don't | wc; ls")).toEqual(["echo don't | wc; ls"]);
});
