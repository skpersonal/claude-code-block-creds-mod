# block-creds

認証情報を含むテキストが LLM に送られる前に、`[REDACTED-xxxxxxxxxxxx]` に置き換える（またはその送信を拒否する）Claude Code の **mod** です。検出は [betterleaks](https://github.com/betterleaks/betterleaks) に任せていて、この mod は検出ルールを持ちません。

動作確認: Claude Code 2.1.287、betterleaks 1.7.4。mods は Claude Code 2.1.287 以降で使えます。

## 何を守るか

| 経路                                                    | フックするイベント  | redact（既定）     | block               |
| ------------------------------------------------------- | ------------------- | ------------------ | ------------------- |
| ユーザーのプロンプトと、添付のコンテキスト              | `prompt.submit`     | 置換して送信       | 送信を中止（drop）  |
| ツールの出力（Read、Bash、MCP、サブエージェントを含む） | `tool.call`         | 結果の文字列を置換 | 結果を破棄して deny |
| `@file` や CLAUDE.md などエンジンが差し込む本文         | `prompt.attachment` | 置換               | その添付を落とす    |
| `!コマンド`（bash モード）の入力と出力                  | `session.append`    | 置換               | 本文を伏せ文に差し替え |

## 同じ値には同じプレースホルダ

プレースホルダは `HMAC-SHA256(鍵, 秘密値)` の先頭 12 桁の 16 進数です。同じ値は、プロンプトでも `.env` でも別のツールの出力でも同じ `[REDACTED-…]` になるので、モデルは「この 2 か所は同じ値」「こちらは別の値」という文脈を保てます。

- 対応表をディスクに保存しません。値は同じ入力から同じ出力になるように計算するだけです。
- 鍵は `hashKey` です。空のときは初回の起動で乱数を作ってプラグインの store に保存するので、セッションや再起動をまたいでも同じプレースホルダになります。
- 鍵を使う理由は、素のハッシュだと弱いパスワードなどを辞書攻撃で逆算されうるためです。

## モデルへの通知

redact したとき、モデルだけが読む短い注記（英語）を添えます。内容は、認証情報フィルタが値をプレースホルダに置き換えたこと、各プレースホルダの検出ルール（`github-pat` など）、本物の値は見えないこと、ユーザーの画面には本物の値が見えているかどうか（`restoreInDisplay` に従う）、ツール入力にプレースホルダをそのまま渡せるかどうか（`restoreInToolInput` に従う）、そのまま作業を続けてよく値をユーザーに求めないこと、です。これでモデルは、ファイルが壊れていると誤解したり値の入力を求めたりせずに作業を続けられます。

| 経路                 | 注記の置き場所                       |
| -------------------- | ------------------------------------ |
| ツール結果           | `context`（ユーザーには見えない）    |
| 失敗したツール結果   | 置換後のエラー文の末尾               |
| プロンプト           | `context` の末尾                     |
| 添付（`@file` など） | 置換後の本文の末尾                   |
| `!コマンド`          | 置換後の行の末尾                     |

block とスキャン失敗のときは、これまでどおり拒否の理由を返します。クリーンな入力には何も足しません。

## ツール入力での復元

モデルが `[REDACTED-…]` を含むコマンドを書いたとき、`tool.call` の入力の中だけ、この mod が覚えている（メモリ上の）対応で本物の値に戻してから実行します。たとえば `curl -H "Authorization: token [REDACTED-…]"` はそのまま動きます。実行結果に本物の値が出てきても、出力側でまた置換されます。

- 戻せるのは、この mod がその読み込み中に置換した値だけです。未知のプレースホルダはそのまま渡します。
- この復元により、モデルが指示した先（`curl` の宛先など）へ本物の値が渡ることがあります。それを避けたい場合は `restoreInToolInput` を `false` にします。

## 画面表示での復元

モデルに渡る内容と履歴は置換したまま、**人間が見る描画だけ**本物の値に戻します（`ui.render`）。モデルの返答、ツールの行と結果、自分のプロンプト、スラッシュコマンドの出力、質問ダイアログが対象です。

- 戻せるのは、この mod が置換した値だけです。未知のプレースホルダはそのままです。
- 画面共有や録画には本物の値が映ります。無効にするには `restoreInDisplay` を `false` にします。
- 履歴やモデルが読む内容は変わりません。送信時だけ置換して履歴は本物の値のままにする方法は、mods API にありません（`turn.step` は送るメッセージを書き換えられず、書き換えた応答は履歴に記録されます）。
- `claude -p` や `--output-format stream-json` の出力は描画を通らないので、置換されたままです。thinking と、折りたたまれたツール群の 1 行要約も対象外です。
- 対応表（秘密値）はディスクに保存しません。`--resume` で再開した直後は、過去の行はプレースホルダのままです。その値にもう一度出会う（たとえば `.env` を再度読む）と、描き直されて本物の値になります。
- 再開後も同じ値が同じプレースホルダになるよう、`hashKey` が空なら初回の起動で鍵を自動生成し、プラグイン専用の store（Claude Code の設定ディレクトリ下の JSON ファイル。平文）に保存します。設定画面の `hashKey` は書き換わりません。決まった鍵を使いたいときは `/plugin configure` で `hashKey` を入力します（入力があれば store は使いません）。保存に失敗すると通知し、その起動の間だけ使うメモリ上の鍵で続けます。

## インストール

前提: `betterleaks` が PATH にあること（`brew install betterleaks`、`mise use -g aqua:betterleaks/betterleaks`、`go install github.com/betterleaks/betterleaks/v2@latest` など）。

GitHub リポジトリ `skpersonal/claude-code-block-creds-mod` をマーケットプレイスとして追加し、そこから入れます。

```text
# Claude Code のセッション内で
/plugin marketplace add skpersonal/claude-code-block-creds-mod
/plugin install block-creds@block-creds-marketplace
```

追加と導入を 1 コマンドにまとめることもできます（Claude Code 2.1.275 以降）。

```text
/plugin install block-creds --marketplace skpersonal/claude-code-block-creds-mod
```

セッションを開かずにシェルから入れる場合は次のとおりです。

```bash
claude plugin marketplace add skpersonal/claude-code-block-creds-mod
claude plugin install block-creds@block-creds-marketplace            # 既定はユーザースコープ
claude plugin install block-creds@block-creds-marketplace --scope project   # リポジトリ単位で有効にする場合
```

- 導入したあと、開いているセッションでは `/reload-plugins` を実行すると読み込まれます。`/plugin` を開き、Installed タブに `block-creds` があれば有効です。
- タグやブランチに固定する場合は、`skpersonal/claude-code-block-creds-mod#v0.1.0` のように `#ref` を付けます。
- 更新は `claude plugin update block-creds@block-creds-marketplace`、削除は `claude plugin uninstall block-creds@block-creds-marketplace` です。
- 手元の clone を 1 セッションだけ試すには `claude --plugin-dir /path/to/claude-code-block-creds-mod` を使います。

## 設定（userConfig）

| 名前                 | 既定値           | 内容                                                                                     |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `mode`               | `redact`         | `redact`: 置換して送る。`block`: 送らない                                                |
| `betterleaksPath`    | `betterleaks`    | 実行ファイルの名前またはパス                                                             |
| `configPath`         | なし             | betterleaks の設定ファイル（`-c`）。省略すると betterleaks の既定ルール                  |
| `hashKey`            | 初回に自動生成   | プレースホルダ用の鍵。空なら store に自動生成                                               |
| `restoreInToolInput` | `true`           | ツール入力でプレースホルダを本物の値に戻す                                               |
| `restoreInDisplay`   | `true`           | 画面の描画でプレースホルダを本物の値に戻す（モデルに渡る内容は変わらない）               |

`/plugin configure block-creds@block-creds-marketplace` で設定できます。

セッション中の件数は `/block-creds` で確認できます。

置換・ブロック・スキャン失敗のときは、toast に加えて、プロンプト下の status 行に内容を表示します。status 行は次のメッセージを送るまで残ります。どちらもモデルには渡りません。

## 検出ルールを足す

検出は betterleaks の既定ルールのままです。たとえば AWS のアクセスキー ID は、**近く（5 行以内）にシークレットキーがあるときだけ**報告され、ID 単体は報告されません。URL に埋め込まれたパスワード（`postgres://user:pass@host`）も既定では検出されません。足したい場合は、既定を継承した設定ファイルを作って `configPath` に指定します。

```toml
# betterleaks.toml
[extend]
useDefault = true

[[rules]]
id = "aws-access-key-id"
description = "AWS access key ID, even without the secret"
regex = '''\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b'''
keywords = ["a3t", "akia", "asia", "abia", "acca"]
filter = '''
entropy(finding["secret"]) <= 3.0
|| matchesAny(finding["secret"], [`.+EXAMPLE$`])
'''
```

## 制限事項

- 画像と PDF の中身は検査しません。
- `!コマンド` の行は会話に保存される前に書き換えるだけで、行そのものを拒否できません。block モードや検査失敗のときは、本文を「伏せた」という文に差し替えて保存します。
- システムプロンプト（`prompt.section`、`prompt.context`）は対象外です。
- mod を読み込む前に会話に入っていた内容（`--resume` した会話の履歴など）は置換しません。
- 検出精度は betterleaks のルールに依存します。未知の形式は見つかりません。
- プロンプト、ツール結果、添付のそれぞれで betterleaks を 1 回起動します（1 回約 40 ms）。
- `--safe-mode`、`--bare`、`disableAllHooks` のときは mod が読み込まれず、何も守られません。
- 検査できないときは常に送りません（fail closed。設定で切り替えることはできません）。
  - betterleaks が起動できない間は、短いテキストも含めてプロンプト・添付・ツール結果・`!コマンド`の行をすべて止めます。起動できるようになれば自動で解除されます。
  - prompt.submit、prompt.attachment、tool.call、session.append のフックが失敗した場合（例外や時間切れ）も、`.catch` でそのテキストを破棄（session.append は伏せ文に差し替え）します。

## 開発

前提: Claude Code 2.1.287 以降、`betterleaks`、Node.js、pnpm（Biome・TypeScript・husky などの開発用ツール）。ビルド工程はなく、Claude Code が `.ts` を直接読み込みます。

### 1. 型定義を生成する（最初と Claude Code を更新した後）

`.claude-plugin/types/` は手で作るものではなく、Claude Code がこの mod を読み込むたびに、インストールされている版に合わせて書き出します（`.gitignore` 済み）。clone した直後は存在しないので、`tsc` の前に一度読み込ませます。

```bash
claude -p "ok" --plugin-dir . < /dev/null
ls .claude-plugin/types   # claude-code/ claude-code-tools/ claude-code-mcp/ tsconfig.json
```

- `claude-code/index.d.ts` が API の正式な定義です（先頭の行に書き出した Claude Code の版が入ります）。イベントの入出力や `$` のメソッドは、Web のドキュメントよりこちらを優先してください。
- 書き出しのたびに `.claude-plugin/types/tsconfig.json` は上書きされます。そのため、`.ts` の import を許す `allowImportingTsExtensions` は、ルートの `tsconfig.json` 側に置いています。

### 2. 変更ごとに実行する

```bash
pnpm validate    # claude plugin validate . --strict。登録しているイベントと呼び出す API の一覧を確認
pnpm test        # claude plugin test。単体テストとイベントテスト（betterleaks はスタブ）
pnpm typecheck   # tsc -p .
pnpm lint        # biome check .（lint と整形の確認）
pnpm format      # biome check --write .（自動修正）
```

最初に `pnpm install` を実行してください（husky が `.husky/` の Git フックを有効にします）。コミット時には pre-commit フックが、ステージしたファイルへの `lint-staged`（Biome の自動修正）、`pnpm typecheck`、`pnpm test` を順に実行します。型チェックには手順 1 の型定義が必要です。

- `claude plugin test` はプラグインのディレクトリを受け取る形式で、テストファイルや単体のテストを指定する方法は見つかっていません。全体で 1 秒未満です。
- `validate` が出す `hooks:` と `calls:` の行に、意図したイベントと API が並んでいるかを見てください。イベント名の綴りミスはここで分かります。
- イベントテストは `claude-code/testing` を使います。API 呼び出し（`$.process.run` など）のスタブは `{ value }` か `{ deny }` を返し、イベント（`tool.call` など）のスタブはそのイベントの結果をそのまま返します。userConfig の値は `test(名前, { options: { mode: 'block' } }, 本体)` で渡します。

### 3. 実際のセッションで確かめる

スタブのテストでは、結果のスキーマ検証や、実際のセッションがモデルに何を送るかは分かりません（AWS のシークレットキーの取りこぼしは、この確認で見つかりました）。フックの結果を変えたときは、ダミーの認証情報で必ず実行してください。

```bash
# ダミーの .env を作業ディレクトリの外に作る（アクセスキー ID は [A-Z2-7] の 16 文字、シークレットは 40 文字）
mkdir -p /tmp/e2e && cd /tmp/e2e
AK="AKIA$(LC_ALL=C tr -dc 'A-Z2-7' </dev/urandom | head -c16)"
SK="$(LC_ALL=C tr -dc 'A-Za-z0-9/+' </dev/urandom | head -c40)"
GH="ghp_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c36)"
printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nGITHUB_TOKEN=%s\n' "$AK" "$SK" "$GH" > .env

# 実行して、モデルに渡った内容（stream-json）に値が残っていないか数える
claude -p "Read .env and tell me every key and token in it, character for character." \
  --plugin-dir /path/to/claude-code-block-creds-mod --output-format stream-json --verbose \
  < /dev/null > out.jsonl
for s in "$AK" "$SK" "$GH"; do grep -c -F "$s" out.jsonl; done   # すべて 0 なら漏れていない
grep -o '\[REDACTED-[0-9a-f]*\]' out.jsonl | sort | uniq -c       # 同じ値は同じプレースホルダ
```

確認するとよい経路は 4 つです。Read、Bash の `cat`、プロンプトへの直接貼り付け、`@.env` のメンション。ツール入力での復元は、Claude に「Read した値を使って `printf '%s' <値> > copy.txt` を実行させる」と、`copy.txt` に本物の値が入ることで確かめられます（Bash などの許可には `--allowedTools` が要ります）。

block モードは、設定を `--settings` で渡して確かめました。

```bash
cat > block-settings.json <<'EOF'
{"pluginConfigs": {"block-creds@inline": {"options": {"mode": "block"}}, "@inline/block-creds": {"mode": "block"}}}
EOF
claude -p "My token is $GH . Say hi." --plugin-dir /path/to/claude-code-block-creds-mod --settings block-settings.json < /dev/null
# => Prompt dropped by a hook: block-creds: the prompt contains credentials (github-pat), so it was not sent
```

上の設定には 2 通りのキー表記を両方入れてあり、どちらが効いたかは切り分けていません。

### 4. コードの構成

`hooks/register.ts` が入口です。`$`（mods API）を渡せるのは同じファイル内の関数だけなので（`validate` が検査します）、betterleaks を起動する処理は `register.ts` にあります。純粋なロジックは `redactor.ts`（置換と HMAC）と `scanner.ts`（betterleaks の出力の解釈）に分けてあり、テストから直接 import できます。

betterleaks の出力は入れ子になることがあります。`aws-secret-access-key` は `aws-access-token` の `ComponentSets[].components[]` の中にだけ現れます。`scanner.ts` は全体をたどって `Secret` を集めているので、最上位だけを読む実装に戻さないでください。

また、betterleaks は secret の直後に `<` が来ると検出できません（`…Qz</bash-stdout>` は検出されず、`…Qz` の後に改行を挟めば検出されます）。`!cmd` の行は末尾がこの形になるため、`session.append` ではタグの前後に改行を入れたコピーをスキャンし、置換は元のテキストに対して行います（`redactor.ts` の `forScan`）。
