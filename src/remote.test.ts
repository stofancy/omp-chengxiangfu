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

test("lark-cli：识别飞书 IM 写入和原始 API 写入", () => {
	for (const verb of ["+messages-send", "+messages-reply", "+messages-forward", "+messages-edit", "+chat-create", "+flag-cancel", "messages forward", "chat.members delete", "feed.groups batch_add_item"]) {
		expect(bash(`echo ready && lark-cli --profile "示例 公司" im ${verb} --as bot`)).toStartWith("lark-cli im write");
	}
	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
		expect(bash(`env /usr/local/bin/lark-cli api --profile=example ${method} /open-apis/im/v1/messages`)).toStartWith("lark-cli api write");
	}
});

test("lark-cli：读消息、读已读状态和 GET 不记账", () => {
	for (const command of [
		`lark-cli --profile "示例 公司" im +messages-mget --message-ids om_example`,
		"lark-cli im +chat-list --as user --types group",
		"lark-cli im +messages-read-status",
		"lark-cli im messages read_users",
		"lark-cli im feed.groups batch_query",
		`lark-cli im +messages-search --query '+messages-send'`,
		`lark-cli api GET /open-apis/im/v1/chats | grep POST`,
		`echo "lark-cli im +messages-send"`,
	]) expect(bash(command)).toBeUndefined();
});

test("拆简单命令：引号、$( )、( ) 里面的分隔符不算；引号没配上时后面整段算一条", () => {
	expect(commands(`a 'x | y' | b "p; q $(c | d)" ; e && f`).map(s => s.trim()).filter(Boolean)).toEqual([`a 'x | y'`, `b "p; q $(c | d)"`, "e", "& f"]);
	expect(commands(`echo "it's fine" | wc -l`).map(s => s.trim())).toEqual([`echo "it's fine"`, "wc -l"]);
	expect(commands("echo don't | wc; ls")).toEqual(["echo don't | wc; ls"]);
});
